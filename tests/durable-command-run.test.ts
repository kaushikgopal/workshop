import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness, type ConversationId, type TaskId, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import type { ResolvedExecutionSite } from "../src/definition/schema-resolved.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { attemptIdSchema, nodeResultSchema, runOutcomeSchema } from "../src/run/schema.js";
import { executionIdSchema, incarnationIdSchema } from "../src/process/schema.js";
import { terminateProcessGroup } from "../src/process/kill-process-tree.js";
import { workflowRunDocumentV1Schema, workshopEventV1Schema, workshopJudgmentV1Schema, workshopProcessV1Schema } from "../src/run/records.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import {
  buildProcessExecutionEnvironment,
  decideProcessReplay,
  processExecutionFiles,
  processExecutionTaskInputSchema,
  processExecutionTaskResultSchema,
  type ProcessExecutionTaskEnvironmentInput,
} from "../src/storage/durable/define-process-execution-task.js";
import { parseWorkerResultBytes } from "../src/attempt/parse-result.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { FAILURE_JUDGMENT_DECISION_TOOL_NAME, FailureJudgmentExtension, failureJudgmentTaskInputSchema, failureJudgmentTaskResultSchema } from "../src/storage/durable/define-failure-judgment-task.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const sourceText = [
  "steps:",
  "  - first:",
  "      run: \"printf 'alpha'\"",
  "  - second:",
  "      run: >-",
  "        printf '%s-beta' \"$(cat \"$WORKSHOP_PREVIOUS_OUTPUT_FILE\")\"",
  "",
].join("\n");
const timeoutSourceText = [
  "steps:",
  "  - first:",
  "      timeout: 1s",
  "      run: exec sleep 30",
  "",
].join("\n");
const failureSourceText = [
  "steps:",
  "  - first:",
  "      run: >-",
  "        printf 'expected failure'; exit 7",
  "",
].join("\n");
const abortSourceText = [
  "steps:",
  "  - first:",
  "      run: exec sleep 30",
  "",
].join("\n");
const machineConfig = { shell: "/bin/bash" } as const;
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type CommandHarness = Awaited<ReturnType<typeof openCommandHarness>>;

async function openCommandHarness(
  databasePath: string,
  serviceBootId?: string,
  options: { readonly startupLaunchGate?: "open" | "closed"; readonly now?: () => number } = {},
  models = createModels(),
) {
  const opened = await openDurableStorage(databasePath);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const taskOptions = options.startupLaunchGate === undefined ? {} : { startupLaunchGate: options.startupLaunchGate };
  const tasks = defineWorkshopTasks(serviceBootId, taskOptions);
  const registry = createRegistry();
  registry.install({
    name: "workshop-command-runtime",
    tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, tasks.FailureJudgmentTask],
  });
  registry.install(tasks.FailureJudgmentExtension);
  const harness = await Harness.open(opened.storage, {
    models,
    registry,
    ...(options.now === undefined ? {} : { now: options.now }),
  }, BACKGROUND_CONTEXT);
  return { harness, tasks };
}

function prepare(
  directory: string,
  requestId: string,
  runId: string,
  source = sourceText,
  machine: Parameters<typeof resolveWorkflowSettings>[0]["machine"] = machineConfig,
  workflowId = runId.startsWith("command-chain-") ? "command-chain" : runId.split("-run-")[0] ?? "command-chain",
) {
  const sourceLabel = `${workflowId}.yaml`;
  const checked = checkDefinitionText(source, sourceLabel, workflowId);
  const resolvedSettings = resolveWorkflowSettings({
    definition: checked.def,
    machine,
    projectCwd: directory,
  });
  const prepared = prepareRunAdmission({
    sourceText: source,
    sourceLabel,
    workflowId,
    machineConfig: machine,
    projectCwd: directory,
    runsDirectory: join(directory, "state", "runs"),
    archiveDirectory: join(directory, ".workshop", "archive"),
    resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: hash("command-only integration test"),
      taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, failureJudgment: 1 },
    },
    runId,
    eventId: `admission-${runId}`,
    activationId: `activation-${workflowId}`,
    occurrenceId: `occurrence-${workflowId}-001`,
    requestId,
    admittedAt: iso(Date.now()),
  });
  if (!prepared.ok) throw new Error(`${prepared.failure.kind}: ${prepared.failure.message}`);
  return prepared.value;
}

async function initializeInstallation(harness: CommandHarness["harness"], definitionHash: string, workflowId = "command-chain") {
  const now = Date.now();
  const installation = installationDocumentV1Schema.parse({
    state: "ready",
    installationId: "installation-command-run-test",
    maxConcurrentRuns: 1,
    workflows: {
      [workflowId]: {
        definitionHash,
        admissionHighWater: 0,
        openRunId: null,
        activations: [{
          activationId: "activation-command-chain",
          state: "active",
          admittedCount: 0,
          maxRuns: 1,
          activatedAt: iso(now - 1_000),
          nextDueAt: null,
        }],
        occurrenceCounters: { "activation-command-chain": 0 },
        runs: [],
        requestIndex: {},
        capacityReservations: [],
        preflightCache: {},
      },
    },
  });
  await harness.commit(async (tx) => {
    Object.assign(await tx.doc(WorkshopInstallationDoc), installation);
  }, BACKGROUND_CONTEXT);
}

async function admit(harness: CommandHarness["harness"], tasks: CommandHarness["tasks"], prepared: ReturnType<typeof prepare>) {
  return admitPreparedRun({
    harness,
    prepared,
    workflowRunTask: tasks.WorkflowRunTask,
    createTaskInput: createWorkflowRunTaskInput,
    parseTaskInput: parseWorkflowRunTaskInput,
    context: BACKGROUND_CONTEXT,
  });
}

describe("Durable workflow lifecycle", () => {
  test("admits real tasks, passes exact stdout across nodes, settles, reopens, and deduplicates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-command-run-"));
    const databasePath = join(directory, "durable.db");
    const requestId = "command-chain-request-001";
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(directory, requestId, "command-chain-run-001", sourceText, { ...machineConfig, stream_cap: "3", keep_files: "always" });
      opened = await openCommandHarness(databasePath);
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      expect(admission.value.duplicate).toBe(false);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const runTask = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      expect(runTask.state.status).toBe("terminal");
      expect(runTask.state.outcome.status).toBe("completed");
      if (runTask.state.outcome.status !== "completed") throw new Error("WorkflowRun task did not complete");
      expect(runOutcomeSchema.parse(runTask.state.outcome.result)).toEqual({ kind: "completed", terminalOutput: "alpha-beta" });
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);

      // SAFETY: admission returns the numeric ID created for this ownerless run conversation.
      const conversationId = admission.value.conversationId as ConversationId;
      const storedRun = await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(storedRun);
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("canonical run is absent");
      expect(run.status).toBe("completed");
      expect(run.terminalOutput).toBe("alpha-beta");
      expect(run.nodes.map((node) => node.status)).toEqual(["succeeded", "succeeded"]);
      const outputs = run.nodes.map((node) => {
        const result = node.attempts[0]?.result;
        if (result?.kind !== "settled" || result.outcome.kind !== "succeeded") throw new Error(`node ${node.nodeId} lacks a settled result`);
        return { output: result.outcome.candidate.output, hash: result.outcome.candidate.sourceBytesHash };
      });
      expect(outputs).toEqual([
        { output: "alpha", hash: hash("alpha") },
        { output: "alpha-beta", hash: hash("alpha-beta") },
      ]);

      const conversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("run conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processEntries = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const exited = processEntries.filter((entry) => entry.process.status === "exited");
      expect(exited).toHaveLength(2);
      const stdoutCaptures = exited.map((entry) => {
        const capture = entry.process.captures.find((item) => item.stream === "stdout");
        if (capture === undefined) throw new Error("exited process lacks stdout evidence");
        return { capture, text: readFileSync(capture.path, "utf8") };
      });
      expect(stdoutCaptures.map((item) => item.text)).toEqual(["ala", "ala"]);
      expect(stdoutCaptures.map(({ capture }) => ({
        totalBytes: capture.totalBytes,
        retainedBytes: capture.retainedBytes,
        truncatedBytes: capture.truncatedBytes,
        keptHeadBytes: capture.keptHeadBytes,
        keptTailBytes: capture.keptTailBytes,
        complete: capture.complete,
        sha256: capture.sha256,
      })).sort((left, right) => left.totalBytes - right.totalBytes)).toEqual([
        { totalBytes: 5, retainedBytes: 3, truncatedBytes: 2, keptHeadBytes: 2, keptTailBytes: 1, complete: false, sha256: hash("ala") },
        { totalBytes: 10, retainedBytes: 3, truncatedBytes: 7, keptHeadBytes: 2, keptTailBytes: 1, complete: false, sha256: hash("ala") },
      ]);

      await opened.harness.close(BACKGROUND_CONTEXT);
      opened = undefined;
      opened = await openCommandHarness(databasePath);
      const reopened = await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT);
      const reopenedRun = workflowRunDocumentV1Schema.parse(reopened);
      expect(reopenedRun.state).toBe("ready");
      if (reopenedRun.state !== "ready") throw new Error("settled run did not survive SQLite reopen");
      expect(reopenedRun.status).toBe("completed");
      expect(reopenedRun.terminalOutput).toBe("alpha-beta");

      const retry = await admit(opened.harness, opened.tasks, prepare(directory, requestId, "command-chain-run-retry", sourceText, { ...machineConfig, stream_cap: "3", keep_files: "always" }));
      expect(retry).toEqual({
        ok: true,
        value: {
          ...admission.value,
          duplicate: true,
        },
      });
      const index = await opened.harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT);
      expect(index?.state).toBe("ready");
      if (index?.state !== "ready") throw new Error("installation index is absent after reopen");
      expect(index.workflows["command-chain"]?.runs).toHaveLength(1);
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("records timeout failure and confirms process-group cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-command-timeout-"));
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(directory, "command-timeout-request-001", "command-chain-timeout-001", timeoutSourceText);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      expect(task.state.status).toBe("terminal");
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("WorkflowRun task did not settle the timeout");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("timed-out command was not recorded as a failed run");
      expect(outcome.failure.kind).toBe("timeout");
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);

      const conversationId = admission.value.conversationId as ConversationId;
      const conversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("run conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processes = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const exited = processes.filter((entry) => entry.process.status === "exited");
      expect(exited).toHaveLength(1);
      expect(exited[0]?.process.cleanupState).toBe("confirmed_dead");
      expect(exited[0]?.process.exit?.kind).toBe("signal");

      const storedRun = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
      );
      expect(storedRun.state).toBe("ready");
      if (storedRun.state !== "ready") throw new Error("failed run is absent");
      expect(storedRun.status).toBe("failed");
      const attempt = storedRun.nodes[0]?.attempts[0];
      expect(attempt?.result.kind).toBe("settled");
      if (attempt?.result.kind !== "settled") throw new Error("timed-out attempt lacks terminal evidence");
      expect(attempt.result.outcome.kind).toBe("failed");
      if (attempt.result.outcome.kind !== "failed") throw new Error("attempt outcome is not failed");
      expect(attempt.result.outcome.failure.kind).toBe("timeout");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("service abort records observed exit but does not cancel the run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-command-abort-"));
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(directory, "command-abort-request-001", "command-chain-abort-001", abortSourceText);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);

      const idle = opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("run conversation is missing");
      let runningProcess: ReturnType<typeof workshopProcessV1Schema.parse> | undefined;
      for (let attempt = 0; attempt < 200 && runningProcess === undefined; attempt += 1) {
        const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
        runningProcess = entries.items
          .filter((entry) => entry.kind === "workshop.process")
          .map((entry) => workshopProcessV1Schema.parse(entry.data))
          .find((entry) => entry.process.status === "running");
        if (runningProcess === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(runningProcess?.process.status).toBe("running");
      if (runningProcess === undefined) throw new Error("command process never reached the running state");

      await conversation.abort(BACKGROUND_CONTEXT);
      await idle;
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      expect(task.state.status).toBe("terminal");
      expect(task.state.outcome.status).toBe("aborted");

      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processes = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const blocked = processes.filter((entry) => entry.process.status === "blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.process.cleanupState).toBe("confirmed_dead");
      expect(blocked[0]?.process.exit?.kind).toBe("signal");

      const storedRun = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      expect(storedRun.state).toBe("ready");
      if (storedRun.state !== "ready") throw new Error("aborted run is absent");
      expect(storedRun.status).toBe("blocked");
      expect(storedRun.desiredState).toBe("stopped");
      const attempt = storedRun.nodes[0]?.attempts[0];
      expect(attempt?.result.kind).toBe("settled");
      if (attempt?.result.kind !== "settled") throw new Error("aborted attempt lacks terminal evidence");
      expect(attempt.result.outcome.kind).toBe("blocked");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("deletes a completed run's folder unless keep_files is always", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-command-cleanup-"));
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(directory, "command-cleanup-request-001", "command-chain-cleanup-001", sourceText);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.outcome.status !== "completed") throw new Error("WorkflowRun task did not complete");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toEqual({ kind: "completed", terminalOutput: "alpha-beta" });
      expect(existsSync(prepared.paths.runDirectory)).toBe(false);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("settles an expected command failure as a typed domain outcome", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-command-failure-"));
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(directory, "command-failure-request-001", "command-chain-failure-001", failureSourceText);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      expect(task.state.status).toBe("terminal");
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("WorkflowRun must settle expected command failures as domain outcomes");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("nonzero command did not produce a failed run outcome");
      expect(outcome.failure.kind).toBe("process_error");
      if (outcome.failure.kind !== "process_error") throw new Error("run outcome lost the process failure kind");
      expect(outcome.failure.nodeId).toBe("first");
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);

      const conversationId = admission.value.conversationId as ConversationId;
      const storedRun = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
      );
      expect(storedRun.state).toBe("ready");
      if (storedRun.state !== "ready") throw new Error("failed run is absent");
      expect(storedRun.status).toBe("failed");
      const attempt = storedRun.nodes[0]?.attempts[0];
      expect(attempt?.result.kind).toBe("settled");
      if (attempt?.result.kind !== "settled") throw new Error("expected failure lacks canonical attempt evidence");
      expect(attempt.result.outcome.kind).toBe("failed");
      if (attempt.result.outcome.kind !== "failed") throw new Error("attempt did not retain its typed failure");
      expect(attempt.result.outcome.failure.kind).toBe("process_error");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

});

function judgedWorkflowSource(workflowId: string, replay: "safe" | "never", maxAttempts = 2): string {
  return [
    "steps:",
    "  - verify:",
    `      replay: ${replay}`,
    `      max_attempts: ${maxAttempts}`,
    "      run: \"printf 'candidate'\"",
    "      check:",
    "        replay: safe",
    "        run: >-",
    "          if [ -f .validator-failed-once ]; then exit 0; else touch .validator-failed-once; exit 7; fi",
    "",
  ].join("\n");
}




describe("native Durable failure judgment", () => {
  test("records a faux-provider retry decision and applies it within the frozen attempt bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-retry-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", {
      action: "retry", reason: "The failed validator can be safely retried once.",
    }), { stopReason: "toolUse" })]);
    const source = judgedWorkflowSource("judged-chain", "safe");
    try {
      const prepared = prepare(directory, "judgment-retry-request-001", "judged-chain-run-001", source, {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, "judged-chain");
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      expect(task.state.status).toBe("terminal");
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error(`judged WorkflowRun did not complete: ${JSON.stringify(task.state)}`);
      const runValue = await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(runValue);
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("judged run is missing its canonical document");
      expect(run.status).toBe("completed");
      expect(run.nodes[0]?.attempts).toHaveLength(2);
      const firstAttempt = run.nodes[0]?.attempts[0];
      expect(firstAttempt?.judgments).toHaveLength(1);
      expect(firstAttempt?.judgments[0]).toMatchObject({
        status: "decided",
        decision: { action: "retry", reason: "The failed validator can be safely retried once." },
      });
      expect(firstAttempt?.judgments[0]?.applicationReceipt).toMatchObject({ eventId: expect.any(String), appliedAt: expect.any(String) });
      expect(faux.state.callCount).toBe(1);
      expect(faux.getPendingResponseCount()).toBe(0);
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("judged run conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const judgments = entries.items.filter((entry) => entry.kind === "workshop.judgment").map((entry) => workshopJudgmentV1Schema.parse(entry.data));
      expect(judgments.map((entry) => entry.phase).reverse()).toEqual(["prepared", "decision_recorded", "decision_applied"]);
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("blocks a retry proposal excluded by the frozen replay policy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-policy-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", {
      action: "retry", reason: "Retry anyway.",
    }), { stopReason: "toolUse" })]);
    const workflowId = "judged-never";
    try {
      const prepared = prepare(directory, "judgment-policy-request-001", "judged-never-run-001", judgedWorkflowSource(workflowId, "never", 3), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("out-of-policy judgment did not settle");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("blocked");
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("blocked judged run is missing its canonical document");
      expect(run.block?.kind).toBe("orchestrator_invalid");
      expect(run.nodes[0]?.attempts).toHaveLength(1);
      expect(run.nodes[0]?.attempts[0]?.judgments[0]?.status).toBe("failed");
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("blocks a retry decision when semantic attempts are exhausted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-exhausted-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", {
      action: "retry", reason: "Proposed retry after the only semantic attempt.",
    }), { stopReason: "toolUse" })]);
    const workflowId = "exhausted-judge";
    try {
      const prepared = prepare(directory, "judgment-exhausted-request-001", "exhausted-judge-run-001", judgedWorkflowSource(workflowId, "safe", 1), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("exhausted-judge run is missing its canonical document");
      expect(run.block?.kind).toBe("orchestrator_invalid");
      expect(run.nodes[0]?.attempts).toHaveLength(1);
      expect(run.nodes[0]?.attempts[0]?.judgments[0]).toMatchObject({ status: "failed", decision: null });
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("blocks when a native judge response omits the checked decision tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-malformed-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("I recommend a retry, but do not record one.", { stopReason: "stop" })]);
    const workflowId = "malformed-judge";
    try {
      const prepared = prepare(directory, "judgment-malformed-request-001", "malformed-judge-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("malformed-judge run is missing its canonical document");
      expect(run.block?.kind).toBe("orchestrator_invalid");
      expect(run.nodes[0]?.attempts[0]?.judgments[0]).toMatchObject({ status: "failed", decision: null });
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);


  test("keeps multiple judgment histories isolated in one run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-multiple-failure-judgments-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", { action: "retry", reason: "Retry the first checked validator failure." }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", { action: "retry", reason: "Retry the second checked validator failure." }), { stopReason: "toolUse" }),
    ]);
    const workflowId = "multiple-judgments";
    const source = [
      "steps:",
      "  - first:",
      "      replay: safe",
      "      max_attempts: 2",
      "      run: \"printf 'first'\"",
      "      check:",
      "        replay: safe",
      "        run: >-",
      "          if [ -f .first-validator-passed-once ]; then exit 0; else touch .first-validator-passed-once; exit 7; fi",
      "  - second:",
      "      replay: safe",
      "      max_attempts: 2",
      "      run: \"printf 'second'\"",
      "      check:",
      "        replay: safe",
      "        run: >-",
      "          if [ -f .second-validator-passed-once ]; then exit 0; else touch .second-validator-passed-once; exit 7; fi",
      "",
    ].join("\n");
    try {
      const prepared = prepare(directory, "multiple-judgments-request-001", "multiple-judgments-run-001", source, {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("multiple-judgment run did not complete");
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("multiple-judgment run is missing its canonical document");
      expect(run.status).toBe("completed");
      expect(run.nodes.map((node) => node.attempts.length)).toEqual([2, 2]);
      expect(run.nodes.map((node) => node.attempts[0]?.judgments[0]?.decision?.reason)).toEqual([
        "Retry the first checked validator failure.",
        "Retry the second checked validator failure.",
      ]);
      expect(faux.state.callCount).toBe(2);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);


  test("rejects a conflicting duplicate decision while preserving the recorded decision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-conflicting-failure-judgment-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("record_workshop_failure_decision", { action: "retry", reason: "The first duplicate action." }, { id: "decision-retry" }),
        fauxToolCall("record_workshop_failure_decision", { action: "fail", reason: "A conflicting duplicate action." }, { id: "decision-fail" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("No further action.", { stopReason: "stop" }),
    ]);
    const workflowId = "conflicting-judgment";
    try {
      const prepared = prepare(directory, "conflicting-judgment-request-001", "conflicting-judgment-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("conflicting-judgment run is missing its canonical document");
      const judgment = run.nodes[0]?.attempts[0]?.judgments[0];
      expect(judgment?.status).toBe("decided");
      expect(judgment?.decision?.action === "retry" || judgment?.decision?.action === "fail").toBe(true);
      expect(judgment?.applicationReceipt).not.toBeNull();
      const runConversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (runConversation === undefined) throw new Error("conflicting-judgment run conversation is missing");
      const runEntries = await runConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const decisions = runEntries.items.filter((entry) => entry.kind === "workshop.judgment").map((entry) => workshopJudgmentV1Schema.parse(entry.data));
      expect(decisions.filter((entry) => entry.phase === "decision_recorded")).toHaveLength(1);
      const judgeConversation = judgment === undefined ? undefined : await opened.harness.conversation(judgment.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (judgeConversation === undefined) throw new Error("failure-judge conversation is missing");
      const judgeEntries = await judgeConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(JSON.stringify(judgeEntries.items.filter((entry) => entry.kind === "pi.tool-result"))).toContain("conflicting duplicate failure-judgment decision");
      expect(faux.state.callCount).toBe(2);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);


  test("gives the native judge bounded untrusted failure excerpts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-judgment-excerpts-"));
    const environmentNames = [
      "WORKSHOP_TEST_WORKERS",
      "WORKSHOP_TEST_VALIDATORS",
      "WORKSHOP_TEST_SUCCESSORS",
      "WORKSHOP_TEST_VALIDATOR_INPUT",
      "WORKSHOP_TEST_RESULT_PATHS",
    ];
    const restoreEnvironment = preserveEnvironment(environmentNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
      resultPaths: join(directory, "result-paths.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    process.env.WORKSHOP_TEST_RESULT_PATHS = markers.resultPaths;
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let capturedPrompt = "";
    const candidateOutput = "CANDIDATE_PRIVATE_SENTINEL";
    const candidateSummary = `SUMMARY_UNTRUSTED_START${"S".repeat(700)}SUMMARY_UNTRUSTED_END`;
    const validatorReason = `VERDICT_UNTRUSTED_START${"V".repeat(700)}VERDICT_UNTRUSTED_END`;
    faux.setResponses([(context) => {
      capturedPrompt = JSON.stringify(context.messages);
      return fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", { action: "fail", reason: "The checked validator rejected the candidate." }), { stopReason: "toolUse" });
    }]);
    const workflowId = "judgment-excerpts";
    const machine = headlessChainMachineConfig(JSON.stringify({ version: 1, passed: false, reason: validatorReason }));
    const machineWithExcerpts = {
      ...machine,
      agent: {
        ...machine.agent,
        harness: {
          ...machine.agent.harness,
          command: machine.agent.harness.command
            .replace("validated candidate", candidateOutput)
            .replace("worker summary", candidateSummary),
        },
      },
      orchestrator: { model: "faux/failure-judge:low", timeout: "10s" },
    };
    const source = headlessChainSourceText;
    try {
      const prepared = prepare(directory, "judgment-excerpts-request-001", "judgment-excerpts-run-001", source, machineWithExcerpts);
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("judgment-excerpts run is missing its canonical document");
      const result = run.nodes[0]?.attempts[0]?.result;
      if (result?.kind !== "settled" || result.outcome.kind !== "failed") throw new Error("judgment-excerpts attempt did not retain its failure");
      expect(result.outcome.candidate?.output).toBe(candidateOutput);
      expect(result.outcome.candidate?.summary).toBe(candidateSummary);
      expect(result.outcome.validator?.kind).toBe("agent");
      if (result.outcome.validator?.kind !== "agent") throw new Error("agent validator verdict is missing");
      expect(result.outcome.validator.verdict.reason).toBe(validatorReason);
      expect(capturedPrompt).toContain("SUMMARY_UNTRUSTED_START");
      expect(capturedPrompt).not.toContain("SUMMARY_UNTRUSTED_END");
      expect(capturedPrompt).toContain("VERDICT_UNTRUSTED_START");
      expect(capturedPrompt).not.toContain("VERDICT_UNTRUSTED_END");
      expect(capturedPrompt).not.toContain(candidateOutput);
      expect(capturedPrompt).toContain("reasonExcerpt");
      expect(capturedPrompt).toContain("summaryExcerpt");
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);




  test("blocks when the configured judge model is unavailable without switching providers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-unavailable-"));
    let opened: CommandHarness | undefined;
    const workflowId = "unavailable-judge";
    try {
      const prepared = prepare(directory, "judgment-unavailable-request-001", "unavailable-judge-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "missing/failure-judge:low", timeout: "10s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("unavailable judge did not settle");
      expect(runOutcomeSchema.parse(task.state.outcome.result).kind).toBe("blocked");
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("unavailable-judge run is missing its canonical document");
      expect(run.block?.kind).toBe("orchestrator_unavailable");
      expect(run.nodes[0]?.attempts[0]?.judgments[0]?.status).toBe("failed");
      expect((await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("aborts the native judgment when its configured deadline expires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-deadline-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }], tokensPerSecond: 1 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", { action: "fail", reason: "This response arrives too late." }), { stopReason: "toolUse" })]);
    const workflowId = "deadline-judge";
    try {
      const prepared = prepare(directory, "judgment-deadline-request-001", "deadline-judge-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "100ms" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("timed-out judgment did not settle");
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("timed-out judgment run is missing its canonical document");
      expect(run.block?.kind).toBe("orchestrator_unavailable");
      expect(run.block?.reason).toContain("exceeded its configured deadline");
      expect(run.nodes[0]?.attempts).toHaveLength(1);
      expect(run.nodes[0]?.attempts[0]?.judgments[0]).toMatchObject({ status: "failed", decision: null });
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("rejects a failure decision when its absolute deadline expires inside the commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-commit-deadline-"));
    try {
      const prepared = prepare(directory, "judgment-commit-deadline-request-001", "command-chain-judgment-commit-deadline-001", failureSourceText);
      const runConversationId = 101 as ConversationId;
      const workflowTaskId = 202;
      const failureTaskId = 303 as TaskId;
      const judgmentConversationId = 404 as ConversationId;
      const attemptId = attemptIdSchema.parse("judgment-commit-deadline-attempt-001");
      const judgmentId = "judgment-commit-deadline-001";
      const submissionRequestId = "judgment-commit-deadline-submission-001";
      const startedAt = prepared.admittedAt;
      const finishedAt = iso(Date.parse(startedAt) + 1);
      const judgment = {
        judgmentId,
        conversationId: Number(judgmentConversationId),
        submissionRequestId,
        taskId: Number(failureTaskId),
        status: "pending",
        decision: null,
        startedAt,
        finishedAt: null,
        decidedAt: null,
        applicationReceipt: null,
      };
      const runDraft = workflowRunDocumentV1Schema.parse({
        state: "ready",
        runId: prepared.runId,
        workflowId: prepared.workflowId,
        activationId: prepared.activationId,
        occurrenceId: prepared.occurrenceId,
        requestId: prepared.requestId,
        admissionSequence: 1,
        admittedAt: prepared.admittedAt,
        sourceText: prepared.sourceText,
        sourceHash: prepared.sourceHash,
        canonicalDefinition: prepared.definition,
        canonicalHash: prepared.canonicalHash,
        resolvedSettings: prepared.resolvedSettings,
        chain: prepared.chain,
        paths: prepared.paths,
        runtimeManifest: prepared.runtimeManifest,
        durable: { conversationId: Number(runConversationId), workflowTaskId },
        status: "running",
        desiredState: "running",
        startedAt,
        finishedAt: null,
        currentNodeId: "first",
        currentAttemptId: attemptId,
        block: null,
        failure: null,
        preflight: { kind: "not_configured" },
        nodes: [{
          nodeId: "first",
          status: "failed",
          successfulAttemptId: null,
          attempts: [{
            attemptId,
            number: 1,
            taskId: 505,
            status: "failed",
            phase: null,
            startedAt,
            finishedAt,
            elapsedMs: 1,
            workerExecutionId: null,
            validatorExecutionId: null,
            result: {
              kind: "settled",
              outcome: {
                kind: "failed",
                failure: { kind: "process_error", message: "fixture failure", failedAt: finishedAt, nodeId: "first", attemptId },
                candidate: null,
                validator: null,
              },
            },
            processIncarnations: [],
            blockIds: [],
            judgments: [judgment],
          }],
        }],
        resolutions: [],
        terminalOutput: null,
      });
      const deadlineMs = Date.now() + 1_000;
      const input = failureJudgmentTaskInputSchema.parse({
        runId: prepared.runId,
        runConversationId: Number(runConversationId),
        workflowTaskId,
        nodeId: "first",
        attemptId,
        judgmentId,
        submissionRequestId,
        modelProvider: "faux",
        modelId: "failure-judge",
        thinkingLevel: "low",
        prompt: "test prompt",
        deadlineAt: iso(deadlineMs),
        allowedActions: ["retry", "block", "fail"],
      });
      const entryWrites: unknown[] = [];
      const tx = {
        conversation: async () => ({ id: judgmentConversationId, owner: { conversationId: runConversationId, taskId: failureTaskId } }),
        task: async () => ({
          id: failureTaskId,
          conversationId: runConversationId,
          kind: "workshop.failure-judgment",
          version: 1,
          input,
          background: false,
          abortRequested: false,
          state: { status: "running", checkpoint: { phase: "submit", conversationId: Number(judgmentConversationId) } },
        }),
        doc: async () => runDraft,
        appendEntry: async (...args: unknown[]) => { entryWrites.push(args); },
      } as unknown as Tx;
      let commitStartedAt = 0;
      let decisionCheckAt = 0;
      const api = {
        conversationId: judgmentConversationId,
        commit: async <T>(change: (transaction: Tx) => T | Promise<T>) => {
          commitStartedAt = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadlineMs - Date.now() + 1)));
          decisionCheckAt = Date.now();
          return change(tx);
        },
      } as unknown as ToolExecutionApi;
      const decisionTool = FailureJudgmentExtension.tools?.find((tool) => tool.name === FAILURE_JUDGMENT_DECISION_TOOL_NAME);
      if (decisionTool === undefined) throw new Error("failure decision tool is not registered");
      const result = await (decisionTool as unknown as ToolRegistration).execute(
        { action: "retry", reason: "A valid decision arrives before the transaction deadline." },
        api,
        BACKGROUND_CONTEXT,
      );

      expect(commitStartedAt).toBeLessThan(deadlineMs);
      expect(decisionCheckAt).toBeGreaterThanOrEqual(deadlineMs);
      expect(result).toMatchObject({
        isError: true,
        content: [{ text: "The failure-judge deadline elapsed; the decision was not recorded." }],
        control: { terminate: true },
      });
      expect(runDraft.state).toBe("ready");
      if (runDraft.state !== "ready") throw new Error("run fixture unexpectedly became uninitialized");
      expect(runDraft.nodes[0]?.attempts[0]?.judgments[0]).toMatchObject({ status: "pending", decision: null });
      expect(entryWrites).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("bounds asynchronous judge authentication by the configured deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-auth-deadline-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const workflowId = "auth-deadline-judge";
    try {
      const prepared = prepare(directory, "judgment-auth-deadline-request-001", "auth-deadline-judge-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "100ms" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      Object.defineProperty(models, "getAuth", {
        configurable: true,
        value: () => new Promise(() => {}),
      });
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("auth-deadline run is missing its canonical document");
      expect(run.block?.kind).toBe("orchestrator_unavailable");
      expect(run.block?.reason).toContain("exceeded its configured deadline");
      expect(run.nodes[0]?.attempts[0]?.judgments[0]?.status).toBe("failed");
      expect(faux.state.callCount).toBe(0);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);


  test("stopping during native judgment preserves the known failure and cancels its decision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-stop-native-judgment-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let releaseProvider!: () => void;
    const providerResponseReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerWaiting = false;
    let providerAbortObserved = false;
    faux.setResponses([async (_context, options) => {
      providerWaiting = true;
      const observeAbort = () => { providerAbortObserved = true; };
      if (options?.signal?.aborted) observeAbort();
      else options?.signal?.addEventListener("abort", observeAbort, { once: true });
      await providerResponseReleased;
      return fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", { action: "retry", reason: "The delayed response must not authorize another attempt." }), { stopReason: "toolUse" });
    }]);
    const workflowId = "stop-native-judgment";
    try {
      const prepared = prepare(directory, "stop-native-judgment-request-001", "stop-native-judgment-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "30s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      opened.harness.resume();
      let pendingRun: ReturnType<typeof workflowRunDocumentV1Schema.parse> | undefined;
      let lastRun: ReturnType<typeof workflowRunDocumentV1Schema.parse> | undefined;
      const judgmentDeadline = Date.now() + 10_000;
      while (Date.now() < judgmentDeadline) {
        const value = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
        lastRun = value;
        const judgment = value.state === "ready" ? value.nodes[0]?.attempts[0]?.judgments[0] : undefined;
        if (judgment?.status === "pending" && faux.state.callCount === 1 && providerWaiting) { pendingRun = value; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (pendingRun?.state !== "ready") throw new Error(`native judgment did not reach its pending stop boundary: ${JSON.stringify({ status: lastRun?.state === "ready" ? lastRun.status : lastRun?.state, block: lastRun?.state === "ready" ? lastRun.block : undefined, judgments: lastRun?.state === "ready" ? lastRun.nodes[0]?.attempts[0]?.judgments : undefined, fauxCalls: faux.state.callCount, providerWaiting })}`);
      const pendingJudgment = pendingRun.nodes[0]?.attempts[0]?.judgments[0];
      if (pendingJudgment?.status !== "pending") throw new Error("known failure has no pending native judgment");
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("known-failure run conversation is missing");
      await opened.harness.commit(async (tx) => {
        const runDraft = await tx.doc(WorkshopRunDoc, admission.value.conversationId as ConversationId);
        const run = workflowRunDocumentV1Schema.parse(runDraft);
        if (run.state !== "ready" || run.status !== "running") throw new Error("run changed before stop intent was recorded");
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({ ...run, desiredState: "stopped" }));
        const installationDraft = await tx.doc(WorkshopInstallationDoc);
        const installation = installationDocumentV1Schema.parse(installationDraft);
        if (installation.state !== "ready") throw new Error("installation is not initialized");
        const workflow = installation.workflows[workflowId];
        const activation = workflow?.activations.find((entry) => entry.activationId === run.activationId);
        if (activation === undefined) throw new Error("stopped run activation is missing");
        activation.state = "stopped";
        Object.assign(installationDraft, installationDocumentV1Schema.parse(installation));
      }, BACKGROUND_CONTEXT);
      const aborting = conversation.abort(BACKGROUND_CONTEXT, { background: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      releaseProvider();
      await aborting;
      expect(providerAbortObserved).toBe(true);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("stopped WorkflowRun did not settle");
      expect(task.state.outcome.result).toEqual({ kind: "cancelled" });
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("stopped run document is missing");
      expect(run.status).toBe("cancelled");
      expect(run.desiredState).toBe("stopped");
      expect(run.block).toBeNull();
      expect(run.nodes[0]?.status).toBe("failed");
      expect(run.nodes[0]?.attempts).toHaveLength(1);
      const attempt = run.nodes[0]?.attempts[0];
      if (attempt?.result.kind !== "settled" || attempt.result.outcome.kind !== "failed") throw new Error("stop erased the known failed attempt");
      expect(attempt.result.outcome.candidate?.output).toBe("candidate");
      expect(attempt.judgments).toMatchObject([{ status: "cancelled", decision: null }]);
    } finally {
      releaseProvider();
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("stop preserves a committed judge block while its paused workflow awaits application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-stop-judgment-block-"));
    let opened: CommandHarness | undefined;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let releaseProvider!: () => void;
    const providerResponseReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const workflowId = "stop-judgment-block";
    faux.setResponses([async () => {
      await providerResponseReleased;
      return fauxAssistantMessage("No checked decision was recorded.");
    }]);
    try {
      const prepared = prepare(directory, "stop-judgment-block-request-001", "stop-judgment-block-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "30s" },
      });
      opened = await openCommandHarness(join(directory, "durable.db"), undefined, {}, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      opened.harness.resume();
      let pending: ReturnType<typeof workflowRunDocumentV1Schema.parse> | undefined;
      const pendingDeadline = Date.now() + 10_000;
      while (Date.now() < pendingDeadline) {
        const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
        if (run.state === "ready" && run.status === "running" && run.nodes[0]?.attempts[0]?.judgments[0]?.status === "pending") {
          pending = run;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (pending?.state !== "ready") throw new Error("failure judge did not reach its pending state");
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("judgment-block run conversation is missing");
      await opened.harness.commit(async (tx) => {
        const runDraft = await tx.doc(WorkshopRunDoc, admission.value.conversationId as ConversationId);
        const run = workflowRunDocumentV1Schema.parse(runDraft);
        if (run.state !== "ready" || run.status !== "running") throw new Error("run changed before pause intent was recorded");
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({ ...run, desiredState: "paused" }));
      }, BACKGROUND_CONTEXT);
      releaseProvider();
      let failedJudgmentRun: ReturnType<typeof workflowRunDocumentV1Schema.parse> | undefined;
      const failureDeadline = Date.now() + 10_000;
      while (Date.now() < failureDeadline) {
        const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
        if (run.state === "ready" && run.status === "paused" && run.block === null
          && run.nodes[0]?.attempts[0]?.judgments[0]?.status === "failed") {
          failedJudgmentRun = run;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (failedJudgmentRun?.state !== "ready") throw new Error("failed native judgment did not remain unapplied while paused");
      const judgment = failedJudgmentRun.nodes[0]?.attempts[0]?.judgments[0];
      if (judgment?.status !== "failed") throw new Error("failed judgment evidence is missing");
      let childSettled = false;
      let childOutcome: unknown;
      const childDeadline = Date.now() + 10_000;
      while (Date.now() < childDeadline) {
        const child = await opened.harness.getTask(judgment.taskId as TaskId, BACKGROUND_CONTEXT);
        if (child?.state.status === "terminal") {
          childSettled = true;
          if (child.state.outcome.status === "completed") childOutcome = child.state.outcome.result;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!childSettled || childOutcome === undefined) throw new Error(`failed judgment task did not settle with a checked block: ${judgment.taskId}`);
      const failedResult = failureJudgmentTaskResultSchema.parse(childOutcome);
      if (failedResult.kind !== "failed") throw new Error("failed judgment task lacks its exact block result");
      expect(failedJudgmentRun.block).toBeNull();
      expect(failedResult.block).toMatchObject({ nodeId: "verify", attemptId: failedJudgmentRun.currentAttemptId, kind: "orchestrator_invalid" });
      await opened.harness.commit(async (tx) => {
        const runDraft = await tx.doc(WorkshopRunDoc, admission.value.conversationId as ConversationId);
        const run = workflowRunDocumentV1Schema.parse(runDraft);
        if (run.state !== "ready" || run.status !== "paused") throw new Error("run changed before stop intent was recorded");
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({ ...run, desiredState: "stopped" }));
        const installationDraft = await tx.doc(WorkshopInstallationDoc);
        const installation = installationDocumentV1Schema.parse(installationDraft);
        if (installation.state !== "ready") throw new Error("installation is not initialized");
        const activation = installation.workflows[workflowId]?.activations.find((entry) => entry.activationId === run.activationId);
        if (activation === undefined) throw new Error("stopped run activation is missing");
        activation.state = "stopped";
        Object.assign(installationDraft, installationDocumentV1Schema.parse(installation));
      }, BACKGROUND_CONTEXT);
      await conversation.abort(BACKGROUND_CONTEXT, { background: true });
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("stopped WorkflowRun did not preserve the committed judgment block");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toMatchObject({ kind: "blocked", block: failedResult.block });
      const stopped = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(stopped.state).toBe("ready");
      if (stopped.state !== "ready") throw new Error("stopped run document is missing");
      expect(stopped.status).toBe("blocked");
      expect(stopped.desiredState).toBe("stopped");
      expect(stopped.block).toEqual(failedResult.block);
      expect(stopped.nodes[0]?.attempts[0]?.blockIds).toContain(failedResult.block.blockId);
      expect(stopped.nodes[0]?.attempts[0]?.judgments).toMatchObject([{ status: "failed", decision: null }]);
    } finally {
      releaseProvider();
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);





  test("recovers a recorded decision after its deadline expires and before applying it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-failure-judgment-restart-"));
    const databasePath = join(directory, "durable.db");
    let opened: CommandHarness | undefined;
    let now = Date.now();
    const clock = () => now;
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }], tokensPerSecond: 100 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("record_workshop_failure_decision", {
      action: "retry", reason: `The safe retry remains within policy. ${"x".repeat(512)}`,
    }), { stopReason: "toolUse" })]);
    const workflowId = "judgment-restart";
    try {
      const prepared = prepare(directory, "judgment-restart-request-001", "judgment-restart-run-001", judgedWorkflowSource(workflowId, "safe"), {
        ...machineConfig, orchestrator: { model: "faux/failure-judge:low", timeout: "30s" },
      });
      now = Date.parse(prepared.admittedAt);
      opened = await openCommandHarness(databasePath, undefined, { now: clock }, models);
      await initializeInstallation(opened.harness, prepared.canonicalHash, workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      opened.harness.resume();
      let judgingRun: ReturnType<typeof workflowRunDocumentV1Schema.parse> | undefined;
      const judgeDeadline = Date.now() + 10_000;
      while (Date.now() < judgeDeadline) {
        const value = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
        const judgment = value.state === "ready" ? value.nodes[0]?.attempts[0]?.judgments[0] : undefined;
        if (judgment?.status === "pending" && faux.state.callCount > 0) { judgingRun = value; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (judgingRun?.state !== "ready") throw new Error("failure judge did not start its native request");
      await opened.harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopRunDoc, admission.value.conversationId as ConversationId);
        const run = workflowRunDocumentV1Schema.parse(draft);
        if (run.state !== "ready") throw new Error("judgment run is not initialized");
        Object.assign(draft, workflowRunDocumentV1Schema.parse({ ...run, desiredState: "paused" }));
      }, BACKGROUND_CONTEXT);
      let pausedRun: ReturnType<typeof workflowRunDocumentV1Schema.parse> | undefined;
      const pauseDeadline = Date.now() + 10_000;
      while (Date.now() < pauseDeadline) {
        const value = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
        const judgment = value.state === "ready" ? value.nodes[0]?.attempts[0]?.judgments[0] : undefined;
        if (value.state === "ready" && value.status === "paused" && judgment?.status === "decided") { pausedRun = value; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (pausedRun?.state !== "ready") throw new Error("WorkflowRun did not reach the paused post-decision boundary");
      const decision = pausedRun.nodes[0]?.attempts[0]?.judgments[0];
      if (decision?.status !== "decided" || decision.decidedAt === null) throw new Error("committed failure judgment is missing its decision timestamp");
      const judgmentTask = await opened.harness.getTask(decision.taskId as TaskId, BACKGROUND_CONTEXT);
      if (judgmentTask === undefined) throw new Error("committed failure-judgment task is missing");
      const judgmentInput = failureJudgmentTaskInputSchema.parse(judgmentTask.input);
      if (judgmentInput.deadlineAt === null) throw new Error("failure judgment has no absolute deadline");
      expect(Date.parse(decision.decidedAt)).toBeLessThan(Date.parse(judgmentInput.deadlineAt));
      expect(decision.applicationReceipt).toBeNull();
      now = Date.parse(judgmentInput.deadlineAt) + 1;
      expect(now).toBeGreaterThan(Date.parse(judgmentInput.deadlineAt));
      await opened.harness.close(BACKGROUND_CONTEXT);
      opened = undefined;

      opened = await openCommandHarness(databasePath, undefined, { now: clock }, models);
      await opened.harness.commit(async (tx) => {
        const runDraft = await tx.doc(WorkshopRunDoc, admission.value.conversationId as ConversationId);
        const currentRun = workflowRunDocumentV1Schema.parse(runDraft);
        if (currentRun.state !== "ready" || currentRun.status !== "paused") throw new Error("reopened run is not paused");
        const installationDraft = await tx.doc(WorkshopInstallationDoc);
        const installation = installationDocumentV1Schema.parse(installationDraft);
        if (installation.state !== "ready") throw new Error("installation is not initialized after restart");
        const workflow = installation.workflows[workflowId];
        const runReference = workflow?.runs.find((entry) => entry.runId === currentRun.runId);
        if (workflow === undefined || runReference === undefined || runReference.status !== "paused") throw new Error("paused run index is inconsistent");
        runReference.status = "running";
        workflow.capacityReservations = [...workflow.capacityReservations.filter((id) => id !== currentRun.runId), currentRun.runId];
        Object.assign(installationDraft, installationDocumentV1Schema.parse(installation));
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({ ...currentRun, status: "running", desiredState: "running" }));
      }, BACKGROUND_CONTEXT);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("recovered WorkflowRun did not complete");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toEqual({ kind: "completed", terminalOutput: "candidate" });
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("recovered run is missing its canonical document");
      expect(run.status).toBe("completed");
      expect(run.nodes[0]?.attempts).toHaveLength(2);
      expect(run.nodes[0]?.attempts[0]?.judgments[0]?.applicationReceipt).not.toBeNull();
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("migrates a persisted WorkflowRun v8 start checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-workflow-migration-v8-"));
    const databasePath = join(directory, "durable.db");
    let v8Harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
    let opened: CommandHarness | undefined;
    const v8WorkflowTask = defineTask<ReturnType<typeof createWorkflowRunTaskInput>, { phase: "start" }, ReturnType<typeof runOutcomeSchema.parse>>({
      name: "workshop.workflow-run",
      version: 8,
      initial: () => ({ phase: "start" }),
      phases: { start: async () => { throw new Error("v8 task must remain unstarted before migration"); } },
      abort: async () => {},
    });
    try {
      const prepared = prepare(directory, "workflow-v8-request-001", "command-chain-workflow-v8-run-001");
      const v8Prepared = {
        ...prepared,
        runtimeManifest: {
          ...prepared.runtimeManifest,
          taskVersions: { workflowRun: 8, nodeAttempt: 4, processExecution: 4, capacityGate: 1 },
        },
      };
      const storage = await openDurableStorage(databasePath);
      if (!storage.ok) throw new Error(`${storage.failure.message}: ${String(storage.failure.cause)}`);
      const registry = createRegistry();
      registry.install({ name: "workshop-v8-migration-fixture", tasks: [v8WorkflowTask] });
      v8Harness = await Harness.open(storage.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
      await initializeInstallation(v8Harness, prepared.canonicalHash);
      const admission = await admitPreparedRun({
        harness: v8Harness,
        prepared: v8Prepared,
        workflowRunTask: v8WorkflowTask as never,
        createTaskInput: createWorkflowRunTaskInput,
        parseTaskInput: parseWorkflowRunTaskInput,
        context: BACKGROUND_CONTEXT,
      });
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await v8Harness.close(BACKGROUND_CONTEXT);
      v8Harness = undefined;

      opened = await openCommandHarness(databasePath);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("migrated WorkflowRun did not complete");
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("migrated run is missing its canonical document");
      expect(run.status).toBe("completed");
      expect(run.runtimeManifest.taskVersions).toEqual({ workflowRun: 8, nodeAttempt: 4, processExecution: 4, capacityGate: 1 });
    } finally {
      if (v8Harness !== undefined) await v8Harness.close(BACKGROUND_CONTEXT);
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("canonical worker output views", () => {
  test("writes successor input from stored output over stale files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-canonical-output-"));
    const databasePath = join(directory, "durable.db");
    let opened: CommandHarness | undefined;
    let conversationId: ConversationId | undefined;
    const prepared = prepare(directory, "canonical-output-request-001", "command-chain-run-001");
    const previousOutputPath = join(prepared.paths.runDirectory, "second.1", "previous-output.txt");
    try {
      const candidate = nodeResultSchema.parse({
        version: 1,
        source: "command",
        output: "alpha",
        summary: "seeded predecessor output",
        artifacts: [],
        sourceBytesHash: hash("alpha"),
        exit: { kind: "code", code: 0 },
      });
      const admittedAt = prepared.admittedAt;
      const firstStartedAt = iso(Date.parse(admittedAt) + 1);
      const firstFinishedAt = iso(Date.parse(admittedAt) + 2);
      const secondStartedAt = iso(Date.parse(admittedAt) + 3);
      const firstAttemptId = "canonical-output-first-attempt";
      const secondAttemptId = attemptIdSchema.parse("canonical-output-second-attempt");
      const firstAttempt = {
        attemptId: firstAttemptId,
        number: 1,
        taskId: 99,
        status: "succeeded",
        phase: null,
        startedAt: firstStartedAt,
        finishedAt: firstFinishedAt,
        elapsedMs: 1,
        workerExecutionId: "canonical-output-first-worker",
        validatorExecutionId: null,
        result: { kind: "settled", outcome: { kind: "succeeded", candidate, validator: null } },
        processIncarnations: [],
        blockIds: [],
        judgments: [],
      };
      let secondTaskId = 1;
      const secondAttempt = () => ({
        attemptId: secondAttemptId,
        number: 1,
        taskId: secondTaskId,
        status: "prepared",
        phase: "prepare",
        startedAt: secondStartedAt,
        finishedAt: null,
        elapsedMs: null,
        workerExecutionId: null,
        validatorExecutionId: null,
        result: { kind: "pending" },
        processIncarnations: [],
        blockIds: [],
        judgments: [],
      });

      opened = await openCommandHarness(databasePath);
      await opened.harness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        conversationId = conversation.id;
        const run = workflowRunDocumentV1Schema.parse({
          state: "ready",
          runId: prepared.runId,
          workflowId: prepared.workflowId,
          activationId: prepared.activationId,
          occurrenceId: prepared.occurrenceId,
          requestId: prepared.requestId,
          admissionSequence: 1,
          admittedAt,
          sourceText: prepared.sourceText,
          sourceHash: prepared.sourceHash,
          canonicalDefinition: prepared.definition,
          canonicalHash: prepared.canonicalHash,
          resolvedSettings: prepared.resolvedSettings,
          chain: prepared.chain,
          paths: prepared.paths,
          runtimeManifest: prepared.runtimeManifest,
          durable: { conversationId: Number(conversation.id), workflowTaskId: 1 },
          status: "running",
          desiredState: "running",
          startedAt: firstStartedAt,
          finishedAt: null,
          currentNodeId: "second",
          currentAttemptId: secondAttemptId,
          block: null,
          failure: null,
          preflight: { kind: "not_configured" },
          nodes: [
            { nodeId: "first", status: "succeeded", successfulAttemptId: firstAttemptId, attempts: [firstAttempt] },
            { nodeId: "second", status: "running", successfulAttemptId: null, attempts: [secondAttempt()] },
          ],
          resolutions: [],
          terminalOutput: null,
        });
        Object.assign(await tx.doc(WorkshopRunDoc, conversation.id), run);
      }, BACKGROUND_CONTEXT);
      if (conversationId === undefined) throw new Error("canonical-output conversation was not created");
      await opened.harness.close(BACKGROUND_CONTEXT);
      opened = undefined;

      mkdirSync(join(prepared.paths.runDirectory, "second.1"), { recursive: true });
      writeFileSync(previousOutputPath, "stale input from disk", "utf8");

      opened = await openCommandHarness(databasePath);
      const reopened = opened;
      await reopened.harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopRunDoc, conversationId!);
        const current = workflowRunDocumentV1Schema.parse(draft);
        if (current.state !== "ready") throw new Error("canonical-output run is uninitialized");
        const childInput = {
          runId: current.runId,
          workflowId: current.workflowId,
          activationId: current.activationId,
          occurrenceId: current.occurrenceId,
          workflowTaskId: current.durable.workflowTaskId,
          nodeId: "second",
          attemptId: secondAttemptId,
          attemptNumber: 1,
        };
        const childId = await tx.createTask(reopened.tasks.NodeAttemptTask, childInput, {
          ownership: { kind: "conversation" },
          conversationId: conversationId!,
        });
        secondTaskId = Number(childId);
        const updated = workflowRunDocumentV1Schema.parse({
          ...current,
          nodes: current.nodes.map((node) => node.nodeId !== "second" ? node : {
            ...node,
            attempts: node.attempts.map((attempt) => attempt.attemptId === secondAttemptId
              ? { ...attempt, taskId: secondTaskId }
              : attempt),
          }),
        });
        Object.assign(draft, updated);
      }, BACKGROUND_CONTEXT);
      await reopened.harness.waitForIdle(BACKGROUND_CONTEXT);

      const completedAttemptRun = workflowRunDocumentV1Schema.parse(
        await reopened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
      );
      if (completedAttemptRun.state !== "ready") throw new Error("canonical-output run disappeared after execution");
      const second = completedAttemptRun.nodes.find((node) => node.nodeId === "second");
      const result = second?.attempts[0]?.result;
      if (result?.kind !== "settled" || result.outcome.kind !== "succeeded") {
        throw new Error("successor attempt lacks committed output");
      }
      expect(result.outcome.candidate.output).toBe("alpha-beta");
      expect(readFileSync(previousOutputPath, "utf8")).toBe("alpha");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("required process input file failures", () => {
  test("blocks a successor before dispatch when its previous output file cannot be written", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-input-view-failure-"));
    const restoreEnvironment = preserveEnvironment(["WORKSHOP_TEST_WORKERS", "WORKSHOP_TEST_SUCCESSORS"]);
    const workerMarker = join(directory, "workers.txt");
    const successorMarker = join(directory, "successors.txt");
    process.env.WORKSHOP_TEST_WORKERS = workerMarker;
    process.env.WORKSHOP_TEST_SUCCESSORS = successorMarker;
    let opened: CommandHarness | undefined;
    try {
      const source = [
        "steps:",
        "  - first:",
        "      run: >-",
        "        printf w >> $WORKSHOP_TEST_WORKERS; printf alpha",
        "  - second:",
        "      run: >-",
        "        printf s >> $WORKSHOP_TEST_SUCCESSORS; printf '%s-beta' $(cat $WORKSHOP_PREVIOUS_OUTPUT_FILE)",
        "",
      ].join("\n");
      const prepared = prepare(directory, "input-view-failure-request", "command-chain-input-view-failure-run", source);
      const inputPath = join(prepared.paths.runDirectory, "second.1", "previous-output.txt");
      mkdirSync(inputPath, { recursive: true });
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("input-view failure did not settle as a domain block");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind !== "blocked") throw new Error("successor launched with an invalid input view");
      expect(outcome.block.kind).toBe("integrity_failed");
      expect(outcome.block.nodeId).toBe("second");

      const conversationId = admission.value.conversationId as ConversationId;
      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("input-view failure run disappeared");
      expect(stored.status).toBe("blocked");
      expect(stored.nodes.map((node) => node.status)).toEqual(["succeeded", "blocked"]);
      const secondResult = stored.nodes[1]?.attempts[0]?.result;
      if (secondResult?.kind !== "settled" || secondResult.outcome.kind !== "blocked") {
        throw new Error("blocked successor lacks durable preparation evidence");
      }
      expect(secondResult.outcome.block.reason).toContain("input files");
      expect(readFileSync(workerMarker, "utf8")).toBe("w");
      expect(existsSync(successorMarker)).toBe(false);

    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("blocks validation when the candidate output file cannot be written", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-validator-view-failure-"));
    const envNames = ["WORKSHOP_TEST_WORKERS", "WORKSHOP_TEST_VALIDATORS"];
    const restoreEnvironment = preserveEnvironment(envNames);
    const workerMarker = join(directory, "workers.txt");
    const validatorMarker = join(directory, "validators.txt");
    process.env.WORKSHOP_TEST_WORKERS = workerMarker;
    process.env.WORKSHOP_TEST_VALIDATORS = validatorMarker;
    const databasePath = join(directory, "durable.db");
    let opened: CommandHarness | undefined;
    try {
      const source = [
        "steps:",
        "  - first:",
        "      run: >-",
        "        printf w >> $WORKSHOP_TEST_WORKERS; printf candidate",
        "      check:",
        "        run: >-",
        "          printf v >> $WORKSHOP_TEST_VALIDATORS; exit 0",
        "",
      ].join("\n");
      const prepared = prepare(directory, "validator-view-failure-request", "command-chain-validator-view-failure-run", source);
      const blockedOutput = join(prepared.paths.runDirectory, "first.1", "candidate-output.txt");
      mkdirSync(blockedOutput, { recursive: true });
      opened = await openCommandHarness(databasePath);
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("validator view failure did not settle as a domain block");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind !== "blocked") throw new Error("validator launched with a stale candidate output view");
      expect(outcome.block.kind).toBe("integrity_failed");

      const conversationId = admission.value.conversationId as ConversationId;
      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("validator-view failure run disappeared");
      expect(stored.status).toBe("blocked");
      const node = stored.nodes[0];
      expect(node?.attempts).toHaveLength(1);
      expect(node?.status).toBe("blocked");
      const result = node?.attempts[0]?.result;
      if (result?.kind !== "settled" || result.outcome.kind !== "blocked") {
        throw new Error("blocked validator attempt lacks durable candidate evidence");
      }
      expect(result.outcome.block.kind).toBe("integrity_failed");
      expect(result.outcome.candidate?.output).toBe("candidate");
      expect(result.outcome.validator).toBeNull();
      expect(readFileSync(workerMarker, "utf8")).toBe("w");
      expect(existsSync(validatorMarker)).toBe(false);

      await opened.harness.close(BACKGROUND_CONTEXT);
      opened = undefined;
      rmSync(blockedOutput, { recursive: true, force: true });
      opened = await openCommandHarness(databasePath);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const reopened = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
      );
      if (reopened.state !== "ready") throw new Error("validator-view failure run did not survive reopen");
      expect(reopened.status).toBe("blocked");
      expect(reopened.nodes[0]?.attempts).toHaveLength(1);
      expect(readFileSync(workerMarker, "utf8")).toBe("w");
      expect(existsSync(validatorMarker)).toBe(false);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function verifyDurableRestartAfterProcessLaunch(mode: "worker" | "validator" | "identity" | "safe-worker" | "safe-validator" | "preflight"): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `workshop-restart-${mode}-`));
  const safeReplay = mode === "safe-worker" || mode === "safe-validator";
  const preflightMode = mode === "preflight";
  const replayedProcess = safeReplay || preflightMode;
  const validatorMode = mode === "validator" || mode === "safe-validator";
  const fakeBin = join(directory, "fake-bin");
  if (mode === "identity") {
    mkdirSync(fakeBin);
    const fakePs = join(fakeBin, "ps");
    writeFileSync(fakePs, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(fakePs, 0o755);
  }
  const databasePath = join(directory, "durable.db");
  const readyPath = join(directory, "runner-ready.txt");
  const metadataPath = join(directory, "admission.json");
  const pgidPath = join(directory, "process-group.txt");
  const workerMarker = join(directory, "workers.txt");
  const validatorMarker = join(directory, "validators.txt");
  const successorMarker = join(directory, "successors.txt");
  let runner: ReturnType<typeof spawn> | undefined;
  let opened: CommandHarness | undefined;
  let pgid: number | undefined;
  let runnerStderr = "";
  try {
    runner = spawn(process.execPath, [
      join(process.cwd(), "tests/fixtures/launch-durable-crash-harness.ts"),
      mode,
      directory,
      databasePath,
      readyPath,
      metadataPath,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(mode === "identity" ? { PATH: fakeBin } : {}),
        WORKSHOP_CRASH_WORKERS: workerMarker,
        WORKSHOP_CRASH_VALIDATORS: validatorMarker,
        WORKSHOP_CRASH_SUCCESSORS: successorMarker,
        WORKSHOP_CRASH_PGID: pgidPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    runner.stderr?.setEncoding("utf8");
    runner.stderr?.on("data", (chunk: string) => { runnerStderr += chunk; });
    for (let attempt = 0; attempt < 1_000 && !(existsSync(readyPath) && existsSync(pgidPath)); attempt += 1) {
      if (runner.exitCode !== null || runner.signalCode !== null) {
        throw new Error(`crash harness exited before launch: ${runnerStderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!existsSync(readyPath) || !existsSync(pgidPath)) throw new Error(`timed out waiting for ${mode} launch: ${runnerStderr}`);
    pgid = Number(readFileSync(pgidPath, "utf8"));
    if (!Number.isSafeInteger(pgid) || pgid <= 0) throw new Error("process group marker is invalid");
    if (mode !== "identity") expect(isProcessGroupAlive(pgid)).toBe(true);

    const runnerExit = new Promise<void>((resolve) => runner?.once("exit", () => resolve()));
    runner.kill("SIGKILL");
    await runnerExit;
    if (mode !== "identity") expect(isProcessGroupAlive(pgid)).toBe(true);
    const admission = JSON.parse(readFileSync(metadataPath, "utf8")) as { conversationId: number; workflowTaskId: number };

    opened = await openCommandHarness(databasePath);
    await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
    const runTask = await opened.harness.waitForTask(
      admission.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
      BACKGROUND_CONTEXT,
    );
    expect(runTask.state.outcome.status).toBe("completed");
    if (runTask.state.outcome.status !== "completed") throw new Error("recovered WorkflowRun did not settle");
    const runOutcome = runOutcomeSchema.parse(runTask.state.outcome.result);
    if (replayedProcess) {
      expect(runOutcome.kind).toBe("completed");
      if (runOutcome.kind !== "completed") throw new Error("safe process replay did not complete the run");
      expect(runOutcome.terminalOutput).toBe(preflightMode ? "preflight-worker" : validatorMode ? "candidate-next" : "replayed-next");
    } else {
      expect(runOutcome.kind).toBe("blocked");
      if (runOutcome.kind !== "blocked") throw new Error("recovered uncertain process was not blocked");
      expect(runOutcome.block.kind).toBe("external_outcome_unknown");
    }

    const conversationId = admission.conversationId as ConversationId;
    const stored = workflowRunDocumentV1Schema.parse(
      await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
    );
    if (stored.state !== "ready") throw new Error("recovered run document is missing");
    expect(stored.status).toBe(replayedProcess ? "completed" : "blocked");
    expect(stored.nodes.map((node) => node.status)).toEqual(replayedProcess
      ? preflightMode ? ["succeeded"] : ["succeeded", "succeeded"]
      : ["blocked", "pending"]);
    expect(stored.nodes[0]?.attempts).toHaveLength(1);
    const firstAttempt = stored.nodes[0]?.attempts[0];
    const attemptResult = firstAttempt?.result;
    if (replayedProcess) {
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "succeeded") {
        throw new Error("safe replay did not settle the original semantic attempt");
      }
      expect(attemptResult.outcome.candidate.output).toBe(preflightMode ? "preflight-worker" : validatorMode ? "candidate" : "replayed");
    } else {
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "blocked") {
        throw new Error("recovered attempt lacks a durable block outcome");
      }
      expect(attemptResult.outcome.block.kind).toBe("external_outcome_unknown");
      expect(firstAttempt?.judgments).toEqual([]);
    }
    if (validatorMode) {
      expect(attemptResult?.kind === "settled" && attemptResult.outcome.kind === "blocked" ? attemptResult.outcome.candidate?.output : "candidate").toBe("candidate");
      if (!replayedProcess) expect(readFileSync(join(stored.paths.runDirectory, "first.1", "candidate-output.txt"), "utf8")).toBe("candidate");
    } else if (!replayedProcess) {
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "blocked") throw new Error("worker replay candidate state is missing");
      expect(attemptResult.outcome.candidate).toBeNull();
    }

    const conversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("recovered run conversation is missing");
    const entries = await conversation.entries({}, 1_000, undefined, BACKGROUND_CONTEXT);
    const processRecords = entries.items
      .filter((entry) => entry.kind === "workshop.process")
      .map((entry) => workshopProcessV1Schema.parse(entry.data));
    const targetRole = preflightMode ? "preflight" : validatorMode ? "validator" : "worker";
    const recoveredProcess = processRecords
      .filter((entry) => entry.process.role === targetRole && entry.process.status === "blocked")
      .at(-1);
    if (mode === "identity") {
      expect(recoveredProcess?.process.cleanupState).toBe("unconfirmed");
      expect(recoveredProcess?.process.identity).toBeNull();
    } else {
      expect(recoveredProcess?.process.cleanupState).toBe("confirmed_dead");
      expect(recoveredProcess?.process.identity?.pgid).toBe(pgid);
      expect(isProcessGroupAlive(pgid)).toBe(false);
    }
    if (replayedProcess) {
      const executionId = preflightMode
        ? processRecords.find((entry) => entry.process.role === "preflight")?.process.executionId
        : validatorMode ? firstAttempt?.validatorExecutionId : firstAttempt?.workerExecutionId;
      if (executionId === null || executionId === undefined) throw new Error("replayed execution ID is missing");
      const latestByIncarnation = new Map<string, { process: (typeof processRecords)[number]["process"]; recordedAt: string }>();
      for (const entry of processRecords.filter((value) => value.process.executionId === executionId)) {
        const current = latestByIncarnation.get(entry.process.incarnationId);
        const currentRank = current?.process.status === "launching" ? 0 : current?.process.status === "running" ? 1 : 2;
        const nextRank = entry.process.status === "launching" ? 0 : entry.process.status === "running" ? 1 : 2;
        if (current === undefined || Date.parse(entry.recordedAt) > Date.parse(current.recordedAt)
          || (entry.recordedAt === current.recordedAt && nextRank >= currentRank)) {
          latestByIncarnation.set(entry.process.incarnationId, { process: entry.process, recordedAt: entry.recordedAt });
        }
      }
      const incarnations = [...latestByIncarnation.values()]
        .map((entry) => entry.process)
        .sort((a, b) => a.incarnationNumber - b.incarnationNumber);
      expect(incarnations.map((process) => process.incarnationNumber)).toEqual([1, 2]);
      expect(incarnations[0]?.status).toBe("blocked");
      expect(incarnations[0]?.exit).toBeNull();
      expect(incarnations[0]?.finishedAt).not.toBeNull();
      expect(incarnations[0]?.cleanupState).toBe("confirmed_dead");
      expect(incarnations[1]?.status).toBe("exited");
      expect(incarnations[1]?.replay).toBe("safe");
      expect(incarnations[0]?.replay).toBe("safe");
      expect(incarnations[0]?.commandHash).toBe(incarnations[1]?.commandHash);
      expect(incarnations[0]?.deadlineAt).toBe(incarnations[1]?.deadlineAt);
      expect(Date.parse(incarnations[1]?.launchIntentAt ?? "") >= Date.parse(incarnations[0]?.finishedAt ?? "")).toBe(true);
      expect(new Set(incarnations.map((process) => process.incarnationId)).size).toBe(2);
      expect(new Set(incarnations.map((process) => process.captures[0]?.path)).size).toBe(2);
    }
    expect(readFileSync(workerMarker, "utf8")).toBe(safeReplay && !validatorMode ? "ww" : "w");
    if (validatorMode) expect(readFileSync(validatorMarker, "utf8")).toBe(safeReplay ? "vv" : "v");
    else expect(existsSync(validatorMarker)).toBe(false);
    if (preflightMode) expect(readFileSync(join(directory, "preflight.txt"), "utf8")).toBe("pp");
    expect(existsSync(successorMarker)).toBe(safeReplay);
  } finally {
    if (runner !== undefined && runner.exitCode === null && runner.signalCode === null) {
      const runnerExit = new Promise<void>((resolve) => runner?.once("exit", () => resolve()));
      runner.kill("SIGKILL");
      await runnerExit;
    }
    if (pgid === undefined && existsSync(pgidPath)) {
      const markedPgid = Number(readFileSync(pgidPath, "utf8"));
      if (Number.isSafeInteger(markedPgid) && markedPgid > 0) pgid = markedPgid;
    }
    if (pgid !== undefined) await terminateProcessGroup(pgid, 50);
    if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("Durable process launch startup gate", () => {
  test("keeps a clean initial intent checkpoint launchable after service boot changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-startup-gate-"));
    const databasePath = join(directory, "durable.db");
    const markerPath = join(directory, "process-launched.txt");
    const source = [
      "steps:",
      "  - first:",
      `      run: 'echo $$ > ${markerPath}; sleep 0.05; printf gate-opened'`,
      "",
    ].join("\n");
    const oldBootId = randomUUID();
    const newBootId = randomUUID();
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(directory, "startup-gate-request", "command-chain-startup-gate-run", source);
      opened = await openCommandHarness(databasePath, oldBootId, { startupLaunchGate: "closed" });
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      opened.harness.resume();
      const initialIntent = await waitForProcessIntent(opened);
      expect(initialIntent.input.serviceBootId).toBe(oldBootId);
      expect(existsSync(markerPath)).toBe(false);
      // SAFETY: admission returns the numeric ID created for this run's ownerless conversation.
      const conversationId = admission.value.conversationId as ConversationId;
      const conversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("run conversation is missing");
      expect((await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => entry.kind === "workshop.process")).toHaveLength(0);

      await opened.harness.close(BACKGROUND_CONTEXT);
      opened = undefined;
      opened = await openCommandHarness(databasePath, newBootId, { startupLaunchGate: "closed" });
      opened.harness.resume();
      const reopenedIntent = await waitForProcessIntent(opened);
      expect(reopenedIntent.input.serviceBootId).toBe(oldBootId);
      expect(existsSync(markerPath)).toBe(false);
      const reopenedConversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (reopenedConversation === undefined) throw new Error("reopened run conversation is missing");

      opened.tasks.openStartupLaunchGate();
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      expect(existsSync(markerPath)).toBe(true);
      const entries = await reopenedConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processes = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data).process);
      const started = processes.find((process) => process.status === "running");
      expect(started?.launchServiceBootId).toBe(newBootId);
      expect(started?.identity?.serviceBootId).toBe(newBootId);
      expect(readFileSync(markerPath, "utf8")).toBe(`${started?.identity?.pid ?? ""}\n`);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  async function waitForProcessIntent(opened: CommandHarness) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
      const task = inspection.tasks.find((entry) => entry.record.kind === opened.tasks.ProcessExecutionTask.definition.name);
      if (task?.record.state.status === "running") {
        const input = processExecutionTaskInputSchema.parse(task.record.input);
        return { task, input };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error("process task did not reach its initial intent checkpoint");
  }
});

describe("Durable restart after process launch", () => {
  test("retires a surviving worker process group and blocks its successor after runner death", async () => {
    await verifyDurableRestartAfterProcessLaunch("worker");
  }, 15_000);

  test("retires a surviving validator group while retaining the candidate and not relaunching the worker", async () => {
    await verifyDurableRestartAfterProcessLaunch("validator");
  }, 15_000);

  test("replays a safe worker as a new incarnation with the same execution and deadline", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-worker");
  }, 15_000);

  test("replays a safe validator without regenerating its worker candidate", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-validator");
  }, 15_000);

  test("replays interrupted preflight with the same execution before dispatching the worker", async () => {
    await verifyDurableRestartAfterProcessLaunch("preflight");
  }, 15_000);
});

describe("Durable launch intent without process identity", () => {
  test("blocks a launched process when identity capture fails and does not replay after restart", async () => {
    await verifyDurableRestartAfterProcessLaunch("identity");
  }, 15_000);
});


const headlessChainSourceText = [
  "steps:",
  "  - first:",
  "      stream_cap: \"32\"",
  "      agent:",
  "        instructions: produce a checked candidate",
  "      check:",
  "        agent:",
  "          instructions: check the candidate",
  "  - second:",
  "      stream_cap: \"32\"",
  "      run: >-",
  "        printf 's' >> \"$WORKSHOP_TEST_SUCCESSORS\"; printf '%s-next' \"$(cat \"$WORKSHOP_PREVIOUS_OUTPUT_FILE\")\"",
  "",
].join("\n");

function headlessChainMachineConfig(validatorJson: string) {
  const workerCommand = [
    "printf 'w' >> \"$WORKSHOP_TEST_WORKERS\"",
    "echo \"$WORKSHOP_RESULT_FILE\" >> \"$WORKSHOP_TEST_RESULT_PATHS\"",
    "yes w | head -c 1100000",
    "printf '%s' '{\"version\":1,\"output\":\"validated candidate\",\"summary\":\"worker summary\",\"artifacts\":[]}' > \"$WORKSHOP_RESULT_FILE\"",
  ].join("; ");
  const validatorCommand = validatorJson === "__sleep__"
    ? [
      "printf 'v' >> \"$WORKSHOP_TEST_VALIDATORS\"",
      "cat \"$WORKSHOP_STEP_OUTPUT_FILE\" > \"$WORKSHOP_TEST_VALIDATOR_INPUT\"",
      "sleep 3",
    ].join("; ")
    : [
      "printf 'v' >> \"$WORKSHOP_TEST_VALIDATORS\"",
      "cat \"$WORKSHOP_STEP_OUTPUT_FILE\" > \"$WORKSHOP_TEST_VALIDATOR_INPUT\"",
      "echo \"$WORKSHOP_RESULT_FILE\" >> \"$WORKSHOP_TEST_RESULT_PATHS\"",
      "printf '%s' '" + validatorJson + "' > \"$WORKSHOP_RESULT_FILE\"",
      "yes v | head -c 1100000",
    ].join("; ");
  return {
    shell: "/bin/bash",
    keep_files: "always",
    agent: {
      model: "provider/model:low",
      harness: {
        command: "if grep -q 'Workshop validator attempt' \"$WORKSHOP_PROMPT_FILE\"; then " + validatorCommand + "; else " + workerCommand + "; fi",
      },
    },
  } as const;
}

function preserveEnvironment(names: readonly string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("Durable headless validation chain", () => {
  test("commits the agent result before validation and publishes only after a strict pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-headless-chain-"));
    const envNames = [
      "WORKSHOP_TEST_WORKERS",
      "WORKSHOP_TEST_VALIDATORS",
      "WORKSHOP_TEST_SUCCESSORS",
      "WORKSHOP_TEST_VALIDATOR_INPUT",
      "WORKSHOP_TEST_RESULT_PATHS",
    ];
    const restoreEnvironment = preserveEnvironment(envNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
      resultPaths: join(directory, "result-paths.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    process.env.WORKSHOP_TEST_RESULT_PATHS = markers.resultPaths;
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(
        directory,
        "headless-chain-request-001",
        "command-chain-headless-run-001",
        headlessChainSourceText,
        headlessChainMachineConfig('{"version":1,"passed":true,"reason":"candidate checks out"}'),
      );
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      expect(task.state.status).toBe("terminal");
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("headless chain did not settle");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toEqual({
        kind: "completed",
        terminalOutput: "validated candidate-next",
      });

      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("headless run disappeared");
      expect(stored.nodes.map((node) => node.status)).toEqual(["succeeded", "succeeded"]);
      const firstResult = stored.nodes[0]?.attempts[0]?.result;
      if (firstResult?.kind !== "settled" || firstResult.outcome.kind !== "succeeded") {
        throw new Error("first attempt lacks a successful candidate and validator outcome");
      }
      expect(firstResult.outcome.candidate).toMatchObject({ source: "agent", output: "validated candidate", summary: "worker summary" });
      expect(firstResult.outcome.validator).toMatchObject({
        kind: "agent",
        verdict: { version: 1, passed: true, reason: "candidate checks out" },
      });
      expect(readFileSync(markers.workers, "utf8")).toBe("w");
      expect(readFileSync(markers.validators, "utf8")).toBe("v");
      expect(readFileSync(markers.successors, "utf8")).toBe("s");
      expect(readFileSync(markers.validatorInput, "utf8")).toBe("validated candidate");

      const resultPaths = readFileSync(markers.resultPaths, "utf8").trim().split("\n");
      expect(resultPaths).toHaveLength(2);
      expect(new Set(resultPaths).size).toBe(2);
      const firstAttempt = stored.nodes[0]!.attempts[0]!;
      const workerRef = firstAttempt.processIncarnations.find((ref) => ref.executionId === firstAttempt.workerExecutionId);
      const validatorRef = firstAttempt.processIncarnations.find((ref) => ref.executionId === firstAttempt.validatorExecutionId);
      if (firstAttempt.workerExecutionId === null || firstAttempt.validatorExecutionId === null
        || workerRef === undefined || validatorRef === undefined) throw new Error("agent process identities were not committed");
      const workerPaths = processExecutionFiles({ role: "worker", nodeId: "first", incarnationNumber: 1 }, stored.paths.runDirectory, 1);
      const validatorPaths = processExecutionFiles({ role: "validator", nodeId: "first", incarnationNumber: 1 }, stored.paths.runDirectory, 1);
      expect(readFileSync(workerPaths.promptPath, "utf8")).toContain("produce a checked candidate");
      expect(readFileSync(validatorPaths.promptPath, "utf8")).toContain("immutable evidence");
      expect(workerPaths.resultPath).not.toBe(validatorPaths.resultPath);

      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("headless run conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processEntries = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const largeLogs = processEntries.flatMap((entry) => {
        const stdout = entry.process.captures.find((capture) => capture.stream === "stdout");
        return stdout !== undefined && stdout.totalBytes > 1024 * 1024 ? [stdout] : [];
      });
      expect(largeLogs).toHaveLength(2);
      for (const capture of largeLogs) {
        expect(capture.retainedBytes).toBe(32);
        expect(capture.truncatedBytes).toBe(capture.totalBytes - capture.retainedBytes);
        expect(capture.complete).toBe(false);
        expect(capture.sha256).toBe(hash(readFileSync(capture.path, "utf8")));
      }
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps the committed candidate and never starts a successor after validator failure", async () => {
    for (const mode of ["rejected", "malformed"] as const) {
      const directory = mkdtempSync(join(tmpdir(), `workshop-validator-${mode}-`));
      const envNames = [
        "WORKSHOP_TEST_WORKERS",
        "WORKSHOP_TEST_VALIDATORS",
        "WORKSHOP_TEST_SUCCESSORS",
        "WORKSHOP_TEST_VALIDATOR_INPUT",
        "WORKSHOP_TEST_RESULT_PATHS",
      ];
      const restoreEnvironment = preserveEnvironment(envNames);
      const markers = {
        workers: join(directory, "workers.txt"),
        validators: join(directory, "validators.txt"),
        successors: join(directory, "successors.txt"),
        validatorInput: join(directory, "validator-input.txt"),
        resultPaths: join(directory, "result-paths.txt"),
      };
      process.env.WORKSHOP_TEST_WORKERS = markers.workers;
      process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
      process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
      process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
      process.env.WORKSHOP_TEST_RESULT_PATHS = markers.resultPaths;
      let opened: CommandHarness | undefined;
      try {
        const verdict = mode === "rejected"
          ? '{"version":1,"passed":false,"reason":"candidate violates the constraint"}'
          : "not-json";
        const prepared = prepare(
          directory,
          `headless-validator-${mode}-request`,
          `command-chain-validator-${mode}-run`,
          headlessChainSourceText,
          headlessChainMachineConfig(verdict),
        );
        opened = await openCommandHarness(join(directory, "durable.db"));
        await initializeInstallation(opened.harness, prepared.canonicalHash);
        const admission = await admit(opened.harness, opened.tasks, prepared);
        expect(admission.ok).toBe(true);
        if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
        await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
        const task = await opened.harness.waitForTask(
          admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
          BACKGROUND_CONTEXT,
        );
        expect(task.state.status).toBe("terminal");
        if (task.state.outcome.status !== "completed") throw new Error("validator failure did not settle as a domain result");
        const outcome = runOutcomeSchema.parse(task.state.outcome.result);
        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") throw new Error("validator failure did not fail the workflow");
        expect(outcome.failure.kind).toBe(mode === "rejected" ? "validator_rejection" : "result_invalid");

        const stored = workflowRunDocumentV1Schema.parse(
          await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
        );
        if (stored.state !== "ready") throw new Error("failed headless run disappeared");
        const firstResult = stored.nodes[0]?.attempts[0]?.result;
        if (firstResult?.kind !== "settled" || firstResult.outcome.kind !== "failed") {
          throw new Error("failed validator attempt did not settle with checked evidence");
        }
        expect(firstResult.outcome.candidate?.output).toBe("validated candidate");
        if (mode === "rejected") {
          expect(firstResult.outcome.failure.kind).toBe("validator_rejection");
          expect(firstResult.outcome.validator).toMatchObject({ kind: "agent", verdict: { passed: false } });
        } else {
          expect(firstResult.outcome.failure.kind).toBe("result_invalid");
          expect(firstResult.outcome.validator).toBeNull();
        }
        expect(stored.nodes[1]?.status).toBe("pending");
        expect(readFileSync(markers.workers, "utf8")).toBe("w");
        expect(readFileSync(markers.validators, "utf8")).toBe("v");
        expect(existsSync(markers.successors)).toBe(false);
      } finally {
        if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
        restoreEnvironment();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  test("rejects an escaped unpaired surrogate before successor launch or output publication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-unpaired-worker-output-"));
    const envNames = ["WORKSHOP_TEST_WORKERS", "WORKSHOP_TEST_VALIDATORS", "WORKSHOP_TEST_SUCCESSORS", "WORKSHOP_TEST_VALIDATOR_INPUT", "WORKSHOP_TEST_RESULT_PATHS"];
    const restoreEnvironment = preserveEnvironment(envNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
      resultPaths: join(directory, "result-paths.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    process.env.WORKSHOP_TEST_RESULT_PATHS = markers.resultPaths;
    let opened: CommandHarness | undefined;
    try {
      const baseMachine = headlessChainMachineConfig('{"version":1,"passed":true,"reason":"candidate checks out"}');
      const validEnvelope = '{"version":1,"output":"validated candidate","summary":"worker summary","artifacts":[]}';
      const malformedEnvelope = JSON.stringify({ version: 1, output: "\uD800", summary: "worker summary", artifacts: [] });
      const machine = {
        ...baseMachine,
        agent: {
          ...baseMachine.agent,
          harness: {
            ...baseMachine.agent.harness,
            command: baseMachine.agent.harness.command.replace(validEnvelope, malformedEnvelope),
          },
        },
      };
      const prepared = prepare(directory, "unpaired-worker-request-001", "command-chain-unpaired-worker-run-001", headlessChainSourceText, machine);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      expect(task.state.status).toBe("terminal");
      if (task.state.outcome.status !== "completed") throw new Error("ill-formed worker output did not settle as a domain failure");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("ill-formed worker output was accepted");
      expect(outcome.failure.kind).toBe("result_invalid");

      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("ill-formed worker run disappeared");
      expect(stored.nodes.map((node) => node.status)).toEqual(["failed", "pending"]);
      const firstResult = stored.nodes[0]?.attempts[0]?.result;
      if (firstResult?.kind !== "settled" || firstResult.outcome.kind !== "failed") throw new Error("invalid result did not preserve checked failure evidence");
      expect(firstResult.outcome.failure.kind).toBe("result_invalid");
      expect(firstResult.outcome.candidate).toBeNull();
      expect(existsSync(join(stored.paths.runDirectory, "first.1", "candidate-output.txt"))).toBe(false);
      expect(readFileSync(markers.workers, "utf8")).toBe("w");
      expect(existsSync(markers.validators)).toBe(false);
      expect(existsSync(markers.successors)).toBe(false);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("does not rerun a committed worker when its validator times out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-validator-timeout-"));
    const envNames = [
      "WORKSHOP_TEST_WORKERS",
      "WORKSHOP_TEST_VALIDATORS",
      "WORKSHOP_TEST_SUCCESSORS",
      "WORKSHOP_TEST_VALIDATOR_INPUT",
      "WORKSHOP_TEST_RESULT_PATHS",
    ];
    const restoreEnvironment = preserveEnvironment(envNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
      resultPaths: join(directory, "result-paths.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    process.env.WORKSHOP_TEST_RESULT_PATHS = markers.resultPaths;
    let opened: CommandHarness | undefined;
    try {
      const timeoutSource = headlessChainSourceText.replace(
        ["      check:", "        agent:"].join("\n"),
        ["      check:", "        timeout: 1s", "        agent:"].join("\n"),
      );
      const prepared = prepare(
        directory,
        "headless-validator-timeout-request",
        "command-chain-validator-timeout-run",
        timeoutSource,
        headlessChainMachineConfig("__sleep__"),
      );
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(admission.failure.kind + ": " + admission.failure.message);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("validator timeout did not settle");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("validator timeout did not fail the workflow");
      expect(outcome.failure.kind).toBe("timeout");
      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("timed-out headless run disappeared");
      const attemptResult = stored.nodes[0]?.attempts[0]?.result;
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "failed") {
        throw new Error("timed-out validator did not retain a settled attempt");
      }
      expect(attemptResult.outcome.candidate?.output).toBe("validated candidate");
      expect(attemptResult.outcome.failure.kind).toBe("timeout");
      expect(stored.nodes[1]?.status).toBe("pending");
      expect(readFileSync(markers.workers, "utf8")).toBe("w");
      expect(readFileSync(markers.validators, "utf8")).toBe("v");
      expect(existsSync(markers.successors)).toBe(false);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  });

});

function commandValidatorChainSource(validatorCommand: string): string {
  return [
    "steps:",
    "  - first:",
    "      stream_cap: \"32\"",
    "      run: \"printf 'command-candidate'\"",
    "      check:",
    "        run: >-",
    "          " + validatorCommand,
    "  - second:",
    "      run: >-",
    "        printf '%s-next' \"$(cat \"$WORKSHOP_PREVIOUS_OUTPUT_FILE\")\"",
    "",
  ].join("\n");
}

describe("Durable command validator chain", () => {
  test("passes and rejects only after the committed candidate reaches the command validator", async () => {
    for (const mode of ["pass", "reject"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "workshop-command-validator-"));
      let opened: CommandHarness | undefined;
      try {
        const command = mode === "pass"
          ? "grep -qx command-candidate \"$WORKSHOP_STEP_OUTPUT_FILE\""
          : "exit 7";
        const prepared = prepare(
          directory,
          "command-validator-" + mode + "-request",
          "command-chain-validator-" + mode + "-run",
          commandValidatorChainSource(command),
        );
        opened = await openCommandHarness(join(directory, "durable.db"));
        await initializeInstallation(opened.harness, prepared.canonicalHash);
        const admission = await admit(opened.harness, opened.tasks, prepared);
        expect(admission.ok).toBe(true);
        if (!admission.ok) throw new Error(admission.failure.kind + ": " + admission.failure.message);
        await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
        const task = await opened.harness.waitForTask(
          admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
          BACKGROUND_CONTEXT,
        );
        expect(task.state.outcome.status).toBe("completed");
        if (task.state.outcome.status !== "completed") throw new Error("command validator chain did not settle");
        const outcome = runOutcomeSchema.parse(task.state.outcome.result);
        const stored = workflowRunDocumentV1Schema.parse(
          await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
        );
        if (stored.state !== "ready") throw new Error("command validator run disappeared");
        const firstResult = stored.nodes[0]?.attempts[0]?.result;
        if (firstResult?.kind !== "settled") throw new Error("command worker candidate did not settle");
        if (mode === "pass") {
          expect(outcome).toEqual({ kind: "completed", terminalOutput: "command-candidate-next" });
          expect(firstResult.outcome.kind).toBe("succeeded");
          if (firstResult.outcome.kind !== "succeeded") throw new Error("passing command validator did not accept the candidate");
          expect(firstResult.outcome.candidate.output).toBe("command-candidate");
          expect(firstResult.outcome.validator).toMatchObject({ kind: "command", exit: { kind: "code", code: 0 } });
          expect(stored.nodes.map((node) => node.status)).toEqual(["succeeded", "succeeded"]);
        } else {
          expect(outcome.kind).toBe("failed");
          if (outcome.kind !== "failed") throw new Error("failing command validator passed the workflow");
          expect(outcome.failure.kind).toBe("validator_rejection");
          expect(firstResult.outcome.kind).toBe("failed");
          if (firstResult.outcome.kind !== "failed") throw new Error("command validator rejection lost attempt evidence");
          expect(firstResult.outcome.candidate?.output).toBe("command-candidate");
          expect(firstResult.outcome.failure.kind).toBe("validator_rejection");
          expect(firstResult.outcome.validator).toMatchObject({ kind: "command", exit: { kind: "code", code: 7 } });
          expect(stored.nodes[1]?.status).toBe("pending");
        }
      } finally {
        if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});

const agentProcessSourceText = [
  "steps:",
  "  - first:",
  "      timeout: 5s",
  "      stream_cap: \"4\"",
  "      agent:",
  "        instructions: worker instructions",
  "      check:",
  "        agent:",
  "          instructions: validator instructions",
  "",
].join("\n");
const agentProcessMachineConfig = {
  shell: "/bin/bash",
  agent: {
    harness: { command: "(sleep 30) & printf '%s' \"$WORKSHOP_TEST_AT_LAUNCH\"; yes x | head -c 1100000; printf '%s' '{\"version\":1,\"output\":\"agent-result\",\"summary\":\"checked\",\"artifacts\":[]}' > \"$WORKSHOP_RESULT_FILE\"" },
    model: "provider/model:low",
  },
} as const;

  test("allows an active validator to launch and finish while the run is paused", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-paused-validator-"));
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(
        directory,
        "paused-validator-request-001",
        "agent-process-adapter-paused-run-001",
        agentProcessSourceText,
        agentProcessMachineConfig,
        "agent-process-adapter",
      );
      opened = await openCommandHarness(join(directory, "durable.db"));
      const seeded = await seedAgentProcessTasks(opened.harness, opened.tasks, prepared, { pauseBeforeValidator: true });
      const validatorTaskId = seeded.taskIds[1];
      if (validatorTaskId === undefined) throw new Error("paused validator task was not created");
      const validatorTask = await opened.harness.waitForTask(validatorTaskId, BACKGROUND_CONTEXT);
      expect(validatorTask.state.status).toBe("terminal");
      expect(validatorTask.state.outcome.status).toBe("completed");
      if (validatorTask.state.outcome.status !== "completed") throw new Error("paused validator did not return checked process evidence");
      expect(processExecutionTaskResultSchema.parse(validatorTask.state.outcome.result).kind).toBe("exited");

      const conversation = await opened.harness.conversation(seeded.conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("paused validator conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const validatorRecords = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data))
        .filter((entry) => entry.process.role === "validator");
      expect(validatorRecords.some((entry) => entry.process.status === "exited"
        && entry.process.cleanupState === "confirmed_dead")).toBe(true);

      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, seeded.conversationId, BACKGROUND_CONTEXT),
      );
      expect(stored.state).toBe("ready");
      if (stored.state !== "ready") throw new Error("paused run disappeared");
      expect(stored.status).toBe("paused");
      expect(stored.desiredState).toBe("paused");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });


describe("safe process replay policy", () => {
  test("requires safe policy, checked group death, no exit receipt, an active run, time, and a remaining relaunch", () => {
    const base = {
      replayPolicy: "safe" as const,
      recordedReplayPolicy: "safe" as const,
      incarnationNumber: 1,
      runStatus: "running" as const,
      desiredState: "running" as const,
      deadlineAt: iso(20_000),
      confirmedDead: true,
      hasExitReceipt: false,
      now: 10_000,
    };
    const decide = (overrides: Partial<Parameters<typeof decideProcessReplay>[0]> = {}) => decideProcessReplay({ ...base, ...overrides });

    expect(decide()).toBeNull();
    expect(decide({ incarnationNumber: 2 })).toBeNull();
    expect(decide({ incarnationNumber: 3 })).toContain("replay limit");
    expect(decide({ replayPolicy: "never" })).toContain("policy");
    expect(decide({ recordedReplayPolicy: "never" })).toContain("policy");
    expect(decide({ confirmedDead: false })).toContain("confirmed death");
    expect(decide({ hasExitReceipt: true })).toContain("checked exit receipt");
    expect(decide({ desiredState: "stopped" })).toContain("stopped");
    expect(decide({ runStatus: "blocked" })).toContain("no longer authorizes");
    expect(decide({ deadlineAt: iso(10_000) })).toContain("deadline");
  });
});


describe("Durable process execution adapter", () => {
  test("keeps large agent and validator stdout diagnostic while preserving their result file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-adapter-"));
    const previousValue = process.env.WORKSHOP_TEST_AT_LAUNCH;
    const ambientValue = "inherited-only-at-launch";
    let opened: CommandHarness | undefined;
    process.env.WORKSHOP_TEST_AT_LAUNCH = ambientValue;
    try {
      const prepared = prepare(
        directory,
        "process-adapter-request-001",
        "agent-process-adapter-run-001",
        agentProcessSourceText,
        agentProcessMachineConfig,
        "agent-process-adapter",
      );
      opened = await openCommandHarness(join(directory, "durable.db"));
      const seeded = await seedAgentProcessTasks(opened.harness, opened.tasks, prepared);
      expect(seeded.inputs.map((input) => input.role)).toEqual(["worker", "validator"]);
      expect(seeded.inputs.every((input) => input.env.WORKSHOP_TEST_AT_LAUNCH === undefined)).toBe(true);
      expect(seeded.inputs.every((input) => input.command.includes("$WORKSHOP_TEST_AT_LAUNCH"))).toBe(true);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const conversation = await opened.harness.conversation(seeded.conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("process adapter conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processes = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const exited = processes.filter((entry) => entry.process.status === "exited");
      const launching = processes.filter((entry) => entry.process.status === "launching");
      const running = processes.filter((entry) => entry.process.status === "running");
      expect(exited.map((entry) => [entry.process.role, entry.process.cleanupState]).sort()).toEqual([
        ["validator", "confirmed_dead"],
        ["worker", "confirmed_dead"],
      ]);
      expect(launching).toHaveLength(2);
      expect(running).toHaveLength(2);
      expect(running.every((entry) => entry.process.identity !== null)).toBe(true);
      expect(JSON.stringify(processes)).not.toContain(ambientValue);
      const logs = exited.map((entry) => {
        const stdout = entry.process.captures.find((capture) => capture.stream === "stdout");
        if (stdout === undefined) throw new Error("exited process evidence lacks stdout capture");
        const text = readFileSync(stdout.path, "utf8");
        expect(stdout.totalBytes).toBeGreaterThan(1024 * 1024);
        expect(stdout.retainedBytes).toBe(4);
        expect(stdout.truncatedBytes).toBe(stdout.totalBytes - stdout.retainedBytes);
        expect(stdout.complete).toBe(false);
        expect(stdout.sha256).toBe(hash(text));
        return text;
      });
      expect(logs).toEqual(["inh\n", "inh\n"]);
      const taskResults = await Promise.all(seeded.taskIds.map((taskId) => opened!.harness.waitForTask(taskId, BACKGROUND_CONTEXT)));
      const results = taskResults.map((task) => {
        expect(task.state.status).toBe("terminal");
        expect(task.state.outcome.status).toBe("completed");
        if (task.state.outcome.status !== "completed") throw new Error("agent process lacked a checked outcome");
        return processExecutionTaskResultSchema.parse(task.state.outcome.result);
      });
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.kind === "exited" && !result.timedOut
        && result.exit.kind === "code" && result.exit.code === 0
        && result.semanticStdout.kind === "not_captured")).toBe(true);
      const resultPath = seeded.inputs[0]?.env.WORKSHOP_RESULT_FILE;
      if (resultPath === undefined) throw new Error("agent process input lacks its result path");
      const checkedResult = parseWorkerResultBytes(readFileSync(resultPath));
      expect(checkedResult.ok).toBe(true);
      if (!checkedResult.ok) throw new Error(`agent result failed validation: ${checkedResult.failure.message}`);
      expect(checkedResult.value.output).toBe("agent-result");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      if (previousValue === undefined) delete process.env.WORKSHOP_TEST_AT_LAUNCH;
      else process.env.WORKSHOP_TEST_AT_LAUNCH = previousValue;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unsafe absolute-deadline arithmetic before dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-unsafe-deadline-"));
    const unsafeDeadlineSource = [
      "steps:",
      "  - first:",
      "      timeout: 9007199254740991ms",
      "      run: \"printf 'must-not-launch'\"",
      "",
    ].join("\n");
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(
        directory,
        "unsafe-deadline-request-001",
        "unsafe-deadline-run-001",
        unsafeDeadlineSource,
      );
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash, prepared.workflowId);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(`${admission.failure.kind}: ${admission.failure.message}`);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      expect(task.state.status).toBe("terminal");
      expect(task.state.outcome.status).toBe("completed");
      if (task.state.outcome.status !== "completed") throw new Error("unsafe deadline did not settle as a domain outcome");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("unsafe deadline did not fail the run");
      expect(outcome.failure.kind).toBe("runtime_fault");
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("unsafe-deadline conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.filter((entry) => entry.kind === "workshop.process")).toHaveLength(0);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function seedAgentProcessTasks(
  harness: CommandHarness["harness"],
  tasks: CommandHarness["tasks"],
  prepared: ReturnType<typeof prepare>,
  options: { readonly pauseBeforeValidator?: boolean } = {},
): Promise<{
  conversationId: ConversationId;
  inputs: ReturnType<typeof processExecutionTaskInputSchema.parse>[];
  taskIds: TaskId<ReturnType<typeof processExecutionTaskResultSchema.parse>>[];
}> {
  const nodeId = prepared.chain.order[0];
  if (nodeId === undefined) throw new Error("prepared chain has no node");
  const settings = prepared.resolvedSettings.nodes[nodeId];
  const validatorSite = settings?.validator;
  if (settings === undefined || settings.run.kind !== "agent" || validatorSite?.kind !== "agent") {
    throw new Error("test fixture must resolve an agent worker and agent validator");
  }
  const attemptId = attemptIdSchema.parse("process-adapter-attempt-001");
  const workerExecutionId = executionIdSchema.parse("process-adapter-worker-001");
  const validatorExecutionId = executionIdSchema.parse("process-adapter-validator-001");
  const startedAt = prepared.admittedAt;
  const workerIncarnationId = incarnationIdSchema.parse("process-adapter-worker-incarnation-001");
  const validatorIncarnationId = incarnationIdSchema.parse("process-adapter-validator-incarnation-001");
  const inputs: ReturnType<typeof processExecutionTaskInputSchema.parse>[] = [];
  const taskIds: TaskId<ReturnType<typeof processExecutionTaskResultSchema.parse>>[] = [];
  let conversationId: ConversationId | undefined;
  let workerTaskId: TaskId<ReturnType<typeof processExecutionTaskResultSchema.parse>> | undefined;

  await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    conversationId = conversation.id;
    const run = workflowRunDocumentV1Schema.parse({
      state: "ready",
      runId: prepared.runId,
      workflowId: prepared.workflowId,
      activationId: prepared.activationId,
      occurrenceId: prepared.occurrenceId,
      requestId: prepared.requestId,
      admissionSequence: 1,
      admittedAt: prepared.admittedAt,
      sourceText: prepared.sourceText,
      sourceHash: prepared.sourceHash,
      canonicalDefinition: prepared.definition,
      canonicalHash: prepared.canonicalHash,
      resolvedSettings: prepared.resolvedSettings,
      chain: prepared.chain,
      paths: prepared.paths,
      runtimeManifest: prepared.runtimeManifest,
      durable: { conversationId: Number(conversation.id), workflowTaskId: 1 },
      status: options.pauseBeforeValidator ? "paused" : "running",
      desiredState: options.pauseBeforeValidator ? "paused" : "running",
      startedAt,
      finishedAt: null,
      currentNodeId: nodeId,
      currentAttemptId: attemptId,
      block: null,
      failure: null,
      preflight: { kind: "not_configured" },
      nodes: prepared.chain.order.map((id) => id === nodeId
        ? {
          nodeId: id,
          status: "running",
          successfulAttemptId: null,
          attempts: [{
            attemptId,
            number: 1,
            taskId: 2,
            status: "executing",
            phase: "awaitWorker",
            startedAt,
            finishedAt: null,
            elapsedMs: null,
            workerExecutionId,
            validatorExecutionId: null,
            result: { kind: "pending" },
            processIncarnations: [],
            blockIds: [],
            judgments: [],
          }],
        }
        : { nodeId: id, status: "pending", successfulAttemptId: null, attempts: [] }),
      resolutions: [],
      terminalOutput: null,
    });
    Object.assign(await tx.doc(WorkshopRunDoc, conversation.id), run);
    const input = createAdapterAgentProcessInput({
      run: readyRun(run),
      nodeId,
      attemptId,
      nodeTaskId: 2,
      role: "worker",
      executionId: workerExecutionId,
      incarnationId: workerIncarnationId,
      serviceBootId: tasks.serviceBootId,
      launchIntentAt: startedAt,
      site: settings.run,
    });
    inputs.push(input);
    workerTaskId = await tx.createTask(tasks.ProcessExecutionTask, input, {
      ownership: { kind: "conversation" },
      conversationId: conversation.id,
    });
    taskIds.push(workerTaskId);
  }, BACKGROUND_CONTEXT);
  if (conversationId === undefined || workerTaskId === undefined) throw new Error("process fixture worker was not created");
  await harness.waitForTask(workerTaskId, BACKGROUND_CONTEXT);

  const candidate = nodeResultSchema.parse({
    version: 1,
    source: "agent",
    output: "seeded candidate",
    summary: "candidate committed before validator",
    artifacts: [],
    sourceBytesHash: hash("seeded candidate"),
    exit: { kind: "code", code: 0 },
  });
  let validatorTaskId: TaskId<ReturnType<typeof processExecutionTaskResultSchema.parse>> | undefined;
  await harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopRunDoc, conversationId!);
    const current = workflowRunDocumentV1Schema.parse(draft);
    if (current.state !== "ready") throw new Error("process fixture run is not initialized");
    const updated = workflowRunDocumentV1Schema.parse({
      ...current,
      nodes: current.nodes.map((node) => node.nodeId !== nodeId ? node : {
        ...node,
        attempts: node.attempts.map((attempt) => attempt.attemptId !== attemptId ? attempt : {
          ...attempt,
          status: "validating",
          phase: "awaitValidator",
          validatorExecutionId,
          result: { kind: "candidate_committed", candidate },
        }),
      }),
    });
    Object.assign(draft, updated);
    const input = createAdapterAgentProcessInput({
      run: readyRun(updated),
      nodeId,
      attemptId,
      nodeTaskId: 2,
      role: "validator",
      executionId: validatorExecutionId,
      incarnationId: validatorIncarnationId,
      serviceBootId: tasks.serviceBootId,
      launchIntentAt: startedAt,
      site: validatorSite,
    });
    inputs.push(input);
    validatorTaskId = await tx.createTask(tasks.ProcessExecutionTask, input, {
      ownership: { kind: "conversation" },
      conversationId: conversationId!,
    });
    taskIds.push(validatorTaskId);
  }, BACKGROUND_CONTEXT);
  if (validatorTaskId === undefined) throw new Error("process fixture validator was not created");
  return { conversationId, inputs, taskIds };
}

type ReadyWorkflowRun = Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { state: "ready" }>;

function readyRun(value: ReturnType<typeof workflowRunDocumentV1Schema.parse>): ReadyWorkflowRun {
  if (value.state !== "ready") throw new Error("expected a ready run fixture");
  return value;
}

function createAdapterAgentProcessInput(args: {
  run: ReadyWorkflowRun;
  nodeId: ReadyWorkflowRun["nodes"][number]["nodeId"];
  attemptId: ReturnType<typeof attemptIdSchema.parse>;
  nodeTaskId: number;
  role: "worker" | "validator";
  executionId: ReturnType<typeof executionIdSchema.parse>;
  incarnationId: ReturnType<typeof incarnationIdSchema.parse>;
  serviceBootId: string;
  launchIntentAt: string;
  site: ResolvedExecutionSite;
}): ReturnType<typeof processExecutionTaskInputSchema.parse> {
  if (args.site.kind !== "agent") throw new Error("adapter test expects an agent execution site");
  const deadlineAt = args.site.timeoutMs === null
    ? null
    : iso(Date.parse(args.launchIntentAt) + args.site.timeoutMs);
  const paths = processExecutionFiles({ role: args.role, nodeId: args.nodeId, incarnationNumber: 1 }, args.run.paths.runDirectory, 1);
  const base: ProcessExecutionTaskEnvironmentInput = {
    runId: args.run.runId,
    workflowId: args.run.workflowId,
    activationId: args.run.activationId,
    occurrenceId: args.run.occurrenceId,
    workflowTaskId: args.run.durable.workflowTaskId,
    nodeTaskId: args.nodeTaskId,
    nodeId: args.nodeId,
    attemptId: args.attemptId,
    executionId: args.executionId,
    incarnationId: args.incarnationId,
    incarnationNumber: 1,
    serviceBootId: args.serviceBootId,
    role: args.role,
    launchIntentAt: args.launchIntentAt,
    deadlineAt,
    shell: args.site.shell,
    command: args.site.harnessCommand,
    cwd: args.site.cwd,
    timeoutMs: args.site.timeoutMs,
    streamCapBytes: args.site.streamCapBytes,
    replay: args.site.replay,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  };
  return processExecutionTaskInputSchema.parse({
    ...base,
    env: buildProcessExecutionEnvironment(base, args.run, 1),
  });
}
