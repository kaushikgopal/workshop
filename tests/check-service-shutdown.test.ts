import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
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
import { serviceStartResultV1Schema } from "../src/service/schema.js";
import { statusDtoSchema } from "../src/views/schema.js";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const taskVersions = { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, scheduleWakeup: 1 } as const;

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
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - hold:",
      "      run: >-",
      `        trap "printf 'TERM\\n' >> '${processMarker}'; sleep 0.45; printf 'RETIRED\\n' >> '${processMarker}'; exit 0" TERM; printf 'STARTED\\n' >> '${processMarker}'; while :; do sleep 5; done`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 2s",
      "  max_runs: 3",
      "steps:",
      "  - tick:",
      `      run: 'printf x >> ${scheduledMarker}'`,
      "",
    ].join("\n"), "utf8");

    const installation = loadInstallation(root);
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let inspectHarness: Harness | undefined;
    try {
      owner = await startWorkshopService(installation);
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
        tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, scheduleWakeupTask],
      });
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
      expect(inspection.tasks.filter((task) => ["workshop.node-attempt", "workshop.process-execution"].includes(task.record.kind)
        && Number(task.record.conversationId) === Number(firstRun.conversationId))).toHaveLength(0);
    } finally {
      if (inspectHarness !== undefined) await inspectHarness.close(BACKGROUND_CONTEXT);
      if (owner !== undefined) await owner.shutdown().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});

async function waitForText(path: string, text: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return;
    await sleep(20);
  }
  throw new Error(`process fixture did not write ${text}`);
}
