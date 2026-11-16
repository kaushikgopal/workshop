import { connect, type Socket } from "node:net";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineDoc, Harness, MemoryStorage, type Storage, type TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { test } from "node:test";
import { createWorkflowStartPort, startWorkflow } from "../run/start-workflow.ts";
import { appendRecent, maxWorkshopHistoryRecords, workshopStateDocument, workflowRunReferenceDocument, type MutationReceipt, type WorkshopAction, type WorkflowAdmission } from "../workflow/define-workshop-state.ts";
import { createWorkshopService } from "../service/create-workshop-service.ts";
import { openWorkshopHarness } from "../service/open-workshop-harness.ts";
import { serveServiceSocket } from "../service/serve-service-socket.ts";
import { parseServiceRequest } from "../service/types.ts";
import { tickWorkflows } from "../schedule/tick-workflows.ts";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { createStepAttemptTask } from "../workflow/define-step-attempt-task.ts";
import { WorkflowTask, WORKFLOW_TASK_NAME } from "../workflow/define-workflow-task.ts";

function createProject(command: string, extraFrontmatter = ""): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "workshop-service-test-"));
  const workflow = join(root, "workflows", "clock");
  mkdirSync(workflow, { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "instructions.md"), "Manage the test workflows.\n");
  writeFileSync(join(root, "workshop.yaml"), [
    "agent_profiles:",
    `  writer:\n    command: ["${process.execPath}"]`,
    "orchestrator: {}",
    "",
  ].join("\n"));
  writeFileSync(join(workflow, "workflow.md"), `---\ncron: '* * * * *'\n${extraFrontmatter}---\nA service test workflow.\n`);
  writeFileSync(join(workflow, "10-task.sh"), command);
  return { root };
}

function createHarness(storage: Storage) {
  const registry = createRegistry();
  registry.install({ name: "workshop", tasks: [WorkflowTask, createStepAttemptTask(executeWorkflowProcess)] });
  return Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Service response did not include a list");
  const records = value.filter(isRecord);
  if (records.length !== value.length) throw new Error("Service response list contains an invalid item");
  return records;
}

function transcriptText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    if (!isRecord(message)) return "";
    const body = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("")
        : "";
    const sections = isRecord(message.sections)
      ? Object.values(message.sections).filter((section): section is string => typeof section === "string")
      : [];
    return [body, ...sections].join("\n");
  }).join("\n");
}

async function waitForTask(storage: Storage, runId: string): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await storage.scanTasks({ kind: WORKFLOW_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT);
    const found = page.items.find((record) => isRecord(record.input) && record.input.runId === runId);
    if (found) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Workflow task for ${runId} was not created`);
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForRunStatus(service: ReturnType<typeof createWorkshopService>, storage: Storage, runId: string, expected: string): Promise<Record<string, unknown>> {
  let lastRun: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await service.handleRequest({ request_id: `read-${attempt}`, type: "read_run", run_id: runId });
    lastRun = response.run;
    if (isRecord(response.run) && response.run.status === expected) return response.run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const page = await storage.scanTasks({ kind: WORKFLOW_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT);
  const task = page.items.find((record) => isRecord(record.input) && record.input.runId === runId);
  throw new Error(`Workflow run ${runId} did not reach ${expected}: ${JSON.stringify(lastRun)} task=${JSON.stringify(task?.state)}`);
}

function runIdFrom(response: Record<string, unknown>): string {
  assert.equal(response.ok, true);
  assert.equal(typeof response.run_id, "string");
  if (typeof response.run_id !== "string") throw new Error("Service response has no run ID");
  return response.run_id;
}

test("bounded workshop history keeps only the newest records", () => {
  const history: number[] = [];
  for (let value = 0; value < maxWorkshopHistoryRecords + 25; value += 1) appendRecent(history, value);
  assert.equal(history.length, maxWorkshopHistoryRecords);
  assert.equal(history[0], 25);
  assert.equal(history.at(-1), maxWorkshopHistoryRecords + 24);
});

test("workshop-state migration bounds history without losing scheduling counters", async () => {
  type WorkshopStateV1 = { admissions: WorkflowAdmission[]; actions: WorkshopAction[]; paused: string[]; receipts: MutationReceipt[] };
  const previousDocument = defineDoc<WorkshopStateV1>({
    kind: "workshop.state",
    version: 1,
    scope: "session",
    initial: () => ({ admissions: [], actions: [], paused: [], receipts: [] }),
    checkpointWhen: () => true,
  });
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    await harness.commit(async (tx) => {
      const previous = await tx.doc(previousDocument);
      for (let value = 0; value < maxWorkshopHistoryRecords + 5; value += 1) {
        const slot = String(value).padStart(6, "0");
        previous.admissions.push({ workflow: "clock", slot, run_id: `run-${value}`, outcome: "started", at: slot });
        previous.actions.push({ at: slot, workflow: "clock", run_id: `run-${value}`, step: null, source: "chat", decision: { action: "start" }, note: "Started" });
        previous.receipts.push({ request_id: `request-${value}`, fingerprint: `fingerprint-${value}`, response: { ok: true } });
      }
      return { stored: true };
    }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const state = await tx.doc(workshopStateDocument);
      assert.equal(state.startedCounts.clock, maxWorkshopHistoryRecords + 5);
      assert.equal(state.lastSlots.clock, String(maxWorkshopHistoryRecords + 4).padStart(6, "0"));
      assert.equal(state.admissions.length, maxWorkshopHistoryRecords);
      assert.equal(state.admissions[0]?.run_id, "run-5");
      assert.equal(state.actions.length, maxWorkshopHistoryRecords);
      assert.equal(state.receipts[0]?.request_id, "request-5");
      return { migrated: true };
    }, BACKGROUND_CONTEXT);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
  }
});

test("fatal durable storage errors are reported to the service owner", async () => {
  const storage = new MemoryStorage();
  const originalCommit = storage.commit.bind(storage);
  let failCommits = false;
  storage.commit = async (...args) => {
    if (failCommits) throw new Error("Injected storage failure");
    return await originalCommit(...args);
  };
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let reportedFailures = 0;
  try {
    harness = await openWorkshopHarness(storage, (report) => {
      if (report.kind === "storage_failed") reportedFailures += 1;
    });
    failCommits = true;
    await assert.rejects(harness.commit(async (tx) => {
      await tx.doc(workshopStateDocument);
      return { committed: true };
    }, BACKGROUND_CONTEXT), /Injected storage failure/);
    assert.equal(reportedFailures, 1);
  } finally {
    failCommits = false;
    if (harness) await harness.close(BACKGROUND_CONTEXT);
  }
});

test("service starts, lists, reads, and cancels a workflow run", async () => {
  const project = createProject(`printf '%s' "$WORKSHOP_DATA_DIR" > "$WORKSHOP_DATA_DIR/started"\nsleep 30\n`);
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const workflows = await service.handleRequest({ request_id: "list", type: "list_workflows" });
    assert.equal(workflows.ok, true);
    assert.equal(recordsFrom(workflows.workflows)[0]?.name, "clock");

    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    const marker = join(project.root, "data", "clock", "started");
    await waitForFile(marker);

    const listed = await service.handleRequest({ request_id: "runs", type: "list_runs", limit: 10 });
    assert.ok(recordsFrom(listed.runs).some((run) => run.run_id === runId));
    const reading = await service.handleRequest({ request_id: "read", type: "read_run", run_id: runId });
    assert.ok(isRecord(reading.run));
    assert.ok(["running", "blocked"].includes(String(reading.run.status)));

    const cancelRequest = { request_id: "cancel", type: "cancel_run", run_id: runId };
    const abort = harness.abortTask.bind(harness);
    harness.abortTask = async () => { throw new Error("simulated crash before abort"); };
    await assert.rejects(service.handleRequest(cancelRequest), /simulated crash before abort/);
    const beforeRetry = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(beforeRetry?.receipts.some((receipt) => receipt.request_id === "cancel"), false);
    assert.equal(beforeRetry?.actions.some((action) => action.decision.action === "cancel"), false);
    harness.abortTask = async (taskId, context) => {
      await abort(taskId, context);
      throw new Error("simulated crash after abort");
    };
    await assert.rejects(service.handleRequest(cancelRequest), /simulated crash after abort/);
    const settledAfterAbort = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settledAfterAbort.state.status, "terminal");
    if (settledAfterAbort.state.status === "terminal") assert.equal(settledAfterAbort.state.outcome.status, "aborted");
    const afterAbort = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(afterAbort?.receipts.some((receipt) => receipt.request_id === "cancel"), false);
    assert.equal(afterAbort?.actions.some((action) => action.decision.action === "cancel"), false);
    harness.abortTask = abort;

    const cancelled = await service.handleRequest(cancelRequest);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.cancelled, true);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") assert.equal(settled.state.outcome.status, "aborted");

    const actions = await service.handleRequest({ request_id: "actions", type: "list_actions", limit: 10 });
    assert.deepEqual(recordsFrom(actions.actions).map((entry) => isRecord(entry.decision) ? entry.decision.action : undefined), ["cancel", "start"]);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});


test("service decisions wake blocked tasks and deduplicate retried requests", async () => {
  const project = createProject("printf 'bad output'; exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    const blocked = await waitForRunStatus(service, storage, runId, "blocked");
    assert.ok(isRecord(blocked.blocked_step));
    assert.equal(blocked.blocked_step.step, "10-task");
    assert.equal(typeof blocked.blocked_step.decision_number, "number");
    const decisionNumber = blocked.blocked_step.decision_number;

    const request = { request_id: "decision", type: "decide_blocked_run", run_id: runId, decision_number: decisionNumber, decision: { action: "skip" } };
    const decision = await service.handleRequest(request);
    assert.equal(decision.ok, true);
    assert.deepEqual(await service.handleRequest(request), decision);
    await assert.rejects(service.handleRequest({ ...request, decision: { action: "fail" } }), /already used for a different request/);

    const root = await harness.root(BACKGROUND_CONTEXT);
    const roundSubmissions = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.ok(roundSubmissions.items.some((submission) => submission.requestId === `round:${runId}:10-task:1`));
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") assert.equal(settled.state.outcome.status, "completed");
    const actions = await service.handleRequest({ request_id: "actions", type: "list_actions", limit: 10 });
    assert.deepEqual(recordsFrom(actions.actions).map((entry) => [entry.source, isRecord(entry.decision) ? entry.decision.action : undefined]), [
      ["chat", "skip"], ["round", "give_up"], ["chat", "start"],
    ]);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a blocked run accepts a chat decision after reopening SQLite", { timeout: 30_000 }, async () => {
  const project = createProject("exit 7\n", "retries: 0\n");
  const stateDirectory = join(project.root, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "workshop.sqlite");
  let firstHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let secondHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let firstStorage: Storage | undefined;
  try {
    firstStorage = await openNodeSqliteStorage(databasePath);
    firstHarness = await createHarness(firstStorage);
    firstHarness.resume();
    const firstService = createWorkshopService({ projectRoot: project.root, harness: firstHarness });
    const started = await firstService.handleRequest({ request_id: "start-before-reopen", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    await waitForRunStatus(firstService, firstStorage, runId, "blocked");
    await firstHarness.close(BACKGROUND_CONTEXT);
    firstHarness = undefined;
    firstStorage = undefined;

    secondHarness = await createHarness(await openNodeSqliteStorage(databasePath));
    secondHarness.resume();
    const secondService = createWorkshopService({ projectRoot: project.root, harness: secondHarness });
    const decision = await secondService.handleRequest({
      request_id: "decision-after-reopen",
      type: "decide_blocked_run",
      run_id: runId,
      decision_number: 1,
      decision: { action: "skip" },
    });
    assert.equal(decision.ok, true);

    const reference = await secondHarness.snapshot(workflowRunReferenceDocument, runId, BACKGROUND_CONTEXT);
    assert.ok(reference);
    if (!reference) return;
    const settled = await secondHarness.waitForTask(reference.task_id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") assert.equal(settled.state.outcome.status, "completed");
    const state = await secondHarness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    const action = state?.actions.find((entry) => entry.run_id === runId && entry.decision.action === "skip");
    assert.equal(action?.source, "chat");
  } finally {
    if (firstHarness) await firstHarness.close(BACKGROUND_CONTEXT);
    if (secondHarness) await secondHarness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});


test("service rejects accepting an empty blocked result", async () => {
  const project = createProject("exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const blocked = await waitForRunStatus(service, storage, runId, "blocked");
    assert.ok(isRecord(blocked.blocked_step));
    await assert.rejects(
      service.handleRequest({ request_id: "accept-empty", type: "decide_blocked_run", run_id: runId, decision_number: 1, decision: { action: "accept" } }),
      /empty output/,
    );
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});
test("two concurrent conflicting decisions allow only one winner", async () => {
  const project = createProject("exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start-conflicting", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    await waitForRunStatus(service, storage, runId, "blocked");
    const requests = [
      { request_id: "choose-skip", type: "decide_blocked_run", run_id: runId, decision_number: 1, decision: { action: "skip" } },
      { request_id: "choose-fail", type: "decide_blocked_run", run_id: runId, decision_number: 1, decision: { action: "fail" } },
    ] as const;

    const results = await Promise.allSettled(requests.map((request) => service.handleRequest(request)));
    const winners = results.flatMap((result, index) => result.status === "fulfilled" && result.value.ok ? [{ request: requests[index], response: result.value }] : []);
    assert.equal(winners.length, 1);
    const winner = winners[0];
    assert.ok(winner);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const task = await waitForTask(storage, runId);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") {
      const winningAction = isRecord(winner.response.decision) ? winner.response.decision.action : undefined;
      if (winningAction === "skip") assert.equal(settled.state.outcome.status, "completed");
      else assert.equal(settled.state.outcome.status, "failed");
    }
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.actions.filter((action) => action.run_id === runId && action.source === "chat" &&
      (action.decision.action === "skip" || action.decision.action === "fail")).length, 1);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("decision source is not accepted from service requests", () => {
  assert.throws(() => parseServiceRequest({
    request_id: "forged-source",
    type: "decide_blocked_run",
    run_id: "run-1",
    decision_number: 1,
    decision: { action: "skip" },
    source: "round",
  }), /source/);
});



test("a delayed decision cannot affect a later blocked step in the same run", async () => {
  const project = createProject("printf 'first failure'; exit 7\n", "retries: 0\n");
  writeFileSync(join(project.root, "workflows", "clock", "20-second.sh"), "printf 'second failure'; exit 7\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    await waitForRunStatus(service, storage, runId, "blocked");
    const firstBlocked = await service.handleRequest({ request_id: "first-blocked", type: "read_run", run_id: runId });
    assert.ok(isRecord(firstBlocked.run) && isRecord(firstBlocked.run.blocked_step));
    assert.equal(firstBlocked.run.blocked_step.step, "10-task");
    assert.equal(firstBlocked.run.blocked_step.decision_number, 1);

    const firstDecision = { request_id: "first-decision", type: "decide_blocked_run", run_id: runId, decision_number: 1, decision: { action: "skip" } };
    assert.equal((await service.handleRequest(firstDecision)).ok, true);

    let secondBlocked: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await service.handleRequest({ request_id: `read-second-${attempt}`, type: "read_run", run_id: runId });
      if (isRecord(response.run) && isRecord(response.run.blocked_step) && response.run.blocked_step.step === "20-second" && response.run.blocked_step.decision_number === 2) {
        secondBlocked = response.run;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(secondBlocked, "second step did not block with decision number 2");
    await assert.rejects(
      service.handleRequest({ ...firstDecision, request_id: "delayed-first-decision" }),
      /stale; current decision is 2/,
    );
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("pause and resume update durable workflow state", async () => {
  const project = createProject("printf 'unused'\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const paused = await service.handleRequest({ request_id: "pause", type: "pause_workflow", workflow: "clock" });
    assert.equal(paused.paused, true);
    await assert.rejects(service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" }), /is paused/);
    const listed = await service.handleRequest({ request_id: "list", type: "list_workflows" });
    assert.equal(recordsFrom(listed.workflows)[0]?.paused, true);
    const resumed = await service.handleRequest({ request_id: "resume", type: "resume_workflow", workflow: "clock" });
    assert.equal(resumed.paused, false);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.deepEqual(state?.paused, []);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("scheduled ticks start once per slot and persist max_runs skips", async () => {
  const project = createProject("printf 'scheduled'\n", "max_runs: 1\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const port = await createWorkflowStartPort(harness);
    const now = new Date("2026-11-15T12:00:30.000Z");
    const first = await tickWorkflows({ projectRoot: project.root, port, now });
    assert.deepEqual(first.map(({ kind }) => kind), ["start"]);
    const duplicate = await tickWorkflows({ projectRoot: project.root, port, now });
    assert.deepEqual(duplicate.map(({ kind }) => kind), ["already-indexed"]);
    const nextMinute = await tickWorkflows({ projectRoot: project.root, port, now: new Date("2026-11-15T12:01:30.000Z") });
    assert.deepEqual(nextMinute.map(({ kind, reason }) => [kind, reason]), [["skip", "max_runs reached"]]);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.admissions.length, 2);
    assert.equal(state?.admissions[0]?.outcome, "started");
    assert.equal(state?.admissions[1]?.reason, "max_runs reached");
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});
test("concurrent starts of one workflow slot create one run", async () => {
  const project = createProject("printf 'slot'\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    const port = await createWorkflowStartPort(harness);
    const start = {
      workflowName: "clock",
      projectRoot: project.root,
      port,
      slot: "2026-11-15T12:00:00.000Z",
      at: new Date("2026-11-15T12:00:30.000Z"),
    };
    const results = await Promise.all([startWorkflow(start), startWorkflow(start)]);
    assert.deepEqual(results.map(({ kind }) => kind).sort(), ["already-indexed", "started"]);
    const tasks = await storage.scanTasks({ kind: WORKFLOW_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(tasks.items.filter((task) => isRecord(task.input) && task.input.workflowName === "clock").length, 1);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.admissions.filter((admission) => admission.slot === start.slot).length, 1);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});




test("workflow named constructor keeps its own schedule counters", async () => {
  const project = createProject(":", "enabled: false\n");
  const directory = join(project.root, "workflows", "constructor");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workflow.md"), "---\ncron: '* * * * *'\nmax_runs: 1\n---\nA constructor-named workflow.\n");
  writeFileSync(join(directory, "10-task.sh"), "printf 'constructor'\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const port = await createWorkflowStartPort(harness);
    const first = await tickWorkflows({ projectRoot: project.root, port, now: new Date("2026-11-15T12:00:30.000Z") });
    assert.deepEqual(first.map(({ workflow, kind }) => [workflow, kind]), [["constructor", "start"]]);
    const duplicate = await tickWorkflows({ projectRoot: project.root, port, now: new Date("2026-11-15T12:00:30.000Z") });
    assert.deepEqual(duplicate.map(({ workflow, kind }) => [workflow, kind]), [["constructor", "already-indexed"]]);
    const nextMinute = await tickWorkflows({ projectRoot: project.root, port, now: new Date("2026-11-15T12:01:30.000Z") });
    assert.deepEqual(nextMinute.map(({ workflow, kind, reason }) => [workflow, kind, reason]), [["constructor", "skip", "max_runs reached"]]);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.ok(state);
    assert.equal(Object.hasOwn(state.startedCounts, "constructor"), true);
    assert.equal(state.startedCounts.constructor, 1);
    assert.equal(Object.hasOwn(state.lastSlots, "constructor"), true);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("manual starts count toward later scheduled max_runs decisions", async () => {
  const project = createProject("printf 'manual'\n", "max_runs: 1\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "manual-start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    await harness.waitForTask(task.id, BACKGROUND_CONTEXT);

    const port = await createWorkflowStartPort(harness);
    const results = await tickWorkflows({
      projectRoot: project.root,
      port,
      now: new Date("2026-11-15T12:00:30.000Z"),
    });
    assert.deepEqual(results.map(({ kind, reason }) => [kind, reason]), [["skip", "max_runs reached"]]);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.admissions.length, 2);
    assert.equal(state?.admissions[0]?.slot, null);
    assert.equal(state?.admissions[1]?.outcome, "skipped");
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("later step files are loaded when each step starts", async () => {
  const firstStep = [
    `cat > "$WORKSHOP_PROJECT_ROOT/workflows/clock/20-next.sh" <<'WORKSHOP'`,
    "printf 'fresh output'",
    "WORKSHOP",
    "printf 'first output'",
    "",
  ].join("\n");
  const project = createProject(firstStep);
  const nextStep = join(project.root, "workflows", "clock", "20-next.sh");
  writeFileSync(nextStep, "printf 'old output'\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const task = await waitForTask(storage, runIdFrom(started));
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") {
      assert.equal(settled.state.outcome.status, "completed");
      if (settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result;
        assert.ok(isRecord(result));
        if (isRecord(result)) assert.equal(result.output, "fresh output");
      }
    }
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("submit_chat reuses the configured root conversation through the service", async () => {
  const project = createProject("printf 'unused'\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    (context) => {
      const prompt = transcriptText(context.messages);
      assert.match(prompt, /## Workshop status/);
      assert.match(prompt, /### Active runs/);
      assert.match(prompt, /### Blocked runs/);
      assert.match(prompt, /### Broken workflows/);
      assert.match(prompt, /### Paused workflows/);
      assert.match(prompt, /### Recent actions/);
      return fauxAssistantMessage("First answer.");
    },
    fauxAssistantMessage(fauxToolCall("consult", { question: "Review the loaded workflow." }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Independent advice: the workflow is ready."),
    (context) => {
      assert.match(transcriptText(context.messages), /Independent advice: the workflow is ready/);
      return fauxAssistantMessage("Second answer.");
    },
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request);
      },
    });
    service = createWorkshopService({ projectRoot: project.root, harness });
    harness.resume();
    const first = await service.handleRequest({ request_id: "chat-1", type: "submit_chat", content: "What is running?" });
    const replay = await service.handleRequest({ request_id: "chat-1", type: "submit_chat", content: "What is running?" });
    const second = await service.handleRequest({ request_id: "chat-2", type: "submit_chat", content: "Ask for independent advice about the workflow." });
    const rootConversation = await harness.root(BACKGROUND_CONTEXT);
    const chatSubmissions = await storage.scanSubmissions({ conversationId: rootConversation.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(first.ok, true, JSON.stringify({ first, chatSubmissions: chatSubmissions.items }));
    assert.equal(first.answer, "First answer.");
    assert.deepEqual(replay, first);
    assert.equal(second.ok, true);
    assert.equal(second.answer, "Second answer.");
    assert.equal(first.conversation_id, second.conversation_id);
    assert.ok(chatSubmissions.items.some((submission) => submission.requestId === "chat:chat-1"));
    assert.equal(faux.state.callCount, 4);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("chat pause and resume tools return successful results", async () => {
  const project = createProject("printf 'unused'\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pause_workflow", { workflow: "clock" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Paused the workflow."),
    fauxAssistantMessage(fauxToolCall("resume_workflow", { workflow: "clock" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Resumed the workflow."),
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request);
      },
    });
    service = createWorkshopService({ projectRoot: project.root, harness });
    harness.resume();
    const paused = await service.handleRequest({ request_id: "pause-chat", type: "submit_chat", content: "Pause clock." });
    assert.equal(paused.ok, true);
    assert.equal(paused.answer, "Paused the workflow.");
    const resumed = await service.handleRequest({ request_id: "resume-chat", type: "submit_chat", content: "Resume clock." });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.answer, "Resumed the workflow.");
    const root = await harness.root(BACKGROUND_CONTEXT);
    const context = await root.context(BACKGROUND_CONTEXT);
    const toolResults = context.messages.filter((message) => message.role === "toolResult");
    assert.equal(toolResults.length, 2);
    assert.ok(toolResults.every((message) => message.isError !== true));
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.deepEqual(state?.paused, []);
    assert.deepEqual(state?.actions.map((action) => action.decision.action), ["pause", "resume"]);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("submit_chat keeps the root transcript after reopening SQLite storage", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'unused'\n");
  const stateDirectory = join(project.root, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "workshop.sqlite");
  let firstHarness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let secondHarness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let secondPrompt = "";

  const firstFaux = fauxProvider();
  const firstModels = createModels();
  firstModels.setProvider(firstFaux.provider);
  const firstModel = firstFaux.getModel();
  assert.ok(firstModel);
  firstFaux.setResponses([fauxAssistantMessage("Nothing is running.")]);
  const firstConfiguredModel = {
    model: { provider: firstModel.provider, modelId: firstModel.id },
    thinkingLevel: "medium" as const,
  };

  try {
    let firstService: ReturnType<typeof createWorkshopService> | undefined;
    firstHarness = await openWorkshopHarness(await openNodeSqliteStorage(databasePath), undefined, {
      projectRoot: project.root,
      models: firstModels,
      model: firstConfiguredModel,
      escalationModel: firstConfiguredModel,
      request: async (request) => {
        if (!firstService) throw new Error("Workshop service is not ready");
        return await firstService.handleRequest(request);
      },
    });
    firstService = createWorkshopService({ projectRoot: project.root, harness: firstHarness });
    firstHarness.resume();
    const first = await firstService.handleRequest({ request_id: "before-restart", type: "submit_chat", content: "What is running?" });
    assert.equal(first.ok, true);
    assert.equal(first.answer, "Nothing is running.");
    const firstConversationId = first.conversation_id;
    assert.notEqual(firstConversationId, undefined);
    await firstHarness.close(BACKGROUND_CONTEXT);
    firstHarness = undefined;

    const secondFaux = fauxProvider();
    const secondModels = createModels();
    secondModels.setProvider(secondFaux.provider);
    const secondModel = secondFaux.getModel();
    assert.ok(secondModel);
    assert.equal(secondModel.provider, firstModel.provider);
    assert.equal(secondModel.id, firstModel.id);
    secondFaux.setResponses([(context) => {
      secondPrompt = transcriptText(context.messages);
      return fauxAssistantMessage("You asked what is running.");
    }]);
    const secondConfiguredModel = {
      model: { provider: secondModel.provider, modelId: secondModel.id },
      thinkingLevel: "medium" as const,
    };
    let secondService: ReturnType<typeof createWorkshopService> | undefined;
    secondHarness = await openWorkshopHarness(await openNodeSqliteStorage(databasePath), undefined, {
      projectRoot: project.root,
      models: secondModels,
      model: secondConfiguredModel,
      escalationModel: secondConfiguredModel,
      request: async (request) => {
        if (!secondService) throw new Error("Workshop service is not ready");
        return await secondService.handleRequest(request);
      },
    });
    secondService = createWorkshopService({ projectRoot: project.root, harness: secondHarness });
    secondHarness.resume();
    const secondRoot = await secondHarness.root(BACKGROUND_CONTEXT);
    assert.equal(secondRoot.id, firstConversationId);
    const second = await secondService.handleRequest({ request_id: "after-restart", type: "submit_chat", content: "What did I ask?" });
    assert.equal(second.ok, true);
    assert.equal(second.answer, "You asked what is running.");
    assert.match(secondPrompt, /What is running\?/);
    assert.match(secondPrompt, /Nothing is running\./);
  } finally {
    if (secondHarness) await secondHarness.close(BACKGROUND_CONTEXT);
    if (firstHarness) await firstHarness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("the chat socket streams fake-model text and tool events to multiple watchers", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'unused'\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider({ tokensPerSecond: 12, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_workflows", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Streaming text reaches both attached clients before this answer ends."),
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let socketServer: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  const clients: Socket[] = [];
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request);
      },
    });
    service = createWorkshopService({ projectRoot: project.root, harness });
    harness.resume();
    const socketDirectory = join(project.root, "state");
    mkdirSync(socketDirectory, { recursive: true });
    socketServer = await serveServiceSocket(join(socketDirectory, "service.sock"), async (value, send) => {
      if (!service) throw new Error("Workshop service is not ready");
      const request = parseServiceRequest(value);
      if (request.type === "watch_chat") return await service.watchChat(request.request_id, send);
      send(await service.handleRequest(request));
    });

    const attach = async (watchId: string) => {
      const socket = connect(join(socketDirectory, "service.sock"));
      clients.push(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      const events: Record<string, unknown>[] = [];
      const waiters: { predicate: (event: Record<string, unknown>) => boolean; resolve: (event: Record<string, unknown>) => void }[] = [];
      const waitFor = (predicate: (event: Record<string, unknown>) => boolean) => {
        const existing = events.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise<Record<string, unknown>>((resolveEvent) => waiters.push({ predicate, resolve: resolveEvent }));
      };
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const value: unknown = JSON.parse(line);
          if (isRecord(value)) {
            events.push(value);
            for (let index = waiters.length - 1; index >= 0; index -= 1) {
              const waiter = waiters[index];
              if (waiter && waiter.predicate(value)) {
                waiters.splice(index, 1);
                waiter.resolve(value);
              }
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      const connected = new Promise<void>((resolveConnect, rejectConnect) => {
        socket.once("connect", resolveConnect);
        socket.once("error", rejectConnect);
      });
      const attached = waitFor((event) => event.type === "chat.attached");
      await connected;
      socket.write(`${JSON.stringify({ request_id: watchId, type: "watch_chat" })}\n`);
      await attached;
      return { socket, events, waitFor };
    };

    const first = await attach("watch-one");
    const second = await attach("watch-two");
    const answer = first.waitFor((event) => event.request_id === "chat-stream" && typeof event.answer === "string");
    first.socket.write(`${JSON.stringify({ request_id: "chat-stream", type: "submit_chat", content: "Stream this answer." })}\n`);
    const response = await answer;
    assert.equal(response.ok, true);
    assert.equal(response.answer, "Streaming text reaches both attached clients before this answer ends.");
    await Promise.all([first, second].map((watcher) => watcher.waitFor((event) => event.type === "assistant.final" && event.answer === response.answer)));
    for (const watcher of [first, second]) {
      const calls = watcher.events.filter((event) => event.type === "tool.call");
      const results = watcher.events.filter((event) => event.type === "tool.result");
      const deltas = watcher.events.filter((event) => event.type === "assistant.delta");
      assert.ok(calls.some((event) => event.name === "list_workflows"));
      assert.ok(results.some((event) => event.name === "list_workflows" && event.status === "ok"));
      const streamed = deltas.map((event) => typeof event.text === "string" ? event.text : "").join("");
      assert.ok(response.answer.startsWith(streamed), `streamed ${JSON.stringify(streamed)} before answer ${JSON.stringify(response.answer)}`);
      const finalIndex = watcher.events.findIndex((event) => event.type === "assistant.final" && event.answer === response.answer);
      const deltaIndex = watcher.events.findIndex((event) => event.type === "assistant.delta");
      assert.ok(deltaIndex >= 0 && finalIndex > deltaIndex, "text deltas arrive before the full answer event");
    }
  } finally {
    for (const client of clients) client.destroy();
    if (socketServer) await socketServer.close();
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});


test("the durable failure round records its keyed tool decision once", async () => {
  const project = createProject("printf 'broken'; exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    (context) => {
      const prompt = transcriptText(context.messages);
      const match = /with run_id ([^,]+), decision_number ([0-9]+)/.exec(prompt);
      if (!match?.[1] || !match[2]) throw new Error(`failure prompt omitted run and decision IDs: ${prompt}`);
      return fauxAssistantMessage(fauxToolCall("decide_blocked_run", {
        run_id: "model-selected-another-run",
        decision_number: 999,
        decision: { action: "skip" },
        note: "Skipped after the command failed.",
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("I recorded the skip."),
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request, invocation) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request, invocation);
      },
    });
    service = createWorkshopService({ projectRoot: project.root, harness });
    harness.resume();
    const started = await service.handleRequest({ request_id: "start-round", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") {
      assert.equal(settled.state.outcome.status, "completed");
      if (settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result;
        assert.ok(isRecord(result));
        if (isRecord(result)) {
          assert.equal(result.status, "completed");
          assert.ok(Array.isArray(result.steps));
          if (Array.isArray(result.steps)) {
            assert.ok(isRecord(result.steps[0]));
            if (isRecord(result.steps[0])) assert.equal(result.steps[0].status, "skipped");
          }
        }
      }
    }
    const root = await harness.root(BACKGROUND_CONTEXT);
    const submissions = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(submissions.items.filter((submission) => submission.requestId === `round:${runId}:10-task:1`).length, 1);
    const actions = await service.handleRequest({ request_id: "round-actions", type: "list_actions", limit: 10 });
    const roundAction = recordsFrom(actions.actions).find((action) => action.source === "round");
    assert.ok(roundAction);
    assert.equal(isRecord(roundAction.decision) ? roundAction.decision.action : undefined, "skip");
    assert.equal(roundAction.run_id, runId);
    assert.equal(roundAction.note, "Skipped after the command failed.");
    assert.equal(faux.state.callCount, 2);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a failed retry from the failure round stays blocked for chat", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'still broken'; exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("decide_blocked_run", {
      run_id: "wrong-run",
      decision_number: 999,
      decision: { action: "retry", hint: "Retry once." },
      note: "Retry the blocked step.",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The retry was requested."),
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request, invocation) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request, invocation);
      },
    });
    service = createWorkshopService({ projectRoot: project.root, harness });
    harness.resume();
    const started = await service.handleRequest({ request_id: "start-round-retry", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    let secondBlocked: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const response = await service.handleRequest({ request_id: `read-round-retry-${attempt}`, type: "read_run", run_id: runId });
      if (isRecord(response.run) && isRecord(response.run.blocked_step) && response.run.blocked_step.decision_number === 2) {
        secondBlocked = response.run;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(secondBlocked, "the failed retry should leave decision 2 blocked");
    const root = await harness.root(BACKGROUND_CONTEXT);
    const submissions = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(submissions.items.filter((submission) => submission.requestId?.startsWith(`round:${runId}:`)).map(({ requestId }) => requestId), [
      `round:${runId}:10-task:1`,
    ]);
    const beforeChat = await service.handleRequest({ request_id: "round-retry-actions", type: "list_actions", limit: 20 });
    const roundAction = recordsFrom(beforeChat.actions).find((action) => action.run_id === runId && action.source === "round");
    assert.ok(roundAction);
    assert.equal(isRecord(roundAction.decision) ? roundAction.decision.action : undefined, "retry");

    const decision = await service.handleRequest({
      request_id: "chat-resolves-round-retry",
      type: "decide_blocked_run",
      run_id: runId,
      decision_number: 2,
      decision: { action: "skip" },
    });
    assert.equal(decision.ok, true);
    const task = await waitForTask(storage, runId);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") assert.equal(settled.state.outcome.status, "completed");
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    const decisions = state?.actions.filter((action) => action.run_id === runId && (action.decision.action === "skip" || action.decision.action === "retry"));
    assert.deepEqual(decisions?.map(({ source, decision: choice }) => [source, choice.action]), [["round", "retry"], ["chat", "skip"]]);
    assert.equal(faux.state.callCount, 2);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a chat retry after the failure round does not submit another automatic round", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'still broken'; exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([fauxAssistantMessage("No safe automatic action.")]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request, invocation) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request, invocation);
      },
    });
    service = createWorkshopService({ projectRoot: project.root, harness });
    harness.resume();
    const started = await service.handleRequest({ request_id: "start-chat-retry", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    let gaveUp = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const response = await service.handleRequest({ request_id: `read-give-up-${attempt}`, type: "list_actions", limit: 20 });
      gaveUp = recordsFrom(response.actions).some((action) => action.run_id === runId && action.source === "round" && isRecord(action.decision) && action.decision.action === "give_up");
      if (gaveUp) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(gaveUp, true);
    const firstBlocked = await waitForRunStatus(service, storage, runId, "blocked");
    assert.ok(isRecord(firstBlocked.blocked_step));

    const retried = await service.handleRequest({
      request_id: "retry-from-chat",
      type: "decide_blocked_run",
      run_id: runId,
      decision_number: 1,
      decision: { action: "retry" },
    });
    assert.equal(retried.ok, true);
    let secondBlocked: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const response = await service.handleRequest({ request_id: `read-chat-retry-${attempt}`, type: "read_run", run_id: runId });
      if (isRecord(response.run) && isRecord(response.run.blocked_step) && response.run.blocked_step.decision_number === 2) {
        secondBlocked = response.run;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(secondBlocked, "the chat retry should leave decision 2 blocked");
    const task = await waitForTask(storage, runId);
    assert.ok(isRecord(task.state.checkpoint));
    if (isRecord(task.state.checkpoint)) {
      assert.equal(task.state.checkpoint.phase, "blocked");
      assert.equal(task.state.checkpoint.roundStatus, "settled");
      assert.equal(task.state.checkpoint.automaticRoundUsed, true);
    }
    const root = await harness.root(BACKGROUND_CONTEXT);
    const submissions = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(submissions.items.filter((submission) => submission.requestId?.startsWith(`round:${runId}:`)).map(({ requestId }) => requestId), [
      `round:${runId}:10-task:1`,
    ]);

    const skipped = await service.handleRequest({
      request_id: "skip-after-chat-retry",
      type: "decide_blocked_run",
      run_id: runId,
      decision_number: 2,
      decision: { action: "skip" },
    });
    assert.equal(skipped.ok, true);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    assert.equal(faux.state.callCount, 1);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});
