import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, MemoryStorage, type TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { test } from "node:test";
import { createWorkflowStartPort } from "../run/start-workflow.ts";
import { appendRecent, maxWorkshopHistoryRecords, workshopStateDocument, type MutationReceipt, type WorkshopAction, type WorkflowAdmission } from "../run/workshop-state.ts";
import { createWorkshopService } from "../service/create-workshop-service.ts";
import { openWorkshopHarness } from "../service/open-workshop-harness.ts";
import { tickWorkflows } from "../schedule/tick-workflows.ts";
import { StepAttemptTask } from "../workflow/define-step-attempt-task.ts";
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

function createHarness(storage: MemoryStorage) {
  const registry = createRegistry();
  registry.install({ name: "workshop", tasks: [WorkflowTask, StepAttemptTask] });
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

async function waitForTask(storage: MemoryStorage, runId: string): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>> {
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

async function waitForRunStatus(service: ReturnType<typeof createWorkshopService>, storage: MemoryStorage, runId: string, expected: string): Promise<Record<string, unknown>> {
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

    const cancelled = await service.handleRequest({ request_id: "cancel", type: "cancel_run", run_id: runId });
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
      assert.match(prompt, /### Blocked runs/);
      assert.match(prompt, /### Broken workflows/);
      assert.match(prompt, /### Paused workflows/);
      assert.match(prompt, /### Recent actions/);
      return fauxAssistantMessage(fauxToolCall("list_workflows", {}), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("consult", { question: "Review the loaded workflow." }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Independent advice: the workflow is ready."),
    (context) => {
      assert.match(transcriptText(context.messages), /Independent advice: the workflow is ready/);
      return fauxAssistantMessage("First answer.");
    },
    fauxAssistantMessage("Second answer."),
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
    const first = await service.handleRequest({ request_id: "chat-1", type: "submit_chat", content: "Hello." });
    const replay = await service.handleRequest({ request_id: "chat-1", type: "submit_chat", content: "Hello." });
    const second = await service.handleRequest({ request_id: "chat-2", type: "submit_chat", content: "Continue." });
    const rootConversation = await harness.root(BACKGROUND_CONTEXT);
    const chatSubmissions = await storage.scanSubmissions({ conversationId: rootConversation.id }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(first.ok, true, JSON.stringify({ first, chatSubmissions: chatSubmissions.items }));
    assert.equal(first.answer, "First answer.");
    assert.deepEqual(replay, first);
    assert.equal(second.ok, true);
    assert.equal(second.answer, "Second answer.");
    assert.equal(first.conversation_id, second.conversation_id);
    assert.ok(chatSubmissions.items.some((submission) => submission.requestId === "chat:chat-1"));
    assert.equal(faux.state.callCount, 5);
  } finally {
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
        run_id: match[1],
        decision_number: Number(match[2]),
        decision: { action: "skip" },
        source: "round",
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
      request: async (request) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request);
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
    assert.equal(roundAction.note, "Skipped after the command failed.");
    assert.equal(faux.state.callCount, 2);
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});
