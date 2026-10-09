import { isAbsolute } from "node:path";
import { z } from "zod";
import { byteCountV2Schema, replayPolicyV2Schema, sha256V2Schema, utcTimestampV2Schema } from "../util/schema-v2.js";

const positiveSafeIntegerV2 = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeSafeIntegerV2 = z.number().int().nonnegative().refine(Number.isSafeInteger);
const notBeforeV2 = (later: string, earlier: string): boolean => Date.parse(later) >= Date.parse(earlier);

export const executionIdV2Schema = z.string().min(1).brand<"ExecutionIdV2">();
export const incarnationIdV2Schema = z.string().min(1).brand<"IncarnationIdV2">();

export const processRoleV2Schema = z.enum(["worker", "validator", "preflight"]);
export const processStatusV2Schema = z.enum(["prepared", "launching", "running", "reconciling", "exited", "blocked"]);
export const processCleanupStateV2Schema = z.enum(["not_started", "pending", "confirmed_dead", "unconfirmed"]);

export const processIdentityV2Schema = z.strictObject({
  pid: positiveSafeIntegerV2,
  pgid: positiveSafeIntegerV2,
  startIdentity: z.string().min(1),
  serviceBootId: z.string().min(1),
});

export const processExitV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("code"), code: nonnegativeSafeIntegerV2 }),
  z.strictObject({ kind: z.literal("signal"), signal: z.string().min(1) }),
]);

export const processCaptureV2Schema = z.strictObject({
  stream: z.enum(["stdout", "stderr"]),
  path: z.string().refine((value) => isAbsolute(value) && !value.includes("\u0000"), "capture path must be absolute and contain no NUL"),
  totalBytes: byteCountV2Schema,
  retainedBytes: byteCountV2Schema,
  truncatedBytes: byteCountV2Schema,
  keptHeadBytes: byteCountV2Schema.optional(),
  keptTailBytes: byteCountV2Schema.optional(),
  sha256: sha256V2Schema.nullable(),
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
export const processIncarnationV2Schema = z.strictObject({
  executionId: executionIdV2Schema,
  incarnationId: incarnationIdV2Schema,
  incarnationNumber: positiveSafeIntegerV2,
  role: processRoleV2Schema,
  status: processStatusV2Schema,
  replay: replayPolicyV2Schema,
  commandHash: sha256V2Schema,
  launchIntentAt: utcTimestampV2Schema.nullable(),
  launchServiceBootId: z.string().uuid().optional(),
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  deadlineAt: utcTimestampV2Schema.nullable(),
  identity: processIdentityV2Schema.nullable(),
  exit: processExitV2Schema.nullable(),
  cleanupState: processCleanupStateV2Schema,
  captures: z.array(processCaptureV2Schema),
}).superRefine((process, context) => {
  if (process.launchIntentAt === null && (process.deadlineAt !== null || process.startedAt !== null)) {
    context.addIssue({ code: "custom", path: ["launchIntentAt"], message: "deadlines and process starts require launch intent" });
  }
  if (process.launchIntentAt !== null && process.deadlineAt !== null && !notBeforeV2(process.deadlineAt, process.launchIntentAt)) {
    context.addIssue({ code: "custom", path: ["deadlineAt"], message: "deadline cannot precede launch intent" });
  }
  if (process.launchIntentAt !== null && process.startedAt !== null && !notBeforeV2(process.startedAt, process.launchIntentAt)) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "process start cannot precede launch intent" });
  }
  if (process.startedAt !== null && process.finishedAt !== null && !notBeforeV2(process.finishedAt, process.startedAt)) {
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

export type ExecutionIdV2 = z.infer<typeof executionIdV2Schema>;
export type IncarnationIdV2 = z.infer<typeof incarnationIdV2Schema>;
export type ProcessRoleV2 = z.infer<typeof processRoleV2Schema>;
export type ProcessStatusV2 = z.infer<typeof processStatusV2Schema>;
export type ProcessCleanupStateV2 = z.infer<typeof processCleanupStateV2Schema>;
export type ProcessIdentityV2 = z.infer<typeof processIdentityV2Schema>;
export type ProcessExitV2 = z.infer<typeof processExitV2Schema>;
export type ProcessCaptureV2 = z.infer<typeof processCaptureV2Schema>;
export type ProcessIncarnationV2 = z.infer<typeof processIncarnationV2Schema>;
