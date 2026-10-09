import { z } from "zod";
import { nodeIdV2, workflowIdV2 } from "../definition/schema-v2.js";
import { runIdV2Schema } from "../run/schema-v2.js";
import { logSectionDtoV2Schema, runSummaryDtoV2Schema } from "../views/schema-v2.js";

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

export const serviceRequestIdV1Schema = z.string().min(1).max(128).refine(
  (value) => !/[\x00-\x1f\x7f]/.test(value),
  "requestId cannot contain control characters",
);

const requestBase = { version: z.literal(1) } as const;
const mutationBase = { ...requestBase, requestId: serviceRequestIdV1Schema, workflowId: workflowIdV2 };

export const serviceMutationMethodV1Schema = z.enum(["start", "pause", "resume", "stop", "resolve"]);

export const serviceRequestV1Schema = z.discriminatedUnion("method", [
  z.strictObject({ ...requestBase, method: z.literal("health") }),
  z.strictObject({ ...mutationBase, method: z.literal("start") }),
  z.strictObject({ ...mutationBase, method: z.literal("pause") }),
  z.strictObject({ ...mutationBase, method: z.literal("resume") }),
  z.strictObject({ ...mutationBase, method: z.literal("stop") }),
  z.strictObject({
    ...mutationBase,
    method: z.literal("resolve"),
    runId: runIdV2Schema.optional(),
    action: z.enum(["retry", "accept", "fail"]),
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
    workflowId: workflowIdV2.optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("runs"),
    workflowId: workflowIdV2,
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("logs.page"),
    workflowId: workflowIdV2,
    runId: runIdV2Schema.optional(),
    cursor: z.string().min(1).max(4_096).optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("node.describe"),
    workflowId: workflowIdV2,
    nodeId: nodeIdV2,
    runId: runIdV2Schema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("diagram"),
    workflowId: workflowIdV2,
    runId: runIdV2Schema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("watch"),
    workflowId: workflowIdV2.optional(),
  }),
]);
export type ServiceRequestV1 = z.infer<typeof serviceRequestV1Schema>;

export const serviceRunsPageV1Schema = z.strictObject({
  version: z.literal(1),
  workflowId: workflowIdV2,
  total: z.number().int().nonnegative().safe(),
  highWaterMark: z.number().int().nonnegative().safe(),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  runs: z.array(runSummaryDtoV2Schema).max(100),
}).superRefine((page, context) => {
  if (page.total > page.highWaterMark || page.runs.length > page.total) {
    context.addIssue({ code: "custom", path: ["total"], message: "page total fits within its admission high-water mark" });
  }
});

export const MAX_LOG_CONTENT_CHUNK_BYTES_V1 = 512 * 1024;
export const serviceLogSectionPageV1Schema = z.strictObject({
  version: z.literal(1),
  runId: runIdV2Schema,
  sectionIndex: z.number().int().nonnegative().safe(),
  totalSections: z.number().int().positive().safe(),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  section: logSectionDtoV2Schema,
  chunk: z.strictObject({
    offsetBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    complete: z.boolean(),
  }),
  projection: z.strictObject({
    truncated: z.boolean(),
    omittedSections: z.number().int().nonnegative().safe(),
    omittedBytes: z.number().int().nonnegative().safe(),
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
  runId: runIdV2Schema,
  workflowId: workflowIdV2,
  activationId: z.string().min(1),
  occurrenceId: z.string().min(1),
  admissionSequence: z.number().int().positive().safe(),
  conversationId: z.number().int().positive().safe(),
  workflowTaskId: z.number().int().positive().safe(),
  duplicate: z.boolean(),
});
export type ServiceStartResultV1 = z.infer<typeof serviceStartResultV1Schema>;

export const serviceResolveResultV1Schema = z.strictObject({
  workflowId: workflowIdV2,
  runId: runIdV2Schema,
  status: z.enum(["queued", "failed"]),
  desiredState: z.enum(["running", "paused", "stopped"]),
  resolutionId: z.string().min(1),
});

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
