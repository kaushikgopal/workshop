import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import { sha256Schema } from "../../util/schema.js";

const uuidSchema = z.string().uuid();
const safePositiveIntegerSchema = z.number().int().positive().safe();
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const isoTimestampSchema = z.iso.datetime({ offset: true });
const taskIdKeySchema = z.string().regex(/^[1-9][0-9]*$/);

export const recoveryProcessIdentityV1Schema = z.object({
  pid: safePositiveIntegerSchema,
  pgid: safePositiveIntegerSchema,
  startIdentity: z.string().min(1),
  serviceBootId: uuidSchema,
}).strict();

export const recoveryOwnerIdentityV1Schema = z.object({
  conversationId: safePositiveIntegerSchema,
  taskOwnerId: safePositiveIntegerSchema.nullable(),
  conversationOwner: z.object({
    conversationId: safePositiveIntegerSchema,
    taskId: safePositiveIntegerSchema,
  }).strict().nullable(),
  ownershipHash: sha256Schema,
}).strict();

export const recoveryProcessIncarnationV1Schema = z.object({
  executionId: z.string().min(1),
  incarnationId: z.string().min(1),
  launchServiceBootId: uuidSchema.nullable(),
  identity: recoveryProcessIdentityV1Schema.nullable(),
}).strict();

export const recoveryActionIntentV1Schema = z.object({
  taskId: safePositiveIntegerSchema,
  taskKind: z.string().min(1),
  taskVersion: safePositiveIntegerSchema,
  action: z.enum(["abort", "retry", "verify_retired"]),
  owner: recoveryOwnerIdentityV1Schema,
  inputHash: sha256Schema,
  checkpointHash: sha256Schema,
  process: recoveryProcessIncarnationV1Schema.nullable(),
  processEntryHash: sha256Schema.optional(),
  replaySafety: z.enum(["safe", "unsafe", "unknown"]),
}).strict().superRefine((action, context) => {
  if (action.process !== null && action.processEntryHash === undefined) {
    context.addIssue({ code: "custom", path: ["processEntryHash"], message: "Process actions require an exact retained process-entry hash" });
  }
  if (action.action === "retry" && (action.replaySafety !== "safe" || action.process !== null)) {
    context.addIssue({ code: "custom", message: "Retry requires a replay-safe task without an unresolved process incarnation" });
  }
  if (action.action === "verify_retired"
    && (action.taskKind !== "workshop.process-execution" || action.process === null || action.processEntryHash === undefined)) {
    context.addIssue({ code: "custom", message: "Retired-process verification requires exact terminal process evidence" });
  }
});

export const recoveryIntentPayloadV1Schema = z.object({
  requestId: uuidSchema,
  manifestDigest: sha256Schema,
  actorKind: z.literal("terminal_operator"),
  reason: z.string().trim().min(1).max(4096),
  confirmedAt: isoTimestampSchema,
  resumeInstallation: z.boolean(),
  supersedesRequestId: uuidSchema.nullable(),
  actions: z.array(recoveryActionIntentV1Schema),
}).strict().superRefine((intent, context) => {
  if (intent.actions.length === 0 && intent.supersedesRequestId === null) {
    context.addIssue({ code: "custom", path: ["actions"], message: "Empty action lists require a linked superseding request" });
  }
});

export const recoveryIntentV1Schema = recoveryIntentPayloadV1Schema.extend({
  payloadHash: sha256Schema,
}).superRefine((intent, context) => {
  const seen = new Set<number>();
  intent.actions.forEach((action, index) => {
    if (seen.has(action.taskId)) {
      context.addIssue({ code: "custom", path: ["actions", index, "taskId"], message: "A task can appear only once in an intent" });
    }
    seen.add(action.taskId);
  });
  if (intent.supersedesRequestId === intent.requestId) {
    context.addIssue({ code: "custom", path: ["supersedesRequestId"], message: "A request cannot supersede itself" });
  }
});

export const recoveryDeathEvidenceV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confirmed_dead"),
    method: z.enum(["process_group_retired", "process_group_absent"]),
    hostBootId: uuidSchema,
    observedAt: isoTimestampSchema,
    identity: recoveryProcessIdentityV1Schema,
    executionId: z.string().min(1),
    incarnationId: z.string().min(1),
    launchServiceBootId: uuidSchema,
    inputHash: sha256Schema,
    checkpointHash: sha256Schema,
    processEntryHash: sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal("operator_attested_absent"),
    method: z.literal("typed_terminal_confirmation"),
    attestingRequestId: uuidSchema,
    attestedAt: isoTimestampSchema,
    manifestDigest: sha256Schema,
    processEntryHash: sha256Schema.optional(),
    evidenceHash: sha256Schema,
  }).strict(),
]);

export const recoveryActionReceiptV1Schema = z.object({
  method: z.enum(["abortTask", "retryTask"]),
  returnedAt: isoTimestampSchema,
  taskSnapshotHash: sha256Schema.nullable(),
}).strict();

export const recoveryActionSettlementV1Schema = z.object({
  settledAt: isoTimestampSchema,
  taskOutcome: z.json() as z.ZodType<JsonValue>,
  outcomeHash: sha256Schema,
  processEvidenceHash: sha256Schema.nullable(),
}).strict();

export const recoveryContinuationConsentV1Schema = z.object({
  manifestDigest: sha256Schema,
  confirmedAt: isoTimestampSchema,
  resumeInstallation: z.boolean(),
  reason: z.string().trim().min(1).max(4096),
}).strict();

export const recoveryGlobalDispatchReceiptV1Schema = z.object({
  method: z.enum(["resume", "retryTask"]),
  taskId: safePositiveIntegerSchema.nullable(),
  returnedAt: isoTimestampSchema,
  taskSnapshotHash: sha256Schema.nullable(),
}).strict().superRefine((receipt, context) => {
  if ((receipt.method === "retryTask") !== (receipt.taskId !== null)) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "retryTask requires a task ID; resume does not" });
  }
});

export const recoveryActionRecordV1Schema = recoveryActionIntentV1Schema.extend({
  occurrence: safePositiveIntegerSchema,
  actionId: z.string().min(1),
  state: z.enum(["authorized", "death_verified", "dispatching", "applied", "settled", "refused", "indeterminate"]),
  deathEvidence: recoveryDeathEvidenceV1Schema.nullable(),
  dispatchMarkedAt: isoTimestampSchema.nullable(),
  receipt: recoveryActionReceiptV1Schema.nullable(),
  settlement: recoveryActionSettlementV1Schema.nullable(),
  refusal: z.object({ code: z.string().min(1), recordedAt: isoTimestampSchema }).strict().nullable(),
}).strict().superRefine((action, context) => {
  const verificationOnly = action.action === "verify_retired";
  if (verificationOnly && (action.dispatchMarkedAt !== null || action.receipt !== null
    || ["dispatching", "applied", "indeterminate"].includes(action.state))) {
    context.addIssue({ code: "custom", message: "Retired-process verification has no Durable control dispatch" });
  }
  if (action.state === "death_verified" && action.deathEvidence === null) {
    context.addIssue({ code: "custom", path: ["deathEvidence"], message: "death_verified requires recorded evidence" });
  }
  if (action.deathEvidence !== null && action.process === null) {
    context.addIssue({ code: "custom", path: ["deathEvidence"], message: "Death evidence requires a process incarnation" });
  }
  if (!verificationOnly && ["dispatching", "applied", "settled", "indeterminate"].includes(action.state) && action.dispatchMarkedAt === null) {
    context.addIssue({ code: "custom", path: ["dispatchMarkedAt"], message: "Dispatched actions require a write-ahead marker" });
  }
  if (!verificationOnly && ["applied", "settled"].includes(action.state) && action.receipt === null) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Applied actions require a returned API receipt" });
  }
  if (action.state === "settled" && action.settlement === null) {
    context.addIssue({ code: "custom", path: ["settlement"], message: "Settled actions require a terminal outcome" });
  }
  if (action.state === "refused" && action.refusal === null) {
    context.addIssue({ code: "custom", path: ["refusal"], message: "Refused actions require a reason code" });
  }
  if (action.state !== "refused" && action.refusal !== null) {
    context.addIssue({ code: "custom", path: ["refusal"], message: "Only refused actions carry a refusal reason" });
  }
});

export const recoveryGlobalDispatchV1Schema = z.object({
  state: z.enum(["dispatching", "applied", "indeterminate"]),
  markedAt: isoTimestampSchema,
  receipt: recoveryGlobalDispatchReceiptV1Schema.nullable(),
}).strict().superRefine((dispatch, context) => {
  if (dispatch.state === "applied" && dispatch.receipt === null) {
    context.addIssue({ code: "custom", message: "Applied global dispatch requires a returned API receipt" });
  }
  if (dispatch.state !== "applied" && dispatch.receipt !== null) {
    context.addIssue({ code: "custom", message: "Only applied global dispatch carries a returned API receipt" });
  }
});

export const recoveryRestartEventV1Schema = z.object({
  observedBootId: uuidSchema,
  observedAt: isoTimestampSchema,
}).strict();

export const recoveryRequestV1Schema = z.object({
  requestId: uuidSchema,
  state: z.enum(["unadmitted", "active", "complete", "refused", "superseded"]),
  intent: recoveryIntentV1Schema.nullable(),
  actions: z.array(recoveryActionRecordV1Schema),
  continuations: z.array(recoveryContinuationConsentV1Schema),
  globalDispatch: recoveryGlobalDispatchV1Schema.nullable(),
  restartEvents: z.array(recoveryRestartEventV1Schema),
  createdAt: isoTimestampSchema.nullable(),
  closedAt: isoTimestampSchema.nullable(),
  closure: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("readiness_verified"), manifestDigest: sha256Schema, checkedAt: isoTimestampSchema }).strict(),
    z.object({ kind: z.literal("refused"), manifestDigest: sha256Schema, refusedAt: isoTimestampSchema, reasonCode: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("superseded"), closedAt: isoTimestampSchema, replacementRequestId: uuidSchema }).strict(),
  ]).nullable(),
  supersededBy: uuidSchema.nullable(),
}).strict().superRefine((request, context) => {
  if (request.intent !== null && request.intent.requestId !== request.requestId) {
    context.addIssue({ code: "custom", path: ["intent", "requestId"], message: "Intent request ID must match its record" });
  }
  if (request.state === "unadmitted") {
    if (request.intent !== null || request.actions.length !== 0 || request.createdAt !== null || request.closedAt !== null || request.closure !== null) {
      context.addIssue({ code: "custom", message: "Unadmitted records cannot contain intent or action state" });
    }
    return;
  }
  if (request.intent === null || request.createdAt === null) {
    context.addIssue({ code: "custom", message: "Admitted records require an intent and creation time" });
  }
  if (request.state === "active" && (request.closedAt !== null || request.closure !== null || request.supersededBy !== null)) {
    context.addIssue({ code: "custom", message: "Active records cannot have closure fields" });
  }
  if (request.state !== "active" && (request.closedAt === null || request.closure === null)) {
    context.addIssue({ code: "custom", message: "Closed records require closure metadata" });
  }
  if (request.state === "superseded" && (request.supersededBy === null || request.closure?.kind !== "superseded" || request.closure.replacementRequestId !== request.supersededBy)) {
    context.addIssue({ code: "custom", message: "Superseded records require matching replacement metadata" });
  }
  if (request.state === "complete" && request.closure?.kind !== "readiness_verified") {
    context.addIssue({ code: "custom", message: "Completed records require verified readiness metadata" });
  }
  if (request.state === "refused" && request.closure?.kind !== "refused") {
    context.addIssue({ code: "custom", message: "Refused records require an explicit refusal reason" });
  }
  if (request.state !== "superseded" && request.supersededBy !== null) {
    context.addIssue({ code: "custom", path: ["supersededBy"], message: "Only superseded records name a replacement" });
  }
  if (request.intent !== null && request.actions.length !== request.intent.actions.length) {
    context.addIssue({ code: "custom", message: "Action state must preserve the ordered intent action list" });
  }
});

export const recoveryRequestIndexEntryV1Schema = z.object({
  payloadHash: sha256Schema,
  state: z.enum(["active", "complete", "refused", "superseded"]),
  createdAt: isoTimestampSchema,
  taskIds: z.array(safePositiveIntegerSchema),
  supersedesRequestId: uuidSchema.nullable(),
}).strict();

export const recoveryLatestOccurrenceV1Schema = z.object({
  occurrence: safePositiveIntegerSchema,
  requestId: uuidSchema,
}).strict();

export const recoveryIndexV1Schema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("uninitialized") }).strict(),
  z.object({
    state: z.literal("ready"),
    schemaVersion: z.literal(1),
    installationId: uuidSchema,
    activeRequestId: uuidSchema.nullable(),
    occurrenceCounters: z.record(taskIdKeySchema, safeNonnegativeIntegerSchema),
    latestOccurrences: z.record(taskIdKeySchema, recoveryLatestOccurrenceV1Schema),
    requests: z.record(uuidSchema, recoveryRequestIndexEntryV1Schema),
  }).strict().superRefine((index, context) => {
    if (index.activeRequestId !== null && index.requests[index.activeRequestId]?.state !== "active") {
      context.addIssue({ code: "custom", path: ["activeRequestId"], message: "Active request pointer must name an active request" });
    }
    for (const [taskId, latest] of Object.entries(index.latestOccurrences)) {
      if ((index.occurrenceCounters[taskId] ?? 0) < latest.occurrence || index.requests[latest.requestId] === undefined) {
        context.addIssue({ code: "custom", path: ["latestOccurrences", taskId], message: "Latest occurrence must be covered by its counter and request index" });
      }
    }
    for (const [requestId, request] of Object.entries(index.requests)) {
      if (request.state === "active" && index.activeRequestId !== requestId) {
        context.addIssue({ code: "custom", path: ["requests", requestId], message: "Only the active request can hold an active reservation" });
      }
    }
  }),
]);

export type RecoveryProcessIdentityV1 = z.infer<typeof recoveryProcessIdentityV1Schema>;
export type RecoveryOwnerIdentityV1 = z.infer<typeof recoveryOwnerIdentityV1Schema>;
export type RecoveryProcessIncarnationV1 = z.infer<typeof recoveryProcessIncarnationV1Schema>;
export type RecoveryActionIntentV1 = z.infer<typeof recoveryActionIntentV1Schema>;
export type RecoveryIntentV1 = z.infer<typeof recoveryIntentV1Schema>;
export type RecoveryDeathEvidenceV1 = z.infer<typeof recoveryDeathEvidenceV1Schema>;
export type RecoveryActionRecordV1 = z.infer<typeof recoveryActionRecordV1Schema>;
export type RecoveryRequestV1 = z.infer<typeof recoveryRequestV1Schema>;
export type RecoveryIndexV1 = z.infer<typeof recoveryIndexV1Schema>;
