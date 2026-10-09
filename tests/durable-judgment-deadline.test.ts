import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { workflowRunDocumentV1Schema, workshopJudgmentV1Schema } from "../src/run/records.js";
import { runOutcomeSchema } from "../src/run/schema.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { FAILURE_JUDGMENT_DECISION_TOOL_NAME, failureJudgmentTaskInputSchema } from "../src/storage/durable/define-failure-judgment-task.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

// Commit-time deadline checks for the failure-judge decision tool, exercised through
// the real Registry/Harness with one injected clock shared by the Harness and the tool.

const JUDGE_TIMEOUT_MS = 30_000;
const machineConfig = {
  version: 2,
  shell: "/bin/bash",
  orchestrator: { model: "faux/failure-judge:low", timeout: `${JUDGE_TIMEOUT_MS / 1_000}s` },
} as const;
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type OpenedHarness = Awaited<ReturnType<typeof openHarness>>;
type ReadyRun = Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { state: "ready" }>;

function judgedWorkflowSource(workflowId: string): string {
  return [
    "version: 2",
    `id: ${workflowId}`,
    "nodes:",
    "  verify:",
    "    replay: safe",
    "    max_attempts: 2",
    "    run: { command: \"printf 'candidate'\" }",
    "    validator:",
    "      replay: safe",
    "      command: >-",
    "        if [ -f .validator-failed-once ]; then exit 0; else touch .validator-failed-once; exit 7; fi",
    "    next: null",
    "",
  ].join("\n");
}

async function openHarness(databasePath: string, harnessClock: () => number, decisionClock: () => number, models: ReturnType<typeof createModels>) {
  const opened = await openDurableStorage(databasePath);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const tasks = defineWorkshopTasks(undefined, { now: decisionClock });
  const registry = createRegistry();
  registry.install({
    name: "workshop-judgment-deadline-test",
    tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, tasks.FailureJudgmentTask],
  });
  registry.install(tasks.FailureJudgmentExtension);
  const harness = await Harness.open(opened.storage, { models, registry, now: harnessClock }, BACKGROUND_CONTEXT);
  return { harness, tasks };
}

function prepare(directory: string, workflowId: string, admittedAt: number) {
  const source = judgedWorkflowSource(workflowId);
  const checked = checkDefinitionText(source, `${workflowId}.yaml`);
  const resolvedSettings = resolveWorkflowSettings({ definition: checked.def, machine: machineConfig, projectCwd: directory });
  const prepared = prepareRunAdmission({
    sourceText: source,
    sourceLabel: `${workflowId}.yaml`,
    machineConfig,
    projectCwd: directory,
    runsDirectory: join(directory, "state", "runs"),
    resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: hash("judgment deadline test"),
      taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, failureJudgment: 1 },
    },
    runId: `${workflowId}-run-001`,
    eventId: `admission-${workflowId}-run-001`,
    activationId: `activation-${workflowId}`,
    occurrenceId: `occurrence-${workflowId}-001`,
    requestId: `${workflowId}-request-001`,
    admittedAt: iso(admittedAt),
  });
  if (!prepared.ok) throw new Error(`${prepared.failure.kind}: ${prepared.failure.message}`);
  return prepared.value;
}

async function admit(opened: OpenedHarness, prepared: ReturnType<typeof prepare>, workflowId: string, now: number) {
  const installation = installationDocumentV1Schema.parse({
    state: "ready",
    installationId: `installation-${workflowId}`,
    maxConcurrentRuns: 1,
    workflows: {
      [workflowId]: {
        definitionHash: prepared.canonicalHash,
        admissionHighWater: 0,
        openRunId: null,
        activations: [{
          activationId: prepared.activationId,
          state: "active",
          admittedCount: 0,
          maxRuns: 1,
          activatedAt: iso(now - 1_000),
          nextDueAt: null,
        }],
        occurrenceCounters: { [prepared.activationId]: 0 },
        runs: [],
        requestIndex: {},
        capacityReservations: [],
        preflightCache: {},
      },
    },
  });
  await opened.harness.commit(async (tx) => {
    Object.assign(await tx.doc(WorkshopInstallationDoc), installation);
  }, BACKGROUND_CONTEXT);
  const admission = await admitPreparedRun({
    harness: opened.harness,
    prepared,
    workflowRunTask: opened.tasks.WorkflowRunTask,
    createTaskInput: createWorkflowRunTaskInput,
    parseTaskInput: parseWorkflowRunTaskInput,
    context: BACKGROUND_CONTEXT,
  });
  if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
  return admission.value;
}

async function readRun(harness: OpenedHarness["harness"], conversationId: ConversationId): Promise<ReadyRun> {
  const run = workflowRunDocumentV1Schema.parse(await harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
  if (run.state !== "ready") throw new Error("judged run is missing its canonical document");
  return run;
}

async function readPendingJudgmentDeadline(harness: OpenedHarness["harness"], conversationId: ConversationId): Promise<number> {
  const judgment = (await readRun(harness, conversationId)).nodes[0]?.attempts[0]?.judgments[0];
  if (judgment?.status !== "pending") throw new Error("judge answered before its judgment was pending");
  const task = await harness.getTask(judgment.taskId as TaskId, BACKGROUND_CONTEXT);
  if (task === undefined) throw new Error("failure-judgment task is missing");
  const deadlineAt = failureJudgmentTaskInputSchema.parse(task.input).deadlineAt;
  if (deadlineAt === null) throw new Error("failure judgment has no persisted absolute deadline");
  return Date.parse(deadlineAt);
}

async function readJudgmentPhases(harness: OpenedHarness["harness"], conversationId: ConversationId): Promise<string[]> {
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("run conversation is missing");
  const entries = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  return entries.items
    .filter((entry) => entry.kind === "workshop.judgment")
    .map((entry) => workshopJudgmentV1Schema.parse(entry.data).phase);
}

async function readJudgeToolResults(harness: OpenedHarness["harness"], conversationId: number): Promise<string[]> {
  const conversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("failure-judge conversation is missing");
  const entries = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  return entries.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry));
}

describe("failure-judge decision deadline", () => {
  test("rejects a decision whose persisted absolute deadline elapses before the decision commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-judgment-commit-deadline-"));
    const workflowId = "commit-deadline-judge";
    let now = Date.now();
    const clock = () => now;
    let opened: OpenedHarness | undefined;
    let runConversationId: ConversationId | undefined;
    let clockAtJudgeRequest: number | undefined;
    let deadline: number | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([async () => {
      if (opened === undefined || runConversationId === undefined) throw new Error("judge ran before admission returned");
      clockAtJudgeRequest = now;
      deadline = await readPendingJudgmentDeadline(opened.harness, runConversationId);
      // The judge answers in time, but the absolute deadline is reached before its decision commits.
      // The judgment task's relative sleep still has its full real-time delay, so only the commit check can reject.
      now = deadline;
      return fauxAssistantMessage(fauxToolCall(FAILURE_JUDGMENT_DECISION_TOOL_NAME, {
        action: "retry", reason: "This valid decision reaches the commit after the deadline.",
      }), { stopReason: "toolUse" });
    }]);
    try {
      const admittedAt = now;
      const prepared = prepare(directory, workflowId, admittedAt);
      opened = await openHarness(join(directory, "durable.db"), clock, clock, models);
      const admission = await admit(opened, prepared, workflowId, admittedAt);
      runConversationId = admission.conversationId as ConversationId;
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);

      const task = await opened.harness.waitForTask(admission.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("late-decision run did not settle");
      expect(runOutcomeSchema.parse(task.state.outcome.result).kind).toBe("blocked");
      expect(deadline).toBe(admittedAt + JUDGE_TIMEOUT_MS);
      expect(clockAtJudgeRequest).toBeLessThan(deadline!);

      const run = await readRun(opened.harness, runConversationId);
      expect(run.status).toBe("blocked");
      expect(run.block).toMatchObject({ kind: "orchestrator_unavailable", reason: "failure judge exceeded its configured deadline" });
      expect(run.nodes[0]?.attempts).toHaveLength(1);
      const judgment = run.nodes[0]?.attempts[0]?.judgments[0];
      expect(judgment).toMatchObject({ status: "failed", decision: null, decidedAt: null, applicationReceipt: null });
      expect((await readJudgmentPhases(opened.harness, runConversationId)).reverse()).toEqual(["prepared", "failed"]);
      const toolResults = await readJudgeToolResults(opened.harness, judgment!.conversationId);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toContain("The failure-judge deadline elapsed; the decision was not recorded.");
      expect(faux.state.callCount).toBe(1);
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("replays and applies a decision committed before its deadline exactly once after expiry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-judgment-replay-after-deadline-"));
    const databasePath = join(directory, "durable.db");
    const workflowId = "replay-after-deadline-judge";
    let now = Date.now();
    const harnessClock = () => now;
    let deadline: number | undefined;
    let decisionClockReads = 0;
    // The first decision commit sees the pre-deadline clock; the deadline then passes, so the
    // identical replayed decision commit and everything after it run past the absolute deadline.
    const decisionClock = () => {
      const current = now;
      decisionClockReads += 1;
      if (deadline !== undefined) now = deadline + 1;
      return current;
    };
    let opened: OpenedHarness | undefined;
    let runConversationId: ConversationId | undefined;
    const decision = { action: "retry", reason: "The safe validator failure can be retried once." } as const;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([async () => {
      if (opened === undefined || runConversationId === undefined) throw new Error("judge ran before admission returned");
      deadline = await readPendingJudgmentDeadline(opened.harness, runConversationId);
      // Hold the WorkflowRun at its post-judgment boundary so the decision stays captured but unapplied.
      await opened.harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopRunDoc, runConversationId!);
        const run = workflowRunDocumentV1Schema.parse(draft);
        if (run.state !== "ready") throw new Error("judgment run is not initialized");
        Object.assign(draft, workflowRunDocumentV1Schema.parse({ ...run, desiredState: "paused" }));
      }, BACKGROUND_CONTEXT);
      return fauxAssistantMessage([
        fauxToolCall(FAILURE_JUDGMENT_DECISION_TOOL_NAME, decision, { id: "decision-original" }),
        fauxToolCall(FAILURE_JUDGMENT_DECISION_TOOL_NAME, decision, { id: "decision-replayed" }),
      ], { stopReason: "toolUse" });
    }]);
    try {
      const admittedAt = now;
      const prepared = prepare(directory, workflowId, admittedAt);
      opened = await openHarness(databasePath, harnessClock, decisionClock, models);
      const admission = await admit(opened, prepared, workflowId, admittedAt);
      runConversationId = admission.conversationId as ConversationId;
      opened.harness.resume();

      let pausedRun: ReadyRun | undefined;
      const pauseWait = Date.now() + 15_000;
      while (Date.now() < pauseWait) {
        const run = await readRun(opened.harness, runConversationId);
        if (run.status === "paused" && run.nodes[0]?.attempts[0]?.judgments[0]?.status === "decided") { pausedRun = run; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (pausedRun === undefined || deadline === undefined) throw new Error("WorkflowRun did not pause after the decision was captured");
      const captured = pausedRun.nodes[0]?.attempts[0]?.judgments[0];
      if (captured?.decidedAt === null || captured?.decidedAt === undefined) throw new Error("captured decision lacks its decision time");
      expect(Date.parse(captured.decidedAt)).toBeLessThan(deadline);
      expect(captured).toMatchObject({ status: "decided", decision, applicationReceipt: null });
      expect(decisionClockReads).toBe(1);
      expect(now).toBeGreaterThan(deadline);
      const judgeToolResults = await readJudgeToolResults(opened.harness, captured.conversationId);
      expect(judgeToolResults).toHaveLength(2);
      for (const result of judgeToolResults) {
        expect(result).toContain("The checked decision has been recorded.");
        expect(result).not.toContain("deadline elapsed");
      }

      await opened.harness.close(BACKGROUND_CONTEXT);
      opened = undefined;
      opened = await openHarness(databasePath, harnessClock, decisionClock, models);
      await opened.harness.commit(async (tx) => {
        const runDraft = await tx.doc(WorkshopRunDoc, runConversationId!);
        const current = workflowRunDocumentV1Schema.parse(runDraft);
        if (current.state !== "ready" || current.status !== "paused") throw new Error("reopened run is not paused");
        const installationDraft = await tx.doc(WorkshopInstallationDoc);
        const installation = installationDocumentV1Schema.parse(installationDraft);
        if (installation.state !== "ready") throw new Error("installation is not initialized after restart");
        const workflow = installation.workflows[workflowId];
        const reference = workflow?.runs.find((entry) => entry.runId === current.runId);
        if (workflow === undefined || reference?.status !== "paused") throw new Error("paused run index is inconsistent");
        reference.status = "running";
        workflow.capacityReservations = [...workflow.capacityReservations.filter((id) => id !== current.runId), current.runId];
        Object.assign(installationDraft, installationDocumentV1Schema.parse(installation));
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({ ...current, status: "running", desiredState: "running" }));
      }, BACKGROUND_CONTEXT);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);

      const task = await opened.harness.waitForTask(admission.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("recovered WorkflowRun did not complete");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toEqual({ kind: "completed", terminalOutput: "candidate" });
      const run = await readRun(opened.harness, runConversationId);
      expect(run.status).toBe("completed");
      expect(run.nodes[0]?.attempts).toHaveLength(2);
      const applied = run.nodes[0]?.attempts[0]?.judgments;
      expect(applied).toHaveLength(1);
      expect(applied?.[0]).toMatchObject({ status: "decided", decision, decidedAt: captured.decidedAt });
      const receipt = applied?.[0]?.applicationReceipt;
      if (receipt === null || receipt === undefined) throw new Error("decision was not applied");
      expect(Date.parse(receipt.appliedAt)).toBeGreaterThan(deadline);
      expect((await readJudgmentPhases(opened.harness, runConversationId)).reverse()).toEqual(["prepared", "decision_recorded", "decision_applied"]);
      expect(faux.state.callCount).toBe(1);
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
