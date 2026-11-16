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
import { parseServiceRequest } from "../service/types.ts";

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
