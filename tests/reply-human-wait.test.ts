import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { readServiceWorklog, sendServiceRequest } from "../src/service/send-service-request.js";
import { serviceReplyResultV1Schema, serviceRunsPageV1Schema, serviceStartResultV1Schema, type ServiceRequestV1 } from "../src/service/schema.js";
import { nodeDescriptionDtoSchema, statusDtoSchema, type RunSummaryDto } from "../src/views/schema.js";
import { humanAnswerSchema, runIdSchema } from "../src/run/schema.js";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const emit = (text: string) => "printf '%s' " + quote(text);
const proposal = "Submit proposal P-42 unchanged.";
const question = "Approve this exact proposal?";
const taggedWait = "<status>needs_input</status>\n<question>" + question + "</question>\n<output>" + proposal + "</output>";
const worker = (prefix = "") => ({ run: prefix + emit(taggedWait), result: "tagged" });
const agent = (command: string) => ({ agent: { instructions: "Use the exact approved proposal.", model: "fixture/model:low", harness: { command } } });
const source = (steps: unknown[], extra = {}) => JSON.stringify({ version: 4, defaults: { replay: "safe", retries: 0 }, steps, ...extra });

type Owner = Awaited<ReturnType<typeof startWorkshopService>>;
async function fixture(workflows: Record<string, string>, action: (f: {
  root: string; socket: string; restart: () => Promise<void>;
  send: (request: ServiceRequestV1) => ReturnType<typeof sendServiceRequest>;
  start: (workflowId?: string) => Promise<ReturnType<typeof serviceStartResultV1Schema.parse>>;
  run: (workflowId?: string, status?: RunSummaryDto["status"]) => Promise<RunSummaryDto>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "workshop-human-wait-"));
  mkdirSync(join(root, ".workshop", "workflows"), { recursive: true });
  writeFileSync(join(root, ".workshop", "workshop.yaml"), "shell: /bin/sh\nmax_concurrent_runs: 1\n");
  for (const [id, text] of Object.entries(workflows)) writeFileSync(join(root, ".workshop", "workflows", id + ".yaml"), text);
  const installation = loadInstallation(root);
  let owner: Owner | undefined;
  try {
    owner = await startWorkshopService(installation);
    const f = {
      root, socket: owner.metadata.socketPath,
      async restart() {
        await owner?.shutdown();
        owner = await startWorkshopService(installation);
        f.socket = owner.metadata.socketPath;
      },
      send: (request: ServiceRequestV1) => sendServiceRequest(f.socket, request),
      async start(workflowId = "approval") {
        const response = await f.send({ version: 1, method: "start", workflowId, requestId: randomUUID() });
        if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
        return serviceStartResultV1Schema.parse(response.result);
      },
      async run(workflowId = "approval", status?: RunSummaryDto["status"]): Promise<RunSummaryDto> {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const response = await f.send({ version: 1, method: "runs", workflowId });
          if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
          const run = serviceRunsPageV1Schema.parse(response.result).runs[0];
          if (run !== undefined && (status === undefined || run.status === status)) return run;
          if (run !== undefined && ["blocked", "failed", "cancelled"].includes(run.status)) {
            throw new Error("expected " + status + "; run settled as " + run.status + ": " + JSON.stringify(run.block ?? run.failure));
          }
          await Bun.sleep(10);
        }
        throw new Error("run did not reach " + status);
      },
    };
    await action(f);
  } finally {
    await owner?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}
function reply(run: RunSummaryDto, action: "continue" | "reject" = "continue", answer = "Approved.", requestId = randomUUID()): Extract<ServiceRequestV1, { method: "human.reply" }> {
  if (run.wait == null) throw new Error("fixture run has no wait");
  return { version: 1, method: "human.reply", workflowId: run.workflowId, runId: run.runId, waitId: run.wait.waitId, action, answer, requestId };
}
async function control(f: { send: (request: ServiceRequestV1) => ReturnType<typeof sendServiceRequest> }, method: "pause" | "resume" | "stop", workflowId = "approval") {
  const response = await f.send({ version: 1, method, workflowId, requestId: randomUUID() });
  if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
  return response;
}

test("restart retains the exact wait, proposal, question, and accepted worker without another launch", async () => {
  await fixture({ approval: source([{ prepare: worker("printf w >> worker-count; ") }, { act: "printf acted" }]) }, async (f) => {
    const admission = await f.start();
    const waiting = await f.run("approval", "waiting");
    expect(waiting.wait).toMatchObject({ runId: admission.runId, nodeId: "prepare", question, output: proposal, settlement: { kind: "pending" } });
    await f.restart();
    const restored = await f.run("approval", "waiting");
    expect(restored.wait).toEqual(waiting.wait);
    expect(readFileSync(join(f.root, "worker-count"), "utf8")).toBe("w");
    const status = await f.send({ version: 1, method: "status", workflowId: "approval" });
    if (!status.ok) throw new Error(status.error.message);
    expect(statusDtoSchema.parse(status.result).workflows[0]?.unresolvedRun?.wait).toEqual(waiting.wait);
    const log = await readServiceWorklog(f.socket, "approval", waiting.runId);
    expect(log).toContain(waiting.wait?.waitId ?? "missing");
    expect(log).toContain(question);
    const duplicateStart = await f.start();
    expect(duplicateStart).toMatchObject({ duplicate: true, runId: waiting.runId });
  });
});

test("identical concurrent replies under old and new IDs return the saved receipt; conflicts never advance twice", async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: "printf a >> actions; printf done" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    const request = reply(waiting);
    const replies = await Promise.all([f.send(request), f.send(request), f.send({ ...request, requestId: randomUUID() })]);
    for (const response of replies) expect(response).toMatchObject({ ok: true, result: replies[0]?.ok ? replies[0].result : null });
    const conflictingAnswer = await f.send({ ...request, answer: "No.", requestId: randomUUID() });
    expect(conflictingAnswer).toMatchObject({ ok: false, error: { code: "reply_conflict" } });
    const conflictingAction = await f.send({ ...request, action: "reject", requestId: randomUUID() });
    expect(conflictingAction).toMatchObject({ ok: false, error: { code: "reply_conflict" } });
    const reused = await f.send({ ...request, answer: "Different." });
    expect(reused).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
    await f.run("approval", "completed");
    expect(readFileSync(join(f.root, "actions"), "utf8")).toBe("a");
  });
});

for (const paused of [false, true]) test("final-step Continue completes the run" + (paused ? " during Pause" : ""), async () => {
  await fixture({ approval: source([{ prepare: worker() }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    if (paused) await control(f, "pause");
    const request = reply(waiting);
    const response = await f.send(request);
    if (!response.ok) throw new Error(response.error.message);
    expect(serviceReplyResultV1Schema.parse(response.result).status).toBe("completed");
    const completed = await f.run("approval", "completed");
    expect(completed.terminalOutput).toBe(proposal);
    await f.restart();
    expect(await f.send(request)).toEqual(response);
    expect(await f.send({ ...request, requestId: randomUUID() })).toMatchObject({ ok: true, result: response.result });
    const status = await f.send({ version: 1, method: "status", workflowId: "approval" });
    if (!status.ok) throw new Error(status.error.message);
    expect(statusDtoSchema.parse(status.result).workflows[0]?.unresolvedRun).toBeNull();
  });
});

test("Reject cancels only this run, retains the answer and proposal, and leaves the schedule enabled", async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: "touch unexpected" }], { schedule: { every: "1h", max_runs: 3 } }) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    const request = reply(waiting, "reject", "Do not submit.");
    const response = await f.send(request);
    expect(response).toMatchObject({ ok: true, result: { status: "cancelled" } });
    expect(await f.send({ ...request, requestId: randomUUID() })).toMatchObject({ ok: true });
    const status = await f.send({ version: 1, method: "status", workflowId: "approval" });
    if (!status.ok) throw new Error(status.error.message);
    expect(statusDtoSchema.parse(status.result).workflows[0]).toMatchObject({ unresolvedRun: null, activation: { state: "active", admittedCount: 1 } });
    expect(existsSync(join(f.root, "unexpected"))).toBe(false);
    const detail = await f.send({ version: 1, method: "node.describe", workflowId: "approval", nodeId: "prepare", runId: waiting.runId });
    if (!detail.ok) throw new Error(detail.error.message);
    expect(nodeDescriptionDtoSchema.parse(detail.result).node).toMatchObject({ status: "cancelled", wait: { settlement: { kind: "replied", action: "reject", answer: "Do not submit." } } });
    const results = readFileSync(join(f.root, ".workshop", "runs", waiting.runId, "results.md"), "utf8");
    expect(results).toContain('action="reject"');
    expect(results).toContain("Do not submit.");
  });
});

test("paused Continue survives reply-commit restart and Resume creates exactly one continuation", async () => {
  await fixture({ approval: source([{ prepare: worker("printf p >> preparations; ") }, { act: "printf a >> actions; printf done" }], { environment: { preflight: { command: "printf p >> preflights" } } }) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    await control(f, "pause");
    expect((await f.run()).status).toBe("waiting");
    const request = reply(waiting);
    const response = await f.send(request);
    expect(response).toMatchObject({ ok: true, result: { status: "paused" } });
    expect(existsSync(join(f.root, "actions"))).toBe(false);
    await f.restart();
    const paused = await f.run("approval", "paused");
    expect(paused).toMatchObject({ currentNodeId: "act", currentAttemptNumber: null, waitingForCapacity: false });
    expect(await f.send(request)).toEqual(response);
    await Promise.all([control(f, "resume"), control(f, "resume")]);
    await f.run("approval", "completed");
    expect(readFileSync(join(f.root, "actions"), "utf8")).toBe("a");
    expect(readFileSync(join(f.root, "preparations"), "utf8")).toBe("p");
    expect(readFileSync(join(f.root, "preflights"), "utf8")).toBe("p");
  });
});

for (const pausedContinue of [false, true]) test("Stop directly cancels a taskless " + (pausedContinue ? "paused continuation" : "wait") + " and rejects late replies", async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: "touch unexpected" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    if (pausedContinue) { await control(f, "pause"); expect(await f.send(reply(waiting))).toMatchObject({ ok: true }); }
    await control(f, "stop");
    const cancelled = await f.run("approval", "cancelled");
    expect(cancelled.desiredState).toBe("stopped");
    expect(await f.send(reply(waiting))).toMatchObject({ ok: false, error: { code: "run_stopped" } });
    await f.restart();
    expect((await f.run()).status).toBe("cancelled");
    expect(existsSync(join(f.root, "unexpected"))).toBe(false);
  });
});

for (const order of ["stop-first", "reply-first", "concurrent"] as const) test("Stop/reply serialization: " + order, async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: "touch launched; exec sleep 30" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    let response;
    if (order === "stop-first") { await control(f, "stop"); response = await f.send(reply(waiting)); }
    else if (order === "reply-first") { response = await f.send(reply(waiting)); await control(f, "stop"); }
    else { [response] = await Promise.all([f.send(reply(waiting)), control(f, "stop")]); }
    expect(response).toBeDefined();
    if (response?.ok === false) expect(response.error.code).toBe("run_stopped");
    if (order === "stop-first") expect(response?.ok).toBe(false);
    if (order === "reply-first") expect(response?.ok).toBe(true);
    await f.run("approval", "cancelled");
    expect(await f.send(reply(waiting))).toMatchObject({ ok: false, error: { code: "run_stopped" } });
  });
});

test("waiting releases capacity; Continue waits for reacquisition", async () => {
  await fixture({ approval: source([{ prepare: worker("printf p >> preparations; ") }, { act: "printf a >> actions; printf done" }]),
    holder: source([{ hold: "touch holding; while [ ! -f release ]; do sleep 0.02; done; printf held" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    await f.start("holder");
    await f.run("holder", "running");
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.root, "holding")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.root, "holding"))).toBe(true);
    const request = reply(waiting);
    expect(await f.send(request)).toMatchObject({ ok: true, result: { status: "queued" } });
    const queued = await f.run("approval", "queued");
    expect(queued.waitingForCapacity).toBe(true);
    expect(existsSync(join(f.root, "actions"))).toBe(false);
    writeFileSync(join(f.root, "release"), "");
    await f.run("holder", "completed");
    await f.run("approval", "completed");
    expect(readFileSync(join(f.root, "actions"), "utf8")).toBe("a");
    expect(readFileSync(join(f.root, "preparations"), "utf8")).toBe("p");
  });
});

for (const kind of ["command", "agent"] as const) test(kind + " successor receives the committed answer and current results.md before launch", async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: kind === "command"
    ? { run: 'cat > previous; printf "%s" "$WORKSHOP_ANSWER" > answer; cp "$WORKSHOP_RESULTS_PATH" at-launch; printf done' }
    : agent('cat > prompt; printf "%s" "$WORKSHOP_ANSWER" > answer; cp "$WORKSHOP_RESULTS_PATH" at-launch; ' + emit("<status>succeeded</status>\n<output>done</output>")) }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    const answer = "Approved.\nSubmit unchanged. ✓";
    expect(await f.send(reply(waiting, "continue", answer))).toMatchObject({ ok: true });
    await f.run("approval", "completed");
    expect(readFileSync(join(f.root, "answer"), "utf8")).toBe(answer);
    if (kind === "command") expect(readFileSync(join(f.root, "previous"), "utf8")).toBe(proposal);
    else expect(readFileSync(join(f.root, "prompt"), "utf8")).toContain("### Human answer (data)\n\n" + answer);
    const tag = createHash("sha256").update(waiting.runId).digest("hex").slice(0, 8);
    const block = '<result-prepare-' + tag + ' status="needs_input">\n' + proposal + '\n</result-prepare-' + tag + '>\n'
      + '<answer-prepare-' + tag + ' action="continue">\n' + answer + '\n</answer-prepare-' + tag + '>';
    expect(readFileSync(join(f.root, "at-launch"), "utf8")).toContain(block);
    const results = readFileSync(join(f.root, ".workshop", "runs", waiting.runId, "results.md"), "utf8");
    expect(results).toContain(block);
    expect(results.match(/<answer-prepare-/gu)).toHaveLength(1);
  });
});

for (const verify of ["exit 0", "exit 9", agent(emit("<decision>block</decision>\n<reason>Do not ask yet.</reason>"))]) test("needs_input reaches its verifier before any wait: " + JSON.stringify(verify), async () => {
  const accepted = verify === "exit 0";
  const blocked = typeof verify !== "string";
  await fixture({ approval: source([{ prepare: { ...worker(), verify } }, { act: "touch unexpected" }]) }, async (f) => {
    await f.start();
    const run = await f.run("approval", accepted ? "waiting" : blocked ? "blocked" : "failed");
    expect(run.wait == null).toBe(!accepted);
    expect(existsSync(join(f.root, "unexpected"))).toBe(false);
  });
});

test("pre-approved succeeded actions create no wait or fabricated answer", async () => {
  await fixture({ approval: source([{ prepare: "printf allowed" }, { act: 'test -z "${WORKSHOP_ANSWER+x}"; printf done' }]) }, async (f) => {
    const admitted = await f.start();
    const completed = await f.run("approval", "completed");
    expect(completed.wait).toBeNull();
    const results = readFileSync(join(f.root, ".workshop", "runs", admitted.runId, "results.md"), "utf8");
    expect(results).not.toContain("<answer-");
  });
});

test("answer parser bounds UTF-8 bytes and rejects blank or malformed text", () => {
  expect(humanAnswerSchema.safeParse(" ").success).toBe(false);
  expect(humanAnswerSchema.safeParse("\ud800").success).toBe(false);
  expect(humanAnswerSchema.safeParse("é".repeat(32768)).success).toBe(true);
  expect(humanAnswerSchema.safeParse("é".repeat(32769)).success).toBe(false);
});

test("old replies stay bound to their wait ID when a successor requests another wait", async () => {
  await fixture({ approval: source([{ first: worker() }, { second: worker() }, { act: 'printf "%s" "$WORKSHOP_ANSWER" > answer; printf done' }]) }, async (f) => {
    await f.start();
    const first = await f.run("approval", "waiting");
    const request = reply(first, "continue", "First approval.");
    const response = await f.send(request);
    expect(response).toMatchObject({ ok: true });
    const deadline = Date.now() + 5000;
    let second = await f.run();
    while ((second.status !== "waiting" || second.wait?.waitId === first.wait?.waitId) && Date.now() < deadline) {
      await Bun.sleep(10); second = await f.run();
    }
    expect(second.wait?.waitId).not.toBe(first.wait?.waitId);
    expect(second.wait?.nodeId).toBe("second");
    expect(await f.send({ ...request, requestId: randomUUID() })).toMatchObject({ ok: true, result: response.ok ? response.result : null });
    expect((await f.run()).wait?.waitId).toBe(second.wait?.waitId);
    expect(await f.send({ ...reply(second), waitId: randomUUID() })).toMatchObject({ ok: false, error: { code: "wait_not_found" } });
    expect(await f.send({ ...reply(second), runId: runIdSchema.parse("wrong-run") })).toMatchObject({ ok: false, error: { code: "wait_not_found" } });
    expect(await f.send(reply(second, "continue", "Second approval."))).toMatchObject({ ok: true });
    await f.run("approval", "completed");
    expect(readFileSync(join(f.root, "answer"), "utf8")).toBe("Second approval.");
  });
});

test("Continue queued at capacity survives reply-commit restart without another preparation", async () => {
  await fixture({ approval: source([{ prepare: worker("printf p >> preparations; ") }, { act: "printf a >> actions; printf done" }]),
    holder: source([{ hold: "touch holding; exec sleep 30" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    await f.start("holder");
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.root, "holding")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.root, "holding"))).toBe(true);
    const request = reply(waiting);
    const response = await f.send(request);
    expect(response).toMatchObject({ ok: true, result: { status: "queued" } });
    expect((await f.run()).waitingForCapacity).toBe(true);
    await f.restart();
    // Graceful service shutdown retires the holder. Its block frees capacity on restart.
    await f.run("approval", "completed");
    expect(await f.send(request)).toEqual(response);
    expect(readFileSync(join(f.root, "actions"), "utf8")).toBe("a");
    expect(readFileSync(join(f.root, "preparations"), "utf8")).toBe("p");
  });
});

for (const action of ["continue", "reject"] as const) test("workshop reply --" + action + " sends the current wait ID; status and logs show the wait", async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: "printf done" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    const cli = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], {
        cwd: f.root, stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, stdout, stderr };
    };
    const status = await cli(["status", "approval"]);
    expect(status.exit).toBe(0);
    expect(status.stdout).toContain("Needs input");
    expect(status.stdout).toContain(waiting.wait?.waitId ?? "missing");
    expect(status.stdout).toContain(question);
    const logs = await cli(["logs", "approval"]);
    expect(logs.stdout).toContain(waiting.wait?.waitId ?? "missing");
    expect(logs.stdout).toContain(question);
    for (const args of [["--continue", "--reject", "--answer", "yes"], ["--continue"], ["--continue", "--answer", " "]]) {
      expect((await cli(["reply", "approval", ...args])).exit).toBe(64);
    }
    const response = await cli(["reply", "approval", "--" + action, "--answer", "Decision by CLI."]);
    expect(response.exit).toBe(0);
    expect(response.stdout).toContain(waiting.wait?.waitId ?? "missing");
    await f.run("approval", action === "continue" ? "completed" : "cancelled");
  });
});

test("Pause and Resume during a wait change only desired state", async () => {
  await fixture({ approval: source([{ prepare: worker("printf p >> preparations; ") }, { act: "touch unexpected" }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    await control(f, "pause");
    expect(await f.run()).toMatchObject({ status: "waiting", desiredState: "paused", wait: waiting.wait });
    await control(f, "resume");
    expect(await f.run()).toMatchObject({ status: "waiting", desiredState: "running", wait: waiting.wait });
    expect(readFileSync(join(f.root, "preparations"), "utf8")).toBe("p");
    expect(existsSync(join(f.root, "unexpected"))).toBe(false);
  });
});

test("a needs_input envelope with a nonzero worker exit cannot create a wait", async () => {
  await fixture({ approval: source([{ prepare: { run: emit(taggedWait) + "; exit 7", result: "tagged" } }]) }, async (f) => {
    await f.start();
    const failed = await f.run("approval", "failed");
    expect(failed.wait).toBeNull();
    expect(failed.failure).toMatchObject({ kind: "process_error" });
  });
});

test("successor retries retain the committed answer without consuming a retry for Continue", async () => {
  await fixture({ approval: source([{ prepare: worker() }, { act: {
    run: 'printf "%s" "$WORKSHOP_ANSWER" > "answer-$WORKSHOP_ATTEMPT"; if [ "$WORKSHOP_ATTEMPT" = 1 ]; then exit 7; fi; printf done', retries: 1,
  } }]) }, async (f) => {
    await f.start();
    const waiting = await f.run("approval", "waiting");
    const answer = "Approved unchanged.";
    expect(await f.send(reply(waiting, "continue", answer))).toMatchObject({ ok: true });
    await f.run("approval", "completed");
    expect(readFileSync(join(f.root, "answer-1"), "utf8")).toBe(answer);
    expect(readFileSync(join(f.root, "answer-2"), "utf8")).toBe(answer);
    const detail = await f.send({ version: 1, method: "node.describe", workflowId: "approval", nodeId: "act" });
    if (!detail.ok) throw new Error(detail.error.message);
    expect(nodeDescriptionDtoSchema.parse(detail.result).node.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
  });
});
