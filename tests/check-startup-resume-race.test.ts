import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, GenerationTask, Harness, LiveDoc, UserEntry, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { completePausedServiceRuntimeStartup, openPausedServiceRuntime, startWorkshopService } from "../src/service/open-service-runtime.js";
import { ServiceShutdownError } from "../src/service/serve-workshop-service.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { serviceMetadataV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { processExecutionTaskInputSchema } from "../src/storage/durable/define-process-execution-task.js";
import { processIncarnationSchema } from "../src/process/schema.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

const providerName = "startup-race-fixture";
const modelId = "marker";

describe("startup task reconciliation resume ordering", () => {
  test("completes normal startup from the paused runtime without reopening storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-paused-startup-api-"));
    const config = join(root, ".workshop");
    mkdirSync(join(config, "workflows"), { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n", "utf8");
    const originalOpen = Harness.open;
    let harnessOpenCount = 0;
    let pausedRuntime: Awaited<ReturnType<typeof openPausedServiceRuntime>> | undefined;
    let runtime: Awaited<ReturnType<typeof completePausedServiceRuntimeStartup>> | undefined;
    Harness.open = async (storage, options, context) => {
      harnessOpenCount++;
      return await originalOpen(storage, options, context);
    };
    try {
      const installation = loadInstallation(root);
      pausedRuntime = await openPausedServiceRuntime(installation, testServiceMetadata(installation.stateDirectory), createModels());
      expect(pausedRuntime.startupInspection.limitations).toEqual([]);
      runtime = await completePausedServiceRuntimeStartup(pausedRuntime);
      expect(harnessOpenCount).toBe(1);
      await runtime.shutdown(Date.now() + 10_000);
      runtime = undefined;
      pausedRuntime = undefined;
    } finally {
      Harness.open = originalOpen;
      if (runtime !== undefined) await runtime.shutdown(Date.now() + 10_000).catch(() => undefined);
      else if (pausedRuntime !== undefined) await pausedRuntime.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps scheduling paused when the active-recovery predicate returns true", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-paused-recovery-request-"));
    const config = join(root, ".workshop");
    mkdirSync(join(config, "workflows"), { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n", "utf8");
    let pausedRuntime: Awaited<ReturnType<typeof openPausedServiceRuntime>> | undefined;
    let resumeCalls = 0;
    try {
      const installation = loadInstallation(root);
      pausedRuntime = await openPausedServiceRuntime(installation, testServiceMetadata(installation.stateDirectory), createModels(), {
        isRecoveryRequestActive: async () => true,
      });
      const resume = pausedRuntime.harness.resume.bind(pausedRuntime.harness);
      pausedRuntime.harness.resume = () => { resumeCalls++; return resume(); };
      await expect(completePausedServiceRuntimeStartup(pausedRuntime)).rejects.toThrow(
        "active recovery request exists; ordinary startup remains stopped");
      expect(resumeCalls).toBe(0);
      await pausedRuntime.close();
      pausedRuntime = undefined;
    } finally {
      if (pausedRuntime !== undefined) await pausedRuntime.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects synthetic prior-boot launch state without running an unrelated generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-resume-race-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const marker = join(root, "unrelated-generation-ran.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nkeep_files: always\n", "utf8");
    writeFileSync(join(workflows, "startup-race.yaml"), [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      "  - hold:",
      "      run: sleep 30; printf stale-process",
      "",
    ].join("\n"), "utf8");

    const faux = fauxProvider({ provider: providerName, models: [{ id: modelId }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const installation = loadInstallation(root);
    let generationTaskId = 0;
    let oldProcessTaskId = 0;
    let oldProcessConversationId = 0;
    let oldProcessInput: ReturnType<typeof processExecutionTaskInputSchema.parse> | undefined;
    let oldProcess: ReturnType<typeof processIncarnationSchema.parse> | undefined;
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let openedHarness: HarnessType | undefined;
    const originalOpen = Harness.open;
    Harness.open = async (storage, options, context) => {
      const harness = await originalOpen(storage, options, context);
      openedHarness = harness;
      return harness;
    };

    try {
      const openedStorage = await openDurableStorage(installation.databasePath);
      if (!openedStorage.ok) throw new Error(openedStorage.failure.message);
      const seedHarness = await Harness.open(openedStorage.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
      try {
        await seedHarness.createConversation({
          ownership: { kind: "ownerless" },
          agent: { model: { provider: providerName, modelId }, thinkingLevel: "off", tools: [] },
          init: async (tx, conversationId) => {
            await tx.appendEntry(UserEntry, conversationId, {
              model: [{ role: "user", content: "Prepare one unrelated faux generation.", timestamp: Date.now() }],
            });
            const live = await tx.doc(LiveDoc, conversationId);
            const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId });
            live.run = { taskId, inputs: [] };
            generationTaskId = Number(taskId);
          },
        }, BACKGROUND_CONTEXT);
      } finally {
        await seedHarness.close(BACKGROUND_CONTEXT);
      }
      await updateTask(installation.databasePath, generationTaskId, (record) => ({
        ...record,
        state: { status: "sleeping", checkpoint: { phase: "prepare", attempt: 1 }, until: Date.now() + 60 * 60_000 },
      }));

      owner = await startWorkshopService(installation, models);
      const startResponse = await sendServiceRequest(owner.metadata.socketPath, {
        version: 1, method: "start", requestId: "startup-race-old-run", workflowId: "startup-race",
      });
      if (!startResponse.ok) throw new Error(startResponse.error.message);
      const started = serviceStartResultV1Schema.parse(startResponse.result);
      const processTask = await waitForProcessLaunchCheckpoint(openedHarness!, started.runId);
      oldProcessTaskId = Number(processTask.id);
      oldProcessConversationId = Number(processTask.conversationId);
      oldProcessInput = processExecutionTaskInputSchema.parse(processTask.input);
      expect(oldProcessInput.runId).toBe(started.runId);
      expect(generationTaskId).toBeLessThan(oldProcessTaskId);
      if (processTask.state.status !== "running") throw new Error("the original worker process is not running");
      const processCheckpoint = processTask.state.checkpoint;
      if (typeof processCheckpoint !== "object" || processCheckpoint === null
        || !("phase" in processCheckpoint) || processCheckpoint.phase !== "monitor"
        || !("process" in processCheckpoint)) {
        throw new Error("the original worker process did not reach its monitor checkpoint");
      }
      oldProcess = processIncarnationSchema.parse(processCheckpoint.process);
      const priorBootId = owner.metadata.bootId;
      expect(oldProcessInput.serviceBootId).toBe(priorBootId);
      expect(oldProcess.launchServiceBootId).toBe(priorBootId);

      await owner.shutdown();
      owner = undefined;

      const unknownLaunch = processIncarnationSchema.parse({
        ...oldProcess,
        status: "launching",
        startedAt: null,
        finishedAt: null,
        identity: null,
        exit: null,
        cleanupState: "pending",
        captures: [],
        stdio: oldProcess.stdio === undefined ? undefined : {
          ...oldProcess.stdio,
          write: { kind: "pending", queuedBytes: 0 },
        },
      });
      // This fixture injects a prior-boot launch state into persisted records after orderly shutdown.
      // It does not simulate a SIGKILL or claim that an operating-system interruption occurred.
      const restoredEvidence = await restorePriorBootProcessEvidence(installation.databasePath, {
        taskId: oldProcessTaskId,
        conversationId: oldProcessConversationId,
        executionId: unknownLaunch.executionId,
        input: oldProcessInput,
        process: unknownLaunch,
      });
      expect(restoredEvidence.task).toMatchObject({
        id: oldProcessTaskId,
        conversationId: oldProcessConversationId,
        owner: oldProcessInput.nodeTaskId,
        input: { runId: started.runId, executionId: unknownLaunch.executionId, serviceBootId: priorBootId },
        state: {
          status: "pending",
          checkpoint: {
            phase: "launch",
            process: { executionId: unknownLaunch.executionId, status: "launching", launchServiceBootId: priorBootId },
          },
        },
      });
      expect(restoredEvidence.processEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            runId: started.runId,
            taskId: oldProcessTaskId,
            process: expect.objectContaining({ executionId: unknownLaunch.executionId, status: "launching", launchServiceBootId: priorBootId }),
          }),
        }),
      ]));
      await updateTask(installation.databasePath, generationTaskId, (record) => ({
        ...record,
        state: { status: "pending", checkpoint: { phase: "prepare", attempt: 1 } },
      }));

      faux.setResponses([async () => {
        appendFileSync(marker, "generation executed\n", "utf8");
        return fauxAssistantMessage("unrelated generation completed");
      }]);

      const expectedStartupError = "process group " + unknownLaunch.executionId + ":" + unknownLaunch.incarnationId
        + " has no confirmed-death receipt at service startup or shutdown";
      const startupError = await startWorkshopService(installation, models).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(startupError).toBeInstanceOf(ServiceShutdownError);
      const startupCauses = (startupError as ServiceShutdownError).cause as AggregateError;
      expect(startupCauses).toBeInstanceOf(AggregateError);
      expect(startupCauses.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expectedStartupError }),
      ]));
      const attemptedBoot = serviceMetadataV1Schema.parse(JSON.parse(
        readFileSync(join(installation.stateDirectory, "service.json"), "utf8"),
      ));
      expect(attemptedBoot.status).toBe("failed");
      expect(attemptedBoot.bootId).not.toBe(priorBootId);
      const generationExecuted = await waitForFile(marker, 2_000);
      expect(generationExecuted).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      Harness.open = originalOpen;
      if (openedHarness !== undefined) await openedHarness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("does not resume unrelated faux generation during partial startup cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-partial-startup-resume-race-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const marker = join(root, "partial-open-generation-ran.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n", "utf8");

    const faux = fauxProvider({ provider: providerName, models: [{ id: modelId }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const installation = loadInstallation(root);
    let generationTaskId = 0;
    let openedHarness: HarnessType | undefined;
    let restoreTaskGraph: (() => void) | undefined;
    const originalOpen = Harness.open;

    try {
      const openedStorage = await openDurableStorage(installation.databasePath);
      if (!openedStorage.ok) throw new Error(openedStorage.failure.message);
      const seedHarness = await Harness.open(openedStorage.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
      try {
        await seedHarness.createConversation({
          ownership: { kind: "ownerless" },
          agent: { model: { provider: providerName, modelId }, thinkingLevel: "off", tools: [] },
          init: async (tx, conversationId) => {
            await tx.appendEntry(UserEntry, conversationId, {
              model: [{ role: "user", content: "Do not execute this unrelated faux generation.", timestamp: Date.now() }],
            });
            const live = await tx.doc(LiveDoc, conversationId);
            const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId });
            live.run = { taskId, inputs: [] };
            generationTaskId = Number(taskId);
          },
        }, BACKGROUND_CONTEXT);
      } finally {
        await seedHarness.close(BACKGROUND_CONTEXT);
      }
      await updateTask(installation.databasePath, generationTaskId, (record) => ({
        ...record,
        state: { status: "sleeping", checkpoint: { phase: "prepare", attempt: 1 }, until: Date.now() + 60 * 60_000 },
      }));
      await updateTask(installation.databasePath, generationTaskId, (record) => ({
        ...record,
        state: { status: "pending", checkpoint: { phase: "prepare", attempt: 1 } },
      }));
      faux.setResponses([async () => {
        appendFileSync(marker, "generation executed\n", "utf8");
        return fauxAssistantMessage("unrelated generation completed");
      }]);

      Harness.open = async (storage, options, context) => {
        const harness = await originalOpen(storage, options, context);
        openedHarness = harness;
        const mutableHarness = harness as unknown as { taskGraph: HarnessType["taskGraph"] };
        const originalTaskGraph = mutableHarness.taskGraph.bind(harness);
        mutableHarness.taskGraph = async () => {
          throw new Error("injected startup task graph inspection failure");
        };
        restoreTaskGraph = () => { mutableHarness.taskGraph = originalTaskGraph; };
        return harness;
      };

      const startupError = await startWorkshopService(installation, models).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(startupError).toBeInstanceOf(ServiceShutdownError);
      const startupCauses = (startupError as ServiceShutdownError).cause as AggregateError;
      expect(startupCauses).toBeInstanceOf(AggregateError);
      expect(startupCauses.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "Durable startup task graph could not be inspected; startup remains stopped" }),
      ]));
      const generationExecuted = await waitForFile(marker, 2_000);
      expect(generationExecuted).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      Harness.open = originalOpen;
      restoreTaskGraph?.();
      if (openedHarness !== undefined) await openedHarness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("serves the public status API after a clean boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-clean-"));
    const config = join(root, ".workshop");
    mkdirSync(join(config, "workflows"), { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n", "utf8");
    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      expect(health.kind).toBe("ready");
      const response = await sendServiceRequest(owner.metadata.socketPath, { version: 1, method: "status" });
      expect(response.ok).toBe(true);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function waitForProcessLaunchCheckpoint(harness: HarnessType, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const task = inspection.tasks.find((entry) => entry.record.kind === "workshop.process-execution"
      && typeof entry.record.input === "object" && entry.record.input !== null
      && "runId" in entry.record.input && entry.record.input.runId === runId);
    if (task?.record.state.status === "running") {
      const checkpoint = task.record.state.checkpoint;
      if (typeof checkpoint === "object" && checkpoint !== null
        && "phase" in checkpoint && checkpoint.phase === "monitor") return task.record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker process did not reach its monitor checkpoint");
}

async function updateTask(
  databasePath: string,
  taskId: number,
  change: (record: Record<string, any>) => Record<string, unknown>,
): Promise<void> {
  const database = await openNodeSqliteDatabase(databasePath);
  try {
    const row = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", taskId);
    if (row === undefined) throw new Error("fixture task record is missing");
    const record = change(JSON.parse(row.record) as Record<string, any>);
    const status = (record.state as { status: string }).status;
    await database.run("UPDATE tasks SET status = ?, abort_requested = ?, record = ? WHERE id = ?",
      status, record.abortRequested === true ? 1 : 0, JSON.stringify(record), taskId);
  } finally {
    await database.close();
  }
}

async function restorePriorBootProcessEvidence(
  databasePath: string,
  input: {
    taskId: number;
    conversationId: number;
    executionId: string;
    input: ReturnType<typeof processExecutionTaskInputSchema.parse> | undefined;
    process: ReturnType<typeof processIncarnationSchema.parse>;
  },
): Promise<{ task: Record<string, any>; processEntries: Record<string, any>[] }> {
  if (input.input === undefined) throw new Error("old process task input was not captured");
  const database = await openNodeSqliteDatabase(databasePath);
  try {
    const row = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", input.taskId);
    if (row === undefined) throw new Error("old process task record is missing after shutdown");
    const task = JSON.parse(row.record) as Record<string, any>;
    const taskInput = processExecutionTaskInputSchema.parse(task.input);
    if (taskInput.executionId !== input.executionId) throw new Error("old process task execution identity changed");
    const { endedAt: _endedAt, abortReason: _abortReason, ...liveTask } = task;
    const restoredTask = {
      ...liveTask,
      abortRequested: false,
      state: { status: "pending", checkpoint: { phase: "launch", process: input.process } },
    };
    await database.run("UPDATE tasks SET status = 'pending', abort_requested = 0, record = ? WHERE id = ?",
      JSON.stringify(restoredTask), input.taskId);

    const entries = await database.all<{ id: number; record: string }>(
      "SELECT id, record FROM entries WHERE conversation_id = ?", input.conversationId);
    let updated = 0;
    for (const entry of entries) {
      const record = JSON.parse(entry.record) as Record<string, any>;
      const data = record.data as Record<string, any> | undefined;
      if (record.kind !== "workshop.process" || data?.process?.executionId !== input.executionId) continue;
      const nextData = { ...data, process: input.process };
      await database.run("UPDATE entries SET record = ? WHERE id = ?", JSON.stringify({ ...record, data: nextData }), entry.id);
      updated++;
    }
    if (updated === 0) throw new Error("prior-boot process evidence was not present in the run conversation");

    const persistedTaskRow = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", input.taskId);
    if (persistedTaskRow === undefined) throw new Error("restored process task record is missing");
    const persistedEntries = await database.all<{ record: string }>(
      "SELECT record FROM entries WHERE conversation_id = ?", input.conversationId);
    const processEntries = persistedEntries.map((entry) => JSON.parse(entry.record) as Record<string, any>)
      .filter((record) => record.kind === "workshop.process"
        && (record.data as Record<string, any> | undefined)?.process?.executionId === input.executionId);
    return { task: JSON.parse(persistedTaskRow.record) as Record<string, any>, processEntries };
  } finally {
    await database.close();
  }
}

function testServiceMetadata(stateDirectory: string) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return serviceMetadataV1Schema.parse({
    version: 1,
    status: "starting",
    pid: process.pid,
    startIdentity: "paused-startup-api-test",
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
    socketPath: join(stateDirectory, "service.sock"),
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(path);
}
