import { z } from "zod";
import { nodeIdSchema, workflowIdSchema } from "../definition/schema.js";
import { runIdSchema, waitIdSchema, humanAnswerSchema, humanReplyResultSchema } from "../run/schema.js";
import { logSectionDtoSchema, runSummaryDtoSchema } from "../views/schema.js";
import { botChatViewV1Schema, chatTextV1Schema } from "../bot/schema.js";

export const serviceStatusV1Schema = z.enum([
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "shutdown_failed",
]);

export const serviceMetadataV1Schema = z.object({
  version: z.literal(1),
  status: serviceStatusV1Schema,
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
  bootId: z.string().uuid(),
  startedAt: z.string().min(1),
  socketPath: z.string().min(1),
}).strict();
export type ServiceMetadataV1 = z.infer<typeof serviceMetadataV1Schema>;

export const serviceHealthResponseV1Schema = z.object({
  version: z.literal(1),
  status: serviceStatusV1Schema,
  pid: z.number().int().positive(),
  bootId: z.string().uuid(),
}).strict();
export type ServiceHealthResponseV1 = z.infer<typeof serviceHealthResponseV1Schema>;

export const MAX_STARTUP_PARK_TASKS_V1 = 256;
export const MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1 = 64 * 1024;

export const startupParkActivationIdV1Schema = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const startupParkRunIdV1Schema = z.string().max(118)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|slot-[0-9a-f]{32})$/);

const startupParkAttributionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("scheduler"),
    workflowId: workflowIdSchema,
    activationId: startupParkActivationIdV1Schema,
  }),
  z.strictObject({
    kind: z.literal("workflow_run"),
    workflowId: workflowIdSchema,
    runId: startupParkRunIdV1Schema,
  }),
  z.strictObject({ kind: z.literal("bot") }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
const startupParkLimitationV1Schema = z.enum([
  "task_graph_unavailable",
  "graph_only_blocked_tasks",
  "inspection_only_blocked_tasks",
  "inspection_disagreement",
  "attribution_incomplete",
  "task_inspection_unavailable",
  "scheduler_not_paused",
  "process_task_uncertain",
  "process_evidence_uncertain",
  "recovery_request_active",
  "recovery_request_unavailable",
]);

export const STARTUP_PARK_TASK_KINDS_V1 = [
  "workshop.workflow-run",
  "workshop.node-attempt",
  "workshop.process-execution",
  "workshop.capacity-gate",
  "workshop.schedule-wakeup",
  "workshop.agent-execution",
  "pi.generation",
  "pi.tool",
  "pi.compaction",
  "unknown",
] as const;

export const startupParkTaskV1Schema = z.strictObject({
  taskId: z.number().int().positive().safe(),
  kind: z.enum(STARTUP_PARK_TASK_KINDS_V1),
  reason: z.enum(["missing_task", "task_too_old", "migration_failed", "restart_limit", "unknown"]),
  attribution: startupParkAttributionV1Schema,
});
export type StartupParkTaskV1 = z.infer<typeof startupParkTaskV1Schema>;

export const startupParkDiagnosticV1Schema = z.strictObject({
  version: z.literal(1),
  state: z.literal("historical_not_ready"),
  createdAt: z.iso.datetime(),
  bootId: z.string().uuid(),
  blockedTaskCount: z.number().int().nonnegative().safe(),
  observationComplete: z.boolean(),
  limitations: z.array(startupParkLimitationV1Schema).max(12),
  truncated: z.boolean(),
  blockedTasks: z.array(startupParkTaskV1Schema).max(MAX_STARTUP_PARK_TASKS_V1),
}).superRefine((diagnostic, context) => {
  const ids = new Set<number>();
  diagnostic.blockedTasks.forEach((task, index) => {
    if (ids.has(task.taskId)) {
      context.addIssue({ code: "custom", path: ["blockedTasks", index, "taskId"], message: "blocked task IDs are unique" });
    }
    ids.add(task.taskId);
  });
  const isTruncated = diagnostic.blockedTasks.length < diagnostic.blockedTaskCount;
  if (diagnostic.blockedTaskCount < diagnostic.blockedTasks.length || diagnostic.truncated !== isTruncated) {
    context.addIssue({ code: "custom", path: ["truncated"], message: "truncation matches the number of listed blocked tasks" });
  }
  if (diagnostic.observationComplete !== (diagnostic.limitations.length === 0)) {
    context.addIssue({ code: "custom", path: ["observationComplete"], message: "observation completeness matches the recorded inspection limitations" });
  }
  if (new Set(diagnostic.limitations).size !== diagnostic.limitations.length) {
    context.addIssue({ code: "custom", path: ["limitations"], message: "inspection limitations are unique" });
  }
});
export type StartupParkDiagnosticV1 = z.infer<typeof startupParkDiagnosticV1Schema>;

export const serviceRequestIdV1Schema = z.string().min(1).max(128).refine(
  (value) => !/[\x00-\x1f\x7f]/.test(value),
  "requestId cannot contain control characters",
);

const requestBase = { version: z.literal(1) } as const;
const mutationBase = { ...requestBase, requestId: serviceRequestIdV1Schema, workflowId: workflowIdSchema };


export const serviceRequestV1Schema = z.discriminatedUnion("method", [
  z.strictObject({ ...requestBase, method: z.literal("health") }),
  z.strictObject({ ...mutationBase, method: z.literal("start") }),
  z.strictObject({ ...mutationBase, method: z.literal("pause") }),
  z.strictObject({ ...mutationBase, method: z.literal("resume") }),
  z.strictObject({ ...mutationBase, method: z.literal("stop") }),
  z.strictObject({ ...mutationBase, method: z.literal("human.reply"), runId: runIdSchema,
    waitId: waitIdSchema, action: z.enum(["continue", "reject"]), answer: humanAnswerSchema }),
  z.strictObject({ ...requestBase, method: z.literal("chat.submit"), requestId: serviceRequestIdV1Schema, text: chatTextV1Schema }),
  z.strictObject({ ...requestBase, method: z.literal("chat.view"), cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(100).optional(), includeKinds: z.literal(true).optional() }),
  z.strictObject({
    ...mutationBase,
    method: z.literal("resolve"),
    runId: runIdSchema.optional(),
    action: z.enum(["retry", "accept", "fail"]),
    resolver: z.enum(["human", "bot"]).optional(),
    target: z.literal("judgment").optional(),
    reason: z.string().min(1).max(16_384),
    allowRepeat: z.boolean().optional(),
    extraAttempt: z.boolean().optional(),
    acknowledgeEffects: z.boolean().optional(),
    resultFile: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("status"),
    workflowId: workflowIdSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("runs"),
    workflowId: workflowIdSchema,
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("logs.page"),
    workflowId: workflowIdSchema,
    runId: runIdSchema.optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    verbose: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("node.describe"),
    workflowId: workflowIdSchema,
    nodeId: nodeIdSchema,
    runId: runIdSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("diagram"),
    workflowId: workflowIdSchema,
    runId: runIdSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("watch"),
    workflowId: workflowIdSchema.optional(),
  }),
]);
export type ServiceRequestV1 = z.infer<typeof serviceRequestV1Schema>;

export const serviceRunsPageV1Schema = z.strictObject({
  version: z.literal(1),
  workflowId: workflowIdSchema,
  total: z.number().int().nonnegative().safe(),
  highWaterMark: z.number().int().nonnegative().safe(),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  runs: z.array(runSummaryDtoSchema).max(100),
}).superRefine((page, context) => {
  if (page.total > page.highWaterMark || page.runs.length > page.total) {
    context.addIssue({ code: "custom", path: ["total"], message: "page total fits within its admission high-water mark" });
  }
});

export const MAX_LOG_CONTENT_CHUNK_BYTES_V1 = 512 * 1024;
export const serviceLogSectionPageV1Schema = z.strictObject({
  version: z.literal(1),
  runId: runIdSchema,
  sectionIndex: z.number().int().nonnegative().safe(),
  totalSections: z.number().int().positive().safe(),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  section: logSectionDtoSchema,
  chunk: z.strictObject({
    offsetBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    complete: z.boolean(),
  }),
}).superRefine((page, context) => {
  const path = ["chunk"] as (string | number)[];
  if (page.sectionIndex >= page.totalSections || page.section.order !== page.sectionIndex) {
    context.addIssue({ code: "custom", path: ["sectionIndex"], message: "log section page lies within its ordered snapshot" });
  }
  const contentBytes = page.section.content === null ? 0 : new TextEncoder().encode(page.section.content).byteLength;
  if (contentBytes > MAX_LOG_CONTENT_CHUNK_BYTES_V1) {
    context.addIssue({ code: "custom", path: [...path, "totalBytes"], message: "log transport chunk exceeds its byte bound" });
  }
  if (page.section.content === null) {
    if (page.chunk.offsetBytes !== 0 || page.chunk.totalBytes !== 0 || !page.chunk.complete) {
      context.addIssue({ code: "custom", path, message: "unavailable sections have no content chunks" });
    }
  } else {
    if (page.chunk.offsetBytes > page.chunk.totalBytes || contentBytes > page.chunk.totalBytes - page.chunk.offsetBytes) {
      context.addIssue({ code: "custom", path, message: "log chunk lies within its section byte range" });
    }
    if (page.chunk.complete !== (page.chunk.offsetBytes + contentBytes === page.chunk.totalBytes)) {
      context.addIssue({ code: "custom", path: [...path, "complete"], message: "log chunk completion matches its section byte range" });
    }
  }
  const isFinalPage = page.sectionIndex === page.totalSections - 1 && page.chunk.complete;
  if ((page.nextCursor === null) !== isFinalPage) {
    context.addIssue({ code: "custom", path: ["nextCursor"], message: "log section cursor matches the remaining snapshot" });
  }
});
export type ServiceLogSectionPageV1 = z.infer<typeof serviceLogSectionPageV1Schema>;
export type ServiceRunsPageV1 = z.infer<typeof serviceRunsPageV1Schema>;

export const serviceStartResultV1Schema = z.strictObject({
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: z.string().min(1),
  occurrenceId: z.string().min(1),
  admissionSequence: z.number().int().positive().safe(),
  conversationId: z.number().int().positive().safe(),
  workflowTaskId: z.number().int().positive().safe(),
  duplicate: z.boolean(),
});

export const serviceResolveResultV1Schema = z.strictObject({
  workflowId: workflowIdSchema,
  runId: runIdSchema,
  status: z.enum(["queued", "failed"]),
  desiredState: z.enum(["running", "paused", "stopped"]),
  resolutionId: z.string().min(1),
});

export const serviceReplyResultV1Schema = humanReplyResultSchema;
export const serviceChatViewV1Schema = botChatViewV1Schema;
export const serviceChatSubmitResultV1Schema = z.strictObject({ submitted: z.literal(true), submissionId: z.string().min(1) });

const serviceErrorV1Schema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(16_384),
  details: z.json().optional(),
});

export const serviceResponseV1Schema = z.discriminatedUnion("ok", [
  z.strictObject({
    version: z.literal(1),
    requestId: serviceRequestIdV1Schema.nullable(),
    ok: z.literal(true),
    result: z.json(),
  }),
  z.strictObject({
    version: z.literal(1),
    requestId: serviceRequestIdV1Schema.nullable(),
    ok: z.literal(false),
    error: serviceErrorV1Schema,
  }),
]);
export type ServiceResponseV1 = z.infer<typeof serviceResponseV1Schema>;

const serviceResponseFragmentV1Schema = z.strictObject({
  version: z.literal(1),
  requestId: serviceRequestIdV1Schema.nullable(),
  fragment: z.strictObject({
    sequence: z.number().int().nonnegative().refine(Number.isSafeInteger),
    final: z.boolean(),
    data: z.string().min(4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
});

export const serviceResponseFrameV1Schema = z.union([serviceResponseV1Schema, serviceResponseFragmentV1Schema]);
export type ServiceResponseFrameV1 = z.infer<typeof serviceResponseFrameV1Schema>;
