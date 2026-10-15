import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import { workflowRunDocumentV1Schema, workshopEventV1Schema, workshopProcessV1Schema } from "../src/run/records.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { WorkshopInstallationDoc, WorkshopRunDoc, WorkshopProcessEntry } from "../src/storage/durable/define-workshop-records.js";
import {
  buildProcessExecutionEnvironment,
  decideProcessReplay,
  processExecutionFiles,
  processExecutionTaskInputSchema,
  processExecutionTaskResultSchema,
  type ProcessExecutionTaskEnvironmentInput,
} from "../src/storage/durable/define-process-execution-task.js";
import { reconstructProcessStdin } from "../src/attempt/build-process-stdin.js";
import { locateWorkflowDirectory } from "../src/run/locate-run-files.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const sourceText = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - first:",
  "      run: \"printf 'alpha'\"",
  "  - second:",
  "      run: >-",
  "        printf '%s-beta' \"$(cat)\"",
  "",
].join("\n");
const timeoutSourceText = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - first:",
  "      timeout: 1s",
  "      run: exec sleep 30",
  "",
].join("\n");
const failureSourceText = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - first:",
  "      run: >-",
  "        printf 'expected failure'; exit 7",
  "",
].join("\n");
const abortSourceText = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
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
) {
  const opened = await openDurableStorage(databasePath);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const taskOptions = options.startupLaunchGate === undefined ? {} : { startupLaunchGate: options.startupLaunchGate };
  const tasks = defineWorkshopTasks(serviceBootId, taskOptions);
  const registry = createRegistry();
  registry.install({
    name: "workshop-command-runtime",
    tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask],
  });
  const harness = await Harness.open(opened.storage, {
    models: createModels(),
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
    stateDirectory: join(directory, ".workshop", "state"),
    resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: hash("command-only integration test"),
      taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1 },
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
      const stdoutByteCounts = exited.map((entry) => {
        const capture = entry.process.captures.find((item) => item.stream === "stdout");
        if (capture === undefined) throw new Error("exited process lacks stdout evidence");
        return capture.totalBytes;
      });
      expect(stdoutByteCounts.sort((left, right) => left - right)).toEqual([5, 10]);

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
      expect(existsSync(join(directory, ".workshop", "runs", prepared.runId))).toBe(false);
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

describe("Durable workflow compatibility", () => {
  test("blocks a migrated WorkflowRun v8 checkpoint under the stdin runtime", async () => {
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
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("migrated WorkflowRun did not settle");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind !== "blocked") throw new Error("legacy process contract bypassed the runtime gate");
      expect(outcome.block.kind).toBe("runtime_incompatible");
      const run = workflowRunDocumentV1Schema.parse(await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT));
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("migrated run is missing its canonical document");
      expect(run.status).toBe("blocked");
      expect(run.block?.kind).toBe("runtime_incompatible");
      expect(run.runtimeManifest.taskVersions).toEqual({ workflowRun: 8, nodeAttempt: 4, processExecution: 4, capacityGate: 1 });
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("legacy WorkflowRun conversation is missing");
      expect((await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => entry.kind === "workshop.process")).toHaveLength(0);
    } finally {
      if (v8Harness !== undefined) await v8Harness.close(BACKGROUND_CONTEXT);
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("canonical worker output views", () => {
  test("feeds successor stdin from stored output, not a stale file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-canonical-output-"));
    const databasePath = join(directory, "durable.db");
    let opened: CommandHarness | undefined;
    let conversationId: ConversationId | undefined;
    const prepared = prepare(directory, "canonical-output-request-001", "command-chain-run-001");
    const staleInputPath = join(directory, ".workshop", "state", "captures", prepared.runId, "second.1", "legacy-input-poison.txt");
    try {
      const candidate = nodeResultSchema.parse({
        version: 2,
        source: "command",
        output: "alpha",
        summary: "",
        artifacts: [],
        sourceBytesHash: hash("alpha"),
        stdioResult: { version: 1, mode: "text", status: "succeeded", reason: null, question: null },
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

      mkdirSync(join(directory, ".workshop", "state", "captures", prepared.runId, "second.1"), { recursive: true });
      writeFileSync(staleInputPath, "stale input from disk", "utf8");

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
      expect(readFileSync(staleInputPath, "utf8")).toBe("stale input from disk");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("format 4 stdout outcomes", () => {
  test("completes early results, waits for human input, and retains verifier blocks", async () => {
    const cases = [
      {
        status: "success_and_complete" as const,
        output: ["<status>success_and_complete</status>", "<reason>workflow is complete</reason>", "<output>final proposal</output>"].join("\n"),
        verifierOutput: acceptedVerifierOutput,
        outputRole: "worker" as const,
        runStatus: "completed" as const,
        blockKind: null,
      },
      {
        status: "needs_input" as const,
        output: ["<status>needs_input</status>", "<reason>required detail is missing</reason>", "<question>Which location should I use?</question>", "<output>pending proposal</output>"].join("\n"),
        verifierOutput: acceptedVerifierOutput,
        outputRole: "worker" as const,
        runStatus: "waiting" as const,
        blockKind: null,
      },
      {
        status: "verifier_block" as const,
        output: taggedWorkerOutput,
        verifierOutput: "block\ncandidate needs an unsupported action",
        outputRole: "validator" as const,
        runStatus: "blocked" as const,
        blockKind: "verifier_block",
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const directory = mkdtempSync(join(tmpdir(), "workshop-stdio-gate-"));
      const envNames = ["WORKSHOP_TEST_WORKERS", "WORKSHOP_TEST_VALIDATORS", "WORKSHOP_TEST_SUCCESSORS", "WORKSHOP_TEST_VALIDATOR_INPUT"];
      const restoreEnvironment = preserveEnvironment(envNames);
      const markers = {
        workers: join(directory, "workers.txt"),
        validators: join(directory, "validators.txt"),
        successors: join(directory, "successors.txt"),
        validatorInput: join(directory, "validator-input.txt"),
      };
      process.env.WORKSHOP_TEST_WORKERS = markers.workers;
      process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
      process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
      process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
      let opened: CommandHarness | undefined;
      try {
        const workerCommand = fixture.outputRole === "worker" ? "printf '%s' '" + fixture.output + "'" : undefined;
        const machine = headlessChainMachineConfig(fixture.verifierOutput, workerCommand);
        const prepared = prepare(directory, "stdio-gate-request-" + index, "command-chain-stdio-gate-run-" + index, headlessChainSourceText, machine);
        opened = await openCommandHarness(join(directory, "durable.db"));
        await initializeInstallation(opened.harness, prepared.canonicalHash);
        const admission = await admit(opened.harness, opened.tasks, prepared);
        if (!admission.ok) throw new Error(admission.failure.kind + ": " + admission.failure.message);
        await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
        const task = await opened.harness.waitForTask(
          admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
          BACKGROUND_CONTEXT,
        );
        if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("stdio outcome run did not settle");
        const outcome = runOutcomeSchema.parse(task.state.outcome.result);
        const stored = workflowRunDocumentV1Schema.parse(
          await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
        );
        if (stored.state !== "ready") throw new Error("stdio outcome run disappeared");
        expect(stored.status).toBe(fixture.runStatus);
        expect(stored.nodes[1]?.status).toBe(fixture.runStatus === "completed" ? "skipped" : "pending");
        expect(readFileSync(markers.workers, "utf8")).toBe("w");
        expect(existsSync(markers.successors)).toBe(false);

        const result = stored.nodes[0]?.attempts[0]?.result;
        if (result?.kind !== "settled") throw new Error("stdio outcome lacks settled attempt evidence");
        const candidate = result.outcome.kind === "succeeded" || result.outcome.kind === "blocked"
          ? result.outcome.candidate : null;
        if (candidate === null || !("stdioResult" in candidate)) throw new Error("tagged result is missing checked stdio fields");
        expect(candidate.version).toBe(2);
        if (fixture.status === "success_and_complete") {
          expect(outcome).toEqual({ kind: "completed", terminalOutput: "final proposal" });
          expect(result.outcome.kind).toBe("succeeded");
          if (result.outcome.kind !== "succeeded") throw new Error("success_and_complete did not succeed");
          expect(candidate.stdioResult.status).toBe("success_and_complete");
          expect(stored.terminalOutput).toBe("final proposal");
        } else if (fixture.status === "needs_input") {
          expect(outcome.kind).toBe("waiting");
          expect(result.outcome.kind).toBe("succeeded");
          expect(stored.waits?.[0]).toMatchObject({ output: "pending proposal", question: "Which location should I use?" });
        } else {
          expect(outcome.kind).toBe("blocked");
          if (outcome.kind !== "blocked") throw new Error("verifier block did not settle as blocked");
          expect(String(outcome.block.kind)).toBe(fixture.blockKind);
          expect(result.outcome.kind).toBe("blocked");
          if (result.outcome.kind !== "blocked") throw new Error("tagged status lacks a checked block");
          expect(String(result.outcome.block.kind)).toBe(fixture.blockKind);
        }
        if (fixture.status !== "verifier_block") {
          expect(candidate.stdioResult.status).toBe(fixture.status);
          expect(existsSync(markers.validators)).toBe(true);
        } else {
          expect(readFileSync(markers.validators, "utf8")).toBe("v");
          expect(result.outcome.kind).toBe("blocked");
          if (result.outcome.kind !== "blocked") throw new Error("verifier block did not retain a blocked outcome");
          expect(result.outcome.validator).toMatchObject({
            kind: "agent",
            verdict: { version: 2, decision: "block", reason: "candidate needs an unsupported action" },
          });
        }
      } finally {
        if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
        restoreEnvironment();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});

async function verifyDurableRestartAfterProcessLaunch(
  mode: "worker" | "identity" | "safe-worker" | "safe-validator" | "preflight",
  tamperOriginalIdentity = false,
  crashes = 1,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `workshop-restart-${mode}-`));
  const safeReplay = mode === "safe-worker" || mode === "safe-validator";
  const preflightMode = mode === "preflight";
  const replayedProcess = (safeReplay || preflightMode) && !tamperOriginalIdentity;
  const validatorMode = mode === "safe-validator";
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
    for (let crash = 0; crash < crashes; crash += 1) {
      rmSync(readyPath, { force: true });
      rmSync(pgidPath, { force: true });
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
          WORKSHOP_CRASH_HANG_LAUNCHES: String(crashes),
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
    }
    if (pgid === undefined) throw new Error("no interrupted process group was recorded");
    const admission = JSON.parse(readFileSync(metadataPath, "utf8")) as { conversationId: number; workflowTaskId: number };
    if (tamperOriginalIdentity) {
      tamperOriginalProcessIncarnation(databasePath, admission.conversationId, preflightMode ? "preflight" : validatorMode ? "validator" : "worker");
    }

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
      expect(runOutcome.block.kind).toBe(tamperOriginalIdentity ? "integrity_failed" : "external_outcome_unknown");
    }

    const conversationId = admission.conversationId as ConversationId;
    const stored = workflowRunDocumentV1Schema.parse(
      await opened.harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT),
    );
    if (stored.state !== "ready") throw new Error("recovered run document is missing");
    expect(stored.status).toBe(replayedProcess ? "completed" : "blocked");
    expect(stored.nodes.map((node) => node.status)).toEqual(replayedProcess
      ? preflightMode ? ["succeeded"] : ["succeeded", "succeeded"]
      : preflightMode ? ["pending"] : ["blocked", "pending"]);
    expect(stored.nodes[0]?.attempts).toHaveLength(preflightMode && tamperOriginalIdentity ? 0 : 1);
    const firstAttempt = stored.nodes[0]?.attempts[0];
    const attemptResult = firstAttempt?.result;
    if (replayedProcess) {
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "succeeded") {
        throw new Error("safe replay did not settle the original semantic attempt");
      }
      expect(attemptResult.outcome.candidate.output).toBe(preflightMode ? "preflight-worker" : validatorMode ? "candidate" : "replayed");
    } else if (!preflightMode) {
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "blocked") {
        throw new Error("recovered attempt lacks a durable block outcome");
      }
      expect(attemptResult.outcome.block.kind).toBe(tamperOriginalIdentity ? "integrity_failed" : "external_outcome_unknown");
    }
    if (validatorMode && !preflightMode) {
      expect(attemptResult?.kind === "settled" && attemptResult.outcome.kind === "blocked" ? attemptResult.outcome.candidate?.output : "candidate").toBe("candidate");
    } else if (!replayedProcess && !preflightMode) {
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
      .filter((entry) => entry.process.role === targetRole && entry.process.status === "blocked"
        && entry.process.incarnationNumber === crashes)
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
      expect(incarnations.map((process) => process.incarnationNumber)).toEqual(Array.from({ length: crashes + 1 }, (_, index) => index + 1));
      expect(incarnations[0]?.status).toBe("blocked");
      expect(incarnations[0]?.exit).toBeNull();
      expect(incarnations[0]?.finishedAt).not.toBeNull();
      expect(incarnations[0]?.cleanupState).toBe("confirmed_dead");
      expect(incarnations.at(-1)?.status).toBe("exited");
      expect(incarnations.at(-1)?.replay).toBe("safe");
      expect(incarnations[0]?.replay).toBe("safe");
      expect(incarnations[0]?.commandHash).toBe(incarnations.at(-1)?.commandHash);
      expect(incarnations[0]?.stdio?.stdinSha256).toBeDefined();
      expect(incarnations.at(-1)?.stdio?.stdinSha256).toBe(incarnations[0]?.stdio?.stdinSha256);
      expect(incarnations.at(-1)?.stdio?.stdinByteCount).toBe(incarnations[0]?.stdio?.stdinByteCount);
      expect(incarnations[0]?.deadlineAt).toBe(incarnations.at(-1)?.deadlineAt);
      expect(Date.parse(incarnations.at(-1)?.launchIntentAt ?? "") >= Date.parse(incarnations[0]?.finishedAt ?? "")).toBe(true);
      expect(new Set(incarnations.map((process) => process.incarnationId)).size).toBe(crashes + 1);
      expect(new Set(incarnations.map((process) => process.captures[0]?.path)).size).toBe(crashes + 1);
    }
    if (preflightMode && tamperOriginalIdentity) expect(existsSync(workerMarker)).toBe(false);
    else expect(readFileSync(workerMarker, "utf8")).toBe(safeReplay && !validatorMode && !tamperOriginalIdentity ? "w".repeat(crashes + 1) : "w");
    if (validatorMode) expect(readFileSync(validatorMarker, "utf8")).toBe(safeReplay && !tamperOriginalIdentity ? "vv" : "v");
    else expect(existsSync(validatorMarker)).toBe(false);
    if (preflightMode) expect(readFileSync(join(directory, "preflight.txt"), "utf8")).toBe(tamperOriginalIdentity ? "p" : "pp");
    expect(existsSync(successorMarker)).toBe(safeReplay && !tamperOriginalIdentity);
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

function tamperOriginalProcessIncarnation(databasePath: string, conversationId: number, role: "worker" | "validator" | "preflight"): void {
  const database = new DatabaseSync(databasePath);
  try {
    const entries = database.prepare("SELECT id, record FROM entries WHERE conversation_id = ?").all(conversationId) as Array<{ id: number; record: string }>;
    const target = entries.find(({ record }) => {
      const entry = JSON.parse(record) as { kind?: string; data?: { process?: { role?: string; status?: string; incarnationNumber?: number; incarnationId?: string } } };
      return entry.kind === "workshop.process" && entry.data?.process?.role === role
        && entry.data.process.status === "running" && entry.data.process.incarnationNumber === 1;
    });
    if (target === undefined) throw new Error("original process identity is missing");
    const original = (JSON.parse(target.record) as { data: { process: { incarnationId: string } } }).data.process.incarnationId;
    const tampered = original.slice(0, -1) + (original.endsWith("0") ? "1" : "0");
    database.prepare("UPDATE entries SET record = json_set(record, '$.data.process.incarnationId', ?) WHERE id = ?")
      .run(tampered, target.id);
  } finally {
    database.close();
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
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
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

  test("replays a safe worker as a new incarnation with the same execution and deadline", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-worker");
  }, 15_000);

  test("keeps the original stdin identity through a third worker incarnation", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-worker", false, 2);
  }, 15_000);

  test("replays an interrupted validator without regenerating its worker candidate", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-validator");
  }, 15_000);

  test("replays interrupted preflight with the same execution before dispatching the worker", async () => {
    await verifyDurableRestartAfterProcessLaunch("preflight");
  }, 15_000);

  test("blocks a tampered original worker incarnation before safe replay", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-worker", true);
  }, 15_000);

  test("blocks a tampered original verifier incarnation before safe replay", async () => {
    await verifyDurableRestartAfterProcessLaunch("safe-validator", true);
  }, 15_000);

  test("blocks a tampered original preflight incarnation before safe replay", async () => {
    await verifyDurableRestartAfterProcessLaunch("preflight", true);
  }, 15_000);
});

describe("Durable launch intent without process identity", () => {
  test("blocks a launched process when identity capture fails and does not replay after restart", async () => {
    await verifyDurableRestartAfterProcessLaunch("identity");
  }, 15_000);
});


const headlessChainSourceText = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - first:",
  "      result: tagged",
  "      agent:",
  "        instructions: produce a checked candidate",
  "      verify:",
  "        agent:",
  "          instructions: check the candidate",
  "  - second:",
  "      run: >-",
  "        printf 's' >> \"$WORKSHOP_TEST_SUCCESSORS\"; printf '%s-next' \"$(cat)\"",
  "",
].join("\n");

const taggedWorkerOutput = [
  "<status>succeeded</status>",
  "<reason>worker summary</reason>",
  "<output>validated candidate</output>",
].join("\n") + "\n";
const acceptedVerifierOutput = "accept\ncandidate checks out\n";

function headlessChainMachineConfig(verifierOutput: string, workerCommand = "printf '%s' '" + taggedWorkerOutput + "'") {
  const workerCommandWithMarker = [
    "printf 'w' >> \"$WORKSHOP_TEST_WORKERS\"",
    workerCommand,
  ].join("; ");
  const verifierCommand = verifierOutput === "__sleep__"
    ? [
      "printf 'v' >> \"$WORKSHOP_TEST_VALIDATORS\"",
      "printf '%s' \"$input\" > \"$WORKSHOP_TEST_VALIDATOR_INPUT\"",
      "sleep 3",
    ].join("; ")
    : [
      "printf 'v' >> \"$WORKSHOP_TEST_VALIDATORS\"",
      "printf '%s' \"$input\" > \"$WORKSHOP_TEST_VALIDATOR_INPUT\"",
      "printf '%s' '" + verifierOutput + "'",
    ].join("; ");
  return {
    shell: "/bin/bash",
    agent: {
      model: "provider/model:low",
      harness: {
        command: "input=$(cat); if printf '%s' \"$input\" | grep -q 'Role: verifier'; then " + verifierCommand
          + "; else " + workerCommandWithMarker + "; fi",
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
  test("parses tagged worker and decision-line verifier stdout before publishing the candidate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-headless-chain-"));
    const envNames = [
      "WORKSHOP_TEST_WORKERS",
      "WORKSHOP_TEST_VALIDATORS",
      "WORKSHOP_TEST_SUCCESSORS",
      "WORKSHOP_TEST_VALIDATOR_INPUT",
    ];
    const restoreEnvironment = preserveEnvironment(envNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(
        directory,
        "headless-chain-request-001",
        "command-chain-headless-run-001",
        headlessChainSourceText,
        headlessChainMachineConfig(acceptedVerifierOutput),
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
        throw new Error("first attempt lacks a successful candidate and verifier outcome");
      }
      expect(firstResult.outcome.candidate).toMatchObject({
        version: 2,
        source: "agent",
        output: "validated candidate",
        summary: "worker summary",
        artifacts: [],
        stdioResult: { version: 1, mode: "tagged", status: "succeeded", reason: "worker summary", question: null },
        sourceBytesHash: hash(taggedWorkerOutput),
      });
      expect(firstResult.outcome.validator).toMatchObject({
        kind: "agent",
        verdict: { version: 2, decision: "accept", reason: "candidate checks out" },
        resultBytesHash: hash(acceptedVerifierOutput),
      });
      expect(readFileSync(markers.workers, "utf8")).toBe("w");
      expect(readFileSync(markers.validators, "utf8")).toBe("v");
      expect(readFileSync(markers.successors, "utf8")).toBe("s");
      const verifierInput = readFileSync(markers.validatorInput, "utf8");
      expect(verifierInput).toContain("Role: verifier");
      expect(verifierInput).toContain("### Candidate output (data)");
      expect(verifierInput).toContain("validated candidate");

      const firstAttempt = stored.nodes[0]!.attempts[0]!;
      expect(firstAttempt.workerExecutionId).not.toBeNull();
      expect(firstAttempt.validatorExecutionId).not.toBeNull();
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("headless run conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processEntries = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const capturedStdout = processEntries.flatMap((entry) => entry.process.captures.filter((capture) => capture.stream === "stdout"));
      expect(capturedStdout).toHaveLength(3);
      expect(capturedStdout.every((capture) => capture.totalBytes > 0)).toBe(true);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("includes a tagged truncation excerpt instead of blocking large prior output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-agent-previous-output-excerpt-"));
    const promptPath = join(directory, "agent-prompt.txt");
    const previousPrompt = process.env.WORKSHOP_TEST_AGENT_PROMPT;
    process.env.WORKSHOP_TEST_AGENT_PROMPT = promptPath;
    let opened: CommandHarness | undefined;
    try {
      const source = [
        "version: 4",
        "defaults:",
        "  retries: 0",
        "  replay: never",
        "steps:",
        "  - first:",
        "      run: >-",
        "        yes x | head -c 70000",
        "  - second:",
        "      result: tagged",
        "      agent:",
        "        instructions: summarize the earlier output",
        "",
      ].join("\n");
      const machine = {
        shell: "/bin/bash",
        agent: {
          model: "provider/model:low",
          harness: {
            command: "input=$(cat); printf '%s' \"$input\" > \"$WORKSHOP_TEST_AGENT_PROMPT\"; printf '%s' '<status>succeeded</status><output>done</output>'",
          },
        },
      } as const;
      const prepared = prepare(directory, "agent-previous-excerpt-request", "command-chain-agent-previous-excerpt-run", source, machine);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(admission.failure.kind + ": " + admission.failure.message);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>, BACKGROUND_CONTEXT);
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("large prior output blocked its agent successor");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toEqual({ kind: "completed", terminalOutput: "done" });
      const prompt = readFileSync(promptPath, "utf8");
      const runTag = hash(prepared.runId).slice(7, 15);
      expect(prompt).toContain("x\nx\n");
      expect(prompt).toContain("[Truncated after the first 64 KiB. Find the complete earlier result in WORKSHOP_RESULTS_PATH (results.md) by its tag: result-first-" + runTag + ".]");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      if (previousPrompt === undefined) delete process.env.WORKSHOP_TEST_AGENT_PROMPT;
      else process.env.WORKSHOP_TEST_AGENT_PROMPT = previousPrompt;
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
      ];
      const restoreEnvironment = preserveEnvironment(envNames);
      const markers = {
        workers: join(directory, "workers.txt"),
        validators: join(directory, "validators.txt"),
        successors: join(directory, "successors.txt"),
        validatorInput: join(directory, "validator-input.txt"),
      };
      process.env.WORKSHOP_TEST_WORKERS = markers.workers;
      process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
      process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
      process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
      let opened: CommandHarness | undefined;
      try {
        const verdict = mode === "rejected"
          ? "retry\ncandidate violates the constraint; remove the conflicting value.\n"
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
        expect(outcome.kind).toBe(mode === "rejected" ? "failed" : "blocked");
        if (outcome.kind === "blocked") expect(outcome.block.kind).toBe("verifier_failed");

        const stored = workflowRunDocumentV1Schema.parse(
          await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
        );
        if (stored.state !== "ready") throw new Error("failed headless run disappeared");
        const firstResult = stored.nodes[0]?.attempts[0]?.result;
        if (firstResult?.kind !== "settled" || (firstResult.outcome.kind !== "failed" && firstResult.outcome.kind !== "blocked")) {
          throw new Error("failed validator attempt did not settle with checked evidence");
        }
        expect(firstResult.outcome.candidate?.output).toBe("validated candidate");
        if (mode === "rejected" && firstResult.outcome.kind === "failed") {
          expect(firstResult.outcome.failure.kind).toBe("validator_rejection");
          expect(firstResult.outcome.failure.message).toContain("candidate violates the constraint");
          expect(firstResult.outcome.failure.message).toContain("remove the conflicting value");
          expect(firstResult.outcome.validator).toMatchObject({
            kind: "agent",
            verdict: { version: 2, decision: "retry", reason: "candidate violates the constraint; remove the conflicting value." },
          });
        } else {
          expect(firstResult.outcome.kind).toBe("blocked");
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
  test("rejects malformed tagged worker stdout before verifier or successor launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-unpaired-worker-output-"));
    const envNames = ["WORKSHOP_TEST_WORKERS", "WORKSHOP_TEST_VALIDATORS", "WORKSHOP_TEST_SUCCESSORS", "WORKSHOP_TEST_VALIDATOR_INPUT"];
    const restoreEnvironment = preserveEnvironment(envNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    let opened: CommandHarness | undefined;
    try {
      const machine = headlessChainMachineConfig(acceptedVerifierOutput, "printf '%s' 'malformed worker output'");
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
    ];
    const restoreEnvironment = preserveEnvironment(envNames);
    const markers = {
      workers: join(directory, "workers.txt"),
      validators: join(directory, "validators.txt"),
      successors: join(directory, "successors.txt"),
      validatorInput: join(directory, "validator-input.txt"),
    };
    process.env.WORKSHOP_TEST_WORKERS = markers.workers;
    process.env.WORKSHOP_TEST_VALIDATORS = markers.validators;
    process.env.WORKSHOP_TEST_SUCCESSORS = markers.successors;
    process.env.WORKSHOP_TEST_VALIDATOR_INPUT = markers.validatorInput;
    let opened: CommandHarness | undefined;
    try {
      // A verifier shares its step's timeout; the fixture worker finishes well inside it.
      const timeoutSource = headlessChainSourceText.replace("  - first:", "  - first:\n      timeout: 1s");
      if (timeoutSource === headlessChainSourceText) throw new Error("validator-timeout fixture did not apply");
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
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind !== "blocked") throw new Error("validator timeout did not fail the workflow");
      expect(outcome.block.kind).toBe("verifier_failed");
      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("timed-out headless run disappeared");
      const attemptResult = stored.nodes[0]?.attempts[0]?.result;
      if (attemptResult?.kind !== "settled" || attemptResult.outcome.kind !== "blocked") {
        throw new Error("timed-out validator did not retain a settled attempt");
      }
      expect(attemptResult.outcome.candidate?.output).toBe("validated candidate");
      expect(attemptResult.outcome.validator).toBeNull();
      expect(attemptResult.outcome.block.kind).toBe("verifier_failed");
      const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("timed-out validator conversation is missing");
      const validatorProcess = (await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data))
        .find((entry) => entry.process.role === "validator" && entry.process.status === "exited");
      if (validatorProcess === undefined) throw new Error("timed-out validator process evidence is missing");
      const timedOutValidator = await opened.harness.waitForTask(
        validatorProcess.taskId as TaskId<unknown>,
        BACKGROUND_CONTEXT,
      );
      if (timedOutValidator.state.status !== "terminal" || timedOutValidator.state.outcome.status !== "completed") {
        throw new Error("validator timeout lacks a checked process receipt");
      }
      const timedOutProcess = processExecutionTaskResultSchema.parse(timedOutValidator.state.outcome.result);
      expect(timedOutProcess.kind).toBe("exited");
      if (timedOutProcess.kind !== "exited") throw new Error("validator timeout returned a non-exit result");
      expect(timedOutProcess.timedOut).toBe(true);
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
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - first:",
    "      stream_cap: \"32\"",
    "      run: \"printf 'command-candidate'\"",
    "      verify:",
    "        run: >-",
    "          " + validatorCommand,
    "  - second:",
    "      run: >-",
    "        printf '%s-next' \"$(cat)\"",
    "",
  ].join("\n");
}

describe("Durable deterministic retries", () => {
  test("retries a safe worker failure deterministically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-worker-retry-"));
    const workerMarker = join(directory, "worker-launches.txt");
    let opened: CommandHarness | undefined;
    const source = [
      "version: 4",
      "steps:",
      "  - first:",
      "      retries: 1",
      "      replay: safe",
      "      run: >-",
      "        printf w >> '" + workerMarker + "'; if [ \"$(wc -c < '" + workerMarker + "')\" -eq 1 ]; then exit 7; fi; printf recovered",
      "",
    ].join("\n");
    try {
      const prepared = prepare(directory, "worker-retry-request", "command-chain-worker-retry-run", source);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(admission.failure.message);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("worker retry did not settle");
      expect(runOutcomeSchema.parse(task.state.outcome.result)).toEqual({ kind: "completed", terminalOutput: "recovered" });
      expect(readFileSync(workerMarker, "utf8")).toBe("ww");
      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("worker retry run disappeared");
      expect(stored.nodes[0]?.attempts).toHaveLength(2);
      expect(stored.nodes[0]?.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
      const first = stored.nodes[0]?.attempts[0]?.result;
      const second = stored.nodes[0]?.attempts[1]?.result;
      expect(first?.kind === "settled" && first.outcome.kind === "failed" ? first.outcome.failure.kind : null).toBe("process_error");
      expect(second?.kind === "settled" && second.outcome.kind === "succeeded").toBe(true);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("retries command verifier rejection and fails when retries are exhausted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-command-verifier-retry-"));
    const workerMarker = join(directory, "worker-launches.txt");
    const verifierMarker = join(directory, "verifier-launches.txt");
    let opened: CommandHarness | undefined;
    const validatorCommand = "printf '%s' \"$WORKSHOP_ATTEMPT\" >&2; printf v >> '" + verifierMarker + "'; exit 7";
    const workerCommand = "run: >-\n        printf w >> '" + workerMarker + "'; printf 'command-candidate'";
    const source = commandValidatorChainSource(validatorCommand)
      .replace("  retries: 0", "  retries: 1")
      .replace("  replay: never", "  replay: safe")
      .replace("run: \"printf 'command-candidate'\"", workerCommand);
    try {
      const prepared = prepare(directory, "command-verifier-retry-request", "command-chain-verifier-retry-run", source);
      opened = await openCommandHarness(join(directory, "durable.db"));
      await initializeInstallation(opened.harness, prepared.canonicalHash);
      const admission = await admit(opened.harness, opened.tasks, prepared);
      if (!admission.ok) throw new Error(admission.failure.message);
      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const task = await opened.harness.waitForTask(
        admission.value.workflowTaskId as TaskId<ReturnType<typeof runOutcomeSchema.parse>>,
        BACKGROUND_CONTEXT,
      );
      if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("verifier retry did not settle");
      const outcome = runOutcomeSchema.parse(task.state.outcome.result);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("repeated command verifier rejection did not fail");
      expect(outcome.failure.kind).toBe("validator_rejection");
      expect(readFileSync(workerMarker, "utf8")).toBe("ww");
      expect(readFileSync(verifierMarker, "utf8")).toBe("vv");
      const stored = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      if (stored.state !== "ready") throw new Error("command verifier retry run disappeared");
      const attempts = stored.nodes[0]?.attempts ?? [];
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
      for (const attempt of attempts) {
        const result = attempt.result;
        expect(result.kind === "settled" && result.outcome.kind === "failed" ? result.outcome.failure.kind : null)
          .toBe("validator_rejection");
      }
      expect(stored.nodes[1]?.status).toBe("pending");
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Durable command validator chain", () => {
  test("passes and rejects only after the committed candidate reaches the command validator", async () => {
    for (const mode of ["pass", "reject"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "workshop-command-validator-"));
      let opened: CommandHarness | undefined;
      try {
        const command = mode === "pass"
          ? "test \"$(cat)\" = command-candidate"
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
        const conversation = await opened.harness.conversation(admission.value.conversationId as ConversationId, BACKGROUND_CONTEXT);
        if (conversation === undefined) throw new Error("run conversation is missing");
        const processes = (await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items
          .filter((entry) => WorkshopProcessEntry.is(entry))
          .map((entry) => workshopProcessV1Schema.parse(entry.data).process);
        const workerInput = processes.find((process) => process.executionId === stored.nodes[0]?.attempts[0]?.workerExecutionId);
        const verifierInput = processes.find((process) => process.executionId === stored.nodes[0]?.attempts[0]?.validatorExecutionId);
        expect(workerInput?.stdio?.stdinSha256).toBe(hash(""));
        expect(workerInput?.stdio?.stdinByteCount).toBe(0);
        expect(verifierInput?.stdio?.stdinSha256).toBe(hash("command-candidate"));
        expect(verifierInput?.stdio?.stdinByteCount).toBe(Buffer.byteLength("command-candidate"));
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
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - first:",
  "      timeout: 5s",
  "      agent:",
  "        instructions: worker instructions",
  "      verify:",
  "        agent:",
  "          instructions: validator instructions",
  "",
].join("\n");
const workerAgentStdout = "<status>succeeded</status>\n<reason>checked</reason>\n<output>agent-result</output>\n";
const validatorAgentStdout = "accept\ncandidate is valid\n";
const agentProcessMachineConfig = {
  shell: "/bin/bash",
  agent: {
    harness: {
      command: "input=$(cat); (sleep 30) & if printf '%s' \"$input\" | grep -q 'Role: verifier'; then printf '%s' '" + validatorAgentStdout + "'; else printf '%s' '" + workerAgentStdout + "'; fi",
    },
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
  test("requires versioned stdin identities and captures tagged agent stdout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-adapter-"));
    let opened: CommandHarness | undefined;
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
      expect(seeded.inputs.every((input) => input.ioVersion === 1)).toBe(true);
      expect(seeded.inputs.every((input) => /^sha256:[0-9a-f]{64}$/.test(input.stdinSha256))).toBe(true);
      expect(seeded.inputs.every((input) => input.stdinByteCount > 0)).toBe(true);
      expect(seeded.inputs.every((input) => input.env.WORKSHOP_RESULTS_PATH !== undefined)).toBe(true);
      expect(seeded.inputs.every((input) => input.env.WORKSHOP_LOG_PATH !== undefined)).toBe(true);
      const removedVariables = [
        "WORKSHOP_PROMPT_FILE", "WORKSHOP_RESULT_FILE", "WORKSHOP_PREVIOUS_OUTPUT_FILE",
        "WORKSHOP_STEP_OUTPUT_FILE", "WORKSHOP_WORKLOG_FILE", "WORKSHOP_STDOUT_FILE", "WORKSHOP_STDERR_FILE",
      ];
      expect(seeded.inputs.every((input) => removedVariables.every((name) => input.env[name] === undefined))).toBe(true);

      await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
      const storedRun = workflowRunDocumentV1Schema.parse(
        await opened.harness.snapshot(WorkshopRunDoc, seeded.conversationId, BACKGROUND_CONTEXT),
      );
      if (storedRun.state !== "ready") throw new Error("process adapter run disappeared");
      for (const input of seeded.inputs) {
        const reconstructed = reconstructProcessStdin({
          role: input.role,
          nodeId: input.nodeId,
          attemptId: input.attemptId,
          executionId: input.executionId,
        }, storedRun);
        expect(input.stdinSha256).toBe(reconstructed.sha256);
        expect(input.stdinByteCount).toBe(reconstructed.byteCount);
      }
      const conversation = await opened.harness.conversation(seeded.conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("process adapter conversation is missing");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const processes = entries.items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      const exited = processes.filter((entry) => entry.process.status === "exited");
      expect(exited.map((entry) => [entry.process.role, entry.process.cleanupState]).sort()).toEqual([
        ["validator", "confirmed_dead"],
        ["worker", "confirmed_dead"],
      ]);
      const stdoutByRole = new Map(exited.map((entry) => {
        const stdout = entry.process.captures.find((capture) => capture.stream === "stdout");
        if (stdout === undefined) throw new Error("exited process evidence lacks stdout capture");
        return [entry.process.role, stdout] as const;
      }));
      expect(stdoutByRole.get("worker")?.sha256).toBe(hash(workerAgentStdout));
      expect(stdoutByRole.get("worker")?.totalBytes).toBe(Buffer.byteLength(workerAgentStdout));
      expect(stdoutByRole.get("validator")?.sha256).toBe(hash(validatorAgentStdout));
      expect(stdoutByRole.get("validator")?.totalBytes).toBe(Buffer.byteLength(validatorAgentStdout));

      const taskResults = await Promise.all(seeded.taskIds.map((taskId) => opened!.harness.waitForTask(taskId, BACKGROUND_CONTEXT)));
      const results = taskResults.map((task) => {
        expect(task.state.status).toBe("terminal");
        expect(task.state.outcome.status).toBe("completed");
        if (task.state.outcome.status !== "completed") throw new Error("agent process lacked a checked outcome");
        return processExecutionTaskResultSchema.parse(task.state.outcome.result);
      });
      expect(results.every((result) => result.kind === "exited" && !result.timedOut
        && result.exit.kind === "code" && result.exit.code === 0)).toBe(true);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not launch when a direct stdin hash differs from the canonical run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-tamper-"));
    let opened: CommandHarness | undefined;
    try {
      const prepared = prepare(
        directory,
        "process-stdin-tamper-request-001",
        "process-stdin-tamper-run-001",
        agentProcessSourceText,
        agentProcessMachineConfig,
        "process-stdin-tamper",
      );
      opened = await openCommandHarness(join(directory, "durable.db"));
      const seeded = await seedAgentProcessTasks(opened.harness, opened.tasks, prepared, { corruptWorkerStdin: true });
      const workerTaskId = seeded.taskIds[0];
      if (workerTaskId === undefined) throw new Error("tampered worker process task is missing");
      const workerTask = await opened.harness.waitForTask(workerTaskId, BACKGROUND_CONTEXT);
      expect(workerTask.state.status).toBe("terminal");
      expect(workerTask.state.outcome.status).toBe("completed");
      if (workerTask.state.outcome.status !== "completed") throw new Error("tampered process input did not settle");
      const result = processExecutionTaskResultSchema.parse(workerTask.state.outcome.result);
      expect(result.kind).toBe("blocked");
      if (result.kind !== "blocked") throw new Error("tampered stdin launched a process");
      expect(result.block.kind).toBe("integrity_failed");
      const conversation = await opened.harness.conversation(seeded.conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("stdin tamper conversation is missing");
      const processRecords = (await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items
        .filter((entry) => entry.kind === "workshop.process")
        .map((entry) => workshopProcessV1Schema.parse(entry.data));
      expect(processRecords.some((entry) => entry.process.status === "running" || entry.process.status === "exited")).toBe(false);
    } finally {
      if (opened !== undefined) await opened.harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unsafe absolute-deadline arithmetic before dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-unsafe-deadline-"));
    const unsafeDeadlineSource = [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
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
  options: { readonly pauseBeforeValidator?: boolean; readonly corruptWorkerStdin?: boolean } = {},
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
    const validInput = createAdapterAgentProcessInput({
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
    const input = options.corruptWorkerStdin
      ? processExecutionTaskInputSchema.parse({ ...validInput, stdinSha256: hash("tampered stdin") })
      : validInput;
    inputs.push(input);
    workerTaskId = await tx.createTask(tasks.ProcessExecutionTask, input, {
      ownership: { kind: "conversation" },
      conversationId: conversation.id,
    });
    taskIds.push(workerTaskId);
  }, BACKGROUND_CONTEXT);
  if (conversationId === undefined || workerTaskId === undefined) throw new Error("process fixture worker was not created");
  await harness.waitForTask(workerTaskId, BACKGROUND_CONTEXT);
  if (options.corruptWorkerStdin) return { conversationId, inputs, taskIds };

  const candidateStdout = "<status>succeeded</status>\n<reason>candidate committed before validator</reason>\n<output>seeded candidate</output>\n";
  const candidate = nodeResultSchema.parse({
    version: 2,
    source: "agent",
    output: "seeded candidate",
    summary: "candidate committed before validator",
    artifacts: [],
    sourceBytesHash: hash(candidateStdout),
    stdioResult: { version: 1, mode: "tagged", status: "succeeded", reason: "candidate committed before validator", question: null },
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
  const paths = processExecutionFiles({ role: args.role, nodeId: args.nodeId, incarnationNumber: 1, executionId: args.executionId }, locateWorkflowDirectory(args.run), args.run.runId, 1);
  const stdin = reconstructProcessStdin({
    role: args.role,
    nodeId: args.nodeId,
    attemptId: args.attemptId,
    executionId: args.executionId,
  }, args.run);
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
    ioVersion: 1,
    stdinSha256: stdin.sha256,
    stdinByteCount: stdin.byteCount,
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
