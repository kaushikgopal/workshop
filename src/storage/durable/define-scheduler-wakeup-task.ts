import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationId, type Harness, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import { workflowIdV2 } from "../../definition/schema-v2.js";
import { loadCheckedV2Workflow, type V2Installation } from "../../installation/load-v2-installation.js";
import { installationDocumentV1Schema } from "../../installation/schema-v2.js";
import { prepareRunAdmissionV2, type PreparedRunAdmissionV2 } from "../../run/prepare-admission-v2.js";
import { decideFixedRateSchedule, type FixedRateScheduleDecision } from "../../run/decide-fixed-rate-schedule.js";
import { activationIdV2Schema, occurrenceIdV2Schema } from "../../run/schema-v2.js";
import { workshopEventV1Schema } from "../../run/records-v2.js";
import { utcTimestampV2Schema } from "../../util/schema-v2.js";
import { parseV2Duration } from "../../util/parse-units.js";
import { admitPreparedRunV2, type ScheduleAdmissionCommitV2 } from "./admit-run.js";
import { createWorkflowRunTaskInputV2, parseWorkflowRunTaskInputV2, type WorkflowRunTaskV2 } from "./define-workshop-tasks.js";
import { WorkshopEventEntry, WorkshopInstallationDoc } from "./define-workshop-records.js";

const scheduleWakeupInputV2Schema = z.strictObject({
  workflowId: workflowIdV2,
  activationId: activationIdV2Schema,
});
export type ScheduleWakeupTaskInputV2 = z.infer<typeof scheduleWakeupInputV2Schema>;

const scheduleWakeupCheckpointV2Schema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("wake") }),
  z.strictObject({ phase: z.literal("wait"), wakeAt: utcTimestampV2Schema }),
]);
type ScheduleWakeupCheckpointV2 = z.infer<typeof scheduleWakeupCheckpointV2Schema>;

const scheduleWakeupOutcomeV2Schema = z.strictObject({ kind: z.literal("finished") });
type ScheduleWakeupOutcomeV2 = z.infer<typeof scheduleWakeupOutcomeV2Schema>;

export type ScheduleWakeupTaskV2 = Task<ScheduleWakeupTaskInputV2, ScheduleWakeupCheckpointV2, ScheduleWakeupOutcomeV2, object>;
type ScheduleWakeupRuntimeV2 = TaskRuntime<ScheduleWakeupTaskInputV2, ScheduleWakeupCheckpointV2, ScheduleWakeupOutcomeV2, object>;

export function createScheduleWakeupTaskInputV2(input: ScheduleWakeupTaskInputV2): ScheduleWakeupTaskInputV2 {
  return scheduleWakeupInputV2Schema.parse(input);
}

export function defineScheduleWakeupTaskV2(input: {
  readonly installation: V2Installation;
  readonly workflowRunTask: WorkflowRunTaskV2;
  readonly runtimeManifest: PreparedRunAdmissionV2["runtimeManifest"];
  readonly canAdmit?: () => boolean;
}): ScheduleWakeupTaskV2 {
  return defineTask<ScheduleWakeupTaskInputV2, ScheduleWakeupCheckpointV2, ScheduleWakeupOutcomeV2>({
    name: "workshop.schedule-wakeup",
    version: 1,
    initial: () => ({ phase: "wake" }),
    phases: {
      wake: async (task, runtime, context) => {
        const taskInput = scheduleWakeupInputV2Schema.parse(task.input);
        if (input.canAdmit?.() === false) {
          await deferWake(runtime, timestamp(runtime.now() + 250), context);
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
        if (decision.kind === "sleep") {
          await deferWake(runtime, decision.wakeAt, context);
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
        const checkpoint = scheduleWakeupCheckpointV2Schema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "wait") throw new Error("schedule wakeup wait lacks its persisted deadline");
        const wakeAt = Date.parse(checkpoint.wakeAt);
        if (runtime.now() < wakeAt) await runtime.sleep(wakeAt, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wake" } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await finishTask(runtime, context);
    },
  });
}

async function admitScheduledOccurrence(
  definition: Parameters<typeof defineScheduleWakeupTaskV2>[0],
  runtime: ScheduleWakeupRuntimeV2,
  taskInput: ScheduleWakeupTaskInputV2,
  expectedNextDueAt: string,
  decision: Extract<FixedRateScheduleDecision, { kind: "admit" }>,
  context: Context,
): Promise<void> {
  if (definition.canAdmit?.() === false) {
    await deferWake(runtime, timestamp(runtime.now() + 250), context);
    return;
  }
  let checked: ReturnType<typeof loadCheckedV2Workflow>;
  try {
    checked = loadCheckedV2Workflow(definition.installation, taskInput.workflowId);
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
    everyMs = parseV2Duration(checked.definition.schedule.every);
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
    await deferWake(runtime, timestamp(runtime.now() + 250), context);
    return;
  }

  const slotDigest = canonicalHash({
    workflowId: taskInput.workflowId,
    activationId: taskInput.activationId,
    slotAt: decision.slotAt,
  }).slice("sha256:".length, "sha256:".length + 32);
  const runId = `${taskInput.workflowId}-slot-${slotDigest}`;
  const occurrenceId = occurrenceIdV2Schema.parse(`schedule-${slotDigest}`);
  const requestId = `schedule:${taskInput.workflowId}:${taskInput.activationId}:${slotDigest}`;
  const admittedAt = timestamp(runtime.now());
  const prepared = prepareRunAdmissionV2({
    sourceText: checked.sourceText,
    sourceLabel: checked.sourcePath,
    machineConfig: definition.installation.machine,
    projectCwd: definition.installation.projectCwd,
    runsDirectory: definition.installation.runsDirectory,
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
  const scheduleAdmission: ScheduleAdmissionCommitV2 = {
    expectedNextDueAt,
    slotAt: decision.slotAt,
    nextDueAt: decision.nextDueAt,
    skippedCount: decision.skippedCount,
    firstSkippedSlotAt: decision.firstSkippedSlotAt,
    lastSkippedSlotAt: decision.lastSkippedSlotAt,
    totalSkippedSlots: decision.totalSkippedSlots,
    admittedCount: decision.admittedCount,
  };
  const result = await admitPreparedRunV2({
    harness: taskCommitHarness(runtime, scheduleAdmission),
    prepared: prepared.value,
    workflowRunTask: definition.workflowRunTask,
    createTaskInput: createWorkflowRunTaskInputV2,
    parseTaskInput: parseWorkflowRunTaskInputV2,
    context,
    scheduleAdmission,
    admissionAllowed: definition.canAdmit,
  });
  if (result.ok) return;
  if (result.failure.kind === "admission_deferred") {
    await deferWake(runtime, timestamp(runtime.now() + 250), context);
    return;
  }
  if (result.failure.kind === "capacity_exhausted") {
    await deferWake(runtime, timestamp(runtime.now() + 250), context);
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
    await deferWake(runtime, timestamp(runtime.now() + 250), context);
    return;
  }
  await stopAdmission(runtime, taskInput, result.failure.message, context);
}

async function commitSkippedSlots(
  runtime: ScheduleWakeupRuntimeV2,
  taskInput: ScheduleWakeupTaskInputV2,
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
      return { status: "running", checkpoint: { phase: "wait", wakeAt: timestamp(runtime.now() + 250) } };
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
      return { status: "running", checkpoint: { phase: "wait", wakeAt: timestamp(runtime.now() + 250) } };
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
    return { status: "running", checkpoint: { phase: "wait", wakeAt: current.nextDueAt } };
  }, context);
}

async function stopAdmission(
  runtime: ScheduleWakeupRuntimeV2,
  taskInput: ScheduleWakeupTaskInputV2,
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

async function deferWake(runtime: ScheduleWakeupRuntimeV2, wakeAt: string, context: Context): Promise<void> {
  await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", wakeAt } }), context);
}

async function finishTask(runtime: ScheduleWakeupRuntimeV2, context: Context): Promise<void> {
  await runtime.commit(() => ({
    status: "terminal",
    outcome: { status: "completed", result: { kind: "finished" } },
  }), context);
}

async function readInstallation(runtime: ScheduleWakeupRuntimeV2, context: Context) {
  const parsed = installationDocumentV1Schema.safeParse(await runtime.snapshot(WorkshopInstallationDoc, context));
  if (!parsed.success || parsed.data.state !== "ready") throw new Error("Durable installation document is not initialized");
  return parsed.data;
}

function taskCommitHarness(
  runtime: ScheduleWakeupRuntimeV2,
  schedule: ScheduleAdmissionCommitV2,
 ): Pick<Harness, "commit"> {
  return {
    async commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
      let committed: { readonly value: T } | undefined;
      await runtime.commit(async (tx) => {
        const value = await change(tx);
        committed = { value };
        return schedule.nextDueAt === null
          ? { status: "terminal", outcome: { status: "completed", result: { kind: "finished" } } }
          : { status: "running", checkpoint: { phase: "wait", wakeAt: schedule.nextDueAt } };
      }, context);
      if (committed === undefined) throw new Error("scheduled admission transaction returned no result");
      return committed.value;
    },
  };
}

function timestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error("scheduler clock returned an invalid timestamp");
  return utcTimestampV2Schema.parse(new Date(ms).toISOString());
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
