import { z } from "zod";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import { recoveryProcessIncarnationV1Schema } from "../storage/durable/schema-recovery.js";

export const MAX_SERVICE_RECOVERY_TASKS_V1 = 256;
export const MAX_SERVICE_RECOVERY_SUBMISSIONS_V1 = 256;
export const MAX_SERVICE_RECOVERY_SCHEDULES_V1 = 256;
export const MAX_SERVICE_RECOVERY_PROCESS_INCARNATIONS_V1 = 256;

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const taskIdSchema = z.number().int().positive().safe();
const attributionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scheduler"), workflowId: z.string().min(1), activationId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("workflow_run"), workflowId: z.string().min(1), runId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("bot") }),
  z.strictObject({ kind: z.literal("unknown") }),
]);

const taskPolicyV1Schema = z.strictObject({
  permittedActions: z.array(z.enum(["abort", "retry"])).max(2),
  retryEligibility: z.enum(["safe", "unsafe", "unknown", "not_applicable"]),
  retryUnavailableReason: z.enum([
    "not_restart_limited",
    "task_kind_not_allowlisted",
    "definition_version_not_allowlisted",
    "replay_safety_unverified",
    "retry_task_resumes_unrelated_work",
    "inspection_incomplete",
  ]).nullable(),
  abortEvidence: z.enum(["none", "launch_not_started", "host_death_proof_required", "operator_attestation_required"]).nullable(),
  abortUnavailableReason: z.enum([
    "unknown_ownership",
    "owned_work_live",
    "pending_submission",
    "task_execution_live",
    "task_already_completing",
    "inspection_incomplete",
    "unsupported_process_checkpoint",
    "process_death_unverified",
  ]).nullable(),
  ownedDescendantCount: z.number().int().nonnegative().safe(),
  pendingSubmissionCount: z.number().int().nonnegative().safe(),
}).strict();

const processEvidenceV1Schema = z.strictObject({
  checkpointPhase: z.enum(["intent", "launch", "monitor", "unknown"]),
  identityKnown: z.boolean(),
  processStatus: z.enum(["prepared", "launching", "running", "reconciling", "exited", "blocked"]).nullable(),
  launchBootIdPresent: z.boolean(),
});

const taskV1Schema = z.strictObject({
  taskId: taskIdSchema,
  kind: z.string().min(1).max(256),
  version: taskIdSchema,
  state: z.enum(["running", "ready", "waiting", "sleeping", "completing", "blocked"]),
  blockedReason: z.enum(["missing_task", "task_too_old", "migration_failed", "restart_limit"]).nullable(),
  ownerTaskId: taskIdSchema.nullable(),
  conversationId: taskIdSchema,
  attribution: attributionV1Schema,
  ownershipVerified: z.boolean(),
  inputHash: sha256Schema,
  checkpointHash: sha256Schema.nullable(),
  processEvidence: processEvidenceV1Schema.nullable(),
  policy: taskPolicyV1Schema,
}).strict();

const processIncarnationV1Schema = z.strictObject({
  taskId: taskIdSchema,
  taskKind: z.literal("workshop.process-execution"),
  taskVersion: taskIdSchema,
  conversationId: taskIdSchema,
  runId: z.string().min(1),
  action: z.enum(["abort", "verify_retired"]),
  inputHash: sha256Schema,
  checkpointHash: sha256Schema,
  processEntryHash: sha256Schema,
  process: recoveryProcessIncarnationV1Schema,
  processStatus: z.enum(["prepared", "launching", "running", "reconciling", "exited", "blocked"]),
  cleanupState: z.enum(["not_started", "pending", "confirmed_dead", "operator_attested_absent", "unconfirmed"]),
}).strict();

const payloadV1Schema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  complete: z.boolean(),
  limitations: z.array(z.enum([
    "scheduling_not_paused",
    "task_inspection_unavailable",
    "task_graph_unavailable",
    "task_graph_disagreement",
    "attribution_incomplete",
    "task_limit_exceeded",
    "installation_state_unavailable",
    "recovery_index_unavailable",
    "recovery_request_active_unavailable",
    "schedule_limit_exceeded",
    "submission_limit_exceeded",
    "process_evidence_unavailable",
    "process_incarnation_limit_exceeded",
  ])).max(13),
  scheduling: z.enum(["paused", "running", "closing", "unavailable"]),
  stateDirectoryHash: sha256Schema,
  installationId: z.string().uuid().nullable(),
  recoveryInstallationId: z.string().uuid().nullable(),
  recoveryIndexState: z.enum(["uninitialized", "ready", "unavailable"]),
  taskCount: z.number().int().nonnegative().safe(),
  omittedTaskCount: z.number().int().nonnegative().safe(),
  attributionComplete: z.boolean(),
  tasks: z.array(taskV1Schema).max(MAX_SERVICE_RECOVERY_TASKS_V1),
  processIncarnations: z.array(processIncarnationV1Schema).max(MAX_SERVICE_RECOVERY_PROCESS_INCARNATIONS_V1),
  queuedSubmissions: z.array(z.strictObject({
    submissionId: taskIdSchema,
    conversationId: taskIdSchema,
    state: z.enum(["queued", "placed"]),
  })).max(MAX_SERVICE_RECOVERY_SUBMISSIONS_V1),
  omittedSubmissionCount: z.number().int().nonnegative().safe(),
  schedules: z.array(z.strictObject({
    workflowId: z.string().min(1),
    activationId: z.string().min(1),
    state: z.enum(["active", "paused", "stopped", "exhausted"]),
    nextDueAt: z.iso.datetime().nullable(),
    schedulerTaskId: taskIdSchema.nullable(),
  })).max(MAX_SERVICE_RECOVERY_SCHEDULES_V1),
  omittedScheduleCount: z.number().int().nonnegative().safe(),
  activeRequest: z.strictObject({
    requestId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    actionCount: z.number().int().nonnegative().safe(),
    globalDispatch: z.enum(["not_started", "dispatching", "applied", "indeterminate"]).nullable(),
  }).nullable(),
  retryControl: z.literal("retryTask_may_resume_unrelated_work"),
}).strict();

export const serviceRecoveryManifestV1Schema = payloadV1Schema.extend({
  digest: sha256Schema,
}).strict().superRefine((manifest, context) => {
  const { digest, ...payload } = manifest;
  if (serviceRecoveryManifestDigestV1(payload) !== digest) {
    context.addIssue({ code: "custom", path: ["digest"], message: "manifest digest does not match its canonical payload" });
  }
});

export type ServiceRecoveryManifestPayloadV1 = z.infer<typeof payloadV1Schema>;
export type ServiceRecoveryManifestV1 = z.infer<typeof serviceRecoveryManifestV1Schema>;
export type ServiceRecoveryTaskV1 = z.infer<typeof taskV1Schema>;
export type ServiceRecoveryAttributionV1 = z.infer<typeof attributionV1Schema>;

export function serviceRecoveryManifestDigestV1(payload: ServiceRecoveryManifestPayloadV1): string {
  const { createdAt: _createdAt, activeRequest, ...decisionInputs } = payload;
  const activeRequestInputs = activeRequest === null ? null : {
    requestId: activeRequest.requestId,
    actionCount: activeRequest.actionCount,
    globalDispatch: activeRequest.globalDispatch,
  };
  return canonicalHash({ ...decisionInputs, activeRequest: activeRequestInputs });
}

export function createServiceRecoveryManifestV1(payload: ServiceRecoveryManifestPayloadV1): ServiceRecoveryManifestV1 {
  const checked = payloadV1Schema.parse(payload);
  return serviceRecoveryManifestV1Schema.parse({ ...checked, digest: serviceRecoveryManifestDigestV1(checked) });
}
