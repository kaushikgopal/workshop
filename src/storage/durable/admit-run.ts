import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import { workflowIdSchema } from "../../definition/schema.js";
import { activationIdSchema, occurrenceIdSchema, runIdSchema } from "../../run/schema.js";
import { parseDuration } from "../../util/parse-units.js";
import { commitServiceMutationInTransaction, type CommitServiceMutationInTransactionInput } from "./commit-service-mutation.js";
import type { ConversationId, Harness, Task, TaskId, Tx } from "@earendil-works/pi-durable";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import {
  activationIndexSchema,
  installationDocumentV1Schema,
  workflowInstallationIndexSchema,
  type ActivationIndex,
  type RunReference,
} from "../../installation/schema.js";
import {
  workflowRunDocumentV1Schema,
  workshopEventV1Schema,
} from "../../run/records.js";
import { prepareRunAdmission, type AdmissionPreparationFailure, type PreparedRunAdmission } from "../../run/prepare-admission.js";
import {
  WorkshopEventEntry,
  WorkshopInstallationDoc,
  WorkshopRunDoc,
} from "./define-workshop-records.js";

type AdmissionRunIdentity = {
  readonly runId: string;
  readonly workflowId: string;
  readonly activationId: string;
  readonly occurrenceId: string;
};

export type ScheduleAdmissionCommit = {
  readonly expectedNextDueAt: string;
  readonly slotAt: string;
  readonly nextDueAt: string | null;
  readonly skippedCount: number;
  readonly firstSkippedSlotAt: string | null;
  readonly lastSkippedSlotAt: string | null;
  readonly totalSkippedSlots: number;
  readonly admittedCount: number;
};

export type DurableRunAdmission = {
  readonly runId: string;
  readonly workflowId: string;
  readonly activationId: string;
  readonly occurrenceId: string;
  readonly admissionSequence: number;
  readonly conversationId: number;
  readonly workflowTaskId: number;
  readonly duplicate: boolean;
};

const durableRunAdmissionSchema = z.strictObject({
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: activationIdSchema,
  occurrenceId: occurrenceIdSchema,
  admissionSequence: z.number().int().positive().safe(),
  conversationId: z.number().int().positive().safe(),
  workflowTaskId: z.number().int().positive().safe(),
  duplicate: z.boolean(),
});

export type DurableRunAdmissionFailure = {
  readonly kind:
    | "installation_uninitialized"
    | "workflow_not_registered"
    | "activation_not_active"
    | "workflow_busy"
    | "admission_deferred"
    | "capacity_exhausted"
    | "activation_limit_reached"
    | "admission_sequence_exhausted"
    | "run_id_collision"
    | "idempotency_conflict"
    | "persisted_run_invalid"
    | "persisted_task_missing"
    | "task_input_invalid"
    | "runtime_manifest_mismatch"
    | "admission_record_invalid"
    | "durable_commit_failed";
  readonly message: string;
  readonly cause?: unknown;
} | AdmissionPreparationFailure;

export type DurableRunAdmissionResult =
  | { readonly ok: true; readonly value: DurableRunAdmission }
  | { readonly ok: false; readonly failure: DurableRunAdmissionFailure };

/** Commit run conversation, task, canonical record, admission index, and event as one Durable transaction. */
export async function admitPreparedRun<
  I,
  S extends { phase: string },
  R,
  H extends object,
>(input: {
  readonly harness: Pick<Harness, "commit">;
  readonly prepared: PreparedRunAdmission;
  readonly workflowRunTask: Task<I, S, R, H>;
  readonly createTaskInput: (identity: AdmissionRunIdentity) => unknown;
  /** Pure schema validation; it also checks that the stored input matches the supplied identity. */
  readonly parseTaskInput: (value: unknown, identity: AdmissionRunIdentity) => I | undefined;
  readonly context: Context;
  readonly serviceMutation?: Omit<CommitServiceMutationInTransactionInput, "apply">;
  readonly activationProposal?: ActivationIndex;
  readonly replaceActiveActivation?: boolean;
  readonly createScheduleWakeupTask?: (
    tx: Tx,
    conversationId: ConversationId,
    workflowId: string,
    activationId: string,
  ) => Promise<TaskId>;
  readonly scheduleAdmission?: ScheduleAdmissionCommit;
  /** Rechecked inside the transaction before scheduled admission becomes durable. */
  readonly admissionAllowed?: () => boolean;
}): Promise<DurableRunAdmissionResult> {
  const original = input.prepared;
  const checked = prepareRunAdmission({
    sourceText: original.sourceText,
    sourceLabel: original.sourceLabel,
    workflowId: original.workflowId,
    machineConfig: original.machineConfig,
    projectCwd: original.projectCwd,
    runsDirectory: original.runsDirectory,
    archiveDirectory: original.archiveDirectory,
    resolvedSettings: original.resolvedSettings,
    runtimeManifest: original.runtimeManifest,
    runId: original.runId,
    eventId: original.eventId,
    activationId: original.activationId,
    occurrenceId: original.occurrenceId,
    requestId: original.requestId,
    admittedAt: original.admittedAt,
  });
  if (!checked.ok) return { ok: false, failure: checked.failure };
  input = { ...input, prepared: checked.value };
  try {
    const commitAdmission = async (tx: Tx): Promise<DurableRunAdmission> => {
      if (input.admissionAllowed?.() === false) {
        throw abortAdmission({ kind: "admission_deferred", message: "scheduled admission was sealed before commit" });
      }
      const installationDraft = await tx.doc(WorkshopInstallationDoc);
      const installationParsed = installationDocumentV1Schema.safeParse(installationDraft);
      if (!installationParsed.success) {
        throw abortAdmission({ kind: "installation_uninitialized", message: "installation document is invalid", cause: installationParsed.error });
      }
      if (installationParsed.data.state !== "ready") {
        throw abortAdmission({ kind: "installation_uninitialized", message: "installation has not been initialized" });
      }
      const installation = installationParsed.data;
      const existingWorkflow = installation.workflows[input.prepared.workflowId];
      if (existingWorkflow === undefined && input.activationProposal === undefined) {
        throw abortAdmission({ kind: "workflow_not_registered", message: "workflow activation is not registered" });
      }
      let workflow = existingWorkflow ?? workflowInstallationIndexSchema.parse({
        definitionHash: input.prepared.canonicalHash,
        admissionHighWater: 0,
        openRunId: null,
        activations: [],
        occurrenceCounters: {},
        runs: [],
        requestIndex: {},
        capacityReservations: [],
        preflightCache: {},
      });
      const requestRunId = input.prepared.requestId === null
        ? undefined
        : workflow.requestIndex[input.prepared.requestId];
      const requestReference = requestRunId === undefined
        ? undefined
        : workflow.runs.find((run) => run.runId === requestRunId);
      if (requestRunId !== undefined && requestReference === undefined) {
        throw abortAdmission({ kind: "persisted_run_invalid", message: "request index points to missing run history" });
      }
      if (requestReference !== undefined) {
        return readExistingAdmission({
          tx,
          reference: requestReference,
          prepared: {
            ...input.prepared,
            activationId: requestReference.activationId,
            occurrenceId: requestReference.occurrenceId,
          },
          taskKind: input.workflowRunTask.definition.name,
          parseTaskInput: input.parseTaskInput,
        });
      }
      const occurrenceReference = workflow.runs.find((run) =>
        run.activationId === input.prepared.activationId && run.occurrenceId === input.prepared.occurrenceId,
      );
      if (occurrenceReference !== undefined) {
        return readExistingAdmission({
          tx,
          reference: occurrenceReference,
          prepared: input.prepared,
          taskKind: input.workflowRunTask.definition.name,
          parseTaskInput: input.parseTaskInput,
        });
      }
      if (workflow.openRunId !== null) {
        throw abortAdmission({ kind: "workflow_busy", message: "workflow already has an unresolved run" });
      }
      if (input.replaceActiveActivation === true) {
        workflow = workflowInstallationIndexSchema.parse({
          ...workflow,
          activations: workflow.activations.map((item) => item.state === "active"
            ? { ...item, state: "stopped", nextDueAt: null, admissionError: "schedule policy changed; replaced by explicit start" }
            : item),
        });
      }
      let activation = workflow.activations.find((item) => item.activationId === input.prepared.activationId);
      if (activation?.state !== "active") {
        const currentActive = workflow.activations.find((item) => item.state === "active");
        if (currentActive !== undefined) {
          activation = currentActive;
        } else if (input.activationProposal !== undefined) {
          const proposal = activationIndexSchema.parse(input.activationProposal);
          if (proposal.activationId !== input.prepared.activationId || proposal.admittedCount !== 0 || proposal.state !== "active") {
            throw abortAdmission({ kind: "activation_not_active", message: "proposed activation does not match the admission identity" });
          }
          activation = proposal;
          workflow = workflowInstallationIndexSchema.parse({
            ...workflow,
            activations: [...workflow.activations, proposal],
            occurrenceCounters: { ...workflow.occurrenceCounters, [proposal.activationId]: 0 },
          });
        } else {
          throw abortAdmission({ kind: "activation_not_active", message: "workflow activation is not active" });
        }
      }
      if (activation === undefined || activation.state !== "active") {
        throw abortAdmission({ kind: "activation_not_active", message: "workflow activation is not active" });
      }
      const prepared = activation.activationId === input.prepared.activationId
        ? input.prepared
        : { ...input.prepared, activationId: activation.activationId };
      const scheduleEveryMs = prepared.definition.schedule === undefined
        ? null
        : parseDuration(prepared.definition.schedule.every);
      const scheduleMaxRuns = prepared.definition.schedule?.max_runs ?? 1;
      if (activation.maxRuns !== scheduleMaxRuns || activation.scheduleEveryMs !== scheduleEveryMs) {
        throw abortAdmission({ kind: "activation_not_active", message: "schedule policy differs from the active activation" });
      }
      if (scheduleEveryMs === null && activation.nextDueAt !== null) {
        throw abortAdmission({ kind: "activation_not_active", message: "one-shot activation has an unexpected due deadline" });
      }
      if (workflow.openRunId !== null) {
        throw abortAdmission({ kind: "workflow_busy", message: "workflow already has an unresolved run" });
      }
      const liveReservations = Object.values(installation.workflows)
        .reduce((count, index) => count + index.capacityReservations.length, 0);
      if (liveReservations >= installation.maxConcurrentRuns) {
        throw abortAdmission({ kind: "capacity_exhausted", message: "installation has no free run capacity" });
      }
      if (activation.maxRuns !== "unlimited" && activation.admittedCount >= activation.maxRuns) {
        throw abortAdmission({ kind: "activation_limit_reached", message: "activation has admitted its finite run limit" });
      }
      const admissionSequence = workflow.admissionHighWater + 1;
      const occurrenceCount = activation.admittedCount + 1;
      if (!Number.isSafeInteger(admissionSequence) || !Number.isSafeInteger(occurrenceCount)) {
        throw abortAdmission({ kind: "admission_sequence_exhausted", message: "admission sequence or occurrence count exceeds the safe integer range" });
      }
      if (Object.values(installation.workflows).some((index) => index.runs.some((run) => run.runId === prepared.runId))) {
        throw abortAdmission({ kind: "run_id_collision", message: "candidate run ID is already retained" });
      }
      const declaredTaskVersion = prepared.runtimeManifest.taskVersions.workflowRun;
      if (declaredTaskVersion !== undefined && declaredTaskVersion !== input.workflowRunTask.definition.version) {
        throw abortAdmission({ kind: "runtime_manifest_mismatch", message: "runtime manifest does not match the supplied WorkflowRun task version" });
      }
      let nextDueAt = activation.nextDueAt;
      let skippedSlots = activation.skippedSlots;
      let lastSkippedSlotAt = activation.lastSkippedSlotAt;
      if (scheduleEveryMs !== null && nextDueAt === null) {
        throw abortAdmission({ kind: "activation_not_active", message: "active recurring activation has no persisted due deadline" });
      }
      if (input.scheduleAdmission !== undefined) {
        const schedule = input.scheduleAdmission;
        if (scheduleEveryMs === null || schedule.expectedNextDueAt !== nextDueAt
          || schedule.admittedCount !== occurrenceCount
          || schedule.totalSkippedSlots !== activation.skippedSlots + schedule.skippedCount) {
          throw abortAdmission({ kind: "workflow_busy", message: "scheduled slot changed before its admission transaction" });
        }
        nextDueAt = schedule.nextDueAt;
        skippedSlots = schedule.totalSkippedSlots;
        if (schedule.lastSkippedSlotAt !== null) lastSkippedSlotAt = schedule.lastSkippedSlotAt;
      }
      const exhausted = activation.maxRuns !== "unlimited" && occurrenceCount === activation.maxRuns;
      if (exhausted) nextDueAt = null;
      let nextActivation: ActivationIndex = activationIndexSchema.parse({
        ...activation,
        admittedCount: occurrenceCount,
        state: exhausted ? "exhausted" : "active",
        nextDueAt,
        scheduleEveryMs,
        skippedSlots,
        lastSkippedSlotAt,
        admissionError: null,
      });
      const taskIdentity = {
        runId: prepared.runId,
        workflowId: prepared.workflowId,
        activationId: activation.activationId,
        occurrenceId: prepared.occurrenceId,
      };
      let taskInput: I | undefined;
      try {
        taskInput = input.parseTaskInput(input.createTaskInput(taskIdentity), taskIdentity);
      } catch (cause) {
        throw abortAdmission({ kind: "task_input_invalid", message: "WorkflowRun task input could not be parsed", cause });
      }
      if (taskInput === undefined) {
        throw abortAdmission({ kind: "task_input_invalid", message: "WorkflowRun task input is invalid" });
      }
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const workflowTaskId = await tx.createTask(
        input.workflowRunTask,
        taskInput,
        { ownership: { kind: "conversation" }, conversationId: conversation.id },
      );
      if (nextActivation.state === "active" && nextActivation.scheduleEveryMs !== null
        && nextActivation.nextDueAt !== null && nextActivation.schedulerTaskId === null
        && input.createScheduleWakeupTask !== undefined) {
        const schedulerTaskId = await input.createScheduleWakeupTask(
          tx, conversation.id, prepared.workflowId, nextActivation.activationId,
        );
        nextActivation = activationIndexSchema.parse({ ...nextActivation, schedulerTaskId: Number(schedulerTaskId) });
      }
      const runValue = workflowRunDocumentV1Schema.safeParse({
        state: "ready",
        runId: prepared.runId,
        workflowId: prepared.workflowId,
        activationId: activation.activationId,
        occurrenceId: prepared.occurrenceId,
        requestId: prepared.requestId,
        admissionSequence,
        admittedAt: prepared.admittedAt,
        sourceText: prepared.sourceText,
        sourceHash: prepared.sourceHash,
        canonicalDefinition: prepared.definition,
        canonicalHash: prepared.canonicalHash,
        resolvedSettings: prepared.resolvedSettings,
        chain: prepared.chain,
        paths: prepared.paths,
        runtimeManifest: prepared.runtimeManifest,
        durable: { conversationId: conversation.id, workflowTaskId, capacityGateTaskId: null },
        status: "queued",
        desiredState: "running",
        startedAt: null,
        finishedAt: null,
        currentNodeId: prepared.chain.order[0],
        currentAttemptId: null,
        block: null,
        failure: null,
        preflight: prepared.preflightCacheKey === null
          ? { kind: "not_configured" }
          : { kind: "pending", cacheKeyHash: prepared.preflightCacheKey, processExecutionIds: [] },
        nodes: prepared.chain.order.map((nodeId) => ({
          nodeId,
          status: "pending",
          successfulAttemptId: null,
          attempts: [],
        })),
        resolutions: [],
        terminalOutput: null,
      });
      if (!runValue.success || runValue.data.state !== "ready") {
        throw abortAdmission({ kind: "admission_record_invalid", message: "prepared run did not satisfy the canonical record schema", cause: runValue.success ? undefined : runValue.error });
      }
      const runReference = {
        runId: prepared.runId,
        activationId: activation.activationId,
        occurrenceId: prepared.occurrenceId,
        conversationId: conversation.id,
        workflowTaskId,
        admissionSequence,
        admittedAt: prepared.admittedAt,
        status: "queued",
        requestId: prepared.requestId,
      };
      const nextWorkflow = workflowInstallationIndexSchema.safeParse({
        ...workflow,
        definitionHash: prepared.canonicalHash,
        admissionHighWater: admissionSequence,
        openRunId: prepared.runId,
        activations: workflow.activations.map((item) => item.activationId === activation.activationId ? nextActivation : item),
        occurrenceCounters: { ...workflow.occurrenceCounters, [activation.activationId]: occurrenceCount },
        runs: [...workflow.runs, runReference],
        requestIndex: prepared.requestId === null
          ? workflow.requestIndex
          : { ...workflow.requestIndex, [prepared.requestId]: prepared.runId },
        capacityReservations: [...workflow.capacityReservations, prepared.runId],
      });
      if (!nextWorkflow.success) {
        throw abortAdmission({ kind: "admission_record_invalid", message: "updated workflow index failed validation", cause: nextWorkflow.error });
      }
      const nextInstallation = installationDocumentV1Schema.safeParse({
        ...installation,
        workflows: { ...installation.workflows, [prepared.workflowId]: nextWorkflow.data },
      });
      if (!nextInstallation.success || nextInstallation.data.state !== "ready") {
        throw abortAdmission({ kind: "admission_record_invalid", message: "updated installation index failed validation", cause: nextInstallation.success ? undefined : nextInstallation.error });
      }
      const event = workshopEventV1Schema.safeParse({
        version: 1,
        eventId: prepared.eventId,
        type: "run_admitted",
        runId: prepared.runId,
        workflowId: prepared.workflowId,
        activationId: activation.activationId,
        occurrenceId: prepared.occurrenceId,
        admissionSequence,
        canonicalHash: prepared.canonicalHash,
        ...(input.scheduleAdmission === undefined ? {} : {
          schedule: {
            slotAt: input.scheduleAdmission.slotAt,
            missedSlots: input.scheduleAdmission.skippedCount,
            firstMissedSlotAt: input.scheduleAdmission.firstSkippedSlotAt,
            lastMissedSlotAt: input.scheduleAdmission.lastSkippedSlotAt,
          },
        }),
        occurredAt: prepared.admittedAt,
      });
      if (!event.success) {
        throw abortAdmission({ kind: "admission_record_invalid", message: "admission event failed validation", cause: event.error });
      }
      if (input.admissionAllowed?.() === false) {
        throw abortAdmission({ kind: "admission_deferred", message: "scheduled admission was sealed before commit" });
      }
      const runDocument = await tx.doc(WorkshopRunDoc, conversation.id);
      Object.assign(runDocument, runValue.data);
      Object.assign(installationDraft, nextInstallation.data);
      await tx.appendEntry(WorkshopEventEntry, conversation.id, { data: event.data });
      return {
        runId: prepared.runId,
        workflowId: prepared.workflowId,
        activationId: activation.activationId,
        occurrenceId: prepared.occurrenceId,
        admissionSequence,
        conversationId: conversation.id,
        workflowTaskId,
        duplicate: false,
      } satisfies DurableRunAdmission;
    };
    const value = input.serviceMutation === undefined
      ? await input.harness.commit(commitAdmission, input.context)
      : await input.harness.commit(async (tx) => {
        if (input.serviceMutation!.request.requestId !== input.prepared.requestId) {
          throw abortAdmission({ kind: "idempotency_conflict", message: "service receipt request ID differs from the prepared admission" });
        }
        const result = await commitServiceMutationInTransaction(tx, {
          ...input.serviceMutation!,
          apply: commitAdmission,
        });
        if (result.kind === "idempotency_conflict") {
          throw abortAdmission({ kind: "idempotency_conflict", message: "service request ID was already used with different arguments" });
        }
        const parsed = durableRunAdmissionSchema.safeParse(result.response);
        if (!parsed.success) {
          throw abortAdmission({ kind: "persisted_run_invalid", message: "service receipt contains an invalid run admission", cause: parsed.error });
        }
        return parsed.data;
      }, input.context);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof AdmissionAbort) return { ok: false, failure: error.failure };
    return {
      ok: false,
      failure: { kind: "durable_commit_failed", message: "could not commit run admission", cause: error },
    };
  }
}

async function readExistingAdmission<I>(input: {
  tx: Tx;
  reference: RunReference;
  prepared: PreparedRunAdmission;
  taskKind: string;
  parseTaskInput: (value: unknown, identity: AdmissionRunIdentity) => I | undefined;
}): Promise<DurableRunAdmission> {
  // SAFETY: runReferenceSchema parsed a positive safe integer; Durable ConversationId brands this numeric ID.
  const conversationId = input.reference.conversationId as ConversationId;
  const conversation = await input.tx.conversation(conversationId);
  if (conversation === undefined || conversation.owner !== undefined || conversation.parent !== undefined) {
    throw abortAdmission({ kind: "persisted_run_invalid", message: "existing run conversation is missing or not ownerless" });
  }
  const storedDraft = await input.tx.doc(WorkshopRunDoc, conversationId);
  const stored = workflowRunDocumentV1Schema.safeParse(storedDraft);
  if (!stored.success || stored.data.state !== "ready") {
    throw abortAdmission({ kind: "persisted_run_invalid", message: "existing run document is invalid", cause: stored.success ? undefined : stored.error });
  }
  const run = stored.data;
  const sameIdentity = run.runId === input.reference.runId
    && run.workflowId === input.prepared.workflowId
    && run.activationId === input.prepared.activationId
    && run.occurrenceId === input.prepared.occurrenceId
    && run.durable.conversationId === input.reference.conversationId
    && run.durable.workflowTaskId === input.reference.workflowTaskId
    && run.admissionSequence === input.reference.admissionSequence
    && run.admittedAt === input.reference.admittedAt
    && run.status === input.reference.status
    && run.requestId === input.reference.requestId;
  const sameRequest = run.requestId === input.prepared.requestId;
  const samePrepared = run.sourceHash === input.prepared.sourceHash
    && run.canonicalHash === input.prepared.canonicalHash
    && canonicalHash(run.resolvedSettings) === canonicalHash(input.prepared.resolvedSettings)
    && run.paths.projectCwd === input.prepared.projectCwd
    && run.paths.runDirectory === join(input.prepared.runsDirectory, run.runId)
    && run.activationId === input.prepared.activationId
    && run.occurrenceId === input.prepared.occurrenceId;
  if (!sameIdentity || !sameRequest || !samePrepared) {
    throw abortAdmission({ kind: "idempotency_conflict", message: "request or occurrence identity was reused with different prepared inputs" });
  }
  // SAFETY: runReferenceSchema parsed the positive safe integer; Durable TaskId is the same numeric ID with an opaque brand.
  const taskId = input.reference.workflowTaskId as TaskId;
  const task = await input.tx.task(taskId);
  const taskIdentity = {
    runId: input.reference.runId,
    workflowId: input.prepared.workflowId,
    activationId: input.reference.activationId,
    occurrenceId: input.reference.occurrenceId,
  };
  let taskInputMatches = false;
  try {
    taskInputMatches = task !== undefined && input.parseTaskInput(task.input, taskIdentity) !== undefined;
  } catch {
    taskInputMatches = false;
  }
  if (task === undefined || task.conversationId !== conversationId || task.owner !== undefined
    || task.background || task.kind !== input.taskKind || !taskInputMatches) {
    throw abortAdmission({ kind: "persisted_task_missing", message: "existing WorkflowRun task reference is missing or inconsistent" });
  }
  return {
    runId: input.reference.runId,
    workflowId: input.prepared.workflowId,
    activationId: input.reference.activationId,
    occurrenceId: input.reference.occurrenceId,
    admissionSequence: input.reference.admissionSequence,
    conversationId: input.reference.conversationId,
    workflowTaskId: input.reference.workflowTaskId,
    duplicate: true,
  };
}

class AdmissionAbort extends Error {
  constructor(readonly failure: DurableRunAdmissionFailure) {
    super(failure.message);
  }
}

function abortAdmission(failure: DurableRunAdmissionFailure): AdmissionAbort {
  return new AdmissionAbort(failure);
}
