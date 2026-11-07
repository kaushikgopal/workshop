import type { Context, Draft } from "@earendil-works/chord";
import { randomUUID } from "node:crypto";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import {
  recoveryActionIntentV1Schema,
  recoveryActionReceiptV1Schema,
  recoveryContinuationConsentV1Schema,
  recoveryDeathEvidenceV1Schema,
  recoveryGlobalDispatchReceiptV1Schema,
  recoveryIndexV1Schema,
  recoveryIntentPayloadV1Schema,
  recoveryIntentV1Schema,
  recoveryRequestV1Schema,
  type RecoveryActionIntentV1,
  type RecoveryDeathEvidenceV1,
  type RecoveryIndexV1,
  type RecoveryIntentV1,
  type RecoveryRequestV1,
} from "./schema-recovery.js";
import { WorkshopRecoveryIndexDoc, WorkshopRecoveryRequestDoc } from "./define-recovery-records.js";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { z } from "zod";

const uuidSchema = z.string().uuid();
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const jsonSchema = z.json();

export interface RecoveryTransactionInput {
  readonly harness: Pick<Harness, "commit">;
  readonly context: Context;
}

export class RecoveryJournalCorruptError extends Error {
  constructor() {
    super("Durable recovery journal is invalid");
    this.name = "RecoveryJournalCorruptError";
  }
}

export type RecoveryConflict =
  | "index_uninitialized"
  | "request_not_active"
  | "request_not_found"
  | "recovery_in_progress"
  | "supersession_target_not_active"
  | "idempotency_conflict"
  | "occurrence_exhausted"
  | "action_not_found"
  | "action_not_ready"
  | "action_not_permitted"
  | "death_proof_required"
  | "death_proof_mismatch"
  | "death_proof_conflict"
  | "dispatch_uncertain"
  | "global_dispatch_required"
  | "global_dispatch_started"
  | "global_dispatch_not_ready"
  | "continuation_required"
  | "fresh_review_required"
  | "settlement_evidence_required"
  | "receipt_mismatch"
  | "request_not_clearable";

export type RecoveryTransitionResult =
  | { readonly kind: "updated"; readonly request: RecoveryRequestV1 }
  | { readonly kind: "already_recorded"; readonly request: RecoveryRequestV1 }
  | { readonly kind: "already_applied"; readonly request: RecoveryRequestV1 }
  | { readonly kind: "conflict"; readonly code: RecoveryConflict }
  | { readonly kind: "invalid_input"; readonly issues: readonly string[] };

export type RecoveryAdmissionResult =
  | { readonly kind: "admitted"; readonly installationId: string; readonly request: RecoveryRequestV1 }
  | { readonly kind: "replayed"; readonly installationId: string; readonly request: RecoveryRequestV1 }
  | { readonly kind: "conflict"; readonly code: "index_uninitialized" | "recovery_in_progress" | "supersession_target_not_active" | "settlement_evidence_required" | "idempotency_conflict" | "occurrence_exhausted" }
  | { readonly kind: "invalid_input"; readonly issues: readonly string[] };

export type RecoveryInitializationResult =
  | { readonly kind: "initialized"; readonly installationId: string }
  | { readonly kind: "already_initialized"; readonly installationId: string }
  | { readonly kind: "invalid_input"; readonly issues: readonly string[] };

type IndexDraft = Draft<RecoveryIndexV1>;
type RequestDraft = Draft<RecoveryRequestV1>;

interface ActiveRequest {
  readonly index: RecoveryIndexV1 & { readonly state: "ready" };
  readonly indexDraft: IndexDraft;
  readonly request: RecoveryRequestV1;
  readonly requestDraft: RequestDraft;
}

function checkedTimestamp(value: string | undefined): string {
  const result = timestampSchema.safeParse(value ?? new Date().toISOString());
  if (!result.success) throw new TypeError("Recovery timestamps must be ISO date-time strings");
  return result.data;
}

function checkedHash(value: string): string | undefined {
  const result = hashSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function parseIndex(draft: unknown): RecoveryIndexV1 {
  const parsed = recoveryIndexV1Schema.safeParse(draft);
  if (!parsed.success) throw new RecoveryJournalCorruptError();
  return parsed.data;
}

function parseRequest(draft: unknown): RecoveryRequestV1 {
  const parsed = recoveryRequestV1Schema.safeParse(draft);
  if (!parsed.success) throw new RecoveryJournalCorruptError();
  return parsed.data;
}

async function readIndex(tx: Tx): Promise<{ readonly draft: IndexDraft; readonly value: RecoveryIndexV1 }> {
  const draft = await tx.doc(WorkshopRecoveryIndexDoc);
  return { draft, value: parseIndex(draft) };
}

async function readActiveRequest(tx: Tx, requestId: string): Promise<ActiveRequest | RecoveryConflict> {
  const { draft: indexDraft, value: index } = await readIndex(tx);
  if (index.state !== "ready") return "index_uninitialized";
  if (index.activeRequestId !== requestId || index.requests[requestId]?.state !== "active") return "request_not_active";
  const requestDraft = await tx.doc(WorkshopRecoveryRequestDoc, requestId, requestId);
  const request = parseRequest(requestDraft);
  if (request.state !== "active" || request.requestId !== requestId) throw new RecoveryJournalCorruptError();
  return { index, indexDraft, request, requestDraft };
}

function transitionConflict(code: RecoveryConflict): RecoveryTransitionResult {
  return { kind: "conflict", code };
}

function validationIssues(issues: readonly { message: string; path: PropertyKey[] }[]): string[] {
  return issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
}

function commitTransition(
  input: RecoveryTransactionInput,
  update: (tx: Tx) => Promise<RecoveryTransitionResult>,
): Promise<RecoveryTransitionResult> {
  return input.harness.commit(update, input.context);
}

/** Commit the stable installation UUID before a caller computes a recovery manifest. */
export async function initializeRecoveryIndex(input: RecoveryTransactionInput & { readonly installationId?: string }): Promise<RecoveryInitializationResult> {
  const proposed = uuidSchema.safeParse(input.installationId ?? randomUUID());
  if (!proposed.success) return { kind: "invalid_input", issues: ["installationId: expected a UUID"] };
  return await input.harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopRecoveryIndexDoc);
    const current = parseIndex(draft);
    if (current.state === "ready") return { kind: "already_initialized", installationId: current.installationId };
    const next: RecoveryIndexV1 = {
      state: "ready",
      schemaVersion: 1,
      installationId: proposed.data,
      activeRequestId: null,
      occurrenceCounters: {},
      latestOccurrences: {},
      requests: {},
    };
    Object.assign(draft, next);
    return { kind: "initialized", installationId: proposed.data };
  }, input.context);
}

export interface AdmitRecoveryIntentInput extends RecoveryTransactionInput {
  readonly requestId: string;
  readonly manifestDigest: string;
  readonly reason: string;
  readonly confirmedAt: string;
  readonly resumeInstallation: boolean;
  readonly supersedesRequestId?: string | null;
  readonly actions: readonly RecoveryActionIntentV1[];
  readonly committedAt?: string;
}

/** Admit an immutable human-reviewed intent and reserve fresh task occurrences atomically. */
export async function admitRecoveryIntent(input: AdmitRecoveryIntentInput): Promise<RecoveryAdmissionResult> {
  const payload = {
    requestId: input.requestId,
    manifestDigest: input.manifestDigest,
    actorKind: "terminal_operator" as const,
    reason: input.reason,
    confirmedAt: input.confirmedAt,
    resumeInstallation: input.resumeInstallation,
    supersedesRequestId: input.supersedesRequestId ?? null,
    actions: input.actions,
  };
  const base = recoveryIntentPayloadV1Schema.safeParse(payload);
  if (!base.success) return { kind: "invalid_input", issues: validationIssues(base.error.issues) };
  const payloadHash = canonicalHash(base.data);
  const parsedIntent = recoveryIntentV1Schema.safeParse({ ...base.data, payloadHash });
  if (!parsedIntent.success) return { kind: "invalid_input", issues: validationIssues(parsedIntent.error.issues) };
  const committedAt = checkedTimestamp(input.committedAt);

  return await input.harness.commit(async (tx) => {
    const indexDraft = await tx.doc(WorkshopRecoveryIndexDoc);
    const parsedIndex = parseIndex(indexDraft);
    if (parsedIndex.state !== "ready") return { kind: "conflict", code: "index_uninitialized" };
    const index: RecoveryIndexV1 & { readonly state: "ready" } = parsedIndex;
    const priorSummary = index.requests[parsedIntent.data.requestId];
    if (priorSummary !== undefined) {
      if (priorSummary.payloadHash !== parsedIntent.data.payloadHash) return { kind: "conflict", code: "idempotency_conflict" };
      const priorDraft = await tx.doc(WorkshopRecoveryRequestDoc, parsedIntent.data.requestId, parsedIntent.data.requestId);
      const prior = parseRequest(priorDraft);
      return { kind: "replayed", installationId: index.installationId, request: prior };
    }

    let superseded: { readonly draft: RequestDraft; readonly request: RecoveryRequestV1 } | undefined;
    if (index.activeRequestId !== null) {
      if (parsedIntent.data.supersedesRequestId !== index.activeRequestId) {
        return { kind: "conflict", code: "recovery_in_progress" };
      }
      const previousId = index.activeRequestId;
      const priorDraft = await tx.doc(WorkshopRecoveryRequestDoc, previousId, previousId);
      const previous = parseRequest(priorDraft);
      if (previous.state !== "active" || previous.intent === null) throw new RecoveryJournalCorruptError();
      if (Date.parse(parsedIntent.data.confirmedAt) <= Date.parse(previous.intent.confirmedAt)) {
        return { kind: "conflict", code: "supersession_target_not_active" };
      }
      if (parsedIntent.data.actions.length === 0 && !await hasSupersessionJournalEvidence(tx, index, previous)) {
        return { kind: "conflict", code: "settlement_evidence_required" };
      }
      superseded = { draft: priorDraft, request: {
        ...previous,
        state: "superseded",
        closedAt: committedAt,
        closure: { kind: "superseded", closedAt: committedAt, replacementRequestId: parsedIntent.data.requestId },
        supersededBy: parsedIntent.data.requestId,
      } };
    } else if (parsedIntent.data.supersedesRequestId !== null) {
      return { kind: "conflict", code: "supersession_target_not_active" };
    }

    const actions = parsedIntent.data.actions;
    for (const action of actions) {
      const nextOccurrence = (index.occurrenceCounters[String(action.taskId)] ?? 0) + 1;
      if (!Number.isSafeInteger(nextOccurrence)) return { kind: "conflict", code: "occurrence_exhausted" };
    }

    const requestDraft = await tx.doc(WorkshopRecoveryRequestDoc, parsedIntent.data.requestId, parsedIntent.data.requestId);
    const unadmitted = parseRequest(requestDraft);
    if (unadmitted.state !== "unadmitted") throw new RecoveryJournalCorruptError();
    const nextCounters = { ...index.occurrenceCounters };
    const nextLatest = { ...index.latestOccurrences };
    const actionRecords = actions.map((action) => {
      const key = String(action.taskId);
      const occurrence = (nextCounters[key] ?? 0) + 1;
      nextCounters[key] = occurrence;
      nextLatest[key] = { occurrence, requestId: parsedIntent.data.requestId };
      return {
        ...action,
        occurrence,
        actionId: `task-${action.taskId}-occurrence-${occurrence}`,
        state: "authorized" as const,
        deathEvidence: null,
        dispatchMarkedAt: null,
        receipt: null,
        settlement: null,
        refusal: null,
      };
    });
    const request: RecoveryRequestV1 = {
      ...unadmitted,
      state: "active",
      intent: parsedIntent.data,
      actions: actionRecords,
      continuations: [],
      globalDispatch: null,
      restartEvents: [],
      createdAt: committedAt,
      closedAt: null,
      closure: null,
      supersededBy: null,
    };
    const requests = { ...index.requests };
    if (superseded !== undefined) {
      const previousId = index.activeRequestId;
      if (previousId === null) throw new RecoveryJournalCorruptError();
      const oldSummary = requests[previousId];
      if (oldSummary === undefined) throw new RecoveryJournalCorruptError();
      requests[previousId] = { ...oldSummary, state: "superseded" };
    }
    requests[parsedIntent.data.requestId] = {
      payloadHash: parsedIntent.data.payloadHash,
      state: "active",
      createdAt: committedAt,
      taskIds: actions.map((action) => action.taskId),
      supersedesRequestId: parsedIntent.data.supersedesRequestId,
    };
    const nextIndex: RecoveryIndexV1 = {
      ...index,
      activeRequestId: parsedIntent.data.requestId,
      occurrenceCounters: nextCounters,
      latestOccurrences: nextLatest,
      requests,
    };
    if (superseded !== undefined) Object.assign(superseded.draft, superseded.request);
    Object.assign(requestDraft, request);
    Object.assign(indexDraft, nextIndex);
    return { kind: "admitted", installationId: index.installationId, request };
  }, input.context);
}

export interface RecoveryRequestInput extends RecoveryTransactionInput {
  readonly requestId: string;
}

export interface RecordRecoveryDeathEvidenceInput extends RecoveryRequestInput {
  readonly taskId: number;
  readonly evidence: RecoveryDeathEvidenceV1;
}

/** Record exact host death evidence or the separately labeled identity-free operator attestation. */
export async function recordRecoveryDeathEvidence(input: RecordRecoveryDeathEvidenceInput): Promise<RecoveryTransitionResult> {
  const requestId = uuidSchema.safeParse(input.requestId);
  const evidence = recoveryDeathEvidenceV1Schema.safeParse(input.evidence);
  if (!requestId.success || !evidence.success || !Number.isSafeInteger(input.taskId) || input.taskId <= 0) {
    return { kind: "invalid_input", issues: ["requestId, taskId, or evidence is invalid"] };
  }
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, requestId.data);
    if (typeof active === "string") return transitionConflict(active);
    const index = active.request.actions.findIndex((action) => action.taskId === input.taskId);
    if (index < 0) return transitionConflict("action_not_found");
    const action = active.request.actions[index]!;
    const proof = evidence.data;
    if (action.process === null) return transitionConflict("death_proof_mismatch");
    if (action.processEntryHash === undefined || action.processEntryHash !== proof.processEntryHash) {
      return transitionConflict("death_proof_mismatch");
    }
    if (proof.kind === "confirmed_dead") {
      const process = action.process;
      if (process.identity === null || process.launchServiceBootId === null
        || proof.identity.pid !== process.identity.pid
        || proof.identity.pgid !== process.identity.pgid
        || proof.identity.startIdentity !== process.identity.startIdentity
        || proof.identity.serviceBootId !== process.identity.serviceBootId
        || proof.executionId !== process.executionId
        || proof.incarnationId !== process.incarnationId
        || proof.launchServiceBootId !== process.launchServiceBootId
        || proof.inputHash !== action.inputHash
        || proof.checkpointHash !== action.checkpointHash) return transitionConflict("death_proof_mismatch");
    } else {
      if (action.process.identity !== null
        || proof.attestingRequestId !== requestId.data
        || active.request.intent === null
        || proof.manifestDigest !== active.request.intent.manifestDigest) return transitionConflict("death_proof_mismatch");
    }
    if (action.deathEvidence !== null) {
      if (canonicalHash(action.deathEvidence) === canonicalHash(proof)) return { kind: "already_recorded", request: active.request };
      return transitionConflict("death_proof_conflict");
    }
    if (action.state !== "authorized") return transitionConflict("action_not_ready");
    const actions = [...active.request.actions];
    actions[index] = { ...action, state: "death_verified", deathEvidence: proof };
    const request = { ...active.request, actions };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface RecoveryTaskInput extends RecoveryRequestInput {
  readonly taskId: number;
  readonly markedAt?: string;
}

/** Write the at-most-once marker before one Durable task-control call. */
export async function markRecoveryActionDispatching(input: RecoveryTaskInput): Promise<RecoveryTransitionResult> {
  const markedAt = checkedTimestamp(input.markedAt);
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    const index = active.request.actions.findIndex((action) => action.taskId === input.taskId);
    if (index < 0) return transitionConflict("action_not_found");
    const action = active.request.actions[index]!;
    if (action.action === "verify_retired") return transitionConflict("action_not_permitted");
    if (action.state === "dispatching" || action.state === "indeterminate") return transitionConflict("dispatch_uncertain");
    if (action.state === "applied" || action.state === "settled") return { kind: "already_applied", request: active.request };
    if (action.state === "refused") return transitionConflict("action_not_ready");
    if (action.process !== null && action.deathEvidence === null) return transitionConflict("death_proof_required");
    if (action.action === "abort" && active.request.globalDispatch !== null) return transitionConflict("global_dispatch_started");
    if (action.action === "retry" && active.request.globalDispatch?.state !== "applied") return transitionConflict("global_dispatch_required");
    const actions = [...active.request.actions];
    actions[index] = { ...action, state: "dispatching", dispatchMarkedAt: markedAt, receipt: null, settlement: null };
    const request = { ...active.request, actions };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface RecordRecoveryActionReceiptInput extends RecoveryTaskInput {
  readonly method: "abortTask" | "retryTask";
  readonly returnedAt?: string;
  readonly taskSnapshotHash?: string | null;
}

/** Record that a marked abortTask or retryTask call returned. */
export async function recordRecoveryActionReceipt(input: RecordRecoveryActionReceiptInput): Promise<RecoveryTransitionResult> {
  const receipt = recoveryActionReceiptV1Schema.safeParse({
    method: input.method,
    returnedAt: input.returnedAt ?? input.markedAt ?? new Date().toISOString(),
    taskSnapshotHash: input.taskSnapshotHash ?? null,
  });
  if (!receipt.success) return { kind: "invalid_input", issues: validationIssues(receipt.error.issues) };
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    const index = active.request.actions.findIndex((action) => action.taskId === input.taskId);
    if (index < 0) return transitionConflict("action_not_found");
    const action = active.request.actions[index]!;
    const matchingMethod = action.action === "abort" ? "abortTask" : "retryTask";
    if (receipt.data.method !== matchingMethod) return transitionConflict("receipt_mismatch");
    if (action.state === "applied" || action.state === "settled") {
      return action.receipt !== null && canonicalHash(action.receipt) === canonicalHash(receipt.data)
        ? { kind: "already_recorded", request: active.request }
        : transitionConflict("receipt_mismatch");
    }
    if (action.state === "indeterminate") return transitionConflict("dispatch_uncertain");
    if (action.state !== "dispatching") return transitionConflict("action_not_ready");
    if (active.request.globalDispatch?.state === "dispatching" && active.request.globalDispatch.receipt === null) {
      return transitionConflict("global_dispatch_started");
    }
    const actions = [...active.request.actions];
    actions[index] = { ...action, state: "applied", receipt: receipt.data };
    const request = { ...active.request, actions };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface SettleRecoveryActionInput extends RecoveryTaskInput {
  readonly settledAt?: string;
  readonly taskOutcome: unknown;
  readonly processEvidenceHash?: string | null;
}

/** Record a terminal task outcome without changing or repeating the Durable task operation. */
export async function settleRecoveryAction(input: SettleRecoveryActionInput): Promise<RecoveryTransitionResult> {
  const outcome = jsonSchema.safeParse(input.taskOutcome);
  const settledAt = checkedTimestamp(input.settledAt);
  const parsedEvidenceHash = input.processEvidenceHash == null ? null : checkedHash(input.processEvidenceHash);
  if (!outcome.success || (input.processEvidenceHash != null && parsedEvidenceHash === undefined)) {
    return { kind: "invalid_input", issues: ["taskOutcome or processEvidenceHash is invalid"] };
  }
  const evidenceHash = parsedEvidenceHash ?? null;
  const outcomeHash = canonicalHash(outcome.data);
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    const index = active.request.actions.findIndex((action) => action.taskId === input.taskId);
    if (index < 0) return transitionConflict("action_not_found");
    const action = active.request.actions[index]!;
    if (action.state === "settled" && action.settlement !== null) {
      return action.settlement.outcomeHash === outcomeHash && action.settlement.processEvidenceHash === evidenceHash
        ? { kind: "already_recorded", request: active.request }
        : transitionConflict("receipt_mismatch");
    }
    const verificationOnly = action.action === "verify_retired";
    if (verificationOnly ? action.state !== "death_verified" || action.receipt !== null || action.dispatchMarkedAt !== null
      : action.state !== "applied" || action.receipt === null) return transitionConflict("action_not_ready");
    if (action.process === null ? evidenceHash !== null
      : action.deathEvidence === null || evidenceHash !== canonicalHash(action.deathEvidence)) {
      return transitionConflict("death_proof_mismatch");
    }
    const actions = [...active.request.actions];
    actions[index] = {
      ...action,
      state: "settled",
      settlement: { settledAt, taskOutcome: outcome.data, outcomeHash, processEvidenceHash: evidenceHash },
    };
    const request = { ...active.request, actions };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface MarkRecoveryActionIndeterminateInput extends RecoveryTaskInput {
  readonly observedAt?: string;
}

/** Permanently spend a dispatch marker when a call may have applied without a receipt. */
export async function markRecoveryActionIndeterminate(input: MarkRecoveryActionIndeterminateInput): Promise<RecoveryTransitionResult> {
  const observedAt = checkedTimestamp(input.observedAt);
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    const index = active.request.actions.findIndex((action) => action.taskId === input.taskId);
    if (index < 0) return transitionConflict("action_not_found");
    const action = active.request.actions[index]!;
    if (action.state === "indeterminate") return { kind: "already_recorded", request: active.request };
    if (action.state !== "dispatching") return transitionConflict("action_not_ready");
    const actions = [...active.request.actions];
    actions[index] = { ...action, state: "indeterminate", dispatchMarkedAt: action.dispatchMarkedAt ?? observedAt };
    const request = { ...active.request, actions };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface RefuseRecoveryActionInput extends RecoveryTaskInput {
  readonly code: string;
  readonly refusedAt?: string;
}

/** Refuse one action before dispatch while retaining its authorization record. */
export async function refuseRecoveryAction(input: RefuseRecoveryActionInput): Promise<RecoveryTransitionResult> {
  const code = z.string().trim().min(1).max(128).safeParse(input.code);
  const refusedAt = checkedTimestamp(input.refusedAt);
  if (!code.success) return { kind: "invalid_input", issues: ["code: expected a short refusal code"] };
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    const index = active.request.actions.findIndex((action) => action.taskId === input.taskId);
    if (index < 0) return transitionConflict("action_not_found");
    const action = active.request.actions[index]!;
    if (action.state === "refused" && action.refusal?.code === code.data) return { kind: "already_recorded", request: active.request };
    if (action.state !== "authorized" && action.state !== "death_verified") return transitionConflict("action_not_ready");
    const actions = [...active.request.actions];
    actions[index] = { ...action, state: "refused", refusal: { code: code.data, recordedAt: refusedAt } };
    const request = { ...active.request, actions };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface HandleRecoveryRestartInput extends RecoveryRequestInput {
  readonly observedBootId: string;
  readonly observedAt?: string;
}

/** Mark every unfinished control call indeterminate after an owner restart. */
export async function handleRecoveryRestart(input: HandleRecoveryRestartInput): Promise<RecoveryTransitionResult> {
  const bootId = uuidSchema.safeParse(input.observedBootId);
  const observedAt = checkedTimestamp(input.observedAt);
  if (!bootId.success) return { kind: "invalid_input", issues: ["observedBootId: expected a UUID"] };
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    if (active.request.restartEvents.some((event) => event.observedBootId === bootId.data)) {
      return { kind: "already_recorded", request: active.request };
    }
    const actions = active.request.actions.map((action) => action.state === "dispatching"
      ? { ...action, state: "indeterminate" as const }
      : action);
    const globalDispatch = active.request.globalDispatch?.state === "dispatching"
      ? { ...active.request.globalDispatch, state: "indeterminate" as const, receipt: null }
      : active.request.globalDispatch;
    const request = {
      ...active.request,
      actions,
      globalDispatch,
      restartEvents: [...active.request.restartEvents, { observedBootId: bootId.data, observedAt }],
    };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface RecordRecoveryContinuationConsentInput extends RecoveryRequestInput {
  readonly manifestDigest: string;
  readonly confirmedAt: string;
  readonly resumeInstallation: boolean;
  readonly reason: string;
}

/** Record fresh human consent before continuing a request that has not begun global dispatch. */
export async function recordRecoveryContinuationConsent(input: RecordRecoveryContinuationConsentInput): Promise<RecoveryTransitionResult> {
  const consent = recoveryContinuationConsentV1Schema.safeParse({
    manifestDigest: input.manifestDigest,
    confirmedAt: input.confirmedAt,
    resumeInstallation: input.resumeInstallation,
    reason: input.reason,
  });
  if (!consent.success) return { kind: "invalid_input", issues: validationIssues(consent.error.issues) };
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    if (active.request.globalDispatch !== null) return transitionConflict("fresh_review_required");
    const prior = active.request.continuations.at(-1);
    const lastConfirmedAt = prior?.confirmedAt ?? active.request.intent?.confirmedAt;
    if (lastConfirmedAt !== undefined && Date.parse(consent.data.confirmedAt) <= Date.parse(lastConfirmedAt)) {
      return transitionConflict("fresh_review_required");
    }
    if (active.request.continuations.some((item) => item.manifestDigest === consent.data.manifestDigest && item.confirmedAt === consent.data.confirmedAt)) {
      return { kind: "already_recorded", request: active.request };
    }
    const request = { ...active.request, continuations: [...active.request.continuations, consent.data] };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface MarkRecoveryGlobalDispatchInput extends RecoveryRequestInput {
  readonly firstRetryTaskId?: number | null;
  readonly markedAt?: string;
}

/** Commit the sole global scheduling marker before the first retryTask() or resume() call. */
export async function markRecoveryGlobalDispatching(input: MarkRecoveryGlobalDispatchInput): Promise<RecoveryTransitionResult> {
  const markedAt = checkedTimestamp(input.markedAt);
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    if (active.request.globalDispatch !== null) {
      return active.request.globalDispatch.state === "applied"
        ? { kind: "already_applied", request: active.request }
        : transitionConflict("dispatch_uncertain");
    }
    const consent = active.request.continuations.at(-1);
    const resumeInstallation = consent?.resumeInstallation ?? active.request.intent?.resumeInstallation ?? false;
    if (!resumeInstallation) return transitionConflict("continuation_required");
    if (active.request.intent === null) throw new RecoveryJournalCorruptError();

    let firstRetry = input.firstRetryTaskId == null
      ? active.request.actions.find((action) => action.action === "retry")
      : active.request.actions.find((action) => action.taskId === input.firstRetryTaskId && action.action === "retry");
    if (input.firstRetryTaskId != null && firstRetry === undefined) return transitionConflict("action_not_found");
    for (const action of active.request.actions) {
      if (action.state === "dispatching" || action.state === "indeterminate") return transitionConflict("dispatch_uncertain");
      if (action.process !== null) {
        if (action.deathEvidence === null) return transitionConflict("death_proof_required");
        if (action.process.identity === null && action.deathEvidence.kind !== "operator_attested_absent") return transitionConflict("death_proof_mismatch");
        if (action.process.identity !== null && action.deathEvidence.kind !== "confirmed_dead") return transitionConflict("death_proof_mismatch");
      }
      if (action.action === "abort" && action.state !== "applied" && action.state !== "settled") {
        return transitionConflict("global_dispatch_not_ready");
      }
      if (action.action === "verify_retired" && action.state !== "settled") {
        return transitionConflict("global_dispatch_not_ready");
      }
      if (action.action === "retry" && (action.replaySafety !== "safe" || action.process !== null
        || (action.state !== "authorized" && action.state !== "death_verified"))) {
        return transitionConflict("action_not_permitted");
      }
    }
    const actions = [...active.request.actions];
    if (firstRetry !== undefined) {
      const index = actions.findIndex((action) => action.taskId === firstRetry!.taskId);
      firstRetry = actions[index];
      if (firstRetry === undefined || (firstRetry.state !== "authorized" && firstRetry.state !== "death_verified")) {
        return transitionConflict("action_not_ready");
      }
      actions[index] = { ...firstRetry, state: "dispatching", dispatchMarkedAt: markedAt, receipt: null, settlement: null };
    }
    const request: RecoveryRequestV1 = {
      ...active.request,
      actions,
      globalDispatch: { state: "dispatching", markedAt, receipt: null },
    };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export interface RecordRecoveryGlobalDispatchReceiptInput extends RecoveryRequestInput {
  readonly method: "resume" | "retryTask";
  readonly taskId?: number | null;
  readonly returnedAt?: string;
  readonly taskSnapshotHash?: string | null;
}

/** Store the returned global resume or first retry receipt and, when present, the retry action receipt atomically. */
export async function recordRecoveryGlobalDispatchReceipt(input: RecordRecoveryGlobalDispatchReceiptInput): Promise<RecoveryTransitionResult> {
  const receipt = recoveryGlobalDispatchReceiptV1Schema.safeParse({
    method: input.method,
    taskId: input.taskId ?? null,
    returnedAt: input.returnedAt ?? new Date().toISOString(),
    taskSnapshotHash: input.taskSnapshotHash ?? null,
  });
  if (!receipt.success) return { kind: "invalid_input", issues: validationIssues(receipt.error.issues) };
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    const dispatch = active.request.globalDispatch;
    if (dispatch?.state === "applied" && dispatch.receipt !== null) {
      return canonicalHash(dispatch.receipt) === canonicalHash(receipt.data)
        ? { kind: "already_recorded", request: active.request }
        : transitionConflict("receipt_mismatch");
    }
    if (dispatch?.state !== "dispatching") return transitionConflict("global_dispatch_not_ready");
    const firstRetry = active.request.actions.find((action) => action.state === "dispatching");
    if (firstRetry === undefined) {
      if (receipt.data.method !== "resume") return transitionConflict("receipt_mismatch");
    } else if (receipt.data.method !== "retryTask" || receipt.data.taskId !== firstRetry.taskId || firstRetry.action !== "retry") {
      return transitionConflict("receipt_mismatch");
    }
    const actions = [...active.request.actions];
    if (firstRetry !== undefined) {
      const index = actions.findIndex((action) => action.taskId === firstRetry.taskId);
      const actionReceipt = recoveryActionReceiptV1Schema.parse({
        method: "retryTask",
        returnedAt: receipt.data.returnedAt,
        taskSnapshotHash: receipt.data.taskSnapshotHash,
      });
      actions[index] = { ...firstRetry, state: "applied", receipt: actionReceipt };
    }
    const request: RecoveryRequestV1 = {
      ...active.request,
      actions,
      globalDispatch: { state: "applied", markedAt: dispatch.markedAt, receipt: receipt.data },
    };
    Object.assign(active.requestDraft, request);
    return { kind: "updated", request };
  });
}

export type ClearActiveRecoveryRequestInput = RecoveryRequestInput & (
  | { readonly mode: "readiness_verified"; readonly manifestDigest: string; readonly checkedAt: string }
  | { readonly mode: "refused"; readonly manifestDigest: string; readonly refusedAt: string; readonly reasonCode: string }
);

/** Clear only the active reservation; preserve the request, every occurrence, and all control evidence. */
export async function clearActiveRecoveryRequest(input: ClearActiveRecoveryRequestInput): Promise<RecoveryTransitionResult> {
  const mode = input.mode;
  const manifestDigest = checkedHash(input.manifestDigest);
  const at = checkedTimestamp(mode === "readiness_verified" ? input.checkedAt : input.refusedAt);
  const reasonCode = mode === "refused" ? z.string().trim().min(1).max(128).safeParse(input.reasonCode) : undefined;
  if (manifestDigest === undefined || (reasonCode !== undefined && !reasonCode.success)) {
    return { kind: "invalid_input", issues: ["manifestDigest or reasonCode is invalid"] };
  }
  return await commitTransition(input, async (tx) => {
    const active = await readActiveRequest(tx, input.requestId);
    if (typeof active === "string") return transitionConflict(active);
    let request: RecoveryRequestV1;
    let state: "complete" | "refused";
    if (mode === "readiness_verified") {
      const ready = active.request.globalDispatch?.state === "applied"
        && active.request.actions.every((action) => action.state === "settled"
          || (action.action === "retry" && action.state === "applied"));
      if (!ready) return transitionConflict("request_not_clearable");
      state = "complete";
      request = {
        ...active.request,
        state,
        closedAt: at,
        closure: { kind: "readiness_verified", manifestDigest, checkedAt: at },
        supersededBy: null,
      };
    } else {
      state = "refused";
      const actions = active.request.actions.map((action) => {
        if (action.state === "dispatching") return { ...action, state: "indeterminate" as const };
        if (action.state === "authorized" || action.state === "death_verified") {
          return {
            ...action,
            state: "refused" as const,
            refusal: { code: reasonCode!.data, recordedAt: at },
          };
        }
        return action;
      });
      const globalDispatch = active.request.globalDispatch?.state === "dispatching"
        ? { ...active.request.globalDispatch, state: "indeterminate" as const, receipt: null }
        : active.request.globalDispatch;
      request = {
        ...active.request,
        state,
        actions,
        globalDispatch,
        closedAt: at,
        closure: { kind: "refused", manifestDigest, refusedAt: at, reasonCode: reasonCode!.data },
        supersededBy: null,
      };
    }
    const summary = active.index.requests[input.requestId];
    if (summary === undefined) throw new RecoveryJournalCorruptError();
    const nextIndex: RecoveryIndexV1 = {
      ...active.index,
      activeRequestId: null,
      requests: { ...active.index.requests, [input.requestId]: { ...summary, state } },
    };
    Object.assign(active.requestDraft, request);
    Object.assign(active.indexDraft, nextIndex);
    return { kind: "updated", request };
  });
}

export function hasSupersessionActionEvidence(request: RecoveryRequestV1): boolean {
  if (request.intent === null || request.actions.length === 0) return false;
  return request.actions.every((action, index) => {
    const intentAction = request.intent!.actions[index];
    if (intentAction === undefined) return false;
    const { occurrence: _occurrence, actionId: _actionId, state: _state, deathEvidence: _deathEvidence,
      dispatchMarkedAt: _dispatchMarkedAt, receipt: _receipt, settlement: _settlement, refusal: _refusal, ...binding } = action;
    if (canonicalHash(binding) !== canonicalHash(intentAction)) return false;
    const expectedEvidenceHash = action.process === null
      ? null
      : action.deathEvidence === null ? undefined : canonicalHash(action.deathEvidence);
    if (action.action === "verify_retired") {
      return action.state === "settled" && action.receipt === null && action.dispatchMarkedAt === null
        && action.process !== null && action.processEntryHash !== undefined
        && action.deathEvidence !== null && action.processEntryHash === action.deathEvidence.processEntryHash
        && recoveryDeathEvidenceMatchesAction(request, action)
        && action.settlement !== null && action.settlement.processEvidenceHash === expectedEvidenceHash;
    }
    const controlApplied = (action.state === "applied" || action.state === "settled")
      && action.dispatchMarkedAt !== null
      && action.receipt?.method === (action.action === "abort" ? "abortTask" : "retryTask");
    const controlIndeterminate = action.state === "indeterminate"
      && action.dispatchMarkedAt !== null && action.receipt === null && action.settlement === null;
    const deathEvidenceMatches = action.process === null
      ? action.deathEvidence === null
      : action.deathEvidence !== null && action.processEntryHash !== undefined
        && action.processEntryHash === action.deathEvidence.processEntryHash
        && recoveryDeathEvidenceMatchesAction(request, action);
    const settlementMatchesEvidence = action.settlement === null
      ? action.state !== "settled"
      : action.state === "settled" && action.settlement.processEvidenceHash === expectedEvidenceHash;
    return (controlApplied || controlIndeterminate) && deathEvidenceMatches && settlementMatchesEvidence;
  });
}

function recoveryDeathEvidenceMatchesAction(request: RecoveryRequestV1, action: RecoveryRequestV1["actions"][number]): boolean {
  const process = action.process;
  const evidence = action.deathEvidence;
  if (process === null || evidence === null || request.intent === null) return false;
  if (evidence.kind === "confirmed_dead") {
    return process.identity !== null && evidence.executionId === process.executionId
      && evidence.incarnationId === process.incarnationId
      && evidence.launchServiceBootId === process.launchServiceBootId
      && evidence.inputHash === action.inputHash && evidence.checkpointHash === action.checkpointHash
      && evidence.processEntryHash === action.processEntryHash
      && canonicalHash(evidence.identity) === canonicalHash(process.identity);
  }
  return process.identity === null && evidence.attestingRequestId === request.requestId
    && evidence.manifestDigest === request.intent.manifestDigest
    && evidence.processEntryHash === action.processEntryHash
    && evidence.evidenceHash === canonicalHash({
      confirmationLine: `recover ${request.requestId} ${request.intent.manifestDigest} resume-installation`,
      taskId: action.taskId, executionId: process.executionId, incarnationId: process.incarnationId,
      inputHash: action.inputHash, checkpointHash: action.checkpointHash, processEntryHash: action.processEntryHash,
    });
}

async function hasSupersessionJournalEvidence(
  tx: Tx,
  index: RecoveryIndexV1 & { readonly state: "ready" },
  active: RecoveryRequestV1,
): Promise<boolean> {
  let request = active;
  const seen = new Set([request.requestId]);
  for (let depth = 0; depth < Object.keys(index.requests).length; depth += 1) {
    if (!matchesRecoveryIndexRequest(index, request)) return false;
    if (request.actions.length > 0) return hasSupersessionActionEvidence(request);
    const priorId = request.intent?.supersedesRequestId;
    if (priorId === null || priorId === undefined || seen.has(priorId)) return false;
    const summary = index.requests[priorId];
    if (summary === undefined || summary.state !== "superseded") return false;
    const prior = parseRequest(await tx.doc(WorkshopRecoveryRequestDoc, priorId, priorId));
    if (prior.requestId !== priorId || prior.state !== "superseded" || prior.supersededBy !== request.requestId
      || prior.closure?.kind !== "superseded" || prior.closure.replacementRequestId !== request.requestId
      || !matchesRecoveryIndexRequest(index, prior)) return false;
    seen.add(priorId);
    request = prior;
  }
  return false;
}

function matchesRecoveryIndexRequest(
  index: RecoveryIndexV1 & { readonly state: "ready" },
  request: RecoveryRequestV1,
): boolean {
  const summary = index.requests[request.requestId];
  const intent = request.intent;
  return summary !== undefined && intent !== null && summary.state === request.state
    && summary.payloadHash === intent.payloadHash && summary.createdAt === request.createdAt
    && summary.supersedesRequestId === intent.supersedesRequestId
    && summary.taskIds.length === request.actions.length
    && summary.taskIds.every((taskId, position) => taskId === request.actions[position]?.taskId);
}
