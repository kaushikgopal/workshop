import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type AnyTask, type ConversationId, type RegistryReader } from "@earendil-works/pi-durable";
import { loadInstallation } from "../src/installation/load-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { workflowRunDocumentV1Schema } from "../src/run/records.js";
import { defineScheduleWakeupTask } from "../src/storage/durable/define-scheduler-wakeup-task.js";
import { defineWorkshopTasks } from "../src/storage/durable/define-workshop-tasks.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { statusDtoSchema } from "../src/views/schema.js";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const taskVersions = { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, failureJudgment: 1, scheduleWakeup: 1 } as const;

describe("Durable service shutdown", () => {
  test("does not admit scheduled work while shutdown reconciles a TERM-trapping process", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-shutdown-fence-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const processMarker = join(root, "holder-events.txt");
    const scheduledMarker = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 2\n", "utf8");
    writeFileSync(join(workflows, "holder.yaml"), [
      "steps:",
      "  - hold:",
      "      run: >-",
      `        trap "printf 'TERM\\n' >> '${processMarker}'; sleep 0.45; printf 'RETIRED\\n' >> '${processMarker}'; exit 0" TERM; printf 'STARTED\\n' >> '${processMarker}'; while :; do sleep 5; done`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "schedule:",
      "  every: 2s",
      "  max_runs: 3",
      "steps:",
      "  - tick:",
      `      run: 'printf x >> ${scheduledMarker}'`,
      "orchestrator:",
      "  model: faux/failure-judge:low",
      "  timeout: 10s",
      "",
    ].join("\n"), "utf8");

    const installation = loadInstallation(root);
    const models = createModels();
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    models.setProvider(faux.provider);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let inspectHarness: Harness | undefined;
    try {
      owner = await startWorkshopService(installation, { models });
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;

      const scheduledResponse = await sendServiceRequest(socketPath, {
        version: 1, method: "start", requestId: "shutdown-scheduled-start", workflowId: "scheduled",
      });
      if (!scheduledResponse.ok) throw new Error(scheduledResponse.error.message);
      const scheduled = serviceStartResultV1Schema.parse(scheduledResponse.result);
      await waitForText(scheduledMarker, "x");

      let scheduledStatus: ReturnType<typeof statusDtoSchema.parse> | undefined;
      const completionDeadline = Date.now() + 8_000;
      while (Date.now() < completionDeadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "scheduled" });
        if (!response.ok) throw new Error(response.error.message);
        scheduledStatus = statusDtoSchema.parse(response.result);
        if (scheduledStatus.workflows[0]?.unresolvedRun === null) break;
        await sleep(20);
      }
      expect(scheduledStatus?.workflows[0]?.unresolvedRun).toBeNull();
      expect(readFileSync(scheduledMarker, "utf8")).toBe("x");
      const activation = scheduledStatus?.workflows[0]?.activation;
      if (activation === null || activation === undefined || activation.nextDueAt === null) {
        throw new Error("scheduled activation deadline is missing after its first run");
      }

      const holderResponse = await sendServiceRequest(socketPath, {
        version: 1, method: "start", requestId: "shutdown-holder-start", workflowId: "holder",
      });
      if (!holderResponse.ok) throw new Error(holderResponse.error.message);
      const holder = serviceStartResultV1Schema.parse(holderResponse.result);
      await waitForText(processMarker, "STARTED");

      let nextDueAt = activation.nextDueAt;
      const dueDeadline = Date.now() + 8_000;
      while (Date.now() < dueDeadline) {
        const untilDue = Date.parse(nextDueAt) - Date.now();
        if (untilDue >= 0 && untilDue <= 80) break;
        if (untilDue < 0) {
          await sleep(30);
          const response = await sendServiceRequest(socketPath, { version: 1, method: "status", workflowId: "scheduled" });
          if (!response.ok) throw new Error(response.error.message);
          const current = statusDtoSchema.parse(response.result).workflows[0]?.activation;
          if (current?.nextDueAt !== null && current?.nextDueAt !== undefined) nextDueAt = current.nextDueAt;
        } else {
          await sleep(Math.min(untilDue - 80, 50));
        }
      }
      expect(Date.parse(nextDueAt) - Date.now()).toBeGreaterThanOrEqual(0);
      expect(Date.parse(nextDueAt) - Date.now()).toBeLessThanOrEqual(80);

      const shutdownStartedAt = Date.now();
      await owner.shutdown();
      owner = undefined;
      expect(Date.now() - shutdownStartedAt).toBeGreaterThanOrEqual(300);
      expect(readFileSync(processMarker, "utf8")).toContain("TERM");
      expect(readFileSync(processMarker, "utf8")).toContain("RETIRED");
      expect(readFileSync(scheduledMarker, "utf8")).toBe("x");
      expect(faux.state.callCount).toBe(0);

      const reopened = await openDurableStorage(installation.databasePath);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error(reopened.failure.message);
      const tasks = defineWorkshopTasks("shutdown-inspection");
      const scheduleWakeupTask = defineScheduleWakeupTask({
        installation,
        workflowRunTask: tasks.WorkflowRunTask,
        runtimeManifest: {
          durableVersion: "1.0.2",
          integrationManifestHash: canonicalHash({ taskVersions }),
          taskVersions,
        },
      });
      const registry = createRegistry();
      registry.install({
        name: "workshop-service-runtime",
        tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, tasks.FailureJudgmentTask, scheduleWakeupTask],
      });
      registry.install(tasks.FailureJudgmentExtension);
      inspectHarness = await Harness.open(reopened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);

      const persistedInstallation = installationDocumentV1Schema.parse(
        await inspectHarness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT),
      );
      expect(persistedInstallation.state).toBe("ready");
      if (persistedInstallation.state !== "ready") throw new Error("service shutdown lost the initialized installation");
      const holderIndex = persistedInstallation.workflows.holder;
      expect(holderIndex?.runs).toHaveLength(1);
      expect(holderIndex?.runs[0]?.runId).toBe(holder.runId);
      const scheduledIndex = persistedInstallation.workflows.scheduled;
      expect(scheduledIndex?.runs).toHaveLength(1);
      expect(scheduledIndex?.openRunId).toBeNull();
      expect(scheduledIndex?.runs[0]).toMatchObject({ runId: scheduled.runId, status: "completed" });
      expect(scheduledIndex?.activations[0]).toMatchObject({ admittedCount: 1, state: "active", nextDueAt });
      const activationAfterShutdown = scheduledIndex?.activations[0];
      const firstRun = scheduledIndex?.runs[0];
      if (activationAfterShutdown === undefined || activationAfterShutdown.schedulerTaskId === null || firstRun === undefined) {
        throw new Error("scheduled history or its scheduler task reference was lost");
      }

      const run = workflowRunDocumentV1Schema.parse(
        await inspectHarness.snapshot(WorkshopRunDoc, firstRun.conversationId as ConversationId, BACKGROUND_CONTEXT),
      );
      expect(run.state).toBe("ready");
      if (run.state !== "ready") throw new Error("completed scheduled run is missing its ready document");
      expect(run.status).toBe("completed");
      expect(run.block).toBeNull();
      expect(run.failure).toBeNull();

      const inspection = await inspectHarness.inspect(BACKGROUND_CONTEXT);
      const schedulerTask = inspection.tasks.find((task) => Number(task.record.id) === activationAfterShutdown.schedulerTaskId);
      expect(schedulerTask?.record.state.checkpoint).toMatchObject({ phase: "wait" });
      const schedulerCheckpoint = schedulerTask?.record.state.checkpoint;
      if (typeof schedulerCheckpoint !== "object" || schedulerCheckpoint === null
        || !("wakeAt" in schedulerCheckpoint) || typeof schedulerCheckpoint.wakeAt !== "string") {
        throw new Error("scheduled occurrence lost its persisted wait deadline during shutdown");
      }
      expect(Date.parse(schedulerCheckpoint.wakeAt)).toBeGreaterThan(Date.parse(nextDueAt));
      expect(inspection.tasks.filter((task) => task.record.kind === "workshop.failure-judgment")).toHaveLength(0);
      expect(inspection.tasks.filter((task) => ["workshop.node-attempt", "workshop.process-execution"].includes(task.record.kind)
        && Number(task.record.conversationId) === Number(firstRun.conversationId))).toHaveLength(0);
      expect(faux.state.callCount).toBe(0);
    } finally {
      if (inspectHarness !== undefined) await inspectHarness.close(BACKGROUND_CONTEXT);
      if (owner !== undefined) await owner.shutdown().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("shutdown holds a failed judgment and prepared node until the next service boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-shutdown-held-dispatch-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const processMarker = join(root, "holder-events.txt");
    const workerMarker = join(root, "judgment-worker.txt");
    const validatorMarker = join(root, "judgment-validator.txt");
    const preparedMarker = join(root, "prepared-worker.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 3\n", "utf8");
    writeFileSync(join(workflows, "holder.yaml"), [
      "steps:",
      "  - hold:",
      "      run: >-",
      `        trap "printf 'TERM\\n' >> '${processMarker}'; sleep 0.45; printf 'RETIRED\\n' >> '${processMarker}'; exit 0" TERM; printf 'STARTED\\n' >> '${processMarker}'; while :; do sleep 5; done`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "judged.yaml"), [
      "steps:",
      "  - verify:",
      "      run: >-",
      `        printf w >> '${workerMarker}'; printf candidate`,
      "      check:",
      "        run: >-",
      `          printf v >> '${validatorMarker}'; exit 7`,
      "orchestrator:",
      "  model: faux/failure-judge:low",
      "  timeout: 10s",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "prepared.yaml"), [
      "steps:",
      "  - work:",
      "      run: >-",
      `        printf c >> '${preparedMarker}'; printf prepared-result`,
      "",
    ].join("\n"), "utf8");

    const installation = loadInstallation(root);
    const models = createModels();
    const faux = fauxProvider({ provider: "faux", models: [{ id: "failure-judge", name: "Failure Judge" }] });
    faux.setResponses([async () => fauxAssistantMessage(
      fauxToolCall("record_workshop_failure_decision", { action: "fail", reason: "The checked validator failure should end this run." }),
      { stopReason: "toolUse" },
    )]);
    models.setProvider(faux.provider);
    const decisionBarrier = createPhaseBarrier();
    const prepareBarrier = createPhaseBarrier();
    const originalOpen = Harness.open;
    let serviceHarness: Harness | undefined;
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let inspectHarness: Harness | undefined;
    const wrapTask = createPhaseTaskWrapper({
      decisionBarrier,
      prepareBarrier,
    });
    Harness.open = async (storage, options, context) => {
      const registry = barrierRegistry(options.registry, wrapTask);
      serviceHarness = await originalOpen(storage, { ...options, registry }, context);
      return serviceHarness;
    };

    try {
      owner = await startWorkshopService(installation, { models });
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      const socketPath = health.metadata.socketPath;

      const holderResponse = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId: "shutdown-held-holder", workflowId: "holder" });
      if (!holderResponse.ok) throw new Error(holderResponse.error.message);
      const holder = serviceStartResultV1Schema.parse(holderResponse.result);
      await waitForText(processMarker, "STARTED");

      const judgedResponse = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId: "shutdown-held-judged", workflowId: "judged" });
      if (!judgedResponse.ok) throw new Error(judgedResponse.error.message);
      const judged = serviceStartResultV1Schema.parse(judgedResponse.result);
      const preparedResponse = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId: "shutdown-held-prepared", workflowId: "prepared" });
      if (!preparedResponse.ok) throw new Error(preparedResponse.error.message);
      const prepared = serviceStartResultV1Schema.parse(preparedResponse.result);
      await Promise.all([decisionBarrier.entered, prepareBarrier.entered]);

      expect(readFileSync(workerMarker, "utf8")).toBe("w");
      expect(readFileSync(validatorMarker, "utf8")).toBe("v");
      expect(existsSync(preparedMarker)).toBe(false);
      expect(faux.state.callCount).toBe(0);
      if (serviceHarness === undefined) throw new Error("service Harness was not captured by the public open seam");
      const liveInstallation = installationDocumentV1Schema.parse(await serviceHarness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
      if (liveInstallation.state !== "ready") throw new Error("service installation is uninitialized during shutdown acceptance");
      const judgedReference = liveInstallation.workflows.judged?.runs.find((run) => run.runId === judged.runId);
      const preparedReference = liveInstallation.workflows.prepared?.runs.find((run) => run.runId === prepared.runId);
      if (judgedReference === undefined || preparedReference === undefined) throw new Error("held test runs are absent from installation history");
      const judgedRun = workflowRunDocumentV1Schema.parse(await serviceHarness.snapshot(WorkshopRunDoc, judgedReference.conversationId as ConversationId, BACKGROUND_CONTEXT));
      const preparedRun = workflowRunDocumentV1Schema.parse(await serviceHarness.snapshot(WorkshopRunDoc, preparedReference.conversationId as ConversationId, BACKGROUND_CONTEXT));
      if (judgedRun.state !== "ready" || preparedRun.state !== "ready") throw new Error("held test run document is uninitialized");
      const failedAttempt = judgedRun.nodes[0]?.attempts[0];
      const pendingAttempt = preparedRun.nodes[0]?.attempts[0];
      expect(failedAttempt).toMatchObject({ status: "failed", result: { kind: "settled", outcome: { kind: "failed" } } });
      expect(failedAttempt?.workerExecutionId).not.toBeNull();
      expect(failedAttempt?.validatorExecutionId).not.toBeNull();
      expect(failedAttempt?.judgments).toHaveLength(0);
      expect(pendingAttempt).toMatchObject({ status: "prepared", phase: "prepare", result: { kind: "pending" }, workerExecutionId: null, validatorExecutionId: null, processIncarnations: [], judgments: [] });

      const activeInspection = await serviceHarness.inspect(BACKGROUND_CONTEXT);
      const judgedWorkflowTask = activeInspection.tasks.find((entry) => entry.record.kind === "workshop.workflow-run" && Number(entry.record.conversationId) === judgedReference.conversationId);
      const preparedNodeTask = activeInspection.tasks.find((entry) => entry.record.kind === "workshop.node-attempt" && Number(entry.record.conversationId) === preparedReference.conversationId);
      expect(judgedWorkflowTask?.record.state.checkpoint).toMatchObject({ phase: "decide" });
      expect(preparedNodeTask?.record.state.checkpoint).toEqual({ phase: "prepare" });
      expect(activeInspection.tasks.filter((entry) => entry.record.kind === "workshop.failure-judgment" && Number(entry.record.conversationId) === judgedReference.conversationId)).toHaveLength(0);
      expect(activeInspection.tasks.filter((entry) => entry.record.kind === "workshop.process-execution" && Number(entry.record.conversationId) === preparedReference.conversationId)).toHaveLength(0);

      const shutdown = owner.shutdown();
      await waitForText(processMarker, "TERM");
      decisionBarrier.release();
      prepareBarrier.release();
      await shutdown;
      owner = undefined;
      serviceHarness = undefined;
      Harness.open = originalOpen;
      expect(readFileSync(processMarker, "utf8")).toContain("RETIRED");
      expect(existsSync(preparedMarker)).toBe(false);
      expect(faux.state.callCount).toBe(0);

      const reopened = await openDurableStorage(installation.databasePath);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error(reopened.failure.message);
      const inspectTasks = defineWorkshopTasks("shutdown-held-inspection");
      const inspectRegistry = createRegistry();
      inspectRegistry.install({
        name: "workshop-shutdown-inspection",
        tasks: [inspectTasks.WorkflowRunTask, inspectTasks.NodeAttemptTask, inspectTasks.ProcessExecutionTask, inspectTasks.CapacityGateTask, inspectTasks.FailureJudgmentTask],
      });
      inspectRegistry.install(inspectTasks.FailureJudgmentExtension);
      inspectHarness = await Harness.open(reopened.storage, { models, registry: inspectRegistry }, BACKGROUND_CONTEXT);
      const persistedInstallation = installationDocumentV1Schema.parse(await inspectHarness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
      if (persistedInstallation.state !== "ready") throw new Error("persisted installation is uninitialized");
      const persistedJudgedReference = persistedInstallation.workflows.judged?.runs.find((run) => run.runId === judged.runId);
      const persistedPreparedReference = persistedInstallation.workflows.prepared?.runs.find((run) => run.runId === prepared.runId);
      expect(persistedInstallation.workflows.holder?.runs[0]?.runId).toBe(holder.runId);
      if (persistedJudgedReference === undefined || persistedPreparedReference === undefined) throw new Error("held run history was lost during shutdown");
      const persistedJudgedRun = workflowRunDocumentV1Schema.parse(await inspectHarness.snapshot(WorkshopRunDoc, persistedJudgedReference.conversationId as ConversationId, BACKGROUND_CONTEXT));
      const persistedPreparedRun = workflowRunDocumentV1Schema.parse(await inspectHarness.snapshot(WorkshopRunDoc, persistedPreparedReference.conversationId as ConversationId, BACKGROUND_CONTEXT));
      if (persistedJudgedRun.state !== "ready" || persistedPreparedRun.state !== "ready") throw new Error("persisted held run document is uninitialized");
      expect(persistedJudgedRun.status).toBe("running");
      expect(persistedJudgedRun.block).toBeNull();
      expect(persistedJudgedRun.nodes[0]?.attempts[0]).toMatchObject({ status: "failed", result: { kind: "settled", outcome: { kind: "failed" } }, judgments: [] });
      expect(persistedPreparedRun.status).toBe("running");
      expect(persistedPreparedRun.nodes[0]?.attempts[0]).toMatchObject({ status: "prepared", phase: "prepare", result: { kind: "pending" }, workerExecutionId: null, validatorExecutionId: null, processIncarnations: [], judgments: [] });
      const persistedInspection = await inspectHarness.inspect(BACKGROUND_CONTEXT);
      expect(persistedInspection.tasks.find((entry) => entry.record.kind === "workshop.workflow-run" && Number(entry.record.conversationId) === persistedJudgedReference.conversationId)?.record.state.checkpoint).toMatchObject({ phase: "decide" });
      expect(persistedInspection.tasks.find((entry) => entry.record.kind === "workshop.node-attempt" && Number(entry.record.conversationId) === persistedPreparedReference.conversationId)?.record.state.checkpoint).toEqual({ phase: "prepare" });
      expect(persistedInspection.tasks.filter((entry) => entry.record.kind === "workshop.failure-judgment" && Number(entry.record.conversationId) === persistedJudgedReference.conversationId)).toHaveLength(0);
      expect(persistedInspection.tasks.filter((entry) => entry.record.kind === "workshop.process-execution" && Number(entry.record.conversationId) === persistedPreparedReference.conversationId)).toHaveLength(0);
      expect(faux.state.callCount).toBe(0);
      await inspectHarness.close(BACKGROUND_CONTEXT);
      inspectHarness = undefined;

      Harness.open = originalOpen;
      owner = await startWorkshopService(installation, { models });
      const restartedHealth = await probeServiceHealth(installation.stateDirectory);
      if (restartedHealth.kind !== "ready") throw new Error(restartedHealth.reason);
      await waitForRunStatus(restartedHealth.metadata.socketPath, "judged", judged.runId, "failed");
      await waitForRunStatus(restartedHealth.metadata.socketPath, "prepared", prepared.runId, "completed");
      expect(readFileSync(preparedMarker, "utf8")).toBe("c");
      expect(faux.state.callCount).toBe(1);
      await owner.shutdown();
      owner = undefined;
    } finally {
      Harness.open = originalOpen;
      if (owner !== undefined) {
        const shutdown = owner.shutdown();
        await waitForText(processMarker, "TERM").catch(() => undefined);
        decisionBarrier.release();
        prepareBarrier.release();
        await shutdown.catch(() => undefined);
      } else {
        decisionBarrier.release();
        prepareBarrier.release();
      }
      if (inspectHarness !== undefined) await inspectHarness.close(BACKGROUND_CONTEXT);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForText(path: string, text: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return;
    await sleep(20);
  }
  throw new Error(`process fixture did not write ${text}`);
}

async function waitForRunStatus(socketPath: string, workflowId: string, runId: string, expected: "completed" | "failed"): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId, limit: 100 });
    if (!response.ok) throw new Error(response.error.message);
    const page = serviceRunsPageV1Schema.parse(response.result);
    const run = page.runs.find((candidate) => candidate.runId === runId);
    if (run?.status === expected) return;
    if (run?.status === "blocked" || run?.status === "cancelled" || (run?.status === "failed" && expected !== "failed")) {
      throw new Error(`run ${runId} settled as ${run.status} instead of ${expected}`);
    }
    await sleep(20);
  }
  throw new Error(`run ${runId} did not settle as ${expected} before the fixture deadline`);
}

type PhaseBarrier = {
  readonly entered: Promise<void>;
  hold(): Promise<void>;
  release(): void;
};

function createPhaseBarrier(): PhaseBarrier {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let didEnter = false;
  return {
    entered,
    async hold() {
      if (!didEnter) {
        didEnter = true;
        markEntered();
      }
      await released;
    },
    release,
  };
}

function createPhaseTaskWrapper(barriers: {
  readonly decisionBarrier: PhaseBarrier;
  readonly prepareBarrier: PhaseBarrier;
}): (task: AnyTask) => AnyTask {
  const wrappedTasks = new WeakMap<AnyTask, AnyTask>();
  return (task) => {
    const existing = wrappedTasks.get(task);
    if (existing !== undefined) return existing;
    const barrier = task.definition.name === "workshop.workflow-run" ? barriers.decisionBarrier
      : task.definition.name === "workshop.node-attempt" ? barriers.prepareBarrier
      : undefined;
    const phaseName = task.definition.name === "workshop.workflow-run" ? "decide"
      : task.definition.name === "workshop.node-attempt" ? "prepare"
      : undefined;
    const workflowId = task.definition.name === "workshop.workflow-run" ? "judged"
      : task.definition.name === "workshop.node-attempt" ? "prepared"
      : undefined;
    if (barrier === undefined || phaseName === undefined || workflowId === undefined) {
      wrappedTasks.set(task, task);
      return task;
    }
    const phaseHandler = task.definition.phases[phaseName];
    if (typeof phaseHandler !== "function") throw new Error(`${task.definition.name}.${phaseName} is not a task phase`);
    const heldTasks = new Set<string>();
    const phases: Record<string, unknown> = { ...task.definition.phases };
    phases[phaseName] = async (...args: unknown[]) => {
      const record = args[0] as { readonly id?: unknown; readonly input?: unknown };
      if (taskInputWorkflowId(record?.input) === workflowId) {
        const identity = typeof record.id === "string" || typeof record.id === "number"
          ? String(record.id)
          : JSON.stringify(record.input);
        if (!heldTasks.has(identity)) {
          heldTasks.add(identity);
          await barrier.hold();
        }
      }
      await (phaseHandler as (...phaseArgs: unknown[]) => Promise<void>)(...args);
    };
    const wrapped = { ...task, definition: { ...task.definition, phases } } as AnyTask;
    wrappedTasks.set(task, wrapped);
    return wrapped;
  };
}

function taskInputWorkflowId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("workflowId" in value)) return undefined;
  const workflowId = (value as { readonly workflowId?: unknown }).workflowId;
  return typeof workflowId === "string" ? workflowId : undefined;
}

function barrierRegistry(registry: RegistryReader, wrapTask: (task: AnyTask) => AnyTask): RegistryReader {
  return {
    subscribe: registry.subscribe.bind(registry),
    snapshot() {
      const current = registry.snapshot();
      const tasks = new Map(current.tasks().map((task) => [task.definition.name, wrapTask(task)]));
      return {
        installed: () => current.installed(),
        extension: (name) => current.extension(name),
        tools: () => current.tools(),
        sections: () => current.sections(),
        tasks: () => [...tasks.values()],
        task: (name) => tasks.get(name),
      };
    },
  };
}
