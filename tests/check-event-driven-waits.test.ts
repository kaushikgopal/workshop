import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { loadCheckedWorkflow, loadInstallation } from "../src/installation/load-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { workflowRunDocumentV1Schema } from "../src/run/records.js";
import { activationIdSchema, runIdSchema } from "../src/run/schema.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { createCapacityGateTaskInput } from "../src/storage/durable/define-capacity-gate-task.js";
import { createScheduleWakeupTaskInput, defineScheduleWakeupTask } from "../src/storage/durable/define-scheduler-wakeup-task.js";
import { createWorkflowRunTaskInput, defineWorkshopTasks, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const taskVersions = { workflowRun: 11, nodeAttempt: 5, agentExecution: 1, processExecution: 4, capacityGate: 1, scheduleWakeup: 1 } as const;
const runtimeManifest = {
  durableVersion: "1.0.2",
  integrationManifestHash: canonicalHash({ taskVersions }),
  taskVersions,
};

describe("event-driven durable waits", () => {
  test("far-future scheduler sleeps without checkpoint churn and reacquires its watch after reopen", async () => {
    const root = createRoot("scheduler-wait");
    const stateDirectory = join(root, ".workshop", ".state");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(root, ".workshop", "workflows", "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1d",
      "  max_runs: 3",
      "steps:",
      "  - tick:",
      "      run: 'printf tick'",
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    const workflowId = "scheduled";
    const activationId = "activation-scheduled";
    const nextDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    let harness: Harness | undefined;
    let schedulerTaskId: number | undefined;
    let commits = 0;
    let canAdmit = true;
    let releaseAdmission: (() => void) | undefined;
    const waitForAdmission = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("scheduler admission wait was cancelled"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      releaseAdmission = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
    let unsubscribe: (() => void) | undefined;
    try {
      const opened = await openWaitHarness(installation, stateDirectory);
      harness = opened.harness;
      await harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopInstallationDoc);
        Object.assign(draft, {
          state: "ready",
          installationId: "event-wait-scheduler",
          maxConcurrentRuns: 1,
          workflows: {
            [workflowId]: {
              definitionHash: null,
              admissionHighWater: 0,
              openRunId: null,
              activations: [{
                activationId,
                state: "active",
                admittedCount: 0,
                maxRuns: 3,
                activatedAt: new Date().toISOString(),
                nextDueAt,
                scheduleEveryMs: 24 * 60 * 60 * 1000,
                schedulerTaskId: null,
                skippedSlots: 0,
                admissionError: null,
                lastSkippedSlotAt: null,
              }],
              occurrenceCounters: { [activationId]: 0 },
              runs: [],
              requestIndex: {},
              capacityReservations: [],
              preflightCache: {},
            },
          },
        });
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const taskId = await tx.createTask(
          opened.scheduleTask,
          createScheduleWakeupTaskInput({ workflowId, activationId: activationIdSchema.parse(activationId) }),
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        );
        schedulerTaskId = Number(taskId);
        const document = installationDocumentV1Schema.parse(draft);
        if (document.state !== "ready") throw new Error("scheduler installation was not initialized");
        document.workflows[workflowId]!.activations[0]!.schedulerTaskId = Number(taskId);
        Object.assign(draft, installationDocumentV1Schema.parse(document));
      }, BACKGROUND_CONTEXT);
      unsubscribe = subscribeTaskCommits(harness, () => schedulerTaskId, () => { commits += 1; });
      harness.resume();
      await waitForTaskState(harness, schedulerTaskId, (state) => isCheckpoint(state, "wait"));
      let taskState = await readTaskState(harness, schedulerTaskId);
      expect(taskState.checkpoint).toEqual({ phase: "wait", waitFor: "deadline", wakeAt: nextDueAt });
      const deadlineCommits = commits;
      await sleep(650);
      expect(commits).toBe(deadlineCommits);

      await setActivation(harness, workflowId, activationId, { state: "paused" });
      await waitForTaskState(harness, schedulerTaskId, (state) => isCheckpoint(state, "wait", "paused"));
      const pausedCommits = commits;
      await sleep(650);
      expect(commits).toBe(pausedCommits);

      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;
      canAdmit = false;
      const reopened = await openWaitHarness(installation, stateDirectory, "open", {
        canAdmit: () => canAdmit,
        waitForAdmission,
      });
      harness = reopened.harness;
      unsubscribe?.();
      unsubscribe = subscribeTaskCommits(harness, () => schedulerTaskId, () => { commits += 1; });
      harness.resume();
      await setActivation(harness, workflowId, activationId, { state: "active" });
      await waitForTaskState(harness, schedulerTaskId, (state) => isCheckpoint(state, "wait", "admission"));
      const admissionWaitDeadline = Date.now() + 5_000;
      while (releaseAdmission === undefined && Date.now() < admissionWaitDeadline) await sleep(5);
      if (releaseAdmission === undefined) throw new Error("scheduler did not subscribe to its admission wake event");
      canAdmit = true;
      releaseAdmission?.();
      await waitForTaskState(harness, schedulerTaskId, (state) => isCheckpoint(state, "wait", "deadline"));
      expect((await readTaskState(harness, schedulerTaskId)).checkpoint).toEqual({
        phase: "wait", waitFor: "deadline", wakeAt: nextDueAt,
      });

      await setActivation(harness, workflowId, activationId, { state: "stopped", nextDueAt: null });
      const settled = await harness.waitForTask(schedulerTaskId as TaskId, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      expect(settled.state.outcome.status).toBe("completed");
    } finally {
      unsubscribe?.();
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("parks workflow admission through stop and resumes it after reopen", async () => {
    const root = createRoot("launch-admission");
    const stateDirectory = join(root, ".workshop", ".state");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(root, ".workshop", "workflows", "worker.yaml"), simpleWorkflow(), "utf8");
    const installation = loadInstallation(root);
    let harness: Harness | undefined;
    let workflowTaskId: number | undefined;
    let conversationId: ConversationId | undefined;
    try {
      const opened = await openWaitHarness(installation, stateDirectory, "closed");
      harness = opened.harness;
      const now = new Date().toISOString();
      await harness.commit(async (tx) => {
        Object.assign(await tx.doc(WorkshopInstallationDoc), {
          state: "ready",
          installationId: "event-wait-launch-gate",
          maxConcurrentRuns: 1,
          workflows: {
            worker: {
              definitionHash: null,
              admissionHighWater: 0,
              openRunId: null,
              activations: [{ activationId: "activation-worker", state: "active", admittedCount: 0, maxRuns: 1, activatedAt: now, nextDueAt: null, scheduleEveryMs: null }],
              occurrenceCounters: { "activation-worker": 0 },
              runs: [], requestIndex: {}, capacityReservations: [], preflightCache: {},
            },
          },
        });
      }, BACKGROUND_CONTEXT);
      const admission = await admitWorkflow(harness, opened.tasks, installation, "worker", "worker-run-launch-wait-001");
      workflowTaskId = Number(admission.value.workflowTaskId);
      conversationId = admission.value.conversationId as ConversationId;
      harness.resume();
      await waitForTaskState(harness, workflowTaskId, (state) => state.status === "running");

      opened.tasks.stopLaunching();
      await sleep(100);
      expect((await readTaskState(harness, workflowTaskId)).status).toBe("running");
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      const reopened = await openWaitHarness(installation, stateDirectory, "closed");
      harness = reopened.harness;
      harness.resume();
      await waitForTaskState(harness, workflowTaskId, (state) => state.status === "running");
      expect((await readTaskState(harness, workflowTaskId)).status).toBe("running");

      reopened.tasks.openStartupLaunchGate();
      const settled = await harness.waitForTask(workflowTaskId as TaskId, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      expect(settled.state.outcome.status).toBe("completed");
      if (conversationId === undefined) throw new Error("workflow conversation ID is unavailable");
      const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("workflow conversation is unavailable after reopen");
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const run = workflowRunDocumentV1Schema.parse(await harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
      expect(entries.items.some((entry) => entry.kind === "workshop.process")).toBe(true);
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("paused workflow watch survives graceful close and resumes after reopen", async () => {
    const root = createRoot("workflow-pause-watch");
    const stateDirectory = join(root, ".workshop", ".state");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(root, ".workshop", "workflows", "worker.yaml"), simpleWorkflow(), "utf8");
    const installation = loadInstallation(root);
    let harness: Harness | undefined;
    let workflowTaskId: number | undefined;
    let conversationId: ConversationId | undefined;
    try {
      const opened = await openWaitHarness(installation, stateDirectory);
      harness = opened.harness;
      const now = new Date().toISOString();
      await harness.commit(async (tx) => {
        Object.assign(await tx.doc(WorkshopInstallationDoc), {
          state: "ready",
          installationId: "event-wait-workflow-pause",
          maxConcurrentRuns: 1,
          workflows: {
            worker: {
              definitionHash: null,
              admissionHighWater: 0,
              openRunId: null,
              activations: [{ activationId: "activation-worker", state: "active", admittedCount: 0, maxRuns: 1, activatedAt: now, nextDueAt: null, scheduleEveryMs: null }],
              occurrenceCounters: { "activation-worker": 0 },
              runs: [], requestIndex: {}, capacityReservations: [], preflightCache: {},
            },
          },
        });
      }, BACKGROUND_CONTEXT);
      const admission = await admitWorkflow(harness, opened.tasks, installation, "worker", "worker-run-pause-watch");
      workflowTaskId = Number(admission.value.workflowTaskId);
      const activeConversationId = admission.value.conversationId as ConversationId;
      conversationId = activeConversationId;
      await harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopRunDoc, activeConversationId);
        const run = workflowRunDocumentV1Schema.parse(draft);
        if (run.state !== "ready") throw new Error("pause-watch run was not initialized");
        Object.assign(draft, workflowRunDocumentV1Schema.parse({ ...run, desiredState: "paused" }));
      }, BACKGROUND_CONTEXT);
      harness.resume();
      await waitForTaskState(harness, workflowTaskId, (state) => isCheckpoint(state, "admitAttempt"));
      await waitForRunStatus(harness, activeConversationId, "paused");
      await sleep(50);

      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      const reopened = await openWaitHarness(installation, stateDirectory);
      harness = reopened.harness;
      harness.resume();
      await waitForTaskState(harness, workflowTaskId, (state) => state.status === "running");
      const paused = workflowRunDocumentV1Schema.parse(await harness.snapshot(WorkshopRunDoc, activeConversationId, BACKGROUND_CONTEXT));
      expect(paused.state).toBe("ready");
      if (paused.state !== "ready") throw new Error("pause-watch run was not initialized after reopen");
      expect(paused.status).toBe("paused");

      await harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopRunDoc, activeConversationId);
        const run = workflowRunDocumentV1Schema.parse(draft);
        if (run.state !== "ready") throw new Error("pause-watch run was not initialized before resume");
        Object.assign(draft, workflowRunDocumentV1Schema.parse({ ...run, status: "running", desiredState: "running" }));
        const installationDraft = await tx.doc(WorkshopInstallationDoc);
        const document = installationDocumentV1Schema.parse(installationDraft);
        if (document.state !== "ready") throw new Error("pause-watch installation was not initialized");
        const reference = document.workflows.worker?.runs.find((entry) => entry.runId === run.runId);
        if (reference === undefined) throw new Error("pause-watch run reference was not found");
        reference.status = "running";
        Object.assign(installationDraft, installationDocumentV1Schema.parse(document));
      }, BACKGROUND_CONTEXT);
      const settled = await harness.waitForTask(workflowTaskId as TaskId, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      expect(settled.state.outcome.status).toBe("completed");
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("keeps a due scheduler live through shutdown and admits after reopen", async () => {
    const root = createRoot("scheduler-shutdown-wait");
    const stateDirectory = join(root, ".workshop", ".state");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(root, ".workshop", "workflows", "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1d",
      "  max_runs: 1",
      "steps:",
      "  - tick:",
      "      run: 'printf tick'",
      "",
    ].join("\n"), "utf8");
    const installation = loadInstallation(root);
    const workflowId = "scheduled";
    const activationId = "activation-shutdown";
    const nextDueAt = new Date(Date.now() + 700).toISOString();
    let harness: Harness | undefined;
    let schedulerTaskId: number | undefined;
    try {
      const opened = await openWaitHarness(installation, stateDirectory);
      harness = opened.harness;
      await harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopInstallationDoc);
        Object.assign(draft, {
          state: "ready",
          installationId: "event-wait-scheduler-shutdown",
          maxConcurrentRuns: 1,
          workflows: {
            [workflowId]: {
              definitionHash: null,
              admissionHighWater: 0,
              openRunId: null,
              activations: [{
                activationId, state: "active", admittedCount: 0, maxRuns: 1, activatedAt: new Date().toISOString(),
                nextDueAt, scheduleEveryMs: 24 * 60 * 60 * 1000, schedulerTaskId: null, skippedSlots: 0,
                admissionError: null, lastSkippedSlotAt: null,
              }],
              occurrenceCounters: { [activationId]: 0 },
              runs: [], requestIndex: {}, capacityReservations: [], preflightCache: {},
            },
          },
        });
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        schedulerTaskId = Number(await tx.createTask(
          opened.scheduleTask,
          createScheduleWakeupTaskInput({ workflowId, activationId: activationIdSchema.parse(activationId) }),
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        ));
        const document = installationDocumentV1Schema.parse(draft);
        if (document.state !== "ready") throw new Error("scheduler installation was not initialized");
        document.workflows[workflowId]!.activations[0]!.schedulerTaskId = schedulerTaskId;
        Object.assign(draft, installationDocumentV1Schema.parse(document));
      }, BACKGROUND_CONTEXT);
      harness.resume();
      await waitForTaskState(harness, schedulerTaskId, (state) => isCheckpoint(state, "wait", "deadline"));

      opened.tasks.stopLaunching();
      await sleep(Math.max(0, Date.parse(nextDueAt) - Date.now() + 50));
      await waitForTaskState(harness, schedulerTaskId, (state) => isCheckpoint(state, "wait", "admission"));
      expect((await readTaskState(harness, schedulerTaskId)).status).toBe("running");
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(nextDueAt));
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      const reopened = await openWaitHarness(installation, stateDirectory);
      harness = reopened.harness;
      harness.resume();
      const settled = await harness.waitForTask(schedulerTaskId as TaskId, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      expect(settled.state.outcome.status).toBe("completed");
      const persisted = installationDocumentV1Schema.parse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
      if (persisted.state !== "ready") throw new Error("scheduler installation was not initialized after reopen");
      expect(persisted.workflows[workflowId]?.activations[0]?.admittedCount).toBe(1);
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("capacity gate does not checkpoint while full, then wakes after reopen and slot release", async () => {
    const root = createRoot("capacity-wait");
    const stateDirectory = join(root, ".workshop", ".state");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(root, ".workshop", "workflows", "holder.yaml"), simpleWorkflow(), "utf8");
    writeFileSync(join(root, ".workshop", "workflows", "waiter.yaml"), simpleWorkflow(), "utf8");
    const installation = loadInstallation(root);
    let harness: Harness | undefined;
    let gateTaskId: number | undefined;
    let waiterAdmission: Awaited<ReturnType<typeof admitWorkflow>> | undefined;
    let commits = 0;
    let unsubscribe: (() => void) | undefined;
    try {
      const opened = await openWaitHarness(installation, stateDirectory, "closed");
      harness = opened.harness;
      const now = new Date().toISOString();
      await harness.commit(async (tx) => {
        Object.assign(await tx.doc(WorkshopInstallationDoc), {
          state: "ready",
          installationId: "event-wait-capacity",
          maxConcurrentRuns: 2,
          workflows: Object.fromEntries(["holder", "waiter"].map((workflowId) => {
            const activationId = "activation-" + workflowId;
            return [workflowId, {
              definitionHash: null,
              admissionHighWater: 0,
              openRunId: null,
              activations: [{ activationId, state: "active", admittedCount: 0, maxRuns: 1, activatedAt: now, nextDueAt: null, scheduleEveryMs: null }],
              occurrenceCounters: { [activationId]: 0 },
              runs: [],
              requestIndex: {},
              capacityReservations: [],
              preflightCache: {},
            }];
          })),
        });
      }, BACKGROUND_CONTEXT);
      const holder = await admitWorkflow(harness, opened.tasks, installation, "holder", "holder-run-001");
      waiterAdmission = await admitWorkflow(harness, opened.tasks, installation, "waiter", "waiter-run-001");
      const holderWorkflowTaskId = Number(holder.value.workflowTaskId);
      const waiterWorkflowTaskId = Number(waiterAdmission.value.workflowTaskId);
      const afterAdmissions = installationDocumentV1Schema.parse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
      if (afterAdmissions.state !== "ready") throw new Error("installation was not initialized after admissions");
      expect(afterAdmissions.workflows.holder?.capacityReservations).toContain(runIdSchema.parse(holder.value.runId));
      expect(afterAdmissions.workflows.waiter?.capacityReservations).toContain(runIdSchema.parse(waiterAdmission.value.runId));
      await harness.commit(async (tx) => {
        const draft = await tx.doc(WorkshopInstallationDoc);
        const document = installationDocumentV1Schema.parse(draft);
        if (document.state !== "ready") throw new Error("capacity installation was not initialized");
        document.maxConcurrentRuns = 1;
        document.workflows.waiter!.capacityReservations = [];
        const conversationId = waiterAdmission!.value.conversationId as ConversationId;
        const gateId = await tx.createTask(
          opened.tasks.CapacityGateTask,
          createCapacityGateTaskInput({
            runId: runIdSchema.parse(waiterAdmission!.value.runId),
            workflowId: "waiter",
            activationId: waiterAdmission!.value.activationId,
            occurrenceId: waiterAdmission!.value.occurrenceId,
            workflowTaskId: waiterAdmission!.value.workflowTaskId,
          }),
          {
            ownership: { kind: "task", taskId: waiterAdmission!.value.workflowTaskId as TaskId },
            conversationId,
          },
        );
        gateTaskId = Number(gateId);
        const runDraft = await tx.doc(WorkshopRunDoc, conversationId);
        const run = workflowRunDocumentV1Schema.parse(runDraft);
        if (run.state !== "ready") throw new Error("waiter run was not initialized");
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({
          ...run,
          status: "queued",
          desiredState: "paused",
          durable: { ...run.durable, capacityGateTaskId: Number(gateId) },
        }));
        Object.assign(draft, installationDocumentV1Schema.parse(document));
      }, BACKGROUND_CONTEXT);
      unsubscribe = subscribeTaskCommits(harness, () => gateTaskId, () => { commits += 1; });
      opened.tasks.stopLaunching();
      harness.resume();
      await waitForTaskState(harness, holderWorkflowTaskId, (state) => state.status === "running");
      await waitForTaskState(harness, waiterWorkflowTaskId, (state) => state.status === "running");
      await waitForTaskState(harness, gateTaskId, (state) => isCheckpoint(state, "wait"));
      const blockedCommits = commits;
      await sleep(650);
      expect(commits).toBe(blockedCommits);

      await setRunPaused(harness, waiterAdmission.value.conversationId as ConversationId, false);
      await sleep(100);
      expect(commits).toBe(blockedCommits);
      await sleep(650);
      expect(commits).toBe(blockedCommits);
      const beforeClose = installationDocumentV1Schema.parse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
      if (beforeClose.state !== "ready") throw new Error("installation was not initialized before close");
      expect(beforeClose.workflows.holder?.capacityReservations).toContain(runIdSchema.parse(holder.value.runId));
      expect(beforeClose.workflows.waiter?.capacityReservations).toEqual([]);
      expect((await readTaskState(harness, holderWorkflowTaskId)).status).toBe("running");
      expect((await readTaskState(harness, waiterWorkflowTaskId)).status).toBe("running");
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      const reopened = await openWaitHarness(installation, stateDirectory, "closed");
      harness = reopened.harness;
      const afterOpen = installationDocumentV1Schema.parse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
      if (afterOpen.state !== "ready") throw new Error("installation was not initialized after reopen");
      expect(afterOpen.workflows.holder?.capacityReservations).toContain(runIdSchema.parse(holder.value.runId));
      unsubscribe?.();
      unsubscribe = subscribeTaskCommits(harness, () => gateTaskId, () => { commits += 1; });
      harness.resume();
      await waitForTaskState(harness, holderWorkflowTaskId, (state) => state.status === "running");
      await waitForTaskState(harness, waiterWorkflowTaskId, (state) => state.status === "running");
      await waitForTaskState(harness, gateTaskId, (state) => isCheckpoint(state, "wait"));
      await releaseCapacity(harness, holder.value.runId);
      const settled = await harness.waitForTask(gateTaskId as TaskId, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      expect(settled.state.outcome.status).toBe("completed");
      const waiter = workflowRunDocumentV1Schema.parse(await harness.snapshot(
        WorkshopRunDoc,
        waiterAdmission.value.conversationId as ConversationId,
        BACKGROUND_CONTEXT,
      ));
      expect(waiter.state).toBe("ready");
      if (waiter.state !== "ready") throw new Error("waiter run is missing");
      expect(waiter.status).toBe("running");
      expect((await readTaskState(harness, waiterWorkflowTaskId)).status).toBe("running");
      reopened.tasks.openStartupLaunchGate();
      const holderSettled = await harness.waitForTask(holderWorkflowTaskId as TaskId, BACKGROUND_CONTEXT);
      const waiterSettled = await harness.waitForTask(waiterWorkflowTaskId as TaskId, BACKGROUND_CONTEXT);
      expect(holderSettled.state.status).toBe("terminal");
      expect(waiterSettled.state.status).toBe("terminal");
    } finally {
      unsubscribe?.();
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

async function openWaitHarness(
  installation: ReturnType<typeof loadInstallation>,
  stateDirectory: string,
  startupLaunchGate: "open" | "closed" = "open",
  scheduleOptions: {
    readonly canAdmit?: () => boolean;
    readonly waitForAdmission?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const opened = await openDurableStorage(join(stateDirectory, "durable.db"));
  if (!opened.ok) throw new Error(opened.failure.message);
  const tasks = defineWorkshopTasks(randomUUID(), { startupLaunchGate });
  const scheduleTask = defineScheduleWakeupTask({
    installation,
    workflowRunTask: tasks.WorkflowRunTask,
    runtimeManifest,
    canAdmit: tasks.canLaunch,
    waitForAdmission: tasks.waitForAdmission,
    ...scheduleOptions,
  });
  const registry = createRegistry();
  registry.install({
    name: "event-wait-test",
    tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, scheduleTask],
  });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
  return { harness, tasks, scheduleTask };
}

async function admitWorkflow(
  harness: Harness,
  tasks: ReturnType<typeof defineWorkshopTasks>,
  installation: ReturnType<typeof loadInstallation>,
  workflowId: string,
  runId: string,
) {
  const checked = loadCheckedWorkflow(installation, workflowId);
  const activationId = "activation-" + workflowId;
  const prepared = prepareRunAdmission({
    sourceText: checked.sourceText,
    sourceLabel: checked.sourcePath,
    workflowId,
    machineConfig: installation.machine,
    projectCwd: installation.projectCwd,
    stateDirectory: installation.stateDirectory,
    resolvedSettings: checked.resolvedSettings,
    runtimeManifest,
    runId: runIdSchema.parse(runId),
    eventId: randomUUID(),
    activationId,
    occurrenceId: "occurrence-" + workflowId,
    requestId: "request-" + workflowId,
    admittedAt: new Date().toISOString(),
  });
  if (!prepared.ok) throw new Error(prepared.failure.message);
  const result = await admitPreparedRun({
    harness,
    prepared: prepared.value,
    workflowRunTask: tasks.WorkflowRunTask,
    createTaskInput: createWorkflowRunTaskInput,
    parseTaskInput: parseWorkflowRunTaskInput,
    context: BACKGROUND_CONTEXT,
  });
  if (!result.ok) throw new Error(result.failure.message);
  return result;
}

async function setActivation(
  harness: Harness,
  workflowId: string,
  activationId: string,
  change: { state: "active" | "paused" | "stopped"; nextDueAt?: string | null },
): Promise<void> {
  await harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopInstallationDoc);
    const document = installationDocumentV1Schema.parse(draft);
    if (document.state !== "ready") throw new Error("installation was not initialized");
    const activation = document.workflows[workflowId]?.activations.find((entry) => entry.activationId === activationId);
    if (activation === undefined) throw new Error("activation was not found");
    activation.state = change.state;
    if (change.nextDueAt !== undefined) activation.nextDueAt = change.nextDueAt;
    Object.assign(draft, installationDocumentV1Schema.parse(document));
  }, BACKGROUND_CONTEXT);
}

async function setRunPaused(harness: Harness, conversationId: ConversationId, paused: boolean): Promise<void> {
  await harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopRunDoc, conversationId);
    const run = workflowRunDocumentV1Schema.parse(draft);
    if (run.state !== "ready") throw new Error("run was not initialized");
    Object.assign(draft, workflowRunDocumentV1Schema.parse({
      ...run,
      status: "queued",
      desiredState: paused ? "paused" : "running",
    }));
    const installationDraft = await tx.doc(WorkshopInstallationDoc);
    const document = installationDocumentV1Schema.parse(installationDraft);
    if (document.state !== "ready") throw new Error("installation was not initialized");
    const reference = document.workflows[run.workflowId]?.runs.find((entry) => entry.runId === run.runId);
    if (reference === undefined) throw new Error("run reference was not found");
    reference.status = paused ? "paused" : "queued";
    Object.assign(installationDraft, installationDocumentV1Schema.parse(document));
  }, BACKGROUND_CONTEXT);
}

async function waitForRunStatus(harness: Harness, conversationId: ConversationId, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = workflowRunDocumentV1Schema.parse(await harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
    if (run.state === "ready" && run.status === status) return;
    await sleep(10);
  }
  throw new Error("WorkflowRun did not reach status " + status);
}

async function releaseCapacity(harness: Harness, runId: string): Promise<void> {
  await harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopInstallationDoc);
    const document = installationDocumentV1Schema.parse(draft);
    if (document.state !== "ready") throw new Error("installation was not initialized");
    const workflow = Object.values(document.workflows).find((index) => index.runs.some((entry) => entry.runId === runId));
    if (workflow === undefined) throw new Error("capacity holder reference was not found");
    workflow.capacityReservations = workflow.capacityReservations.filter((reserved) => reserved !== runId);
    workflow.openRunId = null;
    const reference = workflow.runs.find((entry) => entry.runId === runId);
    if (reference === undefined) throw new Error("capacity holder reference was not found");
    reference.status = "completed";
    Object.assign(draft, installationDocumentV1Schema.parse(document));
  }, BACKGROUND_CONTEXT);
}

function subscribeTaskCommits(harness: Harness, id: () => number | undefined, onCommit: () => void): () => void {
  return harness.subscribeCommits((publication) => {
    if (id() === undefined) return;
    if (publication.changes.some((change) => change.type === "task" && Number(change.value.id) === id())) onCommit();
  });
}

async function waitForTaskState(
  harness: Harness,
  taskId: number | undefined,
  predicate: (state: Awaited<ReturnType<typeof readTaskState>>) => boolean,
): Promise<void> {
  if (taskId === undefined) throw new Error("task ID is unavailable");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readTaskState(harness, taskId);
    if (predicate(state)) return;
    await sleep(10);
  }
  throw new Error("durable task did not reach the expected checkpoint");
}

async function readTaskState(harness: Harness, taskId: number | undefined) {
  if (taskId === undefined) throw new Error("task ID is unavailable");
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  const task = inspection.tasks.find((entry) => Number(entry.record.id) === taskId);
  if (task === undefined) {
    const settled = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
    throw new Error("durable task is not live: " + JSON.stringify(settled?.state));
  }
  return task.record.state;
}

function isCheckpoint(state: Awaited<ReturnType<typeof readTaskState>>, phase: string, waitFor?: string): boolean {
  if (state.status !== "running" || typeof state.checkpoint !== "object" || state.checkpoint === null
    || Array.isArray(state.checkpoint)) return false;
  const checkpoint = state.checkpoint as Record<string, unknown>;
  return checkpoint.phase === phase && (waitFor === undefined || checkpoint.waitFor === waitFor);
}

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), "workshop-" + prefix + "-"));
  mkdirSync(join(root, ".workshop", "workflows"), { recursive: true });
  writeFileSync(join(root, ".workshop", "workshop.yaml"), "max_concurrent_runs: 2\n", "utf8");
  return root;
}

function simpleWorkflow(): string {
  return [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - work:",
    "      run: 'printf done'",
    "",
  ].join("\n");
}
