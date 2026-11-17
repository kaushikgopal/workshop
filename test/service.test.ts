import { execFileSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineDoc, Harness, MemoryStorage, type Storage, type TaskRecord, type Wake } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { test } from "node:test";
import { createWorkflowStartPort, startWorkflow } from "../run/start-workflow.ts";
import { maxWorkshopHistoryRecords, workshopStateDocument, workflowRunReferenceDocument, type MutationReceipt, type WorkshopAction, type WorkflowAdmission } from "../workflow/define-workshop-state.ts";
import { createWorkshopService } from "../service/create-workshop-service.ts";
import { openWorkshopHarness } from "../service/open-workshop-harness.ts";
import { serveServiceSocket } from "../service/serve-service-socket.ts";
import { parseServiceRequest } from "../service/types.ts";
import { tickWorkflows } from "../schedule/tick-workflows.ts";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { createStepAttemptTask, STEP_ATTEMPT_TASK_NAME, type StepAttemptTaskInput } from "../workflow/define-step-attempt-task.ts";
import * as workflowStepLoader from "../workflow/load-workflow-step.ts";
import { WorkflowTask, WORKFLOW_TASK_NAME, workflowDecisionDocument, type WorkflowTaskCheckpoint, type WorkflowTaskInput } from "../workflow/define-workflow-task.ts";

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

function createHarness(
  storage: Storage,
  options: { now?: () => number; onWake?: (wake: Wake) => void; includeStepAttemptTask?: boolean } = {},
) {
  const { includeStepAttemptTask = true, ...harnessOptions } = options;
  const registry = createRegistry();
  const tasks = includeStepAttemptTask ? [WorkflowTask, createStepAttemptTask(executeWorkflowProcess)] : [WorkflowTask];
  registry.install({ name: "workshop", tasks });
  return Harness.open(storage, { models: createModels(), registry, ...harnessOptions }, BACKGROUND_CONTEXT);
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

async function waitForChildAttempt(
  storage: Storage,
  parentId: TaskRecord<JsonValue, JsonValue, JsonValue>["id"],
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await storage.scanTasks({ kind: STEP_ATTEMPT_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT);
    const found = page.items.find((record) => String(record.owner) === String(parentId));
    if (found) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Step-attempt child for ${parentId} was not created`);
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

async function waitForFailureEvidence(
  storage: Storage,
  harness: Awaited<ReturnType<typeof createHarness>>,
  runId: string,
  attempt = 1,
): Promise<string> {
  const root = await harness.root(BACKGROUND_CONTEXT);
  const requestId = `round:${runId}:10-task:${attempt}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, BACKGROUND_CONTEXT);
    if (page.items.some((submission) => submission.requestId === requestId)) {
      const context = await root.context(BACKGROUND_CONTEXT);
      const transcript = transcriptText(context.messages);
      if (transcript.includes("## Attempt history")) return transcript;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Failure evidence for ${requestId} was not submitted`);
}

function runIdFrom(response: Record<string, unknown>): string {
  assert.equal(response.ok, true);
  assert.equal(typeof response.run_id, "string");
  if (typeof response.run_id !== "string") throw new Error("Service response has no run ID");
  return response.run_id;
}


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
    const listedRun = recordsFrom(listed.runs).find((run) => run.run_id === runId);
    assert.ok(listedRun);
    assert.equal(typeof listedRun?.phase, "string");
    assert.equal(typeof listedRun?.status_message, "string");
    assert.ok(Array.isArray(listedRun?.allowed_actions));
    const reading = await service.handleRequest({ request_id: "read", type: "read_run", run_id: runId });
    assert.ok(isRecord(reading.run));
    assert.ok(["running", "blocked"].includes(String(reading.run.status)));
    assert.equal(typeof reading.run.phase, "string");
    assert.equal(typeof reading.run.status_message, "string");
    assert.ok(Array.isArray(reading.run.allowed_actions));
    if (Array.isArray(reading.run.allowed_actions)) assert.ok(reading.run.allowed_actions.includes("cancel_run"));

    const cancelRequest = { request_id: "cancel", type: "cancel_run", run_id: runId };
    const abort = harness.abortTask.bind(harness);
    harness.abortTask = async () => { throw new Error("simulated crash before abort"); };
    const beforeAbortFailure = await service.handleRequest(cancelRequest);
    assert.equal(beforeAbortFailure.ok, false);
    assert.equal(beforeAbortFailure.error_code, "mutation_failed");
    assert.match(String(beforeAbortFailure.error), /simulated crash before abort/);
    const beforeRetry = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(beforeRetry?.receipts.some((receipt) => receipt.request_id === "cancel"), false);
    assert.equal(beforeRetry?.actions.some((action) => action.decision.action === "cancel"), false);
    harness.abortTask = async (taskId, context) => {
      await abort(taskId, context);
      throw new Error("simulated crash after abort");
    };
    const afterAbortFailure = await service.handleRequest(cancelRequest);
    assert.equal(afterAbortFailure.ok, false);
    assert.equal(afterAbortFailure.error_code, "mutation_failed");
    assert.match(String(afterAbortFailure.error), /simulated crash after abort/);
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
test("different workflows progress while one run waits on a marker", { timeout: 20_000 }, async () => {
  const command = [
    `mkdir -p "$WORKSHOP_DATA_DIR"`,
    `printf started > "$WORKSHOP_DATA_DIR/started"`,
    `while [ ! -f "$WORKSHOP_DATA_DIR/release" ]; do sleep 0.01; done`,
    `printf '%s' "$WORKSHOP_WORKFLOW"`,
    "",
  ].join("\n");
  const project = createProject(command);
  const otherWorkflow = join(project.root, "workflows", "news");
  mkdirSync(otherWorkflow, { recursive: true });
  writeFileSync(join(otherWorkflow, "workflow.md"), "---\ncron: '* * * * *'\n---\nA second service test workflow.\n");
  writeFileSync(join(otherWorkflow, "10-task.sh"), command);
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const start = async (requestId: string, workflow: string) => {
      const response = await service.handleRequest({ request_id: requestId, type: "start_workflow", workflow });
      const runId = runIdFrom(response);
      await waitForFile(join(project.root, "data", workflow, "started"));
      return runId;
    };
    const clockRun = await start("start-clock", "clock");
    const newsRun = await start("start-news", "news");

    const active = await service.handleRequest({ request_id: "active-runs", type: "list_runs", limit: 10 });
    assert.equal(active.ok, true);
    const activeWorkflows = recordsFrom(active.runs)
      .filter((run) => run.workflow === "clock" || run.workflow === "news")
      .map((run) => [run.workflow, run.status]);
    assert.deepEqual(activeWorkflows.sort(), [["clock", "running"], ["news", "running"]]);

    writeFileSync(join(project.root, "data", "clock", "release"), "release");
    await waitForRunStatus(service, storage, clockRun, "completed");
    const newsStillRunning = await service.handleRequest({ request_id: "news-still-running", type: "read_run", run_id: newsRun });
    assert.ok(isRecord(newsStillRunning.run));
    assert.equal(newsStillRunning.run.status, "running");

    writeFileSync(join(project.root, "data", "news", "release"), "release");
    await waitForRunStatus(service, storage, newsRun, "completed");
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});



test("receipt namespace gate serializes a cancellation against a colliding pause", async () => {
  const project = createProject(`printf started > "$WORKSHOP_DATA_DIR/started"\nsleep 30\n`);
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    await waitForFile(join(project.root, "data", "clock", "started"));
    const abort = harness.abortTask.bind(harness);
    let enterAbort!: () => void;
    let releaseAbort!: () => void;
    const abortEntered = new Promise<void>((resolveEntered) => { enterAbort = resolveEntered; });
    const abortBarrier = new Promise<void>((resolveBarrier) => { releaseAbort = resolveBarrier; });
    harness.abortTask = async (taskId, context) => {
      enterAbort();
      await abortBarrier;
      return await abort(taskId, context);
    };

    const cancellation = service.handleRequest({ request_id: "shared-id", type: "cancel_run", run_id: runId });
    await abortEntered;
    let pauseFinished = false;
    const pause = service.handleRequest({ request_id: "shared-id", type: "pause_workflow", workflow: "clock" })
      .finally(() => { pauseFinished = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    assert.equal(pauseFinished, false, "the pause must wait behind cancellation's receipt gate");
    releaseAbort();
    const [cancelResponse, pauseResponse] = await Promise.all([cancellation, pause]);
    assert.equal(cancelResponse.ok, true);
    assert.equal(cancelResponse.cancelled, true);
    assert.equal(pauseResponse.ok, false);
    assert.equal(pauseResponse.error_code, "request_id_conflict");
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.actions.filter((action) => action.decision.action === "cancel").length, 1);
    assert.equal(state?.actions.some((action) => action.decision.action === "pause"), false);
    assert.equal(state?.paused.includes("clock"), false);
    assert.ok(task);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a new cancellation of a terminal-cancelled run reports cancelled false", async () => {
  const project = createProject(`printf started > "$WORKSHOP_DATA_DIR/started"\nsleep 30\n`);
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    await waitForFile(join(project.root, "data", "clock", "started"));
    const first = await service.handleRequest({ request_id: "cancel-first", type: "cancel_run", run_id: runId });
    assert.equal(first.cancelled, true);
    await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    const secondRequest = { request_id: "cancel-terminal", type: "cancel_run", run_id: runId };
    const second = await service.handleRequest(secondRequest);
    assert.equal(second.ok, true);
    assert.equal(second.cancelled, false);
    assert.equal(second.status, "cancelled");
    assert.deepEqual(await service.handleRequest(secondRequest), second);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.actions.filter((action) => action.run_id === runId && action.decision.action === "cancel").length, 1);
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
    assert.ok(Array.isArray(blocked.allowed_actions));
    assert.ok(Array.isArray(blocked.blocked_step.allowed_actions));
    assert.deepEqual(blocked.blocked_step.retry_profiles, []);
    const decisionNumber = blocked.blocked_step.decision_number;

    const request = { request_id: "decision", type: "decide_blocked_run", run_id: runId, decision_number: decisionNumber, decision: { action: "skip" } };
    const decision = await service.handleRequest(request);
    assert.equal(decision.ok, true);
    assert.deepEqual(await service.handleRequest(request), decision);
    const conflict = await service.handleRequest({ ...request, decision: { action: "fail" } });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error_code, "request_id_conflict");
    assert.match(String(conflict.error), /already used for a different request/);

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

test("invalid workflow checkpoints keep their integrity error in run reads", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'unused'\\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    const root = await harness.root(BACKGROUND_CONTEXT);
    const runId = "integrity-run";
    const workflow = {
      name: "clock",
      directory: join(project.root, "workflows", "clock"),
      cron: "* * * * *",
      description: "Invalid checkpoint test.",
      steps: [],
    };
    const taskId = await root.commit(async (tx) => {
      const task = await tx.createTask(WorkflowTask, {
        runId,
        workflowName: "clock",
        startedAt: new Date().toISOString(),
        slot: null,
        projectRoot: project.root,
        dataDirectory: join(project.root, "data", "clock"),
        stateDirectory: join(project.root, "state"),
        workflow,
        profileCommands: { writer: [process.execPath] },
      }, { ownership: { kind: "conversation" }, conversationId: root.id });
      await tx.doc(workflowRunReferenceDocument, runId, {
        run_id: runId, task_id: task, workflow: "clock", slot: null, started_at: new Date().toISOString(),
      });
      return task;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") assert.equal(settled.state.outcome.status, "faulted");
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const reading = await service.handleRequest({ request_id: "read-integrity", type: "read_run", run_id: runId });
    assert.ok(isRecord(reading.run));
    assert.equal(reading.run.status, "faulted");
    assert.match(String(reading.run.error), /Workflow checkpoint integrity error at input\.workflow\.steps/);
    assert.match(String(reading.run.status_message), /Workflow checkpoint integrity error at input\.workflow\.steps/);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("terminal failures retain prior step receipts on read", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'prior-output'\n", "retries: 0\n");
  writeFileSync(join(project.root, "workflows", "clock", "20-last.sh"), "printf 'failed-output'; exit 7\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    await waitForRunStatus(service, storage, runId, "blocked");
    const decision = await service.handleRequest({
      request_id: "fail-blocked", type: "decide_blocked_run", run_id: runId, decision_number: 1, decision: { action: "fail" },
    });
    assert.equal(decision.ok, true);
    const task = await waitForTask(storage, runId);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") assert.equal(settled.state.outcome.status, "failed");
    const reading = await service.handleRequest({ request_id: "read-failed", type: "read_run", run_id: runId });
    assert.ok(isRecord(reading.run));
    assert.equal(reading.run.status, "failed");
    assert.match(String(reading.run.error), /^20-last failed: 20-last failed with exit code 7/);
    assert.ok(Array.isArray(reading.run.steps));
    if (Array.isArray(reading.run.steps)) {
      assert.equal(reading.run.steps.length, 1);
      assert.ok(isRecord(reading.run.steps[0]));
      if (isRecord(reading.run.steps[0])) {
        assert.equal(reading.run.steps[0].step, "10-task");
        assert.equal(reading.run.steps[0].output, "prior-output");
      }
    }
    assert.equal(reading.run.output, "prior-output");
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("terminal cancellations retain prior step receipts on read", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'prior-output'\n");
  writeFileSync(join(project.root, "workflows", "clock", "20-wait.sh"), `printf started > "$WORKSHOP_DATA_DIR/started"\nsleep 30\n`);
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    await waitForFile(join(project.root, "data", "clock", "started"));
    const cancelled = await service.handleRequest({ request_id: "cancel", type: "cancel_run", run_id: runId });
    assert.equal(cancelled.cancelled, true);
    const task = await waitForTask(storage, runId);
    await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    const reading = await service.handleRequest({ request_id: "read-cancelled", type: "read_run", run_id: runId });
    assert.ok(isRecord(reading.run));
    assert.equal(reading.run.status, "cancelled");
    assert.ok(Array.isArray(reading.run.steps));
    if (Array.isArray(reading.run.steps)) {
      assert.equal(reading.run.steps.length, 1);
      assert.ok(isRecord(reading.run.steps[0]));
      if (isRecord(reading.run.steps[0])) assert.equal(reading.run.steps[0].output, "prior-output");
    }
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


test("saved workflow decisions reject stale and missing numbers and empty accepts", { timeout: 30_000 }, async (t) => {
  for (const fixture of [
    { name: "stale number", decisionNumber: 0, useCurrentNumber: false, decision: { action: "skip" as const }, error: /Decision changed or became stale/ },
    { name: "missing number", decisionNumber: undefined, useCurrentNumber: false, decision: { action: "skip" as const }, error: /Decision changed or became stale/ },
    { name: "empty accept", decisionNumber: undefined, useCurrentNumber: true, decision: { action: "accept" as const }, error: /Cannot accept a blocked step with empty output/ },
  ]) {
    await t.test(fixture.name, async () => {
      const project = createProject("exit 7\n", "retries: 0\n");
      const storage = new MemoryStorage();
      let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
      try {
        harness = await createHarness(storage);
        harness.resume();
        const service = createWorkshopService({ projectRoot: project.root, harness });
        const started = await service.handleRequest({ request_id: `start-${fixture.name}`, type: "start_workflow", workflow: "clock" });
        const runId = runIdFrom(started);
        const task = await waitForTask(storage, runId);
        const blocked = await waitForRunStatus(service, storage, runId, "blocked");
        assert.ok(isRecord(blocked.blocked_step));
        assert.equal(typeof blocked.blocked_step.decision_number, "number");
        if (typeof blocked.blocked_step.decision_number !== "number") throw new Error("Blocked run has no decision number");
        const savedNumber = fixture.useCurrentNumber ? blocked.blocked_step.decision_number : fixture.decisionNumber;
        await harness.commit(async (tx) => {
          const document = await tx.doc(workflowDecisionDocument, task.id);
          document.choice = {
            requestId: `saved-${fixture.name}`,
            ...(savedNumber === undefined ? {} : { decisionNumber: savedNumber }),
            decision: fixture.decision,
            source: "chat",
          };
          return true;
        }, BACKGROUND_CONTEXT);
        const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
        if (settled.state.status !== "terminal") throw new Error("Saved decision did not settle the workflow task");
        assert.equal(settled.state.outcome.status, "faulted");
        if (settled.state.outcome.status !== "faulted") throw new Error("Invalid saved decision did not fault the workflow task");
        assert.match(settled.state.outcome.error.message, fixture.error);
      } finally {
        if (harness) await harness.close(BACKGROUND_CONTEXT);
        rmSync(project.root, { recursive: true, force: true });
      }
    });
  }
});

test("source-less retry resumes a numbered old SQLite checkpoint without replaying a failure round", { timeout: 30_000 }, async () => {
  const project = createProject("exit 7\n", "retries: 0\n");
  const stateDirectory = join(project.root, "state");
  const dataDirectory = join(project.root, "data", "clock");
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(project.root, "workflows", "clock", "10-task.sh"), `printf x >> "$WORKSHOP_PROJECT_ROOT/attempts"\nprintf 'retry failed'; exit 7\n`);
  const databasePath = join(stateDirectory, "workshop.sqlite");
  const attemptFile = join(project.root, "attempts");
  const firstAttempt = { attempt: 1, output: "first failure", error: "10-task failed with exit code 7: first failure" };
  const history = [firstAttempt];
  const workflow = {
    name: "clock",
    directory: "clock",
    cron: "* * * * *",
    description: "Historical blocked workflow fixture.",
    retries: 0,
    steps: [{ kind: "command" as const, file: "10-task.sh", number: 10, name: "task" }],
  };
  const input: WorkflowTaskInput = {
    runId: "legacy-run",
    workflowName: "clock",
    startedAt: new Date(0).toISOString(),
    slot: null,
    projectRoot: project.root,
    dataDirectory,
    stateDirectory,
    workflow,
    profileCommands: { writer: [process.execPath] },
  };
  const failure = {
    workflow: "clock",
    runId: input.runId,
    step: "10-task",
    stepKind: "command" as const,
    retryProfiles: [],
    lastError: firstAttempt.error,
    lastOutput: firstAttempt.output,
    attemptHistory: history,
    decisionNumber: 1,
  };
  const checkpoint: WorkflowTaskCheckpoint = {
    phase: "blocked",
    stepIndex: 0,
    pipeInput: "",
    results: [],
    attemptHistory: history,
    localRetriesLeft: 0,
    feedback: "",
    decisionNumber: 1,
    automaticRoundUsed: true,
    failure,
  };
  assert.equal("roundStatus" in checkpoint, false);
  let firstStorage: Storage | undefined;
  let secondStorage: Storage | undefined;
  let firstHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let secondHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    firstStorage = await openNodeSqliteStorage(databasePath);
    firstHarness = await createHarness(firstStorage);
    const root = await firstHarness.root(BACKGROUND_CONTEXT);
    const taskId = await firstHarness.commit(async (tx) => {
      const created = await tx.createTask(WorkflowTask, input, { ownership: { kind: "conversation" }, conversationId: root.id });
      const decision = await tx.doc(workflowDecisionDocument, created);
      decision.choice = { requestId: "legacy-retry", decisionNumber: 1, decision: { action: "retry", hint: "Retry the saved failure." } };
      return created;
    }, BACKGROUND_CONTEXT);
    const createdTask = await firstStorage.task(taskId, BACKGROUND_CONTEXT);
    assert.ok(createdTask);
    if (!createdTask) throw new Error("Historical workflow task was not saved");
    const saved = await firstStorage.commit(
      [[{ type: "task", value: { ...createdTask, state: { status: "pending", checkpoint } } }]],
      () => {},
      BACKGROUND_CONTEXT,
    );
    assert.equal(saved.stored, 1);
    assert.equal(saved.refused, undefined);
    const oldTask = await firstStorage.task(taskId, BACKGROUND_CONTEXT);
    assert.ok(oldTask);
    if (!oldTask) throw new Error("Historical workflow checkpoint was not saved");
    assert.equal(oldTask.version, 3);
    assert.ok(isRecord(oldTask.state));
    assert.ok(isRecord(oldTask.state.checkpoint));
    assert.equal(oldTask.state.checkpoint.phase, "blocked");
    assert.equal("roundStatus" in oldTask.state.checkpoint, false);
    await firstHarness.close(BACKGROUND_CONTEXT);
    firstHarness = undefined;
    firstStorage = undefined;

    secondStorage = await openNodeSqliteStorage(databasePath);
    secondHarness = await createHarness(secondStorage);
    secondHarness.resume();
    let resumedTask: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await secondStorage.task(taskId, BACKGROUND_CONTEXT);
      assert.ok(current);
      if (!current) throw new Error("Historical workflow task disappeared");
      resumedTask = current;
      const currentCheckpoint = current.state.checkpoint;
      if (current.state.status === "running" && isRecord(currentCheckpoint) && currentCheckpoint.phase === "blocked" && currentCheckpoint.decisionNumber === 2) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(resumedTask);
    assert.equal(resumedTask.state.status, "running");
    if (resumedTask.state.status !== "running") throw new Error("Retry did not return to a running checkpoint");
    const resumedCheckpoint = resumedTask.state.checkpoint;
    assert.ok(isRecord(resumedCheckpoint));
    if (!isRecord(resumedCheckpoint)) throw new Error("Retry checkpoint is invalid");
    assert.equal(resumedCheckpoint.phase, "blocked");
    if (resumedCheckpoint.phase !== "blocked") throw new Error("Retry did not block after attempt 2");
    assert.ok(isRecord(resumedCheckpoint.failure));
    if (!isRecord(resumedCheckpoint.failure)) throw new Error("Blocked failure is invalid");
    assert.equal(resumedCheckpoint.failure.decisionNumber, 2);
    assert.ok(Array.isArray(resumedCheckpoint.attemptHistory));
    if (!Array.isArray(resumedCheckpoint.attemptHistory)) throw new Error("Attempt history is invalid");
    assert.deepEqual(resumedCheckpoint.attemptHistory.map((entry) => isRecord(entry) ? entry.attempt : null), [1, 2]);
    assert.equal(readFileSync(attemptFile, "utf8"), "x");
    const submissions = await secondStorage.scanSubmissions({ conversationId: root.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(submissions.items.map((submission) => submission.requestId), []);
  } finally {
    if (secondHarness) await secondHarness.close(BACKGROUND_CONTEXT);
    else if (secondStorage) await secondStorage.close(BACKGROUND_CONTEXT);
    if (firstHarness) await firstHarness.close(BACKGROUND_CONTEXT);
    else if (firstStorage) await firstStorage.close(BACKGROUND_CONTEXT);
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
    const rejected = await service.handleRequest({ request_id: "accept-empty", type: "decide_blocked_run", run_id: runId, decision_number: 1, decision: { action: "accept" } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error_code, "empty_output");
    assert.match(String(rejected.error), /empty output/);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});
test("a blocked decision is rejected after cancellation is requested", async () => {
  const project = createProject("exit 7\n", "retries: 0\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    await waitForRunStatus(service, storage, runId, "blocked");
    assert.equal(await harness.abortTask(task.id, BACKGROUND_CONTEXT), "marked");
    await harness.waitForTask(task.id, BACKGROUND_CONTEXT);

    const decision = await service.handleRequest({
      request_id: "decision-during-cancel",
      type: "decide_blocked_run",
      run_id: runId,
      decision_number: 1,
      decision: { action: "skip" },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.error_code, "cancellation_in_progress", JSON.stringify(decision));
    assert.match(String(decision.error), /cancellation/i);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.receipts.some((receipt) => receipt.request_id === "decision-during-cancel"), false);
    assert.equal(state?.actions.some((action) => action.run_id === runId && action.decision.action === "skip"), false);
    const mailbox = await harness.snapshot(workflowDecisionDocument, task.id, BACKGROUND_CONTEXT);
    assert.equal(mailbox?.choice ?? null, null);
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
    const rejected = results.filter((result) => result.status === "fulfilled" && !result.value.ok);
    assert.equal(rejected.length, 1);
    if (rejected[0]?.status === "fulfilled") assert.equal(rejected[0].value.error_code, "choice_already_recorded");
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
    const rejected = await service.handleRequest({ ...firstDecision, request_id: "delayed-first-decision" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error_code, "stale_decision");
    assert.match(String(rejected.error), /stale; current decision is 2/);
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
    const repeatedPause = await service.handleRequest({ request_id: "pause-again", type: "pause_workflow", workflow: "clock" });
    assert.equal(repeatedPause.paused, true);
    assert.deepEqual(repeatedPause.paused_workflows, ["clock"]);
    const denied = await service.handleRequest({ request_id: "start", type: "start_workflow", workflow: "clock" });
    assert.equal(denied.ok, false);
    assert.equal(denied.error_code, "mutation_failed");
    assert.match(String(denied.error), /is paused/);
    const listed = await service.handleRequest({ request_id: "list", type: "list_workflows" });
    assert.equal(recordsFrom(listed.workflows)[0]?.paused, true);
    const resumed = await service.handleRequest({ request_id: "resume", type: "resume_workflow", workflow: "clock" });
    assert.equal(resumed.paused, false);
    const repeatedResume = await service.handleRequest({ request_id: "resume-again", type: "resume_workflow", workflow: "clock" });
    assert.equal(repeatedResume.paused, false);
    assert.deepEqual(repeatedResume.paused_workflows, []);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.deepEqual(state?.paused, []);
    assert.equal(state?.actions.filter((action) => action.decision.action === "pause").length, 1);
    assert.equal(state?.actions.filter((action) => action.decision.action === "resume").length, 1);
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

test("step loader classifies expected failures and preserves path defects", () => {
  const project = createProject("");
  const root = join(project.root, "workflows");
  const workflow = { name: "clock", directory: "clock", cron: "* * * * *", description: "Test.", steps: [] };
  const load = (file: string, kind: "command" | "agent") =>
    workflowStepLoader.loadWorkflowStep(root, workflow, { kind, file, number: 20, name: "next" });

  try {
    const expectedFailures = [
      ["20-missing.sh", "command", null, "ENOENT"],
      ["20-incomplete.md", "agent", "---\nprofile: writer\nprompt without closing delimiter", "missing or incomplete YAML frontmatter"],
      ["20-empty.md", "agent", "---\nprofile: writer\n---\n  \n", "step content must not be empty"],
    ] as const;
    for (const [file, kind, contents, message] of expectedFailures) {
      if (contents !== null) writeFileSync(join(root, "clock", file), contents);
      assert.throws(() => load(file, kind), (error: unknown) =>
        error instanceof workflowStepLoader.WorkflowStepLoadError && error.message.includes(message), file);
    }
    const pathFailure = new TypeError("invalid workflow path");
    const invalidWorkflow = { ...workflow, get directory(): string { throw pathFailure; } };
    assert.throws(() => workflowStepLoader.loadWorkflowStep(root, invalidWorkflow, {
      kind: "command", file: "20-next.sh", number: 20, name: "next",
    }), (error: unknown) => error === pathFailure);
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("agent prompt and failure brief share one raw step-file read", () => {
  const project = createProject("");
  const stepFile = join(project.root, "workflows", "clock", "20-next.md");
  const original = "\uFEFF---\r\nprofile: writer\r\n...\r\nOriginal agent prompt.\r\n";
  const replacement = "\uFEFF---\r\nprofile: writer\r\n...\r\nReplacement agent prompt.\r\n";
  writeFileSync(stepFile, original);
  const script = [
    `import fs from "node:fs";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `const file = ${JSON.stringify(stepFile)};`,
    `const originalReadFileSync = fs.readFileSync;`,
    `let reads = 0;`,
    `fs.readFileSync = function (path, options) {`,
    `  const source = originalReadFileSync.call(this, path, options);`,
    `  if (String(path) === file) {`,
    `    reads += 1;`,
    `    if (reads === 1) fs.writeFileSync(file, ${JSON.stringify(replacement)});`,
    `  }`,
    `  return source;`,
    `};`,
    `syncBuiltinESMExports();`,
    `try {`,
    `const { loadWorkflowStep } = await import(${JSON.stringify(new URL("../workflow/load-workflow-step.ts", import.meta.url).href)});`,
    `const { executeWorkflowAttempt } = await import(${JSON.stringify(new URL("../workflow/execute-workflow-attempt.ts", import.meta.url).href)});`,
    `const { buildOrchestratorBrief } = await import(${JSON.stringify(new URL("../workflow/build-orchestrator-brief.ts", import.meta.url).href)});`,
    `const workflow = { name: "clock", directory: "clock", cron: "* * * * *", description: "Test.", steps: [] };`,
    `const step = { kind: "agent", file: "20-next.md", number: 20, name: "next", profile: "writer" };`,
    `const loaded = loadWorkflowStep(${JSON.stringify(join(project.root, "workflows"))}, workflow, step);`,
    `let agentPrompt;`,
    `await executeWorkflowAttempt({ workflow, documents: loaded.documents, files: loaded.files, profileCommands: { writer: ["fake"] }, executeProcess: async ({ input }) => { agentPrompt = input; return { exitCode: 0, stdout: "draft", stderr: "", timedOut: false }; } }, { step, profile: "writer", pipeInput: "", feedback: "", attempt: 1 });`,
    `const stepContent = loaded.stepContent`,
    `const brief = buildOrchestratorBrief({ workflow, step, stepId: "20-next", runId: "run-1", decisionNumber: 1, stepContent, lastOutput: "draft", lastError: "failed", attemptHistory: [], allowedRetryProfiles: [] });`,
    `process.stdout.write(JSON.stringify({ reads, stepContent, agentPrompt, brief: brief.prompt }));`,
    `} finally {`,
    `  fs.readFileSync = originalReadFileSync;`,
    `  syncBuiltinESMExports();`,
    `}`,
  ].join("\n");

  try {
    const output: unknown = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 }));
    assert.ok(isRecord(output));
    if (!isRecord(output)) return;
    assert.equal(output.reads, 1);
    assert.equal(output.stepContent, original);
    assert.equal(output.agentPrompt, "Original agent prompt.");
    assert.equal(typeof output.brief, "string");
    if (typeof output.brief === "string") {
      assert.ok(output.brief.includes(original));
      assert.doesNotMatch(output.brief, /Replacement agent prompt\./);
    }
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("admitted missing step retries and blocks with saved input", { timeout: 10_000 }, async () => {
  const firstStep = [
    `mv "$WORKSHOP_PROJECT_ROOT/workflows/clock/20-next.sh" "$WORKSHOP_DATA_DIR/20-next.sh"`,
    "printf 'first output'",
    "",
  ].join("\n");
  const project = createProject(firstStep, "retries: 1\n");
  writeFileSync(join(project.root, "workflows", "clock", "20-next.sh"), "printf 'unreachable output'\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start-missing-step", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    let settled = task;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await storage.task(task.id, BACKGROUND_CONTEXT);
      assert.ok(current);
      settled = current;
      const checkpoint = current.state.checkpoint;
      if (current.state.status === "terminal" ||
        (isRecord(checkpoint) && checkpoint.phase === "blocked" && checkpoint.roundStatus === "settled")) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(settled.state.status, "running", JSON.stringify(settled.state));
    const checkpoint = settled.state.checkpoint;
    assert.ok(isRecord(checkpoint));
    assert.equal(checkpoint.phase, "blocked");
    assert.equal(checkpoint.roundStatus, "settled");
    assert.equal(checkpoint.localRetriesLeft, 0);
    assert.equal(checkpoint.pipeInput, "first output");
    assert.ok(Array.isArray(checkpoint.attemptHistory));
    const history = checkpoint.attemptHistory;
    assert.deepEqual(history.map((entry) => isRecord(entry) ? [entry.attempt, entry.output] : null), [[1, ""], [2, ""]]);
    assert.ok(history.every((entry) => isRecord(entry) && typeof entry.error === "string" && entry.error.includes("ENOENT")));

    const rootConversation = await harness.root(BACKGROUND_CONTEXT);
    const submissions = await storage.scanSubmissions({ conversationId: rootConversation.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(submissions.items.map(({ requestId }) => requestId), [`round:${runId}:20-next:2`]);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.ok(state?.actions.some((action) => action.run_id === runId && action.step === "20-next" &&
      action.source === "round" && action.decision.action === "give_up"));
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("unexpected step load errors during failure-brief building still fault the task", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'failed'; exit 7\n", "retries: 0\n");
  const stateDirectory = join(project.root, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "workshop.sqlite");
  let seedStorage: Storage | undefined;
  let seedHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    seedStorage = await openNodeSqliteStorage(databasePath);
    seedHarness = await createHarness(seedStorage);
    const port = await createWorkflowStartPort(seedHarness);
    const started = await startWorkflow({
      projectRoot: project.root,
      workflowName: "clock",
      port,
      at: new Date("2026-11-16T12:00:00.000Z"),
    });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") throw new Error("Workflow did not start");
    const task = await waitForTask(seedStorage, started.run_id);
    const input = structuredClone(task.input);
    assert.ok(isRecord(input));
    assert.ok(isRecord(input.workflow));
    assert.ok(Array.isArray(input.workflow.steps));
    const step = input.workflow.steps[0];
    assert.ok(isRecord(step));
    step.file = 42;
    const attemptHistory = [{ attempt: 1, output: "failed", error: "command exited with status 7" }];
    const checkpoint: JsonValue = {
      phase: "blocked",
      stepIndex: 0,
      pipeInput: "",
      results: [],
      attemptHistory,
      localRetriesLeft: 0,
      feedback: "",
      decisionNumber: 1,
      automaticRoundUsed: true,
      failure: {
        workflow: "clock",
        runId: started.run_id,
        step: "10-task",
        stepKind: "command",
        retryProfiles: [],
        lastError: "command exited with status 7",
        lastOutput: "failed",
        attemptHistory,
        decisionNumber: 1,
      },
      roundStatus: "pending",
    };
    const seededTask: TaskRecord<JsonValue, JsonValue, JsonValue> = {
      ...task,
      input,
      state: { status: "pending", checkpoint },
    };
    const stored = await seedStorage.commit(
      [[{ type: "task", value: seededTask }]],
      () => {},
      BACKGROUND_CONTEXT,
    );
    assert.equal(stored.stored, 1);
    assert.equal(stored.refused, undefined);

    await seedHarness.close(BACKGROUND_CONTEXT);
    seedHarness = undefined;
    seedStorage = undefined;
    harness = await createHarness(await openNodeSqliteStorage(databasePath));
    harness.resume();
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status !== "terminal") throw new Error("Blocked workflow task did not settle");
    assert.equal(settled.state.outcome.status, "faulted");
    if (settled.state.outcome.status !== "faulted") throw new Error("Unexpected failure-brief error did not fault the task");
    assert.match(settled.state.outcome.error.message, /invalid argument|must be of type|path/i);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    if (seedHarness) await seedHarness.close(BACKGROUND_CONTEXT);
    else if (seedStorage) await seedStorage.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("durable retries send check feedback to the worker and keep the accepted worker output", async () => {
  const project = createProject("", "retries: 1\n");
  const workflowDirectory = join(project.root, "workflows", "clock");
  writeFileSync(join(workflowDirectory, "10-task.sh"), [
    'log="$WORKSHOP_DATA_DIR/attempts.log"',
    'marker="$WORKSHOP_DATA_DIR/first-worker"',
    'if [ -f "$marker" ]; then',
    '  printf "worker:second feedback=%s\n" "$WORKSHOP_FEEDBACK" >> "$log"',
    '  printf "second worker output\n"',
    'else',
    '  : > "$marker"',
    '  printf "worker:first feedback=%s\n" "$WORKSHOP_FEEDBACK" >> "$log"',
    '  printf "first worker output\n"',
    'fi',
    "",
  ].join("\n"));
  writeFileSync(join(workflowDirectory, "10-task.check.sh"), [
    "IFS= read -r candidate",
    'case "$candidate" in',
    '  "first worker output")',
    '    printf "check:first\n" >> "$WORKSHOP_DATA_DIR/attempts.log"',
    '    printf "expected a revision"',
    "    exit 7",
    "    ;;",
    '  "second worker output")',
    '    printf "check:second\n" >> "$WORKSHOP_DATA_DIR/attempts.log"',
    '    printf "checker accepted second output"',
    "    exit 0",
    "    ;;",
    "  *) exit 8 ;;",
    "esac",
    "",
  ].join("\n"));
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "retry-step", type: "start_workflow", workflow: "clock" });
    const task = await waitForTask(storage, runIdFrom(started));
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);

    assert.equal(settled.state.status, "terminal");
    if (settled.state.status !== "terminal") throw new Error("Durable workflow task did not finish");
    assert.equal(settled.state.outcome.status, "completed");
    if (settled.state.outcome.status !== "completed") throw new Error("Durable workflow task did not complete");
    const result: unknown = settled.state.outcome.result;
    assert.ok(isRecord(result));
    if (!isRecord(result)) throw new Error("Durable workflow result is invalid");
    assert.equal(result.output, "second worker output\n");
    assert.ok(Array.isArray(result.steps));
    const stepResult: unknown = result.steps[0];
    assert.ok(isRecord(stepResult));
    if (!isRecord(stepResult)) throw new Error("Durable step result is invalid");
    assert.equal(stepResult.output, "second worker output\n");
    assert.deepEqual(readFileSync(join(project.root, "data", "clock", "attempts.log"), "utf8").trim().split("\n"), [
      "worker:first feedback=",
      "check:first",
      "worker:second feedback=expected a revision",
      "check:second",
    ]);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("durable explicit-zero retry budgets override workflow defaults", { timeout: 10_000 }, async () => {
  const project = createProject("printf 'first step output'\n", "retries: 2\n");
  const workflowDirectory = join(project.root, "workflows", "clock");
  writeFileSync(join(project.root, "workshop.yaml"), [
    "agent_profiles:",
    `  writer:\n    command: ${JSON.stringify([process.execPath, join(process.cwd(), "test/fixtures/profile-command.mjs"), "fail"])}`,
    "orchestrator: {}",
    "",
  ].join("\n"));
  writeFileSync(join(workflowDirectory, "20-agent.md"), "---\nprofile: writer\nretries: 0\n---\n\nFail this attempt.\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "retry-budget", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    await waitForRunStatus(service, storage, runId, "blocked");
    const settled = await storage.task(task.id, BACKGROUND_CONTEXT);
    assert.ok(settled);
    assert.equal(settled.state.status, "running");
    const checkpoint = settled.state.checkpoint;
    assert.ok(isRecord(checkpoint));
    assert.equal(checkpoint.phase, "blocked");
    assert.equal(checkpoint.stepIndex, 1);
    assert.equal(checkpoint.localRetriesLeft, 0);
    assert.ok(Array.isArray(checkpoint.attemptHistory));
    assert.equal(checkpoint.attemptHistory.length, 1);
    const attempt = checkpoint.attemptHistory[0];
    assert.ok(isRecord(attempt));
    assert.equal(attempt.profile, "writer");
    assert.match(String(attempt.error), /fixture profile failure/);

    const childTasks = await storage.scanTasks({ kind: STEP_ATTEMPT_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT);
    const childRequests = childTasks.items
      .filter((child) => String(child.owner) === String(task.id))
      .map((child) => {
        assert.ok(isRecord(child.input));
        assert.ok(isRecord(child.input.request));
        assert.ok(isRecord(child.input.request.step));
        return [child.input.request.step.file, child.input.request.attempt, child.input.request.profile];
      })
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || Number(left[1]) - Number(right[1]));
    assert.deepEqual(childRequests, [
      ["10-task.sh", 1, undefined],
      ["20-agent.md", 1, "writer"],
    ]);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a delayed retry survives SQLite reopen before its deadline", { timeout: 30_000 }, async () => {
  const command = [
    `printf 'attempt\\n' >> "$WORKSHOP_PROJECT_ROOT/invocations"`,
    'if [ ! -e "$WORKSHOP_PROJECT_ROOT/first-attempt" ]; then',
    '  touch "$WORKSHOP_PROJECT_ROOT/first-attempt"',
    "  printf 'first failure'",
    "  exit 7",
    "fi",
    'printf "%s" "$WORKSHOP_FEEDBACK" > "$WORKSHOP_PROJECT_ROOT/retry-feedback"',
    "printf 'retry succeeded'",
    "",
  ].join("\n");
  const project = createProject(command, "retries: 0\n");
  const stateDirectory = join(project.root, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "workshop.sqlite");
  const invocationFile = join(project.root, "invocations");
  const retryFeedbackFile = join(project.root, "retry-feedback");
  const initialTime = Date.now();
  const deadline = initialTime + 60_000;
  let now = initialTime;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let service: ReturnType<typeof createWorkshopService> | undefined;
  try {
    storage = await openNodeSqliteStorage(databasePath);
    harness = await createHarness(storage, { now: () => now, onWake: () => {} });
    harness.resume();
    service = createWorkshopService({ projectRoot: project.root, harness });
    const started = await service.handleRequest({ request_id: "start-delayed-retry", type: "start_workflow", workflow: "clock" });
    const runId = runIdFrom(started);
    const task = await waitForTask(storage, runId);
    const blocked = await waitForRunStatus(service, storage, runId, "blocked");
    if (!isRecord(blocked.blocked_step) || typeof blocked.blocked_step.decision_number !== "number") {
      throw new Error("Blocked run has no decision number");
    }
    const decision = await service.handleRequest({
      request_id: "retry-after-one-minute",
      type: "decide_blocked_run",
      run_id: runId,
      decision_number: blocked.blocked_step.decision_number,
      decision: { action: "retry", after: "1m", hint: "Continue after the saved delay." },
    });
    assert.equal(decision.ok, true);
    await waitForRunStatus(service, storage, runId, "sleeping");
    const sleeping = await storage.task(task.id, BACKGROUND_CONTEXT);
    assert.ok(sleeping);
    if (!sleeping || sleeping.state.status !== "sleeping") throw new Error("Retry did not enter durable sleep");
    assert.equal(sleeping.state.until, deadline);
    assert.equal(harness.wake().at, deadline);
    assert.equal(readFileSync(invocationFile, "utf8"), "attempt\n");
    assert.equal(existsSync(retryFeedbackFile), false);

    await harness.close(BACKGROUND_CONTEXT);
    harness = undefined;
    await storage.close(BACKGROUND_CONTEXT);
    storage = undefined;
    now = deadline - 1;
    storage = await openNodeSqliteStorage(databasePath);
    harness = await createHarness(storage, { now: () => now, onWake: () => {} });
    harness.resume();
    service = createWorkshopService({ projectRoot: project.root, harness });
    await waitForRunStatus(service, storage, runId, "sleeping");
    assert.equal(harness.wake().at, deadline);
    assert.equal(readFileSync(invocationFile, "utf8"), "attempt\n");
    assert.equal(existsSync(retryFeedbackFile), false);

    now = deadline;
    harness.resume();
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    if (settled.state.status !== "terminal" || settled.state.outcome.status !== "completed") {
      throw new Error("Due retry did not complete");
    }
    assert.equal(readFileSync(invocationFile, "utf8"), "attempt\nattempt\n");
    const retryFeedback = readFileSync(retryFeedbackFile, "utf8");
    assert.match(retryFeedback, /first failure/);
    assert.match(retryFeedback, /Hint: Continue after the saved delay\./);
    const result: unknown = settled.state.outcome.result;
    assert.ok(isRecord(result));
    const steps = recordsFrom(result.steps);
    assert.ok(steps[0]);
    const attempts = recordsFrom(steps[0].attempts);
    assert.deepEqual(attempts.map(({ attempt, output }) => [attempt, output]), [
      [1, "first failure"],
      [2, "retry succeeded"],
    ]);
    assert.match(String(attempts[0]?.error), /exit code 7/);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    if (storage) await storage.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("durable command exit 99 completes without checking or starting later steps", { timeout: 10_000 }, async () => {
  const project = createProject("printf 'no work'; exit 99\n", "retries: 2\n");
  const workflowDirectory = join(project.root, "workflows", "clock");
  const dataDirectory = join(project.root, "data", "clock");
  const stateDirectory = join(project.root, "state");
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(join(workflowDirectory, "10-task.check.sh"), 'touch "$WORKSHOP_DATA_DIR/check-marker"\n');
  writeFileSync(join(workflowDirectory, "20-later.sh"), 'touch "$WORKSHOP_DATA_DIR/later-marker"\n');
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    storage = await openNodeSqliteStorage(join(stateDirectory, "workshop.sqlite"));
    harness = await createHarness(storage);
    harness.resume();
    const port = await createWorkflowStartPort(harness);
    const started = await startWorkflow({
      projectRoot: project.root,
      workflowName: "clock",
      port,
      at: new Date("2026-11-16T12:00:00.000Z"),
    });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") throw new Error("Workflow did not start");
    const task = await waitForTask(storage, started.run_id);
    const settled = await harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    assert.ok(settled.state.status === "terminal" && settled.state.outcome.status === "completed");
    assert.deepEqual(settled.state.outcome.result, {
      status: "nothing-to-do",
      output: "no work",
      completedSteps: 0,
      steps: [{ step: "10-task", status: "nothing-to-do", output: "no work", attempts: [{ attempt: 1, output: "no work" }] }],
    });
    assert.equal(existsSync(join(dataDirectory, "check-marker")), false);
    assert.equal(existsSync(join(dataDirectory, "later-marker")), false);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    else if (storage) await storage.close(BACKGROUND_CONTEXT);
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
      assert.match(prompt, /Run list is capped at 100 rows/);
      assert.match(prompt, /### Active runs/);
      assert.match(prompt, /### Blocked runs/);
      assert.match(prompt, /### Definition-unavailable runs/);
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
      await watcher.waitFor((event) => {
        if (event.type !== "run.end" || event.chat_request_id !== "chat-stream") return false;
        const answerIndex = watcher.events.findIndex((item) => item.type === "assistant.final" && item.answer === response.answer);
        return answerIndex >= 0 && watcher.events.indexOf(event) > answerIndex;
      });
      const terminal = watcher.events.filter((event) => event.type === "run.end" && event.chat_request_id === "chat-stream");
      assert.equal(terminal.length, 1, "one terminal event follows the settled answer");
      assert.equal(terminal[0]?.status, "done");
    }
  } finally {
    for (const client of clients) client.destroy();
    if (socketServer) await socketServer.close();
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});


test("a replacement service watch recovers chat correlation and completion when settlement wins submission lookup", { timeout: 30_000 }, async () => {
  const project = createProject("printf 'unused'\\n");
  const storage = new MemoryStorage();
  const faux = fauxProvider({ tokensPerSecond: 12, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  let markStarted = () => {};
  let releaseFirst = () => {};
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const generationGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  let markLookupStarted = () => {};
  let releaseLookup = () => {};
  const lookupStarted = new Promise<void>((resolveStarted) => { markLookupStarted = resolveStarted; });
  const lookupGate = new Promise<void>((resolveGate) => { releaseLookup = resolveGate; });
  faux.setResponses([async () => {
    markStarted();
    await generationGate;
    return fauxAssistantMessage("Recovered answer from the durable submission.");
  }]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let watcher: Awaited<ReturnType<ReturnType<typeof createWorkshopService>["watchChat"]>> | undefined;
  let watcherStarting: ReturnType<ReturnType<typeof createWorkshopService>["watchChat"]> | undefined;
  const events: Record<string, unknown>[] = [];
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot: project.root,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async () => ({ ok: true }),
    });
    harness.resume();
    const originalInspect = harness.inspect.bind(harness);
    const originalSubmission = harness.submission.bind(harness);
    const waitForLookup = async () => {
      markLookupStarted();
      await lookupGate;
    };
    harness.inspect = async (context) => {
      await waitForLookup();
      return await originalInspect(context);
    };
    harness.submission = async (id, context) => {
      await waitForLookup();
      return await originalSubmission(id, context);
    };
    const originalService = createWorkshopService({ projectRoot: project.root, harness });
    const submission = originalService.handleRequest({
      request_id: "recovered-chat",
      type: "submit_chat",
      content: "Please answer after the service is replaced.",
    });
    await started;
    const replacementService = createWorkshopService({ projectRoot: project.root, harness });
    watcherStarting = replacementService.watchChat("replacement-watch", (event) => events.push(event));
    await lookupStarted;
    releaseFirst();
    const response = await submission;
    assert.equal(response.ok, true);
    assert.equal(response.answer, "Recovered answer from the durable submission.");
    releaseLookup();
    watcher = await watcherStarting;
    assert.equal(events[0]?.type, "chat.attached");
    const waitFor = async (type: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const event = events.find((item) => item.type === type);
        if (event) return event;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(events)}`);
    };
    const final = await waitFor("assistant.final");
    assert.equal(final.chat_request_id, "recovered-chat");
    assert.equal(final.answer, response.answer);
    assert.equal(events.filter((event) => event.type === "assistant.final").length, 1);
  } finally {
    releaseFirst();
    releaseLookup();
    await watcherStarting?.then(async (active) => { watcher = active; }).catch(() => undefined);
    if (watcher) await watcher.close();
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

test("a saved faulted step-attempt child is consumed after SQLite reopen", { timeout: 60_000 }, async () => {
  const project = createProject("printf 'unused'\n", "retries: 0\n");
  const stateDirectory = join(project.root, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "workshop.sqlite");
  const reason = "faulted child detail";
  let storage: Storage | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const seedStorage = await openNodeSqliteStorage(databasePath);
    storage = seedStorage;
    const seedHarness = await createHarness(seedStorage);
    harness = seedHarness;
    const service = createWorkshopService({ projectRoot: project.root, harness: seedHarness });
    const runId = runIdFrom(await service.handleRequest({
      request_id: "start-faulted-child", type: "start_workflow", workflow: "clock",
    }));
    const parentPage = await seedStorage.scanTasks({ kind: WORKFLOW_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT);
    const parent = parentPage.items.find((record) => isRecord(record.input) && record.input.runId === runId);
    assert.ok(parent, "SQLite contains the workflow parent");
    if (!parent) throw new Error("Workflow parent was not saved");
    const workflow: WorkflowTaskInput["workflow"] = {
      name: "clock", directory: "clock", cron: "* * * * *", description: "A service test workflow.", retries: 0,
      steps: [{ kind: "command", file: "10-task.sh", number: 10, name: "task" }],
    };
    const step = workflow.steps[0];
    if (!step) throw new Error("Test workflow has no step");
    const request = { step, pipeInput: "", feedback: "", attempt: 1 };
    const childInput: StepAttemptTaskInput = {
      projectRoot: project.root, workflow, step, documents: {}, files: {},
      profileCommands: { writer: [process.execPath] }, runId,
      dataDirectory: join(project.root, "data", "clock"), stateDirectory, request,
    };
    const childId = await seedHarness.commit(
      (tx) => tx.createTask(createStepAttemptTask(executeWorkflowProcess), childInput, {
        ownership: { kind: "task", taskId: parent.id },
      }),
      BACKGROUND_CONTEXT,
    );
    const [parentRecord, childRecord] = await Promise.all([
      seedStorage.task(parent.id, BACKGROUND_CONTEXT), seedStorage.task(childId, BACKGROUND_CONTEXT),
    ]);
    assert.ok(parentRecord);
    assert.ok(childRecord);
    if (!parentRecord || !childRecord) throw new Error("Seed parent or child task is missing");
    const checkpoint: WorkflowTaskCheckpoint = {
      phase: "attempt", stepIndex: 0, pipeInput: "", results: [], attemptHistory: [],
      localRetriesLeft: 0, feedback: "", decisionNumber: 0, automaticRoundUsed: false,
      activeAttempt: { taskId: childId, request },
    };
    const { memos: _memos, ...childWithoutMemos } = childRecord;
    const seeded = await seedStorage.commit(
      [[
        { type: "task", value: { ...parentRecord, startedAt: 1_000, state: { status: "running", checkpoint } } },
        { type: "task", value: {
          ...childWithoutMemos, startedAt: 1_000, endedAt: 2_000,
          state: { status: "terminal", outcome: { status: "faulted", error: { message: reason } } },
        } },
      ]],
      () => {},
      BACKGROUND_CONTEXT,
    );
    assert.equal(seeded.stored, 1);
    assert.equal(seeded.refused, undefined);
    await seedHarness.close(BACKGROUND_CONTEXT);
    harness = undefined;
    storage = undefined;

    const reopenedStorage = await openNodeSqliteStorage(databasePath);
    storage = reopenedStorage;
    const resumedHarness = await createHarness(reopenedStorage);
    harness = resumedHarness;
    resumedHarness.resume();
    const resumedService = createWorkshopService({ projectRoot: project.root, harness: resumedHarness });
    const blocked = await waitForRunStatus(resumedService, reopenedStorage, runId, "blocked");
    assert.ok(isRecord(blocked.blocked_step));
    if (!isRecord(blocked.blocked_step)) throw new Error("Faulted child did not block its parent");
    assert.equal(blocked.blocked_step.last_error, reason);
    assert.ok(Array.isArray(blocked.blocked_step.attempt_history));
    if (!Array.isArray(blocked.blocked_step.attempt_history)) throw new Error("Blocked step has no attempt history");
    assert.ok(isRecord(blocked.blocked_step.attempt_history[0]));
    if (!isRecord(blocked.blocked_step.attempt_history[0])) throw new Error("Blocked step has no first attempt record");
    assert.equal(blocked.blocked_step.attempt_history[0].error, reason);
    assert.ok((await waitForFailureEvidence(reopenedStorage, resumedHarness, runId)).includes(reason));
    const savedChild = await reopenedStorage.task(childId, BACKGROUND_CONTEXT);
    assert.ok(savedChild);
    if (!savedChild) throw new Error("Recovered child disappeared");
    assert.equal(savedChild.state.status, "terminal");
    if (savedChild.state.status !== "terminal") throw new Error("Recovered child is not terminal");
    assert.equal(savedChild.state.outcome.status, "faulted");
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    else if (storage) await storage.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("an orphaned step-attempt child preserves its reason after SQLite reopen", { timeout: 60_000 }, async () => {
  const project = createProject("printf 'unused'\n", "retries: 0\n");
  const stateDirectory = join(project.root, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "workshop.sqlite");
  let storage: Storage | undefined;
  let firstHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    storage = await openNodeSqliteStorage(databasePath);
    firstHarness = await createHarness(storage, { includeStepAttemptTask: false });
    firstHarness.resume();
    const firstService = createWorkshopService({ projectRoot: project.root, harness: firstHarness });
    const runId = runIdFrom(await firstService.handleRequest({
      request_id: "start-orphaned-child", type: "start_workflow", workflow: "clock",
    }));
    const parent = await waitForTask(storage, runId);
    const child = await waitForChildAttempt(storage, parent.id);
    await firstHarness.close(BACKGROUND_CONTEXT);
    firstHarness = undefined;
    storage = undefined;

    storage = await openNodeSqliteStorage(databasePath);
    harness = await createHarness(storage, { includeStepAttemptTask: false });
    assert.equal(await harness.abortTask(child.id, BACKGROUND_CONTEXT), "marked");
    const orphaned = await storage.task(child.id, BACKGROUND_CONTEXT);
    assert.ok(orphaned);
    if (!orphaned) throw new Error("Orphaned child task was not saved");
    assert.equal(orphaned.state.status, "terminal");
    if (orphaned.state.status !== "terminal") throw new Error("Step-attempt child did not settle");
    assert.equal(orphaned.state.outcome.status, "orphaned");
    if (orphaned.state.outcome.status !== "orphaned") throw new Error("Step-attempt child was not orphaned");
    const reason = orphaned.state.outcome.reason;
    assert.ok(reason.length > 0);

    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const blocked = await waitForRunStatus(service, storage, runId, "blocked");
    assert.ok(isRecord(blocked.blocked_step));
    if (!isRecord(blocked.blocked_step)) throw new Error("Orphaned child did not block its parent");
    assert.equal(blocked.blocked_step.last_error, reason);
    assert.ok(Array.isArray(blocked.blocked_step.attempt_history));
    if (!Array.isArray(blocked.blocked_step.attempt_history)) throw new Error("Blocked step has no attempt history");
    assert.ok(isRecord(blocked.blocked_step.attempt_history[0]));
    if (!isRecord(blocked.blocked_step.attempt_history[0])) throw new Error("Blocked step has no first attempt record");
    assert.equal(blocked.blocked_step.attempt_history[0].error, reason);
    assert.ok((await waitForFailureEvidence(storage, harness, runId)).includes(reason));
  } finally {
    if (firstHarness) await firstHarness.close(BACKGROUND_CONTEXT);
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    else if (storage) await storage.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("aborting an owned step-attempt child blocks the run with its reason", { timeout: 60_000 }, async () => {
  const project = createProject([
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify([
      `require("node:fs").writeFileSync(process.env.WORKSHOP_PROJECT_ROOT + "/child-started", "started");`,
      `require("node:net").createServer().listen(0, "127.0.0.1");`,
    ].join(" "))}`,
    "",
  ].join("\n"), "retries: 0\n");
  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const runId = runIdFrom(await service.handleRequest({
      request_id: "start-aborted-owned-child", type: "start_workflow", workflow: "clock",
    }));
    const parent = await waitForTask(storage, runId);
    const child = await waitForChildAttempt(storage, parent.id);
    await waitForFile(join(project.root, "child-started"));
    assert.equal(await harness.abortTask(child.id, BACKGROUND_CONTEXT), "marked");
    await harness.waitForTask(child.id, BACKGROUND_CONTEXT);
    const abortedChild = await storage.task(child.id, BACKGROUND_CONTEXT);
    assert.ok(abortedChild);
    if (!abortedChild) throw new Error("Aborted child task was not saved");
    assert.equal(abortedChild.state.status, "terminal");
    if (abortedChild.state.status !== "terminal") throw new Error("Aborted child task did not settle");
    assert.equal(abortedChild.state.outcome.status, "aborted");
    if (abortedChild.state.outcome.status !== "aborted") throw new Error("Step-attempt child was not aborted");
    const reason = abortedChild.state.outcome.reason ?? "Step attempt was aborted";
    assert.equal(reason, "cancelled");

    const blocked = await waitForRunStatus(service, storage, runId, "blocked");
    assert.ok(isRecord(blocked.blocked_step));
    if (!isRecord(blocked.blocked_step)) throw new Error("Aborted child did not block its parent");
    assert.equal(blocked.status, "blocked", "aborting the child does not cancel its parent run");
    assert.equal(blocked.blocked_step.last_error, reason);
    assert.ok(Array.isArray(blocked.blocked_step.attempt_history));
    if (!Array.isArray(blocked.blocked_step.attempt_history)) throw new Error("Blocked step has no attempt history");
    assert.ok(isRecord(blocked.blocked_step.attempt_history[0]));
    if (!isRecord(blocked.blocked_step.attempt_history[0])) throw new Error("Blocked step has no first attempt record");
    assert.equal(blocked.blocked_step.attempt_history[0].error, reason);
    assert.ok((await waitForFailureEvidence(storage, harness, runId)).includes(reason));
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("daily-summary gathers service activity and saves its report", { timeout: 20_000 }, async () => {
  const project = createProject("printf 'source activity\\n'\n");
  const summaryWorkflow = join(project.root, "workflows", "daily-summary");
  cpSync(new URL("../examples/workflows/daily-summary", import.meta.url), summaryWorkflow, { recursive: true });
  const scriptsDirectory = join(project.root, "scripts");
  const serviceDirectory = join(project.root, "service");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(serviceDirectory, { recursive: true });
  cpSync(new URL("../scripts/read-workshop-activity.ts", import.meta.url), join(scriptsDirectory, "read-workshop-activity.ts"));
  cpSync(new URL("../service/request-service.ts", import.meta.url), join(serviceDirectory, "request-service.ts"));
  cpSync(new URL("../service/types.ts", import.meta.url), join(serviceDirectory, "types.ts"));

  const fakeWriter = join(project.root, "fake-writer.mjs");
  writeFileSync(fakeWriter, [
    "for await (const chunk of process.stdin) { void chunk; }",
    `process.stdout.write(${JSON.stringify("# Activity summary\n\nRecorded test activity.\n")});`,
    "",
  ].join("\n"));
  writeFileSync(join(project.root, "workshop.yaml"), [
    "agent_profiles:",
    "  writer:",
    `    command: ${JSON.stringify([process.execPath, fakeWriter])}`,
    "orchestrator: {}",
    "",
  ].join("\n"));

  const storage = new MemoryStorage();
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let socket: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  try {
    harness = await createHarness(storage);
    harness.resume();
    const service = createWorkshopService({ projectRoot: project.root, harness });
    const stateDirectory = join(project.root, "state");
    mkdirSync(stateDirectory, { recursive: true });
    socket = await serveServiceSocket(join(stateDirectory, "service.sock"), async (value, send) => {
      send(await service.handleRequest(parseServiceRequest(value)));
    });

    const activityStart = await service.handleRequest({ request_id: "activity-start", type: "start_workflow", workflow: "clock" });
    const activityRunId = runIdFrom(activityStart);
    await waitForRunStatus(service, storage, activityRunId, "completed");

    const summaryStart = await service.handleRequest({ request_id: "summary-start", type: "start_workflow", workflow: "daily-summary" });
    const summaryRunId = runIdFrom(summaryStart);
    await waitForRunStatus(service, storage, summaryRunId, "completed");

    const read = await service.handleRequest({ request_id: "summary-read", type: "read_run", run_id: summaryRunId });
    assert.ok(isRecord(read.run));
    const steps = recordsFrom(read.run.steps);
    const gather = steps.find((step) => step.step === "10-gather-activity");
    assert.ok(gather);
    assert.equal(gather.status, "completed");
    assert.equal(typeof gather.output, "string");
    if (typeof gather.output !== "string") throw new Error("Daily-summary gather step did not return JSON");
    const report: unknown = JSON.parse(gather.output);
    assert.ok(isRecord(report));
    assert.deepEqual(Object.keys(report).sort(), ["actions", "runs", "window_end", "window_start"]);
    if (typeof report.window_start !== "string" || typeof report.window_end !== "string") {
      throw new Error("Daily-summary report did not include its time window");
    }
    assert.ok(Number.isFinite(Date.parse(report.window_start)));
    assert.ok(Number.isFinite(Date.parse(report.window_end)));
    assert.ok(Date.parse(report.window_start) <= Date.parse(report.window_end));

    const runs = recordsFrom(report.runs);
    const recordedRun = runs.find((run) => run.run_id === activityRunId);
    assert.ok(recordedRun);
    assert.equal(recordedRun.workflow, "clock");
    assert.equal(recordedRun.status, "completed");
    const actions = recordsFrom(report.actions);
    const recordedStart = actions.find((action) => action.run_id === activityRunId);
    assert.ok(recordedStart);
    assert.equal(recordedStart.workflow, "clock");
    assert.deepEqual(recordedStart.decision, { action: "start" });

    const save = steps.find((step) => step.step === "30-save-summary");
    assert.ok(save);
    assert.equal(save.status, "completed");
    const dataDirectory = join(project.root, "data", "daily-summary");
    const savedFiles = readdirSync(dataDirectory);
    assert.equal(savedFiles.length, 1);
    const savedFile = savedFiles[0];
    assert.ok(savedFile);
    assert.match(savedFile, /^summary-\d{4}-\d{2}-\d{2}\.md$/);
    assert.equal(readFileSync(join(dataDirectory, savedFile), "utf8"), "# Activity summary\n\nRecorded test activity.\n");
  } finally {
    if (socket) await socket.close();
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});
