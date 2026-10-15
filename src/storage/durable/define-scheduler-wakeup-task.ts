import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal, withCancel } from "@earendil-works/chord/context";
import { defineTask, type ConversationId, type DocumentWatch, type Harness, type JsonObject, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import { workflowIdSchema } from "../../definition/schema.js";
import { loadCheckedWorkflow, type Installation } from "../../installation/load-installation.js";
import { installationDocumentV1Schema } from "../../installation/schema.js";
import { prepareRunAdmission, type PreparedRunAdmission } from "../../run/prepare-admission.js";
import { decideFixedRateSchedule, type FixedRateScheduleDecision } from "../../run/decide-fixed-rate-schedule.js";
import { activationIdSchema, occurrenceIdSchema } from "../../run/schema.js";
import { workshopEventV1Schema } from "../../run/records.js";
import { utcTimestampSchema } from "../../util/schema.js";
import { parseDuration } from "../../util/parse-units.js";
import { admitPreparedRun, type ScheduleAdmissionCommit } from "./admit-run.js";
import { createWorkflowRunTaskInput, parseWorkflowRunTaskInput, type WorkflowRunTaskDefinition } from "./define-workshop-tasks.js";
import { WorkshopEventEntry, WorkshopInstallationDoc } from "./define-workshop-records.js";

const scheduleWakeupInputSchema = z.strictObject({
  workflowId: workflowIdSchema,
  activationId: activationIdSchema,
});
export type ScheduleWakeupTaskInput = z.infer<typeof scheduleWakeupInputSchema>;

const scheduleWakeupCheckpointSchema = z.union([
  z.strictObject({ phase: z.literal("wake") }),
  z.strictObject({ phase: z.literal("wait"), waitFor: z.literal("deadline"), wakeAt: utcTimestampSchema }),
  z.strictObject({ phase: z.literal("wait"), waitFor: z.literal("paused") }),
  z.strictObject({ phase: z.literal("wait"), waitFor: z.literal("capacity") }),
  z.strictObject({ phase: z.literal("wait"), waitFor: z.literal("admission") }),
  z.strictObject({ phase: z.literal("wait"), waitFor: z.literal("cursor"), expectedNextDueAt: utcTimestampSchema.nullable() }),
]);
type ScheduleWakeupCheckpoint = z.infer<typeof scheduleWakeupCheckpointSchema>;
type ScheduleWaitCheckpoint = Extract<ScheduleWakeupCheckpoint, { phase: "wait" }>;

const scheduleWakeupOutcomeSchema = z.strictObject({ kind: z.literal("finished") });
type ScheduleWakeupOutcome = z.infer<typeof scheduleWakeupOutcomeSchema>;

export type ScheduleWakeupTaskDefinition = Task<ScheduleWakeupTaskInput, ScheduleWakeupCheckpoint, ScheduleWakeupOutcome, object>;
type ScheduleWakeupRuntime = TaskRuntime<ScheduleWakeupTaskInput, ScheduleWakeupCheckpoint, ScheduleWakeupOutcome, object>;

export function createScheduleWakeupTaskInput(input: ScheduleWakeupTaskInput): ScheduleWakeupTaskInput {
  return scheduleWakeupInputSchema.parse(input);
}

export function defineScheduleWakeupTask(input: {
  readonly installation: Installation;
  readonly workflowRunTask: WorkflowRunTaskDefinition;
  readonly runtimeManifest: PreparedRunAdmission["runtimeManifest"];
  readonly canAdmit?: () => boolean;
  /** Waits for admission to open, rechecks before subscribing, and cancels when signal aborts. */
  readonly waitForAdmission?: (signal: AbortSignal) => Promise<void>;
}): ScheduleWakeupTaskDefinition {
  return defineTask<ScheduleWakeupTaskInput, ScheduleWakeupCheckpoint, ScheduleWakeupOutcome>({
    name: "workshop.schedule-wakeup",
    version: 1,
    initial: () => ({ phase: "wake" }),
    phases: {
      wake: async (task, runtime, context) => {
        const taskInput = scheduleWakeupInputSchema.parse(task.input);
        if (input.canAdmit?.() === false) {
          await deferWake(runtime, { phase: "wait", waitFor: "admission" }, context);
          return;
        }
        const snapshot = await readInstallation(runtime, context);
        const workflow = snapshot.workflows[taskInput.workflowId];
        const activation = workflow?.activations.find((entry) => entry.activationId === taskInput.activationId);
        if (workflow === undefined || activation === undefined || activation.schedulerTaskId !== Number(runtime.taskId)) {
          await finishTask(runtime, context);
          return;
        }

        const decision = decideFixedRateSchedule({
          state: activation.state,
          everyMs: activation.scheduleEveryMs,
          maxRuns: activation.maxRuns,
          admittedCount: activation.admittedCount,
          skippedSlots: activation.skippedSlots,
          nextDueAt: activation.nextDueAt,
          now: runtime.now(),
          hasOpenRun: workflow.openRunId !== null,
        });
        if (decision.kind === "finished") {
          await finishTask(runtime, context);
          return;
        }
        if (decision.kind === "invalid") {
          await stopAdmission(runtime, taskInput, decision.reason, context);
          return;
        }
        if (decision.kind === "wait") {
          await deferWake(runtime, { phase: "wait", waitFor: "paused" }, context);
          return;
        }
        if (decision.kind === "sleep") {
          await deferWake(runtime, { phase: "wait", waitFor: "deadline", wakeAt: decision.wakeAt }, context);
          return;
        }
        if (decision.kind === "skip") {
          await commitSkippedSlots(runtime, taskInput, activation.nextDueAt, context);
          return;
        }
        if (activation.nextDueAt === null) {
          await stopAdmission(runtime, taskInput, "active schedule has no persisted due deadline", context);
          return;
        }
        await admitScheduledOccurrence(input, runtime, taskInput, activation.nextDueAt, decision, context);
      },
      wait: async (task, runtime, context) => {
        const checkpoint = scheduleWakeupCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "wait") throw new Error("schedule wakeup checkpoint is not waiting");
        await waitForSchedulerChange(runtime, task.input, Number(runtime.taskId), checkpoint, input.canAdmit, input.waitForAdmission, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wake" } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await finishTask(runtime, context);
    },
  });
}

async function admitScheduledOccurrence(
  definition: Parameters<typeof defineScheduleWakeupTask>[0],
  runtime: ScheduleWakeupRuntime,
  taskInput: ScheduleWakeupTaskInput,
  expectedNextDueAt: string,
  decision: Extract<FixedRateScheduleDecision, { kind: "admit" }>,
  context: Context,
): Promise<void> {
  if (definition.canAdmit?.() === false) {
    await deferWake(runtime, { phase: "wait", waitFor: "admission" }, context);
    return;
  }
  let checked: ReturnType<typeof loadCheckedWorkflow>;
  try {
    checked = loadCheckedWorkflow(definition.installation, taskInput.workflowId);
  } catch (error) {
    await stopAdmission(runtime, taskInput, safeError(error), context);
    return;
  }
  const snapshot = await readInstallation(runtime, context);
  const workflow = snapshot.workflows[taskInput.workflowId];
  const activation = workflow?.activations.find((entry) => entry.activationId === taskInput.activationId);
  if (workflow === undefined || activation === undefined) {
    await finishTask(runtime, context);
    return;
  }
  if (activation.state === "stopped" || activation.state === "exhausted") {
    await finishTask(runtime, context);
    return;
  }
  let everyMs: number;
  let maxRuns: number | "unlimited";
  try {
    if (checked.definition.schedule === undefined) throw new Error("checked workflow no longer has a schedule");
    everyMs = parseDuration(checked.definition.schedule.every);
    maxRuns = checked.definition.schedule.max_runs ?? 1;
  } catch (error) {
    await stopAdmission(runtime, taskInput, safeError(error), context);
    return;
  }
  if (everyMs !== activation.scheduleEveryMs || maxRuns !== activation.maxRuns) {
    await stopAdmission(runtime, taskInput, "schedule policy changed; start to create a new activation", context);
    return;
  }
  if (activation.nextDueAt !== expectedNextDueAt) {
    await deferWake(runtime, { phase: "wait", waitFor: "cursor", expectedNextDueAt }, context);
    return;
  }

  const slotDigest = canonicalHash({
    workflowId: taskInput.workflowId,
    activationId: taskInput.activationId,
    slotAt: decision.slotAt,
  }).slice("sha256:".length, "sha256:".length + 32);
  const runId = `${taskInput.workflowId}-slot-${slotDigest}`;
  const occurrenceId = occurrenceIdSchema.parse(`schedule-${slotDigest}`);
  const requestId = `schedule:${taskInput.workflowId}:${taskInput.activationId}:${slotDigest}`;
  const admittedAt = timestamp(runtime.now());
  const prepared = prepareRunAdmission({
    sourceText: checked.sourceText,
    sourceLabel: checked.sourcePath,
    workflowId: checked.workflowId,
    machineConfig: definition.installation.machine,
    projectCwd: definition.installation.projectCwd,
    stateDirectory: definition.installation.stateDirectory,
    resolvedSettings: checked.resolvedSettings,
    runtimeManifest: definition.runtimeManifest,
    runId,
    eventId: randomUUID(),
    activationId: taskInput.activationId,
    occurrenceId,
    requestId,
    admittedAt,
  });
  if (!prepared.ok) {
    await stopAdmission(runtime, taskInput, prepared.failure.message, context);
    return;
  }
  const scheduleAdmission: ScheduleAdmissionCommit = {
    expectedNextDueAt,
    slotAt: decision.slotAt,
    nextDueAt: decision.nextDueAt,
    skippedCount: decision.skippedCount,
    firstSkippedSlotAt: decision.firstSkippedSlotAt,
    lastSkippedSlotAt: decision.lastSkippedSlotAt,
    totalSkippedSlots: decision.totalSkippedSlots,
    admittedCount: decision.admittedCount,
  };
  const result = await admitPreparedRun({
    harness: taskCommitHarness(runtime, scheduleAdmission),
    prepared: prepared.value,
    workflowRunTask: definition.workflowRunTask,
    createTaskInput: createWorkflowRunTaskInput,
    parseTaskInput: parseWorkflowRunTaskInput,
    context,
    scheduleAdmission,
    admissionAllowed: definition.canAdmit,
  });
  if (result.ok) return;
  if (result.failure.kind === "admission_deferred") {
    await deferWake(runtime, { phase: "wait", waitFor: "admission" }, context);
    return;
  }
  if (result.failure.kind === "capacity_exhausted") {
    await deferWake(runtime, { phase: "wait", waitFor: "capacity" }, context);
    return;
  }
  if (result.failure.kind === "workflow_busy" || result.failure.kind === "activation_not_active") {
    const refreshed = await readInstallation(runtime, context);
    const currentWorkflow = refreshed.workflows[taskInput.workflowId];
    const currentActivation = currentWorkflow?.activations.find((entry) => entry.activationId === taskInput.activationId);
    if (currentWorkflow !== undefined && currentActivation !== undefined && currentWorkflow.openRunId !== null) {
      const skip = decideFixedRateSchedule({
        state: currentActivation.state,
        everyMs: currentActivation.scheduleEveryMs,
        maxRuns: currentActivation.maxRuns,
        admittedCount: currentActivation.admittedCount,
        skippedSlots: currentActivation.skippedSlots,
        nextDueAt: currentActivation.nextDueAt,
        now: runtime.now(),
        hasOpenRun: true,
      });
      if (skip.kind === "skip") {
        await commitSkippedSlots(runtime, taskInput, currentActivation.nextDueAt, context);
        return;
      }
      if (currentActivation.state === "stopped" || currentActivation.state === "exhausted") {
        await finishTask(runtime, context);
        return;
      }
    }
    await deferWake(runtime, { phase: "wait", waitFor: "cursor", expectedNextDueAt }, context);
    return;
  }
  await stopAdmission(runtime, taskInput, result.failure.message, context);
}

async function commitSkippedSlots(
  runtime: ScheduleWakeupRuntime,
  taskInput: ScheduleWakeupTaskInput,
  expectedNextDueAt: string | null,
  context: Context,
): Promise<void> {
  await runtime.commit(async (tx) => {
    const draft = await tx.doc(WorkshopInstallationDoc);
    const installation = installationDocumentV1Schema.parse(draft);
    if (installation.state !== "ready") throw new Error("installation is not initialized");
    const workflow = installation.workflows[taskInput.workflowId];
    const activationIndex = workflow?.activations.findIndex((entry) => entry.activationId === taskInput.activationId) ?? -1;
    const activation = activationIndex < 0 ? undefined : workflow?.activations[activationIndex];
    if (workflow === undefined || activation === undefined
      || activation.schedulerTaskId !== Number(runtime.taskId)
      || activation.nextDueAt !== expectedNextDueAt || workflow.openRunId === null) {
      return { status: "running", checkpoint: { phase: "wait", waitFor: "cursor", expectedNextDueAt } };
    }
    const current = decideFixedRateSchedule({
      state: activation.state,
      everyMs: activation.scheduleEveryMs,
      maxRuns: activation.maxRuns,
      admittedCount: activation.admittedCount,
      skippedSlots: activation.skippedSlots,
      nextDueAt: activation.nextDueAt,
      now: runtime.now(),
      hasOpenRun: true,
    });
    if (current.kind !== "skip") {
      return { status: "running", checkpoint: { phase: "wait", waitFor: "cursor", expectedNextDueAt } };
    }
    workflow.activations[activationIndex] = {
      ...activation,
      nextDueAt: current.nextDueAt,
      skippedSlots: current.totalSkippedSlots,
      lastSkippedSlotAt: current.lastSlotAt,
    };
    const checkedInstallation = installationDocumentV1Schema.parse(installation);
    const openReference = workflow.runs.find((entry) => entry.runId === workflow.openRunId);
    if (openReference === undefined) throw new Error("open run reference is missing while recording skipped schedule slots");
    const event = workshopEventV1Schema.parse({
      version: 1,
      eventId: randomUUID(),
      type: "schedule_slots_skipped",
      runId: openReference.runId,
      workflowId: taskInput.workflowId,
      activationId: taskInput.activationId,
      firstSlotAt: current.firstSlotAt,
      lastSlotAt: current.lastSlotAt,
      skippedCount: current.skippedCount,
      occurredAt: timestamp(runtime.now()),
    });
    Object.assign(draft, checkedInstallation);
    await tx.appendEntry(WorkshopEventEntry, openReference.conversationId as ConversationId, { data: event });
    return { status: "running", checkpoint: { phase: "wait", waitFor: "deadline", wakeAt: current.nextDueAt } };
  }, context);
}

async function waitForSchedulerChange(
  runtime: ScheduleWakeupRuntime,
  rawInput: unknown,
  taskId: number,
  checkpoint: ScheduleWaitCheckpoint,
  canAdmit: (() => boolean) | undefined,
  waitForAdmission: ((signal: AbortSignal) => Promise<void>) | undefined,
  context: Context,
): Promise<void> {
  const taskInput = scheduleWakeupInputSchema.parse(rawInput);
  const parentContext = withAbortSignal(runtime.signal, context);
  const { context: waitContext, cancel } = withCancel(parentContext);
  let watch: DocumentWatch<JsonObject> | undefined;
  try {
    watch = await runtime.watchDoc(WorkshopInstallationDoc, waitContext);
    if (watch === undefined) throw new Error("scheduler installation document is unavailable for watching");
    const shouldWake = (value: unknown): boolean => schedulerShouldWake(
      taskInput,
      taskId,
      checkpoint,
      value,
      runtime.now(),
      canAdmit,
    );
    if (shouldWake(watch.value)) return;

    let notify!: () => void;
    const changed = new Promise<void>((resolve) => { notify = resolve; });
    watch.start(async (value) => {
      if (shouldWake(value)) notify();
    });
    if (shouldWake(watch.value)) return;

    const closed = watch.closed.then((end) => ({ kind: "closed" as const, end }));
    const waiters: Promise<{ kind: "changed" | "deadline" | "admission" } | { kind: "closed"; end: Awaited<typeof watch.closed> }>[] = [
      changed.then(() => ({ kind: "changed" as const })),
      closed,
    ];
    if (checkpoint.waitFor === "admission" && waitForAdmission !== undefined) {
      const signal = waitContext.abortSignal;
      if (signal === undefined) throw new Error("scheduler admission wait lacks an abort signal");
      waiters.push(waitForAdmission(signal).then(() => ({ kind: "admission" as const })));
    }
    const wakeAt = checkpoint.waitFor === "deadline" ? checkpoint.wakeAt : undefined;
    if (wakeAt !== undefined) {
      const deadline = Date.parse(wakeAt);
      if (runtime.now() >= deadline) return;
      waiters.push(runtime.sleep(deadline, waitContext).then(() => ({ kind: "deadline" as const })));
    }
    const result = await Promise.race(waiters);
    if (result.kind === "closed") {
      if (runtime.signal.aborted || waitContext.abortSignal?.aborted) {
        throw runtime.signal.reason ?? waitContext.abortSignal?.reason ?? new Error("scheduler wait was cancelled");
      }
      if (result.end.reason === "listener_error") throw result.end.error;
      throw new Error("scheduler document watch ended: " + result.end.reason);
    }
  } finally {
    cancel();
    if (watch !== undefined) {
      const end = await watch.stop();
      if (end.reason === "listener_error") throw end.error;
    }
  }
}

function schedulerShouldWake(
  input: ScheduleWakeupTaskInput,
  taskId: number,
  checkpoint: ScheduleWaitCheckpoint,
  value: unknown,
  now: number,
  canAdmit: (() => boolean) | undefined,
): boolean {
  const parsed = installationDocumentV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.state !== "ready") {
    throw new Error("Durable installation document failed validation while scheduler waits");
  }
  const installation = parsed.data;
  const workflow = installation.workflows[input.workflowId];
  const activation = workflow?.activations.find((entry) => entry.activationId === input.activationId);
  if (workflow === undefined || activation === undefined || activation.schedulerTaskId !== taskId) return true;
  if (checkpoint.waitFor === "deadline") {
    return activation.state !== "active" || activation.nextDueAt !== checkpoint.wakeAt || now >= Date.parse(checkpoint.wakeAt);
  }
  if (checkpoint.waitFor === "paused") return activation.state !== "paused";
  if (checkpoint.waitFor === "capacity") {
    if (activation.state !== "active" || workflow.openRunId !== null) return true;
    const reserved = Object.values(installation.workflows)
      .reduce((count, index) => count + index.capacityReservations.length, 0);
    return reserved < installation.maxConcurrentRuns;
  }
  if (checkpoint.waitFor === "admission") return activation.state !== "active" || canAdmit?.() !== false;
  return activation.state !== "active"
    || activation.nextDueAt !== checkpoint.expectedNextDueAt
    || workflow.openRunId === null;
}

async function stopAdmission(
  runtime: ScheduleWakeupRuntime,
  taskInput: ScheduleWakeupTaskInput,
  reason: string,
  context: Context,
): Promise<void> {
  await runtime.commit(async (tx) => {
    const draft = await tx.doc(WorkshopInstallationDoc);
    const installation = installationDocumentV1Schema.parse(draft);
    if (installation.state !== "ready") throw new Error("installation is not initialized");
    const workflow = installation.workflows[taskInput.workflowId];
    const activationIndex = workflow?.activations.findIndex((entry) => entry.activationId === taskInput.activationId) ?? -1;
    const activation = activationIndex < 0 ? undefined : workflow?.activations[activationIndex];
    if (workflow === undefined || activation === undefined || activation.schedulerTaskId !== Number(runtime.taskId)) {
      return { status: "terminal", outcome: { status: "completed", result: { kind: "finished" } } };
    }
    workflow.activations[activationIndex] = {
      ...activation,
      state: "stopped",
      nextDueAt: null,
      admissionError: reason.slice(0, 4 * 1024),
    };
    Object.assign(draft, installationDocumentV1Schema.parse(installation));
    return { status: "terminal", outcome: { status: "completed", result: { kind: "finished" } } };
  }, context);
}

async function deferWake(runtime: ScheduleWakeupRuntime, checkpoint: ScheduleWakeupCheckpoint, context: Context): Promise<void> {
  await runtime.commit(() => ({ status: "running", checkpoint }), context);
}

async function finishTask(runtime: ScheduleWakeupRuntime, context: Context): Promise<void> {
  await runtime.commit(() => ({
    status: "terminal",
    outcome: { status: "completed", result: { kind: "finished" } },
  }), context);
}

async function readInstallation(runtime: ScheduleWakeupRuntime, context: Context) {
  const parsed = installationDocumentV1Schema.safeParse(await runtime.snapshot(WorkshopInstallationDoc, context));
  if (!parsed.success || parsed.data.state !== "ready") throw new Error("Durable installation document is not initialized");
  return parsed.data;
}

function taskCommitHarness(
  runtime: ScheduleWakeupRuntime,
  schedule: ScheduleAdmissionCommit,
 ): Pick<Harness, "commit"> {
  return {
    async commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
      let committed: { readonly value: T } | undefined;
      await runtime.commit(async (tx) => {
        const value = await change(tx);
        committed = { value };
        return schedule.nextDueAt === null
          ? { status: "terminal", outcome: { status: "completed", result: { kind: "finished" } } }
          : { status: "running", checkpoint: { phase: "wait", waitFor: "deadline", wakeAt: schedule.nextDueAt } };
      }, context);
      if (committed === undefined) throw new Error("scheduled admission transaction returned no result");
      return committed.value;
    },
  };
}

function timestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error("scheduler clock returned an invalid timestamp");
  return utcTimestampSchema.parse(new Date(ms).toISOString());
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
