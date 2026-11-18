import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireStoreLock } from "../service/acquire-store-lock.ts";
import { requestService } from "../service/request-service.ts";
import { serveServiceSocket } from "../service/serve-service-socket.ts";
import { parseServiceRequest } from "../service/parse-service-request.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the Unix socket accepts a JSON request and refuses a second service", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "workshop-socket-test-"));
  const socketPath = join(stateDirectory, "service.sock");
  let service: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  let handledRequests = 0;
  try {
    service = await serveServiceSocket(socketPath, async (request, send) => {
      const parsed = parseServiceRequest(request);
      handledRequests += 1;
      send({ request_id: parsed.request_id, ok: true, accepted: parsed.type });
    });
    const response = await requestService({ type: "list_workflows" }, stateDirectory);
    assert.equal(response.ok, true);
    assert.equal(response.accepted, "list_workflows");
    assert.throws(() => parseServiceRequest({ request_id: "bad", type: "list_workflows", extra: true }));
    await assert.rejects(serveServiceSocket(socketPath, async () => {}), /already running/);
    const oversizedResponse = await new Promise<string>((resolveResponse, rejectResponse) => {
      const client = connect(socketPath);
      let responseText = "";
      client.setEncoding("utf8");
      client.on("data", (chunk: string) => { responseText += chunk; });
      client.once("error", rejectResponse);
      client.once("close", () => resolveResponse(responseText));
      client.once("connect", () => {
        const request = JSON.stringify({ request_id: "large", type: "start_workflow", workflow: "clock" });
        client.end(`${request}${" ".repeat(1_048_576)}\n`);
      });
    });
    const oversizedValue: unknown = JSON.parse(oversizedResponse);
    assert.ok(isRecord(oversizedValue));
    if (!isRecord(oversizedValue)) throw new Error("Oversized socket response was not an object");
    assert.equal(oversizedValue.ok, false);
    assert.equal(typeof oversizedValue.error, "string");
    if (typeof oversizedValue.error === "string") assert.match(oversizedValue.error, /1 MiB limit/);
    assert.equal(handledRequests, 1);
  } finally {
    if (service) await service.close();
    assert.equal(existsSync(socketPath), false);
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("the SQLite store lock refuses a second owner and releases cleanly", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "workshop-lock-test-"));
  const databasePath = join(stateDirectory, "workshop.sqlite");
  let first: Awaited<ReturnType<typeof acquireStoreLock>> | undefined;
  try {
    first = await acquireStoreLock(databasePath);
    const storage = await openNodeSqliteStorage(databasePath);
    await storage.close(BACKGROUND_CONTEXT);
    await assert.rejects(acquireStoreLock(databasePath), /already running/);
    const moduleUrl = new URL("../service/acquire-store-lock.ts", import.meta.url).href;
    const script = `import { acquireStoreLock } from ${JSON.stringify(moduleUrl)};\nconst lock = await acquireStoreLock(${JSON.stringify(databasePath)});\nawait lock.release();\nthrow new Error("unexpected lock acquisition");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let childError = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { childError += chunk; });
    const childExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    assert.equal(childExit.code, 1, childError);
    assert.match(childError, /already running/);
    await first.release();
    first = undefined;
    const database = new DatabaseSync(databasePath);
    database.prepare(`INSERT INTO workshop_service_lock (lock_key, pid, process_started_at, token, acquired_at) VALUES (?, ?, ?, ?, ?)`)
      .run("service", process.pid, "different process start", "stale-token", new Date().toISOString());
    database.close();
    const reclaimed = await acquireStoreLock(databasePath);
    await reclaimed.release();
  } finally {
    if (first) await first.release();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("overlapping SQLite lock releases wait for completion", async () => {
  const lock = await acquireStoreLock(":memory:");
  const completed: string[] = [];
  try {
    const first = lock.release().then(() => { completed.push("first"); });
    const second = lock.release().then(() => { completed.push("second"); });
    await Promise.all([first, second]);
    assert.deepEqual(completed, ["first", "second"]);
    assert.equal(await lock.release(), undefined);
  } finally {
    await lock.release();
  }
});

test("repeated SQLite lock releases retain a DELETE failure", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "workshop-lock-test-"));
  const databasePath = join(stateDirectory, "workshop.sqlite");
  const database = new DatabaseSync(databasePath);
  let lock: Awaited<ReturnType<typeof acquireStoreLock>> | undefined;
  try {
    lock = await acquireStoreLock(databasePath);
    database.exec(`CREATE TRIGGER deny_release BEFORE DELETE ON workshop_service_lock
      BEGIN SELECT RAISE(ABORT, 'release denied'); END`);
    const [first, second] = await Promise.allSettled([lock.release(), lock.release()]);
    assert.ok(first.status === "rejected");
    assert.ok(first.reason instanceof Error);
    assert.equal(first.reason.message, "release denied");
    assert.ok("code" in first.reason);
    assert.equal(first.reason.code, "ERR_SQLITE_ERROR");
    assert.deepEqual(second, { status: "rejected", reason: first.reason });
    await assert.rejects(lock.release(), first.reason);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workshop_service_lock").get()?.count, 1);
  } finally {
    await lock?.release().catch(() => {});
    database.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("socket permission failure cleans up its listener and path", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "workshop-socket-permission-test-"));
  const socketPath = join(stateDirectory, "service.sock");
  let service: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  let failure: unknown;
  try {
    try {
      service = await serveServiceSocket(socketPath, async () => {}, {
        protectSocket: () => { throw new Error("injected chmod failure"); },
      });
    } catch (error) {
      failure = error;
    }
    if (service) {
      await service.close();
      service = undefined;
    }
    assert.match(String(failure), /injected chmod failure/);
    assert.equal(existsSync(socketPath), false);
  } finally {
    if (service) await service.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("socket shutdown closes every watcher and listener after a watcher fails", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "workshop-socket-watch-test-"));
  const socketPath = join(stateDirectory, "service.sock");
  let closeCalls = 0;
  let attachedCount = 0;
  let resolveAttached: (() => void) | undefined;
  const watchersAttached = new Promise<void>((resolveWatchers) => { resolveAttached = resolveWatchers; });
  const service = await serveServiceSocket(socketPath, async () => {
    attachedCount += 1;
    if (attachedCount === 2) resolveAttached?.();
    return {
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error("injected watcher close failure");
      },
    };
  });
  const clients = [connect(socketPath), connect(socketPath)];
  try {
    await Promise.all(clients.map((client) => new Promise<void>((resolveClient, rejectClient) => {
      client.once("error", rejectClient);
      client.once("connect", () => {
        client.write('{"request_id":"watch","type":"watch_chat"}\n');
        resolveClient();
      });
    })));
    await watchersAttached;
    await assert.rejects(service.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Service socket shutdown failed/);
      assert.ok(error.errors.some((cause: unknown) => String(cause).includes("watcher close failure")));
      return true;
    });
    assert.equal(closeCalls, 2);
    assert.equal(existsSync(socketPath), false);
  } finally {
    for (const client of clients) client.destroy();
    await service.close().catch(() => undefined);
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

for (const framing of ["lines", "trailing"] as const) {
  for (const failure of ["none", "error", "non-error"] as const) {
    const behavior = failure === "none"
      ? "closes once and preserves responses"
      : "logs watcher cleanup rejection without terminating";
    test(`socket EOF ${behavior} (${framing}, ${failure})`, { timeout: 15_000 }, async () => {
      const stateDirectory = mkdtempSync(join(tmpdir(), "workshop-socket-eof-"));
      const socketPath = join(stateDirectory, "service.sock");
      const moduleUrl = new URL("../service/serve-service-socket.ts", import.meta.url).href;
      const requestUrl = new URL("../service/request-service.ts", import.meta.url).href;
      // A child keeps Node's fatal unhandled-rejection policy intact.
      const script = `
        import { connect } from 'node:net';
        import { serveServiceSocket } from ${JSON.stringify(moduleUrl)};
        import { requestService } from ${JSON.stringify(requestUrl)};
        let closeCalls = 0;
        let finishClose;
        const closed = new Promise(resolve => { finishClose = resolve; });
        const service = await serveServiceSocket(${JSON.stringify(socketPath)}, async (request, send) => {
          send({ request_id: request.request_id, ok: true, type: request.type });
          if (request.type !== 'watch_chat') return;
          return { close: async () => {
            closeCalls += 1;
            finishClose();
            if (${JSON.stringify(failure)} === 'error') throw new Error('watch close failed');
            if (${JSON.stringify(failure)} === 'non-error') throw 'watch close failed';
          } };
        });
        let transcript = '';
        await new Promise((resolve, reject) => {
          const client = connect(${JSON.stringify(socketPath)});
          client.setEncoding('utf8');
          client.once('error', reject);
          client.once('close', resolve);
          let ended = false;
          client.on('data', chunk => {
            transcript += chunk;
            if (${JSON.stringify(framing)} === 'lines' && !ended && transcript.includes('\\n')) {
              ended = true;
              client.end('{"request_id":"later","type":"list_workflows"}');
            }
          });
          client.once('connect', () => {
            const watch = '{"request_id":"watch","type":"watch_chat"}';
            if (${JSON.stringify(framing)} === 'trailing') client.end(watch);
            else client.write(watch + '\\n');
          });
        });
        await closed;
        const probe = await requestService({ request_id: 'probe', type: 'list_workflows' }, ${JSON.stringify(stateDirectory)});
        await service.close();
        console.log(JSON.stringify({ transcript, probe, closeCalls }));
      `;
      const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, 0, stderr);
        const diagnostic = failure === "error" ? "watch close failed" : "Service request failed";
        assert.equal(stderr, failure === "none" ? "" : `[workshop] chat watch close failed: ${diagnostic}\n`);
        assert.deepEqual(JSON.parse(stdout), {
          transcript: '{"request_id":"watch","ok":true,"type":"watch_chat"}\n'
            + (framing === "lines" ? '{"request_id":"later","ok":true,"type":"list_workflows"}\n' : ""),
          probe: { request_id: "probe", ok: true, type: "list_workflows" },
          closeCalls: 1,
        });
      } finally {
        child.kill("SIGKILL");
        rmSync(stateDirectory, { recursive: true, force: true });
      }
    });
  }
}
