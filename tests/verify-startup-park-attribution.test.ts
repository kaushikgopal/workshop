import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { createWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { createScheduleWakeupTaskInput } from "../src/storage/durable/define-scheduler-wakeup-task.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { WorkshopBotDoc, WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { activationIdSchema } from "../src/run/schema.js";
import { MAX_STARTUP_PARK_TASKS_V1 } from "../src/service/schema.js";
import { verifyStartupParkAttributions } from "../src/service/open-service-runtime.js";

const workflowId = "startup-attribution";
const workflowTaskKind = "workshop.workflow-run";
const schedulerTaskKind = "workshop.schedule-wakeup";
const workflowTask = defineTask<ReturnType<typeof createWorkflowRunTaskInput>, { readonly phase: "hold" }, { readonly done: true }>({
  name: workflowTaskKind, version: 11, initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { done: true } } }), context);
    },
  },
  abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), context),
});
const schedulerTask = defineTask<ReturnType<typeof createScheduleWakeupTaskInput>, { readonly phase: "hold" }, { readonly done: true }>({
  name: schedulerTaskKind, version: 1, initial: () => ({ phase: "hold" }),
  phases: { hold: async () => undefined },
  abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), context),
});
const dormantTask = defineTask<Record<string, never>, { readonly phase: "hold" }, { readonly done: true }>({
  name: "workshop.test.startup-attribution-dormant", version: 1, initial: () => ({ phase: "hold" }),
  phases: { hold: async () => undefined },
  abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), context),
});
const probeTask = defineTask<{ readonly markerPath: string; readonly secret: string }, { readonly phase: "fire" }, { readonly done: true }>({
  name: "workshop.test.startup-attribution-probe", version: 1, initial: () => ({ phase: "fire" }),
  phases: {
    fire: async (task, runtime, context) => {
      writeFileSync(task.input.markerPath, task.input.secret);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { done: true } } }), context);
    },
  },
  abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), context),
});

function registry() {
  const value = createRegistry();
  value.install({ name: "startup-attribution-test", tasks: [workflowTask, schedulerTask, dormantTask, probeTask] });
  return value;
}

describe("verified startup park attribution", () => {
  test("checks owner chains, canonical identities, and shared bot without scheduling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-startup-attribution-"));
    const markerPath = join(directory, "must-not-run");
    let harness: Harness | undefined;
    try {
      const opened = await openDurableStorage(join(directory, "durable.db"));
      if (!opened.ok) throw new Error(opened.failure.message);
      harness = await Harness.open(opened.storage, { models: createModels(), registry: registry() }, BACKGROUND_CONTEXT);
      const activationId = randomUUID(), occurrenceId = randomUUID();
      const runId = workflowId + "-" + randomUUID();
      const taskInput = createWorkflowRunTaskInput({ workflowId, runId, activationId, occurrenceId });
      const created = await harness.commit(async (tx) => {
        const runConversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const workflowTaskId = await tx.createTask(workflowTask, taskInput, {
          ownership: { kind: "conversation" }, conversationId: runConversation.id,
        });
        const schedulerTaskId = await tx.createTask(schedulerTask, createScheduleWakeupTaskInput({ workflowId, activationId: activationIdSchema.parse(activationId) }), {
          ownership: { kind: "conversation" }, conversationId: runConversation.id,
        });
        const ownedConversation = await tx.createConversation({ ownership: { kind: "task", taskId: workflowTaskId } });
        const conversationTaskId = await tx.createTask(dormantTask, {}, {
          ownership: { kind: "conversation" }, conversationId: ownedConversation.id,
        });
        const descendantTaskId = await tx.createTask(dormantTask, {}, {
          ownership: { kind: "task", taskId: conversationTaskId }, conversationId: ownedConversation.id,
        });
        const botConversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const botDraft = await tx.doc(WorkshopBotDoc);
        Object.assign(botDraft, { state: "ready", conversationId: Number(botConversation.id), cursorInitialized: false, eventCursors: {} });
        const botRootTaskId = await tx.createTask(probeTask, { markerPath, secret: "private-input-sentinel" }, {
          ownership: { kind: "conversation" }, conversationId: botConversation.id,
        });
        const botChildTaskId = await tx.createTask(dormantTask, {}, {
          ownership: { kind: "task", taskId: botRootTaskId }, conversationId: botConversation.id,
        });
        const unrelatedConversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const unrelatedTaskId = await tx.createTask(dormantTask, {}, {
          ownership: { kind: "conversation" }, conversationId: unrelatedConversation.id,
        });
        const directRunConversationTaskId = await tx.createTask(dormantTask, {}, {
          ownership: { kind: "conversation" }, conversationId: runConversation.id,
        });
        const probeTaskId = await tx.createTask(probeTask, { markerPath, secret: "do-not-run" }, {
          ownership: { kind: "conversation" }, conversationId: unrelatedConversation.id,
        });
        const admittedAt = new Date().toISOString();
        const installation = installationDocumentV1Schema.parse({
          state: "ready", installationId: randomUUID(), maxConcurrentRuns: 1,
          workflows: {
            [workflowId]: {
              definitionHash: null, admissionHighWater: 1, openRunId: runId,
              activations: [{
                activationId, state: "active", admittedCount: 1, maxRuns: "unlimited",
                activatedAt: admittedAt, nextDueAt: new Date(Date.now() + 60_000).toISOString(),
                scheduleEveryMs: 60_000, schedulerTaskId: Number(schedulerTaskId),
                skippedSlots: 0, lastSkippedSlotAt: null, admissionError: null,
              }],
              occurrenceCounters: { [activationId]: 1 },
              runs: [{
                runId, activationId, occurrenceId,
                conversationId: Number(runConversation.id), workflowTaskId: Number(workflowTaskId),
                admissionSequence: 1, admittedAt, status: "queued", requestId: null,
              }],
              requestIndex: {}, capacityReservations: [runId], preflightCache: {},
            },
          },
        });
        const installationDraft = await tx.doc(WorkshopInstallationDoc);
        Object.assign(installationDraft, installation);
        const runDraft = await tx.doc(WorkshopRunDoc, runConversation.id);
        Object.assign(runDraft, {
          state: "ready", workflowId, runId, activationId, occurrenceId,
          durable: { conversationId: Number(runConversation.id), workflowTaskId: Number(workflowTaskId) },
        });
        return {
          workflowTaskId: Number(workflowTaskId), schedulerTaskId: Number(schedulerTaskId),
          conversationTaskId: Number(conversationTaskId), descendantTaskId: Number(descendantTaskId),
          botRootTaskId: Number(botRootTaskId), botChildTaskId: Number(botChildTaskId),
          unrelatedTaskId: Number(unrelatedTaskId), directRunConversationTaskId: Number(directRunConversationTaskId),
          probeTaskId: Number(probeTaskId),
        };
      }, BACKGROUND_CONTEXT);

      const verification = await verifyStartupParkAttributions(harness, [
        created.schedulerTaskId, created.workflowTaskId, created.conversationTaskId, created.descendantTaskId,
        created.botRootTaskId, created.botChildTaskId, created.unrelatedTaskId,
        created.directRunConversationTaskId, created.probeTaskId, 2_000_000_000,
      ].sort((left, right) => left - right), schedulerTaskKind, workflowTaskKind, Date.now() + 10_000);
      expect(verification.byTaskId.get(created.schedulerTaskId)).toEqual({ kind: "scheduler", workflowId, activationId });
      expect(verification.byTaskId.get(created.workflowTaskId)).toEqual({ kind: "workflow_run", workflowId, runId });
      expect(verification.byTaskId.get(created.conversationTaskId)).toEqual({ kind: "workflow_run", workflowId, runId });
      expect(verification.byTaskId.get(created.descendantTaskId)).toEqual({ kind: "workflow_run", workflowId, runId });
      expect(verification.byTaskId.get(created.botRootTaskId)).toEqual({ kind: "bot" });
      expect(verification.byTaskId.get(created.botChildTaskId)).toEqual({ kind: "bot" });
      expect(verification.byTaskId.get(created.unrelatedTaskId)).toEqual({ kind: "unknown" });
      expect(verification.byTaskId.get(created.directRunConversationTaskId)).toEqual({ kind: "unknown" });
      expect(verification.byTaskId.get(2_000_000_000)).toEqual({ kind: "unknown" });
      expect(verification.complete).toBe(false);
      const attributionText = JSON.stringify([...verification.byTaskId.values()]);
      expect(attributionText).not.toContain("private-input-sentinel");
      expect(attributionText).not.toContain(markerPath);
      expect(existsSync(markerPath)).toBe(false);
      expect((await harness.getTask(created.probeTaskId as never, BACKGROUND_CONTEXT))?.state.status).toBe("pending");
    } finally {
      await harness?.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("bounds attribution to the sorted diagnostic task prefix", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-startup-attribution-budget-"));
    let harness: Harness | undefined;
    try {
      const opened = await openDurableStorage(join(directory, "durable.db"));
      if (!opened.ok) throw new Error(opened.failure.message);
      harness = await Harness.open(opened.storage, { models: createModels(), registry: registry() }, BACKGROUND_CONTEXT);
      const taskIds = Array.from({ length: MAX_STARTUP_PARK_TASKS_V1 * 40 }, (_, index) => index + 1);
      const verification = await verifyStartupParkAttributions(
        harness, taskIds, schedulerTaskKind, workflowTaskKind, Date.now() + 10_000,
      );
      expect([...verification.byTaskId.keys()]).toEqual(taskIds.slice(0, MAX_STARTUP_PARK_TASKS_V1));
      expect(verification.byTaskId.size).toBe(MAX_STARTUP_PARK_TASKS_V1);
      expect(verification.complete).toBe(false);
    } finally {
      await harness?.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("reads terminal task owners through the public transaction API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-terminal-owner-attribution-"));
    let harness: Harness | undefined;
    try {
      const opened = await openDurableStorage(join(directory, "durable.db"));
      if (!opened.ok) throw new Error(opened.failure.message);
      harness = await Harness.open(opened.storage, { models: createModels(), registry: registry() }, BACKGROUND_CONTEXT);
      const activationId = randomUUID(), occurrenceId = randomUUID();
      const runId = workflowId + "-" + randomUUID();
      const input = createWorkflowRunTaskInput({ workflowId, runId, activationId, occurrenceId });
      const root = await harness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const taskId = await tx.createTask(workflowTask, input, {
          ownership: { kind: "conversation" }, conversationId: conversation.id,
        });
        const childTaskId = await tx.createTask(dormantTask, {}, {
          ownership: { kind: "task", taskId }, conversationId: conversation.id,
        });
        return { conversationId: Number(conversation.id), taskId: Number(taskId), childTaskId: Number(childTaskId) };
      }, BACKGROUND_CONTEXT);
      await harness.resume();
      await harness.waitForTask(root.taskId as never, BACKGROUND_CONTEXT);
      expect((await harness.getTask(root.taskId as never, BACKGROUND_CONTEXT))?.state.status).toBe("terminal");
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      const reopened = await openDurableStorage(join(directory, "durable.db"));
      if (!reopened.ok) throw new Error(reopened.failure.message);
      harness = await Harness.open(reopened.storage, { models: createModels(), registry: registry() }, BACKGROUND_CONTEXT);
      const descendantTaskId = await harness.commit(async (tx) => {
        const admittedAt = new Date().toISOString();
        const installation = installationDocumentV1Schema.parse({
          state: "ready", installationId: randomUUID(), maxConcurrentRuns: 1,
          workflows: {
            [workflowId]: {
              definitionHash: null, admissionHighWater: 1, openRunId: null,
              activations: [{
                activationId, state: "active", admittedCount: 1, maxRuns: "unlimited",
                activatedAt: admittedAt, nextDueAt: new Date(Date.now() + 60_000).toISOString(),
                scheduleEveryMs: 60_000, schedulerTaskId: 2_000_000_001,
                skippedSlots: 0, lastSkippedSlotAt: null, admissionError: null,
              }],
              occurrenceCounters: { [activationId]: 1 },
              runs: [{
                runId, activationId, occurrenceId,
                conversationId: root.conversationId, workflowTaskId: root.taskId,
                admissionSequence: 1, admittedAt, status: "completed", requestId: null,
              }],
              requestIndex: {}, capacityReservations: [], preflightCache: {},
            },
          },
        });
        Object.assign(await tx.doc(WorkshopInstallationDoc), installation);
        Object.assign(await tx.doc(WorkshopRunDoc, root.conversationId as never), {
          state: "ready", workflowId, runId, activationId, occurrenceId,
          durable: { conversationId: root.conversationId, workflowTaskId: root.taskId },
        });
        return root.childTaskId;
      }, BACKGROUND_CONTEXT);
      const verification = await verifyStartupParkAttributions(
        harness, [descendantTaskId], schedulerTaskKind, workflowTaskKind, Date.now() + 10_000,
      );
      expect(verification.byTaskId.get(descendantTaskId)).toEqual({ kind: "workflow_run", workflowId, runId });
      expect(verification.complete).toBe(true);
      expect((await harness.getTask(descendantTaskId as never, BACKGROUND_CONTEXT))?.state.status).toBe("terminal");
    } finally {
      await harness?.close(BACKGROUND_CONTEXT).catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
