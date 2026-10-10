import { isAbsolute } from "node:path";
import { z } from "zod";
import { byteCountSchema, replayPolicySchema, sha256Schema, utcTimestampSchema } from "../util/schema.js";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const notBefore = (later: string, earlier: string): boolean => Date.parse(later) >= Date.parse(earlier);

export const executionIdSchema = z.string().min(1).brand<"ExecutionId">();
export const incarnationIdSchema = z.string().min(1).brand<"IncarnationId">();

export const processRoleSchema = z.enum(["worker", "validator", "preflight"]);
export const processStatusSchema = z.enum(["prepared", "launching", "running", "reconciling", "exited", "blocked"]);
export const processCleanupStateSchema = z.enum(["not_started", "pending", "confirmed_dead", "unconfirmed"]);

export const processIdentitySchema = z.strictObject({
  pid: positiveSafeInteger,
  pgid: positiveSafeInteger,
  startIdentity: z.string().min(1),
  serviceBootId: z.string().min(1),
});

export const processExitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("code"), code: nonnegativeSafeInteger }),
  z.strictObject({ kind: z.literal("signal"), signal: z.string().min(1) }),
]);

export const processCaptureSchema = z.strictObject({
  stream: z.enum(["stdout", "stderr"]),
  path: z.string().refine((value) => isAbsolute(value) && !value.includes("\u0000"), "capture path must be absolute and contain no NUL"),
  totalBytes: byteCountSchema,
  retainedBytes: byteCountSchema,
  truncatedBytes: byteCountSchema,
  keptHeadBytes: byteCountSchema.optional(),
  keptTailBytes: byteCountSchema.optional(),
  sha256: sha256Schema.nullable(),
  complete: z.boolean(),
}).superRefine((capture, context) => {
  if (capture.retainedBytes > capture.totalBytes) {
    context.addIssue({ code: "custom", path: ["retainedBytes"], message: "retained bytes cannot exceed total bytes" });
  }
  if (capture.truncatedBytes !== capture.totalBytes - capture.retainedBytes) {
    context.addIssue({ code: "custom", path: ["truncatedBytes"], message: "truncated bytes must equal total minus retained bytes" });
  }
  if ((capture.keptHeadBytes === undefined) !== (capture.keptTailBytes === undefined)) {
    context.addIssue({ code: "custom", path: ["keptHeadBytes"], message: "head and tail retention metadata must appear together" });
  }
  if (capture.keptHeadBytes !== undefined && capture.keptTailBytes !== undefined
    && capture.keptHeadBytes + capture.keptTailBytes !== capture.retainedBytes) {
    context.addIssue({ code: "custom", path: ["keptHeadBytes"], message: "head and tail bytes must equal retained bytes" });
  }
  if (capture.complete && capture.truncatedBytes > 0) {
    context.addIssue({ code: "custom", path: ["complete"], message: "truncated captures cannot be complete" });
  }
  if (capture.complete && capture.sha256 === null) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "complete captures require a SHA-256 digest" });
  }
});

/** One process incarnation; a safe replay retains the execution ID and adds an incarnation. */
export const processIncarnationSchema = z.strictObject({
  executionId: executionIdSchema,
  incarnationId: incarnationIdSchema,
  incarnationNumber: positiveSafeInteger,
  role: processRoleSchema,
  status: processStatusSchema,
  replay: replayPolicySchema,
  commandHash: sha256Schema,
  launchIntentAt: utcTimestampSchema.nullable(),
  launchServiceBootId: z.string().uuid().optional(),
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  deadlineAt: utcTimestampSchema.nullable(),
  identity: processIdentitySchema.nullable(),
  exit: processExitSchema.nullable(),
  cleanupState: processCleanupStateSchema,
  captures: z.array(processCaptureSchema),
}).superRefine((process, context) => {
  if (process.launchIntentAt === null && (process.deadlineAt !== null || process.startedAt !== null)) {
    context.addIssue({ code: "custom", path: ["launchIntentAt"], message: "deadlines and process starts require launch intent" });
  }
  if (process.launchIntentAt !== null && process.deadlineAt !== null && !notBefore(process.deadlineAt, process.launchIntentAt)) {
    context.addIssue({ code: "custom", path: ["deadlineAt"], message: "deadline cannot precede launch intent" });
  }
  if (process.launchIntentAt !== null && process.startedAt !== null && !notBefore(process.startedAt, process.launchIntentAt)) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "process start cannot precede launch intent" });
  }
  if (process.startedAt !== null && process.finishedAt !== null && !notBefore(process.finishedAt, process.startedAt)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "process finish cannot precede process start" });
  }
  if (process.identity !== null && process.startedAt === null) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "process identity requires a start time" });
  }
  if (process.launchServiceBootId !== undefined && process.identity !== null
    && process.identity.serviceBootId !== process.launchServiceBootId) {
    context.addIssue({ code: "custom", path: ["launchServiceBootId"], message: "process identity matches the service that committed launch intent" });
  }
  if (process.exit !== null && (process.identity === null || process.finishedAt === null)) {
    context.addIssue({ code: "custom", path: ["exit"], message: "exit receipts require process identity and finish time" });
  }
  if (process.finishedAt !== null && (process.identity === null || process.startedAt === null)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "process finish time requires recorded identity and start time" });
  }
  if (process.cleanupState === "confirmed_dead" && process.identity === null) {
    context.addIssue({ code: "custom", path: ["cleanupState"], message: "death cannot be confirmed without process identity" });
  }
  switch (process.status) {
    case "prepared":
      if (process.launchIntentAt !== null || process.startedAt !== null || process.finishedAt !== null
        || process.identity !== null || process.exit !== null || process.cleanupState !== "not_started") {
        context.addIssue({ code: "custom", path: ["status"], message: "prepared processes have no launch or cleanup state" });
      }
      break;
    case "launching":
      if (process.launchIntentAt === null || process.startedAt !== null || process.identity !== null
        || process.finishedAt !== null || process.exit !== null || process.cleanupState !== "pending") {
        context.addIssue({ code: "custom", path: ["status"], message: "launching processes require intent and await identity" });
      }
      break;
    case "running":
      if (process.launchIntentAt === null || process.startedAt === null || process.identity === null
        || process.finishedAt !== null || process.exit !== null || process.cleanupState !== "pending") {
        context.addIssue({ code: "custom", path: ["status"], message: "running processes require identity and pending cleanup" });
      }
      break;
    case "reconciling":
      if (process.launchIntentAt === null || process.startedAt === null || process.identity === null
        || process.cleanupState === "not_started") {
        context.addIssue({ code: "custom", path: ["status"], message: "reconciliation requires recorded process identity" });
      }
      break;
    case "exited":
      if (process.launchIntentAt === null || process.startedAt === null || process.finishedAt === null
        || process.identity === null || process.exit === null || process.cleanupState !== "confirmed_dead") {
        context.addIssue({ code: "custom", path: ["status"], message: "exited processes require a checked exit and confirmed group death" });
      }
      break;
    case "blocked":
      if (process.launchIntentAt === null || (process.cleanupState !== "unconfirmed" && process.cleanupState !== "confirmed_dead")) {
        context.addIssue({ code: "custom", path: ["status"], message: "blocked processes retain launch intent and reconciled cleanup state" });
      }
      break;
  }
});

export type ProcessExit = z.infer<typeof processExitSchema>;
export type ProcessCapture = z.infer<typeof processCaptureSchema>;
