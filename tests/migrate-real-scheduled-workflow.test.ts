import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createRegistry, Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { expect, test } from "bun:test";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { loadInstallation } from "../src/installation/load-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { serviceRunsPageV1Schema } from "../src/service/schema.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { defineAgentExecutionTask } from "../src/storage/durable/define-agent-execution-task.js";
import { defineScheduleWakeupTask } from "../src/storage/durable/define-scheduler-wakeup-task.js";
import { defineWorkshopTasks } from "../src/storage/durable/define-workshop-tasks.js";
import { WorkshopInstallationDoc } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { statusDtoSchema } from "../src/views/schema.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/real-1.0.2-scheduled-workflow/", import.meta.url));
const workflowId = "scheduled-migration";
const historicalOutput = "HISTORICAL_SCHEDULED_CAPTURE";
const fixtureRootPlaceholder = "/WORKSHOP_FIXTURE_ROOT";
const taskVersions = { workflowRun: 11, nodeAttempt: 5, agentExecution: 1, processExecution: 4, capacityGate: 1, scheduleWakeup: 1 } as const;

test("migrates and resumes a path-normalized 1.0.2 Workshop scheduler wait safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "workshop-migrate-scheduled-workflow-"));
  try {
    const workshopDirectory = join(root, ".workshop");
    const workflowsDirectory = join(workshopDirectory, "workflows");
    const stateDirectory = join(workshopDirectory, ".state");
    mkdirSync(workflowsDirectory, { recursive: true });
    mkdirSync(stateDirectory, { recursive: true });
    copyFileSync(join(fixtureDirectory, "workshop.yaml"), join(workshopDirectory, "workshop.yaml"));
    copyFileSync(join(fixtureDirectory, "scheduled-migration.yaml"), join(workflowsDirectory, "scheduled-migration.yaml"));
    const databasePath = join(stateDirectory, "durable.db");
    const fixtureDatabasePath = join(fixtureDirectory, "durable.db");
    expect(readFileSync(fixtureDatabasePath).includes(Buffer.from("/var/"))).toBe(false);
    copyFileSync(fixtureDatabasePath, databasePath);

    const legacyDatabase = await openNodeSqliteDatabase(databasePath);
    try {
      expect(await legacyDatabase.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))
        .toEqual({ version: 1 });

      const documentRevisions = await legacyDatabase.all<{ document_id: number; seq: number; content: string }>(
        "SELECT document_id, seq, content FROM document_revisions WHERE instr(content, ?) > 0 ORDER BY document_id, seq",
        fixtureRootPlaceholder,
      );
      const taskRecords = await legacyDatabase.all<{ id: number; record: string }>(
        "SELECT id, record FROM tasks WHERE instr(record, ?) > 0 ORDER BY id", fixtureRootPlaceholder,
      );
      const entries = await legacyDatabase.all<{ id: number; record: string }>(
        "SELECT id, record FROM entries WHERE instr(record, ?) > 0 ORDER BY id", fixtureRootPlaceholder,
      );
      expect(documentRevisions.map(row => row.document_id + ":" + row.seq)).toEqual(["12:2", "23:10", "24:10"]);
      expect(documentRevisions.map(row => countOccurrences(row.content, fixtureRootPlaceholder))).toEqual([3, 1, 2]);
      expect(taskRecords.map(row => row.id)).toEqual([17]);
      expect(taskRecords.map(row => JSON.parse(row.record).kind)).toEqual(["workshop.agent-execution"]);
      expect(taskRecords.map(row => countOccurrences(row.record, fixtureRootPlaceholder))).toEqual([5]);
      expect(entries.map(row => row.id)).toEqual([27]);
      expect(entries.map(row => JSON.parse(row.record).kind)).toEqual(["pi.user"]);
      expect(entries.map(row => countOccurrences(row.record, fixtureRootPlaceholder))).toEqual([2]);
      expect(
        documentRevisions.reduce((sum, row) => sum + countOccurrences(row.content, fixtureRootPlaceholder), 0)
        + taskRecords.reduce((sum, row) => sum + countOccurrences(row.record, fixtureRootPlaceholder), 0)
        + entries.reduce((sum, row) => sum + countOccurrences(row.record, fixtureRootPlaceholder), 0),
      ).toBe(13);

      // Restore only these path prefixes in the disposable database copy. Keep task state and evidence unchanged.
      await legacyDatabase.exec("BEGIN IMMEDIATE");
      try {
        await legacyDatabase.run("UPDATE document_revisions SET content = replace(content, ?, ?) WHERE instr(content, ?) > 0", fixtureRootPlaceholder, root, fixtureRootPlaceholder);
        await legacyDatabase.run("UPDATE tasks SET record = replace(record, ?, ?) WHERE instr(record, ?) > 0", fixtureRootPlaceholder, root, fixtureRootPlaceholder);
        await legacyDatabase.run("UPDATE entries SET record = replace(record, ?, ?) WHERE instr(record, ?) > 0", fixtureRootPlaceholder, root, fixtureRootPlaceholder);
        await legacyDatabase.exec("COMMIT");
      } catch (error) {
        await legacyDatabase.exec("ROLLBACK");
        throw error;
      }
      const remainingPlaceholders = await legacyDatabase.get<{ count: number }>(
        "SELECT (SELECT count(*) FROM document_revisions WHERE instr(content, ?) > 0) + (SELECT count(*) FROM tasks WHERE instr(record, ?) > 0) + (SELECT count(*) FROM entries WHERE instr(record, ?) > 0) AS count",
        fixtureRootPlaceholder, fixtureRootPlaceholder, fixtureRootPlaceholder,
      );
      expect(remainingPlaceholders?.count).toBe(0);
      const restoredDocumentRevisions = await legacyDatabase.all<{ content: string }>(
        "SELECT content FROM document_revisions WHERE instr(content, ?) > 0", root,
      );
      const restoredTaskRecords = await legacyDatabase.all<{ record: string }>(
        "SELECT record FROM tasks WHERE instr(record, ?) > 0", root,
      );
      const restoredEntries = await legacyDatabase.all<{ record: string }>(
        "SELECT record FROM entries WHERE instr(record, ?) > 0", root,
      );
      expect(
        restoredDocumentRevisions.reduce((sum, row) => sum + countOccurrences(row.content, root), 0)
        + restoredTaskRecords.reduce((sum, row) => sum + countOccurrences(row.record, root), 0)
        + restoredEntries.reduce((sum, row) => sum + countOccurrences(row.record, root), 0),
      ).toBe(13);
    } finally {
      await legacyDatabase.close();
    }

    const installation = loadInstallation(root);
    const provider = fauxProvider({ provider: "fixture", models: [{ id: "legacy-worker" }] });
    let recoveryModelRequests = 0;
    provider.setResponses([() => {
      recoveryModelRequests += 1;
      return fauxAssistantMessage("<status>succeeded</status>\n<reason>Unexpected post-upgrade worker request.</reason>\n<output>UNEXPECTED_RECOVERY_RUN</output>");
    }]);
    const models = createModels();
    models.setProvider(provider.provider);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let inspectionHarness: HarnessType | undefined;
    try {
      owner = await startWorkshopService(installation, models);
      const health = await probeServiceHealth(installation.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);

      const statusResponse = await sendServiceRequest(health.metadata.socketPath, { version: 1, method: "status", workflowId });
      if (!statusResponse.ok) throw new Error(statusResponse.error.message);
      const status = statusDtoSchema.parse(statusResponse.result);
      const workflow = status.workflows.find(item => item.workflowId === workflowId);
      expect(workflow?.configurationError).toBeNull();
      expect(workflow?.unresolvedRun).toBeNull();
      expect(workflow?.latestRun).toMatchObject({ status: "completed", terminalOutput: historicalOutput });
      const activation = workflow?.activation;
      expect(activation?.state).toBe("active");
      expect(activation?.admittedCount).toBe(1);
      if (activation === undefined || activation === null || activation.nextDueAt === null) {
        throw new Error("the migrated scheduler deadline is missing");
      }
      const capturedReferenceAt = Date.parse(activation.activatedAt);
      const deadlineAt = Date.parse(activation.nextDueAt);
      const expectedDelayMs = deadlineAt - capturedReferenceAt;
      expect(deadlineAt).toBeGreaterThan(capturedReferenceAt);

      const runsResponse = await sendServiceRequest(health.metadata.socketPath, { version: 1, method: "runs", workflowId, limit: 100 });
      if (!runsResponse.ok) throw new Error(runsResponse.error.message);
      const runs = serviceRunsPageV1Schema.parse(runsResponse.result);
      expect(runs.total).toBe(1);
      expect(runs.runs[0]).toMatchObject({ status: "completed", terminalOutput: historicalOutput });
      expect(recoveryModelRequests).toBe(0);

      await owner.shutdown();
      owner = undefined;

      const migratedDatabase = await openNodeSqliteDatabase(databasePath);
      try {
        expect(await migratedDatabase.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))
          .toEqual({ version: CURRENT_SQLITE_SCHEMA_VERSION });
      } finally {
        await migratedDatabase.close();
      }

      const opened = await openDurableStorage(databasePath);
      if (!opened.ok) throw new Error(opened.failure.message + ": " + String(opened.failure.cause));
      let activeHarness: HarnessType | undefined;
      const agentExecution = defineAgentExecutionTask({ getHarness: () => {
        if (activeHarness === undefined) throw new Error("inspection Harness is unavailable");
        return activeHarness;
      } });
      const tasks = defineWorkshopTasks("scheduled-migration-inspection", { agentExecutionTask: agentExecution.task });
      const scheduleWakeupTask = defineScheduleWakeupTask({
        installation,
        workflowRunTask: tasks.WorkflowRunTask,
        runtimeManifest: {
          durableVersion: "1.4.0",
          integrationManifestHash: canonicalHash({ taskVersions }),
          taskVersions,
        },
      });
      const registry = createRegistry();
      registry.install({
        name: "workshop-service-runtime",
        tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, agentExecution.task, scheduleWakeupTask],
      });
      registry.install(agentExecution.guard.extension);
      registry.install(CodingTools);
      const observedTimers: ObservedDeadlineTimer[] = [];
      activeHarness = await Harness.open(opened.storage, {
        models,
        registry,
        now: () => capturedReferenceAt,
        setTimer: captureDeadlineTimer(expectedDelayMs, observedTimers),
      }, BACKGROUND_CONTEXT);
      inspectionHarness = activeHarness;
      inspectionHarness.resume();
      const observationLimit = Date.now() + 5_000;
      while (observedTimers.length === 0 && Date.now() < observationLimit) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const observedTimer = observedTimers.find(timer => timer.delayMs === expectedDelayMs && !timer.cancelled);
      if (observedTimer === undefined) throw new Error("the live Harness did not re-arm the captured scheduler deadline");
      expect(observedTimer.background).toBe(false);

      const persisted = installationDocumentV1Schema.parse(
        await inspectionHarness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT),
      );
      if (persisted.state !== "ready") throw new Error("the migrated Workshop installation is not ready");
      const persistedWorkflow = persisted.workflows[workflowId];
      const persistedActivation = persistedWorkflow?.activations[0];
      if (persistedActivation?.schedulerTaskId === null || persistedActivation?.schedulerTaskId === undefined) {
        throw new Error("the migrated Workshop activation lost its scheduler task identity");
      }
      const inspection = await inspectionHarness.inspect(BACKGROUND_CONTEXT);
      const scheduler = inspection.tasks.find(task => Number(task.record.id) === persistedActivation.schedulerTaskId);
      expect(scheduler?.record.kind).toBe("workshop.schedule-wakeup");
      const checkpoint = (scheduler?.record.state as { checkpoint?: unknown } | undefined)?.checkpoint;
      expect(checkpoint).toEqual({ phase: "wait", waitFor: "deadline", wakeAt: persistedActivation.nextDueAt });
      expect(observedTimer.cancelled).toBe(false);
      expect(recoveryModelRequests).toBe(0);
      await inspectionHarness.close(BACKGROUND_CONTEXT);
      inspectionHarness = undefined;
      expect(observedTimer.cancelled).toBe(true);
    } finally {
      try {
        if (inspectionHarness !== undefined) await inspectionHarness.close(BACKGROUND_CONTEXT);
      } finally {
        if (owner !== undefined) await owner.shutdown();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

type ObservedDeadlineTimer = {
  readonly delayMs: number;
  readonly background: boolean;
  cancelled: boolean;
};

function captureDeadlineTimer(expectedDelayMs: number, observedTimers: ObservedDeadlineTimer[]) {
  return (
    callback: () => void,
    delayMs: number,
    options: { readonly background: boolean },
  ): (() => void) => {
    if (!options.background && delayMs === expectedDelayMs) {
      const timer: ObservedDeadlineTimer = { delayMs, background: options.background, cancelled: false };
      observedTimers.push(timer);
      return () => { timer.cancelled = true; };
    }
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  };
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}
