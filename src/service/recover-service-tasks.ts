import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import type { Installation } from "../installation/load-installation.js";
import { processIncarnationSchema } from "../process/schema.js";
import { verifyProcessDeath } from "../process/verify-process-death.js";
import { workshopProcessV1Schema } from "../run/records.js";
import { processExecutionTaskInputSchema } from "../storage/durable/define-process-execution-task.js";
import {
  admitRecoveryIntent,
  clearActiveRecoveryRequest,
  handleRecoveryRestart,
  hasSupersessionActionEvidence,
  initializeRecoveryIndex,
  markRecoveryActionDispatching,
  markRecoveryActionIndeterminate,
  markRecoveryGlobalDispatching,
  recordRecoveryActionReceipt,
  recordRecoveryDeathEvidence,
  recordRecoveryGlobalDispatchReceipt,
  refuseRecoveryAction,
  settleRecoveryAction,
} from "../storage/durable/commit-recovery-intent.js";
import { WorkshopRecoveryIndexDoc, WorkshopRecoveryRequestDoc } from "../storage/durable/define-recovery-records.js";
import {
  recoveryDeathEvidenceV1Schema,
  recoveryIndexV1Schema,
  recoveryRequestV1Schema,
  type RecoveryActionIntentV1,
  type RecoveryDeathEvidenceV1,
  type RecoveryRequestV1,
} from "../storage/durable/schema-recovery.js";
import { acquireServiceLock } from "./acquire-service-lock.js";
import {
  assertNoUnreconciledProcessEvidence,
  completePausedServiceRuntimeStartup,
  hasRetainedProcessEntryHash,
  openPausedServiceRuntime,
  type PausedWorkshopServiceRuntime,
} from "./open-service-runtime.js";
import {
  serveWorkshopService,
  ServiceShutdownError,
  type WorkshopServiceOwner,
} from "./serve-workshop-service.js";
import { inspectServiceRecovery } from "./inspect-service-recovery.js";
import { locateServiceSocket } from "./locate-service-socket.js";
import type { ServiceMetadataV1 } from "./schema.js";

export class RecoveryRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecoveryRefusal";
  }
}

export interface RecoveryActionSelection {
  readonly taskId: number;
  readonly action: "abort" | "retry" | "verify_retired";
}

export interface RecoveryApplyInput {
  readonly requestId: string;
  readonly diagnosticDigest: string;
  readonly actions: readonly RecoveryActionSelection[];
  readonly resumeInstallation: true;
  readonly reason: string;
  readonly supersedesRequestId: string | null;
}

export interface RecoveryTerminal {
  isTerminal(): boolean;
  readConfirmation(): Promise<string>;
  write(message: string): void;
}

/** Check consent, apply one at-most-once recovery request, and promote this owner to the service. */
export async function applyRecoveryInstallation(
  installation: Installation,
  input: RecoveryApplyInput,
  terminal: RecoveryTerminal,
 ): Promise<{ readonly receipt: ReturnType<typeof recoveryReceipt>; readonly owner: WorkshopServiceOwner | null }> {
  if (!terminal.isTerminal()) throw new RecoveryRefusal("terminal_required", "terminal stdin and stderr are required");
  let receipt: ReturnType<typeof recoveryReceipt> | undefined;
  try {
    const owner = await serveWorkshopService({
      stateDirectory: installation.stateDirectory,
      openRuntime: async (metadata) => {
        const runtime = await openPausedServiceRuntime(installation, metadata, undefined, {
          isRecoveryRequestActive: async (harness) => {
            const stored = await harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
            const parsed = recoveryIndexV1Schema.safeParse(stored ?? { state: "uninitialized" });
            if (!parsed.success) throw new Error("Durable recovery index is invalid");
            return parsed.data.state === "ready" && parsed.data.activeRequestId !== null;
          },
        });
        let promoted = false;
        try {
          const initialized = await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT });
          if (initialized.kind === "invalid_input") throw new Error(initialized.issues.join("; "));
          const result = await applyRecoveryRequest(runtime, installation, input, terminal, metadata);
          if (result.kind === "replayed") {
            receipt = recoveryReceipt(result.request);
            await runtime.close();
            throw new RecoveryReplayOnly();
          }
          receipt = recoveryReceipt(result.request);
          const serviceRuntime = await completePausedServiceRuntimeStartup(runtime);
          promoted = true;
          return serviceRuntime;
        } catch (error) {
          if (!promoted) {
            try {
              await runtime.close();
            } catch (closeError) {
              throw new ServiceShutdownError("recovery failed and the paused runtime could not close safely", {
                cause: new AggregateError([error, closeError]),
              });
            }
          }
          throw error;
        }
      },
    });
    if (receipt === undefined) throw new Error("recovery completed without a receipt");
    return { receipt, owner };
  } catch (error) {
    if (error instanceof RecoveryReplayOnly && receipt !== undefined) return { receipt, owner: null };
    throw error;
  }
}

class RecoveryReplayOnly extends Error {}

async function applyRecoveryRequest(
  runtime: PausedWorkshopServiceRuntime,
  installation: Installation,
  input: RecoveryApplyInput,
  terminal: RecoveryTerminal,
  metadata: ServiceMetadataV1,
 ): Promise<{ readonly kind: "admitted" | "replayed"; readonly request: RecoveryRequestV1 }> {
  const harness = runtime.harness;
  const indexValue = recoveryIndexV1Schema.safeParse(
    await harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT) ?? { state: "uninitialized" },
  );
  if (!indexValue.success || indexValue.data.state !== "ready") throw new RecoveryRefusal("recovery_index_unavailable", "recovery journal is unavailable");
  if (indexValue.data.activeRequestId !== null) {
    const restarted = await handleRecoveryRestart({
      harness, context: BACKGROUND_CONTEXT, requestId: indexValue.data.activeRequestId, observedBootId: metadata.bootId,
    });
    requireTransition(restarted, "recovery_restart_failed");
  }
  const manifest = await inspectServiceRecovery(runtime, installation);
  if (!manifest.complete) throw new RecoveryRefusal("inspection_incomplete", "recovery inspection is incomplete");
  const replay = await replayCompletedRecoveryRequest(harness, input);
  if (replay !== null) {
    terminal.write(`Request ${input.requestId} already has a retained receipt; no control call will be repeated.\n`);
    return { kind: "replayed", request: replay };
  }
  if (manifest.digest !== input.diagnosticDigest) throw new RecoveryRefusal("diagnostic_changed", "inspect again before recovery");
  if (manifest.activeRequest !== null && input.supersedesRequestId !== manifest.activeRequest.requestId) {
    throw new RecoveryRefusal("supersedes_required", `active request ${manifest.activeRequest.requestId} requires --supersedes`);
  }
  if (manifest.activeRequest === null && input.supersedesRequestId !== null) {
    throw new RecoveryRefusal("supersedes_not_active", "--supersedes does not name an active recovery request");
  }
  const required = manifest.tasks.filter(isRecoveryRequiredTask);
  const requiredTaskIds = new Set(required.map((task) => task.taskId));
  for (const incarnation of manifest.processIncarnations) requiredTaskIds.add(incarnation.taskId);
  const zeroActionSupersession = requiredTaskIds.size === 0 && input.actions.length === 0;
  const selected = new Map<number, RecoveryActionSelection>();
  for (const action of input.actions) {
    if (!Number.isSafeInteger(action.taskId) || action.taskId <= 0) throw new RecoveryRefusal("invalid_task_id", "recovery task IDs must be positive integers");
    if (selected.has(action.taskId)) throw new RecoveryRefusal("duplicate_action", `task ${action.taskId} appears more than once`);
    selected.set(action.taskId, action);
  }
  if (requiredTaskIds.size !== selected.size || [...requiredTaskIds].some((taskId) => !selected.has(taskId))) {
    throw new RecoveryRefusal("action_list_incomplete", "enumerate each blocked task and retained process incarnation exactly once");
  }
  for (const task of required) {
    const action = selected.get(task.taskId)!;
    const processIncarnation = manifest.processIncarnations.find((item) => item.taskId === task.taskId);
    if (processIncarnation !== undefined ? action.action !== processIncarnation.action
      : action.action === "verify_retired" || !task.policy.permittedActions.includes(action.action)) {
      throw new RecoveryRefusal("action_not_permitted", `task ${task.taskId} does not permit ${action.action}`);
    }
  }
  for (const processIncarnation of manifest.processIncarnations) {
    const action = selected.get(processIncarnation.taskId)!;
    if (action.action !== processIncarnation.action) {
      throw new RecoveryRefusal("action_not_permitted", `task ${processIncarnation.taskId} requires ${processIncarnation.action}`);
    }
    if (action.action === "abort") {
      const task = manifest.tasks.find((item) => item.taskId === action.taskId);
      if (task === undefined || !task.policy.permittedActions.includes("abort")) {
        throw new RecoveryRefusal("action_not_permitted", `task ${action.taskId} does not permit abort`);
      }
    }
  }

  terminal.write("Recovery permits installation-wide execution, including unrelated tasks, submissions, schedules, model calls, and external effects.\n");
  terminal.write(`Request ${input.requestId}; diagnostic ${manifest.digest}\n`);
  for (const task of required) {
    const action = selected.get(task.taskId)!;
    const identity = await recoveryProcessSummary(harness, task.taskId);
    terminal.write(`  ${action.action} task ${task.taskId} ${task.kind} ${describeRecoveryAttribution(task.attribution)}; process ${JSON.stringify(identity)}\n`);
    if (task.policy.abortEvidence === "operator_attestation_required") {
      terminal.write(`  task ${task.taskId}: typed confirmation attests that the identity-free process is absent; this is not host proof.\n`);
    }
  }
  for (const processIncarnation of manifest.processIncarnations.filter((item) => item.action === "verify_retired")) {
    terminal.write(`  verify_retired task ${processIncarnation.taskId} process ${JSON.stringify(processIncarnation.process)} retained entry ${processIncarnation.processEntryHash}\n`);
  }
  const unrelated = manifest.tasks.filter((task) => !selected.has(task.taskId));
  terminal.write(`Pending work released by resume: ${unrelated.length} task(s), ${manifest.queuedSubmissions.length} queued submission(s), ${manifest.schedules.filter((item) => item.state !== "exhausted").length} active schedule(s)\n`);
  for (const task of unrelated) terminal.write(`  task ${task.taskId} ${task.kind} ${task.state} ${describeRecoveryAttribution(task.attribution)}\n`);
  for (const schedule of manifest.schedules) terminal.write(`  schedule ${schedule.workflowId} ${schedule.state}${schedule.nextDueAt === null ? "" : ` next ${schedule.nextDueAt}`}\n`);
  terminal.write(`Type exactly: recover ${input.requestId} ${manifest.digest} resume-installation\n> `);
  const confirmationLine = `recover ${input.requestId} ${manifest.digest} resume-installation`;
  if (await terminal.readConfirmation() !== confirmationLine) {
    throw new RecoveryRefusal("confirmation_mismatch", "confirmation did not match");
  }
  if (zeroActionSupersession) {
    if (manifest.activeRequest === null || input.supersedesRequestId !== manifest.activeRequest.requestId) {
      throw new RecoveryRefusal("empty_action_supersession_required", "zero-action recovery requires a linked active request");
    }
    await verifySupersessionEvidence(harness, manifest.activeRequest.requestId);
  }
  const checked = await inspectServiceRecovery(runtime, installation);
  if (!checked.complete || checked.digest !== manifest.digest) throw new RecoveryRefusal("diagnostic_changed", "inspection changed after confirmation");
  if (zeroActionSupersession) {
    if (checked.activeRequest?.requestId !== input.supersedesRequestId) {
      throw new RecoveryRefusal("diagnostic_changed", "the linked recovery request changed after confirmation");
    }
    await verifySupersessionEvidence(harness, checked.activeRequest.requestId);
  }

  const actions = await buildRecoveryActionIntents(harness, checked, input.actions);
  const confirmedAt = new Date().toISOString();
  const priorValue = recoveryRequestV1Schema.safeParse(
    await harness.snapshot(WorkshopRecoveryRequestDoc, input.requestId, BACKGROUND_CONTEXT),
  );
  const replayTimestamp = priorValue.success && priorValue.data.intent !== null
    && isSameRecoveryPayload(priorValue.data.intent, {
      requestId: input.requestId, manifestDigest: checked.digest, reason: input.reason,
      resumeInstallation: input.resumeInstallation, supersedesRequestId: input.supersedesRequestId, actions,
    })
    ? priorValue.data.intent.confirmedAt
    : confirmedAt;
  const admitted = await admitRecoveryIntent({
    harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, manifestDigest: checked.digest,
    reason: input.reason, confirmedAt: replayTimestamp, resumeInstallation: input.resumeInstallation,
    supersedesRequestId: input.supersedesRequestId, actions,
  });
  if (admitted.kind === "invalid_input") throw new RecoveryRefusal("invalid_recovery_intent", admitted.issues.join("; "));
  if (admitted.kind === "conflict") throw new RecoveryRefusal(admitted.code, `recovery intent was refused: ${admitted.code}`);
  if (admitted.kind === "replayed") return { kind: "replayed", request: admitted.request };

  for (const action of actions) {
    if (action.action === "retry" || action.process === null) continue;
    await verifyAndRecordProcessDeath({
      harness, action, requestId: input.requestId, diagnosticDigest: checked.digest, confirmationLine,
    });
  }
  for (const action of actions.filter((item) => item.action === "verify_retired")) {
    const task = await harness.getTask(action.taskId as TaskId, BACKGROUND_CONTEXT);
    if (task === undefined || task.state.status !== "terminal") {
      throw new RecoveryRefusal("terminal_process_task_changed", `task ${action.taskId} is no longer terminal`);
    }
    const request = recoveryRequestV1Schema.parse(
      await harness.snapshot(WorkshopRecoveryRequestDoc, input.requestId, BACKGROUND_CONTEXT),
    );
    const deathEvidence = request.actions.find((item) => item.taskId === action.taskId)?.deathEvidence;
    if (deathEvidence === null || deathEvidence === undefined) {
      throw new RecoveryRefusal("death_proof_required", `task ${action.taskId} has no recorded process-death evidence`);
    }
    requireTransition(await settleRecoveryAction({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId,
      taskOutcome: task.state.outcome, processEvidenceHash: canonicalHash(deathEvidence),
    }), "retired_process_settlement_failed");
  }
  for (const action of actions) {
    if (action.action !== "abort") continue;
    requireTransition(await markRecoveryActionDispatching({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId,
    }), "abort_dispatch_not_ready");
    try {
      await withDeadline(harness.abortTask(action.taskId as TaskId, BACKGROUND_CONTEXT), Date.now() + RECOVERY_OPERATION_MS, "abortTask");
    } catch (error) {
      const indeterminate = await markRecoveryActionIndeterminate({ harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId });
      requireTransition(indeterminate, "abort_dispatch_indeterminate");
      throw new RecoveryRefusal("abort_dispatch_indeterminate", `abortTask outcome is uncertain for task ${action.taskId}: ${errorText(error)}`);
    }
    const snapshotHash = await getTaskSnapshotHash(harness, action.taskId);
    requireTransition(await recordRecoveryActionReceipt({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId,
      method: "abortTask", taskSnapshotHash: snapshotHash,
    }), "abort_receipt_failed");
  }

  const retryActions = actions.filter((action) => action.action === "retry");
  const firstRetry = retryActions[0];
  requireTransition(await markRecoveryGlobalDispatching({
    harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, firstRetryTaskId: firstRetry?.taskId ?? null,
  }), "global_dispatch_not_ready");
  if (firstRetry !== undefined) {
    await withDeadline(harness.retryTask(firstRetry.taskId as TaskId, BACKGROUND_CONTEXT), Date.now() + RECOVERY_OPERATION_MS, "first retryTask");
    runtime.markRecoverySchedulingStarted();
    const snapshotHash = await getTaskSnapshotHash(harness, firstRetry.taskId);
    requireTransition(await recordRecoveryGlobalDispatchReceipt({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, method: "retryTask",
      taskId: firstRetry.taskId, taskSnapshotHash: snapshotHash,
    }), "global_dispatch_receipt_failed");
  } else {
    harness.resume();
    runtime.markRecoverySchedulingStarted();
    requireTransition(await recordRecoveryGlobalDispatchReceipt({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, method: "resume", taskId: null,
    }), "global_dispatch_receipt_failed");
  }
  for (const action of retryActions.slice(1)) {
    requireTransition(await markRecoveryActionDispatching({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId,
    }), "retry_dispatch_not_ready");
    await withDeadline(harness.retryTask(action.taskId as TaskId, BACKGROUND_CONTEXT), Date.now() + RECOVERY_OPERATION_MS, "retryTask");
    const snapshotHash = await getTaskSnapshotHash(harness, action.taskId);
    requireTransition(await recordRecoveryActionReceipt({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId,
      method: "retryTask", taskSnapshotHash: snapshotHash,
    }), "retry_receipt_failed");
  }

  const deadline = Date.now() + RECOVERY_SETTLEMENT_MS;
  const settledTasks = new Map<number, Awaited<ReturnType<Harness["getTask"]>>>();
  for (const action of actions) {
    if (action.action !== "abort") continue;
    settledTasks.set(action.taskId, await waitForTaskTerminal(harness, action.taskId, deadline));
  }
  await assertNoUnreconciledProcessEvidence(harness, deadline, metadata.bootId);
  const refreshed = await runtime.refreshStartupInspection();
  if (refreshed.blockedTasks.length > 0 || refreshed.limitations.length > 0) {
    throw new Error(`recovery dispatch left blocked or uncertain task state; service remains stopped: ${JSON.stringify({ blockedTasks: refreshed.blockedTasks, limitations: refreshed.limitations })}`);
  }
  for (const action of actions) {
    if (action.action !== "abort") continue;
    const task = settledTasks.get(action.taskId);
    if (task === undefined || task.state.status !== "terminal") throw new Error(`aborted task ${action.taskId} has no terminal receipt`);
    const processEvidenceHash = action.process === null ? null : canonicalHash(
      (await harness.snapshot(WorkshopRecoveryRequestDoc, input.requestId, BACKGROUND_CONTEXT))?.actions.find((item) => item.taskId === action.taskId)?.deathEvidence,
    );
    requireTransition(await settleRecoveryAction({
      harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, taskId: action.taskId,
      taskOutcome: task.state.outcome, processEvidenceHash,
    }), "action_settlement_failed");
  }
  requireTransition(await clearActiveRecoveryRequest({
    harness, context: BACKGROUND_CONTEXT, requestId: input.requestId, mode: "readiness_verified",
    manifestDigest: checked.digest, checkedAt: new Date().toISOString(),
  }), "recovery_readiness_not_clearable");
  const completed = recoveryRequestV1Schema.parse(
    await harness.snapshot(WorkshopRecoveryRequestDoc, input.requestId, BACKGROUND_CONTEXT),
  );
  return { kind: "admitted", request: completed };
}
async function replayCompletedRecoveryRequest(
  harness: Harness,
  input: RecoveryApplyInput,
): Promise<RecoveryRequestV1 | null> {
  const parsed = recoveryRequestV1Schema.safeParse(
    await harness.snapshot(WorkshopRecoveryRequestDoc, input.requestId, BACKGROUND_CONTEXT),
  );
  if (!parsed.success || parsed.data.intent === null || parsed.data.state === "unadmitted" || parsed.data.state === "active") return null;
  const intent = parsed.data.intent;
  const sameActions = intent.actions.length === input.actions.length
    && intent.actions.every((action, index) => action.taskId === input.actions[index]?.taskId
      && action.action === input.actions[index]?.action);
  if (intent.manifestDigest !== input.diagnosticDigest || intent.reason !== input.reason
    || intent.resumeInstallation !== input.resumeInstallation
    || intent.supersedesRequestId !== input.supersedesRequestId || !sameActions) {
    throw new RecoveryRefusal("idempotency_conflict", "request ID is already bound to a different recovery payload");
  }
  const result = await admitRecoveryIntent({
    harness, context: BACKGROUND_CONTEXT, requestId: intent.requestId,
    manifestDigest: intent.manifestDigest, reason: intent.reason, confirmedAt: intent.confirmedAt,
    resumeInstallation: intent.resumeInstallation, supersedesRequestId: intent.supersedesRequestId,
    actions: intent.actions,
  });
  if (result.kind !== "replayed") throw new Error("recovery replay did not return its retained request");
  return result.request;
}



const RECOVERY_OPERATION_MS = 10_000;
const RECOVERY_SETTLEMENT_MS = 10_000;

function describeRecoveryAttribution(attribution: import("./schema-recovery.js").ServiceRecoveryAttributionV1): string {
  switch (attribution.kind) {
    case "workflow_run": return `workflow ${attribution.workflowId} run ${attribution.runId}`;
    case "scheduler": return `scheduler ${attribution.workflowId}`;
    case "bot": return "shared bot";
    case "unknown": return "unknown owner";
  }
}

export function isRecoveryRequiredTask(task: import("./schema-recovery.js").ServiceRecoveryTaskV1): boolean {
  return task.state === "blocked" || (task.processEvidence !== null
    && task.state !== "completing" && task.processEvidence.checkpointPhase !== "intent");
}

async function buildRecoveryActionIntents(
  harness: Harness,
  manifest: Awaited<ReturnType<typeof inspectServiceRecovery>>,
  selections: readonly RecoveryActionSelection[],
): Promise<RecoveryActionIntentV1[]> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  const tasks = new Map(inspection.tasks.map((task) => [Number(task.record.id), task]));
  const attached = await harness.taskGraph(BACKGROUND_CONTEXT);
  const conversationOwners = new Map<number, number>();
  try {
    for (const node of Object.values(attached.value.tasks)) {
      for (const conversationId of node.conversations) conversationOwners.set(Number(conversationId), Number(node.id));
    }
  } finally {
    attached.dispose();
  }
  const manifestTasks = new Map(manifest.tasks.map((task) => [task.taskId, task]));
  return await Promise.all(selections.map(async (selection) => {
    const inspected = tasks.get(selection.taskId);
    const task = manifestTasks.get(selection.taskId);
    const retiredProcess = manifest.processIncarnations.find((item) => item.taskId === selection.taskId && item.action === "verify_retired");
    if (retiredProcess !== undefined) {
      const terminalTask = await harness.getTask(selection.taskId as TaskId, BACKGROUND_CONTEXT);
      const parsedInput = processExecutionTaskInputSchema.safeParse(terminalTask?.input);
      if (selection.action !== "verify_retired" || terminalTask === undefined || terminalTask.state.status !== "terminal"
        || terminalTask.kind !== "workshop.process-execution" || terminalTask.version !== retiredProcess.taskVersion
        || !parsedInput.success || parsedInput.data.runId !== retiredProcess.runId
        || parsedInput.data.executionId !== retiredProcess.process.executionId
        || parsedInput.data.incarnationId !== retiredProcess.process.incarnationId
        || canonicalHash(terminalTask.input) !== retiredProcess.inputHash
        || retiredProcess.checkpointHash !== canonicalHash(null)
        || Number(terminalTask.conversationId) !== retiredProcess.conversationId) {
        throw new RecoveryRefusal("task_changed", `retired process task ${selection.taskId} changed during confirmation`);
      }
      const conversationId = Number(terminalTask.conversationId);
      const taskOwnerId = terminalTask.owner === undefined ? null : Number(terminalTask.owner);
      const conversationOwnerTaskId = conversationOwners.get(conversationId) ?? null;
      const conversationOwner = conversationOwnerTaskId === null ? null : { conversationId, taskId: conversationOwnerTaskId };
      const ownerBinding = { conversationId, taskOwnerId, conversationOwner };
      return {
        taskId: selection.taskId, taskKind: terminalTask.kind, taskVersion: terminalTask.version,
        action: selection.action, owner: { ...ownerBinding, ownershipHash: canonicalHash({ taskId: selection.taskId, ...ownerBinding }) },
        inputHash: retiredProcess.inputHash, checkpointHash: retiredProcess.checkpointHash,
        process: retiredProcess.process, processEntryHash: retiredProcess.processEntryHash, replaySafety: "unknown" as const,
      };
    }
    if (inspected === undefined || task === undefined) throw new RecoveryRefusal("task_changed", `task ${selection.taskId} changed during confirmation`);
    const inputHash = canonicalHash(inspected.record.input);
    const checkpoint = "checkpoint" in inspected.record.state ? inspected.record.state.checkpoint : null;
    const observedCheckpointHash = checkpoint === null ? null : canonicalHash(checkpoint);
    if (task.inputHash !== inputHash || task.checkpointHash !== observedCheckpointHash) {
      throw new RecoveryRefusal("task_changed", `task ${selection.taskId} changed during confirmation`);
    }
    const checkpointHash = observedCheckpointHash ?? canonicalHash(null);
    const conversationId = Number(inspected.record.conversationId);
    const taskOwnerId = inspected.record.owner === undefined ? null : Number(inspected.record.owner);
    const conversationOwnerTaskId = conversationOwners.get(conversationId) ?? null;
    const conversationOwner = conversationOwnerTaskId === null ? null : { conversationId, taskId: conversationOwnerTaskId };
    const ownerBinding = { conversationId, taskOwnerId, conversationOwner };
    const ownershipHash = canonicalHash({ taskId: selection.taskId, ...ownerBinding });
    let process: RecoveryActionIntentV1["process"] = null;
    let processEntryHash: string | undefined;
    if (inspected.record.kind === "workshop.process-execution") {
      const checkpointValue = checkpoint as { phase?: unknown; process?: unknown };
      if (checkpointValue.phase !== "intent") {
        const parsedProcess = processIncarnationSchema.safeParse(checkpointValue.process);
        if (!parsedProcess.success) throw new RecoveryRefusal("unsupported_process_checkpoint", `task ${selection.taskId} has an unsupported process checkpoint`);
        const parsedInput = processExecutionTaskInputSchema.safeParse(inspected.record.input);
        if (!parsedInput.success) throw new RecoveryRefusal("unsupported_process_input", `task ${selection.taskId} has invalid process input`);
        process = {
          executionId: parsedProcess.data.executionId,
          incarnationId: parsedProcess.data.incarnationId,
          launchServiceBootId: parsedProcess.data.launchServiceBootId ?? parsedInput.data.serviceBootId,
          identity: parsedProcess.data.identity,
        };
        processEntryHash = manifest.processIncarnations.find((item) => item.taskId === selection.taskId)?.processEntryHash;
      }
    }
    return {
      taskId: selection.taskId,
      taskKind: inspected.record.kind,
      taskVersion: inspected.record.version,
      action: selection.action,
      owner: { ...ownerBinding, ownershipHash },
      inputHash,
      checkpointHash,
      process,
      ...(processEntryHash === undefined ? {} : { processEntryHash }),
      replaySafety: task.policy.retryEligibility === "safe" ? "safe"
        : task.policy.retryEligibility === "unsafe" ? "unsafe" : "unknown",
    };
  }));
}

function isSameRecoveryPayload(
  intent: RecoveryRequestV1["intent"],
  payload: {
    readonly requestId: string;
    readonly manifestDigest: string;
    readonly reason: string;
    readonly resumeInstallation: boolean;
    readonly supersedesRequestId: string | null;
    readonly actions: readonly RecoveryActionIntentV1[];
  },
): boolean {
  return intent !== null && intent.requestId === payload.requestId
    && intent.manifestDigest === payload.manifestDigest && intent.reason === payload.reason
    && intent.resumeInstallation === payload.resumeInstallation
    && intent.supersedesRequestId === payload.supersedesRequestId
    && canonicalHash(intent.actions) === canonicalHash(payload.actions);
}

async function recoveryProcessSummary(harness: Harness, taskId: number): Promise<unknown> {
  const task = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
  if (task === undefined || task.state.status === "terminal" || !("checkpoint" in task.state)) return null;
  const checkpoint = task.state.checkpoint as { phase?: unknown; process?: unknown };
  const parsed = processIncarnationSchema.safeParse(checkpoint.process);
  if (checkpoint.phase === "intent" || !parsed.success) return null;
  return {
    executionId: parsed.data.executionId,
    incarnationId: parsed.data.incarnationId,
    launchServiceBootId: parsed.data.launchServiceBootId ?? null,
    identity: parsed.data.identity,
  };
}

async function verifySupersessionEvidence(harness: Harness, activeRequestId: string): Promise<void> {
  const active = recoveryRequestV1Schema.safeParse(
    await harness.snapshot(WorkshopRecoveryRequestDoc, activeRequestId, BACKGROUND_CONTEXT),
  );
  if (!active.success || active.data.requestId !== activeRequestId || active.data.state !== "active"
    || active.data.intent === null) {
    throw new RecoveryRefusal("settlement_evidence_required", "the active request has no valid supersession evidence");
  }
  let request = active.data;
  const seen = new Set([request.requestId]);
  while (request.actions.length === 0) {
    const priorId = request.intent?.supersedesRequestId;
    if (priorId === null || priorId === undefined || seen.has(priorId)) {
      throw new RecoveryRefusal("settlement_evidence_required", "the zero-action request chain has no action-bearing predecessor");
    }
    const prior = recoveryRequestV1Schema.safeParse(
      await harness.snapshot(WorkshopRecoveryRequestDoc, priorId, BACKGROUND_CONTEXT),
    );
    if (!prior.success || prior.data.requestId !== priorId || prior.data.state !== "superseded"
      || prior.data.supersededBy !== request.requestId || prior.data.closure?.kind !== "superseded"
      || prior.data.closure.replacementRequestId !== request.requestId) {
      throw new RecoveryRefusal("settlement_evidence_required", "the zero-action request chain is not intact");
    }
    seen.add(priorId);
    request = prior.data;
  }
  if (!hasSupersessionActionEvidence(request)) {
    throw new RecoveryRefusal("settlement_evidence_required", "the action-bearing predecessor has unresolved or incomplete control evidence");
  }
  for (const action of request.actions) {
    const task = await harness.getTask(action.taskId as TaskId, BACKGROUND_CONTEXT);
    if (task === undefined || task.kind !== action.taskKind || canonicalHash(task.input) !== action.inputHash
      || Number(task.conversationId) !== action.owner.conversationId) {
      throw new RecoveryRefusal("settlement_evidence_required", `task ${action.taskId} no longer matches its retained action`);
    }
    const retirementSettled = action.action === "verify_retired";
    if (retirementSettled && task.version !== action.taskVersion) {
      throw new RecoveryRefusal("settlement_evidence_required", `retired task ${action.taskId} changed after verification`);
    }
    if (action.settlement !== null && (task.state.status !== "terminal"
      || canonicalHash(task.state.outcome) !== action.settlement.outcomeHash
      || canonicalHash(task.state.outcome) !== canonicalHash(action.settlement.taskOutcome))) {
      throw new RecoveryRefusal("settlement_evidence_required", `task ${action.taskId} no longer matches its retained settlement`);
    }
    if (action.process === null) continue;
    const process = action.process;
    const evidence = action.deathEvidence;
    const taskInput = processExecutionTaskInputSchema.safeParse(task.input);
    if (evidence === null || action.processEntryHash === undefined
      || evidence.processEntryHash !== action.processEntryHash
      || task.kind !== "workshop.process-execution" || !taskInput.success
      || taskInput.data.executionId !== process.executionId
      || taskInput.data.incarnationId !== process.incarnationId) {
      throw new RecoveryRefusal("settlement_evidence_required", `task ${action.taskId} no longer matches its process binding`);
    }
    const retained = await hasRetainedProcessEntryHash(
      harness, action.owner.conversationId, taskInput.data.runId, action.taskId, process,
      taskInput.data.serviceBootId, taskInput.data.incarnationNumber, action.processEntryHash, Date.now() + RECOVERY_OPERATION_MS,
    );
    const evidenceMatches = evidence.kind === "confirmed_dead"
      ? process.identity !== null && evidence.executionId === process.executionId
        && evidence.incarnationId === process.incarnationId
        && evidence.inputHash === action.inputHash && evidence.checkpointHash === action.checkpointHash
        && evidence.launchServiceBootId === process.launchServiceBootId
        && canonicalHash(evidence.identity) === canonicalHash(process.identity)
      : process.identity === null && evidence.attestingRequestId === request.requestId
        && evidence.manifestDigest === request.intent?.manifestDigest
        && evidence.processEntryHash === action.processEntryHash
        && evidence.evidenceHash === canonicalHash({
          confirmationLine: `recover ${request.requestId} ${request.intent?.manifestDigest} resume-installation`,
          taskId: action.taskId, executionId: process.executionId, incarnationId: process.incarnationId,
          inputHash: action.inputHash, checkpointHash: action.checkpointHash, processEntryHash: action.processEntryHash,
        });
    if (!retained || !evidenceMatches) {
      throw new RecoveryRefusal("settlement_evidence_required", `task ${action.taskId} has invalid retained process evidence`);
    }
  }
}

async function verifyAndRecordProcessDeath(input: {
  readonly harness: Harness;
  readonly action: RecoveryActionIntentV1;
  readonly requestId: string;
  readonly diagnosticDigest: string;
  readonly confirmationLine: string;
}): Promise<RecoveryDeathEvidenceV1> {
  const process = input.action.process;
  if (process === null) throw new Error("process retirement was requested without a process binding");
  let processEntryHash: string;
  try {
    processEntryHash = await findProcessEntryHash(input.harness, input.action);
  } catch (error) {
    if (error instanceof RecoveryRefusal) {
      return await refuseAction(input.harness, input.requestId, input.action.taskId, error.code);
    }
    throw error;
  }
  let evidence: RecoveryDeathEvidenceV1;
  if (process.identity === null) {
    evidence = {
      kind: "operator_attested_absent",
      method: "typed_terminal_confirmation",
      attestingRequestId: input.requestId,
      attestedAt: new Date().toISOString(),
      manifestDigest: input.diagnosticDigest,
      processEntryHash,
      evidenceHash: canonicalHash({
        confirmationLine: input.confirmationLine, taskId: input.action.taskId,
        executionId: process.executionId, incarnationId: process.incarnationId,
        inputHash: input.action.inputHash, checkpointHash: input.action.checkpointHash, processEntryHash,
      }),
    };
  } else {
    const verification = await verifyProcessDeath({
      identity: process.identity,
      ...(process.launchServiceBootId === null ? {} : { launchServiceBootId: process.launchServiceBootId }),
    });
    if (verification.kind === "refused") {
      return await refuseAction(input.harness, input.requestId, input.action.taskId, verification.reason);
    }
    if (process.launchServiceBootId === null) {
      return await refuseAction(input.harness, input.requestId, input.action.taskId, "launch_boot_unknown");
    }
    evidence = {
      kind: "confirmed_dead",
      method: verification.kind === "confirmed_absent" ? "process_group_absent" : "process_group_retired",
      hostBootId: verification.hostBootId,
      observedAt: verification.observedAt,
      identity: verification.checkedIdentity,
      executionId: process.executionId,
      incarnationId: process.incarnationId,
      launchServiceBootId: process.launchServiceBootId,
      inputHash: input.action.inputHash,
      checkpointHash: input.action.checkpointHash,
      processEntryHash,
    };
  }
  const checked = recoveryDeathEvidenceV1Schema.safeParse(evidence);
  if (!checked.success) return await refuseAction(input.harness, input.requestId, input.action.taskId, "death_evidence_invalid");
  const recorded = await recordRecoveryDeathEvidence({
    harness: input.harness, context: BACKGROUND_CONTEXT, requestId: input.requestId,
    taskId: input.action.taskId, evidence: checked.data,
  });
  if (recorded.kind !== "updated" && recorded.kind !== "already_recorded") {
    await refuseAction(input.harness, input.requestId, input.action.taskId, "death_proof_mismatch");
  }
  return checked.data;
}

async function findProcessEntryHash(harness: Harness, action: RecoveryActionIntentV1): Promise<string> {
  const process = action.process;
  if (process === null) throw new RecoveryRefusal("process_binding_missing", `task ${action.taskId} has no process binding`);
  const taskRecord = await harness.getTask(action.taskId as TaskId, BACKGROUND_CONTEXT);
  if (taskRecord === undefined || taskRecord.kind !== "workshop.process-execution"
    || taskRecord.version !== action.taskVersion || canonicalHash(taskRecord.input) !== action.inputHash
    || Number(taskRecord.conversationId) !== action.owner.conversationId) {
    throw new RecoveryRefusal("process_task_changed", `task ${action.taskId} no longer matches its recovery binding`);
  }
  const parsedInput = processExecutionTaskInputSchema.safeParse(taskRecord.input);
  if (!parsedInput.success) throw new RecoveryRefusal("unsupported_process_input", `task ${action.taskId} has invalid process input`);
  let parsedCheckpoint: ReturnType<typeof processIncarnationSchema.safeParse> | undefined;
  if (action.action === "verify_retired") {
    if (taskRecord.state.status !== "terminal" || action.processEntryHash === undefined
      || action.checkpointHash !== canonicalHash(null)) {
      throw new RecoveryRefusal("terminal_process_checkpoint_changed", `task ${action.taskId} is not bound to a terminal process entry`);
    }
  } else {
    if (taskRecord.state.status === "terminal" || !("checkpoint" in taskRecord.state)) {
      throw new RecoveryRefusal("process_checkpoint_missing", `task ${action.taskId} has no live process checkpoint`);
    }
    const checkpoint = taskRecord.state.checkpoint as { phase?: unknown; process?: unknown };
    parsedCheckpoint = processIncarnationSchema.safeParse(checkpoint.process);
    if (!parsedCheckpoint.success || checkpoint.phase === "intent"
      || parsedCheckpoint.data.executionId !== process.executionId
      || parsedCheckpoint.data.incarnationId !== process.incarnationId
      || (parsedCheckpoint.data.launchServiceBootId ?? parsedInput.data.serviceBootId) !== process.launchServiceBootId
      || canonicalHash(parsedCheckpoint.data.identity) !== canonicalHash(process.identity)
      || canonicalHash(taskRecord.state.checkpoint) !== action.checkpointHash) {
      throw new RecoveryRefusal("process_checkpoint_changed", `task ${action.taskId} process checkpoint changed`);
    }
  }
  const conversation = await harness.conversation(action.owner.conversationId as never, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new RecoveryRefusal("process_entry_missing", `task ${action.taskId} has no process evidence conversation`);
  let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
  let match: { readonly id: number; readonly data: unknown } | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (entry.kind !== "workshop.process") continue;
      if (entry.data === undefined) throw new RecoveryRefusal("process_entry_invalid", `task ${action.taskId} has an empty process evidence entry`);
      const parsed = workshopProcessV1Schema.safeParse(entry.data);
      if (!parsed.success) throw new RecoveryRefusal("process_entry_invalid", `task ${action.taskId} has invalid process evidence`);
      if (parsed.data.taskId !== action.taskId) continue;
      if (parsed.data.runId !== parsedInput.data.runId) {
        throw new RecoveryRefusal("process_entry_run_mismatch", `task ${action.taskId} has process evidence for another run`);
      }
      const entryProcess = parsed.data.process;
      const exactIncarnation = action.action === "verify_retired"
        ? entryProcess.executionId === process.executionId && entryProcess.incarnationId === process.incarnationId
          && entryProcess.incarnationNumber === parsedInput.data.incarnationNumber
          && (entryProcess.launchServiceBootId ?? parsedInput.data.serviceBootId) === process.launchServiceBootId
          && canonicalHash(entryProcess.identity) === canonicalHash(process.identity)
        : canonicalHash(entryProcess) === canonicalHash(parsedCheckpoint!.data);
      if (!exactIncarnation) continue;
      const id = Number(entry.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new RecoveryRefusal("process_entry_invalid", `task ${action.taskId} has an invalid process entry ID`);
      if (match === undefined || id > match.id) match = { id, data: entry.data };
    }
    cursor = page.next;
  } while (cursor !== undefined);
  if (match === undefined) throw new RecoveryRefusal("process_entry_missing", `task ${action.taskId} has no exact process evidence entry`);
  const processEntryHash = canonicalHash({ id: match.id, data: match.data });
  if (action.processEntryHash !== undefined && processEntryHash !== action.processEntryHash) {
    throw new RecoveryRefusal("process_entry_changed", `task ${action.taskId} process evidence changed during confirmation`);
  }
  return processEntryHash;
}


async function refuseAction(harness: Harness, requestId: string, taskId: number, code: string): Promise<never> {
  const result = await refuseRecoveryAction({
    harness, context: BACKGROUND_CONTEXT, requestId, taskId, code,
  });
  requireTransition(result, "recovery_action_refusal_failed");
  throw new RecoveryRefusal(code, `recovery action refused for task ${taskId}: ${code}`);
}

async function getTaskSnapshotHash(harness: Harness, taskId: number): Promise<string | null> {
  const task = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
  return task === undefined ? null : canonicalHash({ id: Number(task.id), kind: task.kind, version: task.version, state: task.state });
}

async function waitForTaskTerminal(harness: Harness, taskId: number, deadline: number) {
  for (;;) {
    const task = await withDeadline(harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT), deadline, "task settlement poll");
    if (task === undefined) throw new Error(`task ${taskId} disappeared during recovery settlement`);
    if (task.state.status === "terminal") return task;
    await withDeadline(new Promise<void>((resolve) => setTimeout(resolve, 10)), deadline, "task settlement poll");
  }
}

async function withDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`timed out during ${label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out during ${label}`)), remaining); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireTransition(
  result: Awaited<ReturnType<typeof markRecoveryActionDispatching>> ,
  fallbackCode: string,
): void {
  if (result.kind === "updated" || result.kind === "already_recorded" || result.kind === "already_applied") return;
  if (result.kind === "conflict") throw new RecoveryRefusal(result.code, `${fallbackCode}: ${result.code}`);
  throw new RecoveryRefusal(fallbackCode, result.issues.join("; "));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** Inspect under the same kernel lock as the service owner, without enabling scheduling. */
export async function inspectRecoveryInstallation(installation: Installation) {
  return await withPausedRecoveryRuntime(installation, async (runtime) =>
    await inspectServiceRecovery(runtime, installation));
}

/** Read a retained recovery request without advancing the recovery journal. */
export async function readRecoveryReceipt(installation: Installation, requestId: string) {
  return await withPausedRecoveryRuntime(installation, async (runtime) => {
    const value = await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, requestId, BACKGROUND_CONTEXT);
    const parsed = recoveryRequestV1Schema.safeParse(value);
    if (value === undefined || (parsed.success && parsed.data.state === "unadmitted")) {
      throw new RecoveryRefusal("request_not_found", `recovery request ${requestId} was not found`);
    }
    if (!parsed.success || parsed.data.requestId !== requestId) throw new Error("Durable recovery receipt is invalid");
    return recoveryReceipt(parsed.data);
  });
}

export function recoveryReceipt(request: RecoveryRequestV1) {
  if (request.intent === null) throw new Error("recovery request has no admitted intent");
  return {
    version: 1 as const,
    requestId: request.requestId,
    requestHash: request.intent.payloadHash,
    diagnosticDigest: request.intent.manifestDigest,
    state: request.state,
    globalDispatch: request.globalDispatch?.state === "dispatching" ? "indeterminate" : request.globalDispatch?.state ?? "not_started",
    actions: request.actions.map((action) => ({
      taskId: action.taskId,
      action: action.action,
      state: action.state === "dispatching" ? "indeterminate" : action.state,
      evidence: action.deathEvidence?.kind ?? null,
      dispatch: action.receipt === null ? (action.dispatchMarkedAt === null ? "not_started" : "indeterminate") : "applied",
    })),
  };
}

async function withPausedRecoveryRuntime<T>(
  installation: Installation,
  operation: (runtime: PausedWorkshopServiceRuntime) => Promise<T>,
): Promise<T> {
  const directory = lstatSync(installation.stateDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (typeof process.getuid === "function" && directory.uid !== process.getuid())
    || (directory.mode & 0o077) !== 0) {
    throw new Error("service state directory must be private and owner-controlled");
  }
  const location = locateServiceSocket(installation.stateDirectory);
  const lock = acquireServiceLock(join(location.stateDirectory, "service.lock"));
  const metadata: ServiceMetadataV1 = {
    version: 1,
    status: "starting",
    pid: lock.metadata.pid,
    startIdentity: lock.metadata.startIdentity,
    bootId: lock.metadata.bootId,
    startedAt: lock.metadata.acquiredAt,
    socketPath: location.socketPath,
  };
  let runtime: PausedWorkshopServiceRuntime | undefined;
  let release = false;
  try {
    try {
      runtime = await openPausedServiceRuntime(installation, metadata);
    } catch (error) {
      release = !(error instanceof ServiceShutdownError);
      throw error;
    }
    const initialized = await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT });
    if (initialized.kind === "invalid_input") throw new Error(initialized.issues.join("; "));
    return await operation(runtime);
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
      release = true;
    }
    if (release) lock.release();
  }
}
