import { isAbsolute } from "node:path";
import { z } from "zod";
import { validatorVerdictV2Schema } from "../attempt/parse-v2-result.js";
import { processExitV2Schema } from "../process/schema-v2.js";
import { nodeIdV2 } from "../definition/schema-v2.js";
import { sha256V2Schema, utcTimestampV2Schema } from "../util/schema-v2.js";

export const runIdV2Schema = z.string().min(1).brand<"RunIdV2">();
export const activationIdV2Schema = z.string().min(1).brand<"ActivationIdV2">();
export const occurrenceIdV2Schema = z.string().min(1).brand<"OccurrenceIdV2">();
export const attemptIdV2Schema = z.string().min(1).brand<"AttemptIdV2">();
export const judgmentIdV2Schema = z.string().min(1).brand<"JudgmentIdV2">();
export const evidenceIdV2Schema = z.string().min(1).brand<"EvidenceIdV2">();
export const blockIdV2Schema = z.string().min(1).brand<"BlockIdV2">();
export const resolutionIdV2Schema = z.string().min(1).brand<"ResolutionIdV2">();

export const runStatusV2Schema = z.enum(["queued", "running", "paused", "blocked", "completed", "failed", "cancelled"]);
export const desiredStateV2Schema = z.enum(["running", "paused", "stopped"]);
export const attemptStatusV2Schema = z.enum(["prepared", "executing", "validating", "succeeded", "failed", "interrupted", "cancelled"]);
export const attemptPhaseV2Schema = z.enum(["prepare", "awaitWorker", "captureCandidate", "awaitValidator", "finish"]);

export const blockKindV2Schema = z.enum([
  "external_outcome_unknown",
  "process_death_unconfirmed",
  "operator",
  "orchestrator",
  "orchestrator_unavailable",
  "orchestrator_invalid",
  "preflight_failed",
  "runtime_incompatible",
  "integrity_failed",
  "retry_exhausted",
]);

export const failureKindV2Schema = z.enum([
  "process_error",
  "timeout",
  "result_invalid",
  "result_too_large",
  "validator_rejection",
  "artifact_missing",
  "runtime_fault",
]);

const boundedReasonV2 = z.string().min(1).refine(
  (value) => value.isWellFormed(),
  "reason must be well-formed Unicode",
 ).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
  "reason must be at most 64 KiB in UTF-8",
 );
const boundedCandidateTextV2 = (maxBytes: number) => z.string()
  .refine((value) => value.isWellFormed(), "text must be well-formed Unicode")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
    `text must be at most ${maxBytes} UTF-8 bytes`,
  );

export const failureInfoV2Schema = z.strictObject({
  kind: failureKindV2Schema,
  message: boundedReasonV2,
  failedAt: utcTimestampV2Schema,
  nodeId: nodeIdV2.nullable(),
  attemptId: attemptIdV2Schema.nullable(),
});

export const blockInfoV2Schema = z.strictObject({
  blockId: blockIdV2Schema,
  kind: blockKindV2Schema,
  reason: boundedReasonV2,
  blockedAt: utcTimestampV2Schema,
  nodeId: nodeIdV2.nullable(),
  attemptId: attemptIdV2Schema.nullable(),
});

export const operatorAcceptanceV2Schema = z.strictObject({
  kind: z.literal("operator_acceptance"),
  resolutionId: resolutionIdV2Schema,
  provenance: z.literal("operator"),
  target: z.enum(["worker", "validator"]),
  reason: boundedReasonV2,
  resolvedAt: utcTimestampV2Schema,
  processGroupsConfirmedDead: z.literal(true),
  acknowledgedEffects: z.literal(true),
  sourceBlock: blockInfoV2Schema.refine(
    (block) => block.kind === "external_outcome_unknown" && block.nodeId !== null && block.attemptId !== null,
    "operator acceptance applies to an unknown attempt outcome",
  ),
  resultBytesHash: sha256V2Schema,
}).superRefine((acceptance, context) => {
  if (Date.parse(acceptance.resolvedAt) < Date.parse(acceptance.sourceBlock.blockedAt)) {
    context.addIssue({ code: "custom", path: ["resolvedAt"], message: "acceptance cannot precede its source block" });
  }
});

const operatorResolutionFieldsV2 = {
  resolutionId: resolutionIdV2Schema,
  provenance: z.literal("operator"),
  reason: boundedReasonV2,
  resolvedAt: utcTimestampV2Schema,
  processGroupsConfirmedDead: z.literal(true),
  sourceBlock: blockInfoV2Schema,
};

/** Retry/fail audit data; acceptance is retained with the accepted result bytes. */
export const operatorResolutionV2Schema = z.discriminatedUnion("action", [
  z.strictObject({
    ...operatorResolutionFieldsV2,
    action: z.literal("retry"),
    target: z.literal("judgment").optional(),
    allowRepeat: z.boolean(),
    extraAttempt: z.boolean(),
  }),
  z.strictObject({
    ...operatorResolutionFieldsV2,
    action: z.literal("fail"),
  }),
]).superRefine((resolution, context) => {
  if (Date.parse(resolution.resolvedAt) < Date.parse(resolution.sourceBlock.blockedAt)) {
    context.addIssue({ code: "custom", path: ["resolvedAt"], message: "resolution cannot precede its source block" });
  }
});

/** Attempt failures keep §11's fixed kinds; operator-forced termination is a separate run cause. */
export const operatorRunFailureV2Schema = z.strictObject({
  kind: z.literal("operator"),
  resolutionId: resolutionIdV2Schema,
  provenance: z.literal("operator"),
  reason: boundedReasonV2,
  failedAt: utcTimestampV2Schema,
  processGroupsConfirmedDead: z.literal(true),
  sourceBlock: blockInfoV2Schema,
}).superRefine((failure, context) => {
  if (Date.parse(failure.failedAt) < Date.parse(failure.sourceBlock.blockedAt)) {
    context.addIssue({ code: "custom", path: ["failedAt"], message: "operator failure cannot precede its source block" });
  }
});

export const runFailureInfoV2Schema = z.discriminatedUnion("kind", [failureInfoV2Schema, operatorRunFailureV2Schema]);

const absoluteArtifactPathV2 = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes("\u0000"),
  "artifact path must be absolute and contain no NUL",
);

export const resultArtifactV2Schema = z.discriminatedUnion("availability", [
  z.strictObject({
    kind: z.string().min(1),
    path: absoluteArtifactPathV2,
    availability: z.literal("available"),
    byteCount: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
    sha256: sha256V2Schema.nullable(),
  }).superRefine((artifact, context) => {
    if (artifact.sha256 !== null && artifact.byteCount === null) {
      context.addIssue({ code: "custom", path: ["byteCount"], message: "hashed artifacts require a byte count" });
    }
  }),
  z.strictObject({
    kind: z.string().min(1),
    path: absoluteArtifactPathV2,
    availability: z.literal("missing"),
    byteCount: z.null(),
    sha256: z.null(),
  }),
]);

const nodeResultFieldsV2 = {
  version: z.literal(1),
  output: boundedCandidateTextV2(1024 * 1024),
  summary: boundedCandidateTextV2(64 * 1024),
  artifacts: z.array(resultArtifactV2Schema).max(100),
  sourceBytesHash: sha256V2Schema,
};

/** Canonical checked candidate. Operator acceptance preserves its own provenance and source block. */
export const nodeResultV2Schema = z.discriminatedUnion("source", [
  z.strictObject({
    ...nodeResultFieldsV2,
    source: z.literal("command"),
    exit: processExitV2Schema,
  }),
  z.strictObject({
    ...nodeResultFieldsV2,
    source: z.literal("agent"),
    exit: processExitV2Schema,
  }),
  z.strictObject({
    ...nodeResultFieldsV2,
    source: z.literal("operator"),
    workerKind: z.enum(["command", "agent"]),
    exit: z.null(),
    acceptance: operatorAcceptanceV2Schema,
  }),
]).superRefine((result, context) => {
  if (result.source === "agent" && result.output.length === 0) {
    context.addIssue({ code: "custom", path: ["output"], message: "agent output must be nonempty" });
  }
  if (result.source === "command" || result.source === "agent") {
    if (result.exit.kind !== "code" || result.exit.code !== 0) {
      context.addIssue({ code: "custom", path: ["exit"], message: "successful candidate results require exit code 0" });
    }
  } else {
    if (result.acceptance.target !== "worker") {
      context.addIssue({ code: "custom", path: ["acceptance", "target"], message: "candidate acceptance must target a worker result" });
    }
    if (result.acceptance.resultBytesHash !== result.sourceBytesHash) {
      context.addIssue({ code: "custom", path: ["sourceBytesHash"], message: "accepted candidate hash must match its supplied result bytes" });
    }
    if (result.workerKind === "agent" && result.output.length === 0) {
      context.addIssue({ code: "custom", path: ["output"], message: "agent results must be nonempty" });
    }
  }
});

const successfulValidatorExitV2Schema = z.strictObject({
  kind: z.literal("code"),
  code: z.literal(0),
});

export const validatorOutcomeV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    exit: processExitV2Schema,
    stdoutHash: sha256V2Schema.nullable(),
    stderrHash: sha256V2Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("agent"),
    exit: successfulValidatorExitV2Schema,
    verdict: validatorVerdictV2Schema,
    resultBytesHash: sha256V2Schema,
  }),
  z.strictObject({
    kind: z.literal("operator"),
    verdict: validatorVerdictV2Schema,
    resultBytesHash: sha256V2Schema,
    acceptance: operatorAcceptanceV2Schema,
  }).superRefine((outcome, context) => {
    if (outcome.acceptance.target !== "validator") {
      context.addIssue({ code: "custom", path: ["acceptance", "target"], message: "verdict acceptance must target a validator result" });
    }
    if (outcome.acceptance.resultBytesHash !== outcome.resultBytesHash) {
      context.addIssue({ code: "custom", path: ["resultBytesHash"], message: "accepted verdict hash must match its supplied result bytes" });
    }
  }),
]);

type ValidatorOutcomeValueV2 = z.infer<typeof validatorOutcomeV2Schema>;
export function validatorOutcomePassesV2(outcome: ValidatorOutcomeValueV2): boolean {
  if (outcome.kind === "command") return outcome.exit.kind === "code" && outcome.exit.code === 0;
  return outcome.verdict.passed;
}

export const nodeAttemptOutcomeV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("succeeded"),
    candidate: nodeResultV2Schema,
    validator: validatorOutcomeV2Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("failed"),
    failure: failureInfoV2Schema,
    candidate: nodeResultV2Schema.nullable(),
    validator: validatorOutcomeV2Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    block: blockInfoV2Schema,
    candidate: nodeResultV2Schema.nullable(),
    validator: validatorOutcomeV2Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("cancelled"),
    candidate: nodeResultV2Schema.nullable().optional(),
    validator: validatorOutcomeV2Schema.nullable().optional(),
  }),
]).superRefine((outcome, context) => {
  if (outcome.kind === "succeeded" && outcome.validator && !validatorOutcomePassesV2(outcome.validator)) {
    context.addIssue({ code: "custom", path: ["validator"], message: "a succeeded attempt requires a passing validator" });
  }
  if (outcome.kind === "failed" || outcome.kind === "blocked") {
    if (outcome.validator !== null && outcome.candidate === null) {
      context.addIssue({ code: "custom", path: ["candidate"], message: "validator outcomes require a committed candidate" });
    }
  }
  if (outcome.kind === "cancelled" && outcome.validator != null && outcome.candidate == null) {
    context.addIssue({ code: "custom", path: ["candidate"], message: "cancelled validator history retains its worker candidate" });
  }
  if (outcome.kind === "failed") {
    const rejected = outcome.failure.kind === "validator_rejection";
    const validatorFailed = outcome.validator !== null && !validatorOutcomePassesV2(outcome.validator);
    const validatorPassed = outcome.validator !== null && validatorOutcomePassesV2(outcome.validator);
    if (rejected && (outcome.candidate === null || !validatorFailed)) {
      context.addIssue({ code: "custom", path: ["validator"], message: "validator rejection requires a candidate and a failing validator result" });
    }
    const executionFailure = ["timeout", "process_error", "runtime_fault"].includes(outcome.failure.kind);
    const resultFailure = ["result_invalid", "result_too_large"].includes(outcome.failure.kind);
    if (["timeout", "process_error", "result_invalid", "result_too_large"].includes(outcome.failure.kind) && validatorPassed) {
      context.addIssue({ code: "custom", path: ["validator"], message: "execution failures cannot retain a passing validator result" });
    }
    if ((executionFailure || resultFailure) && outcome.validator?.kind === "agent") {
      context.addIssue({ code: "custom", path: ["validator"], message: "execution failures retain process evidence, not an agent verdict" });
    }
    if (validatorFailed && !rejected && !executionFailure) {
      context.addIssue({ code: "custom", path: ["failure", "kind"], message: "failing validator results are rejections unless execution failed" });
    }
  }
});

export const judgmentDecisionV2Schema = z.strictObject({
  action: z.enum(["retry", "block", "fail"]),
  reason: boundedReasonV2,
});

export const runOutcomeV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed"), terminalOutput: boundedCandidateTextV2(1024 * 1024) }),
  z.strictObject({ kind: z.literal("failed"), failure: runFailureInfoV2Schema }),
  z.strictObject({ kind: z.literal("blocked"), block: blockInfoV2Schema }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);

export type RunIdV2 = z.infer<typeof runIdV2Schema>;
export type ActivationIdV2 = z.infer<typeof activationIdV2Schema>;
export type OccurrenceIdV2 = z.infer<typeof occurrenceIdV2Schema>;
export type AttemptIdV2 = z.infer<typeof attemptIdV2Schema>;
export type JudgmentIdV2 = z.infer<typeof judgmentIdV2Schema>;
export type EvidenceIdV2 = z.infer<typeof evidenceIdV2Schema>;
export type BlockIdV2 = z.infer<typeof blockIdV2Schema>;
export type ResolutionIdV2 = z.infer<typeof resolutionIdV2Schema>;
export type RunStatusV2 = z.infer<typeof runStatusV2Schema>;
export type DesiredStateV2 = z.infer<typeof desiredStateV2Schema>;
export type AttemptStatusV2 = z.infer<typeof attemptStatusV2Schema>;
export type AttemptPhaseV2 = z.infer<typeof attemptPhaseV2Schema>;
export type BlockKindV2 = z.infer<typeof blockKindV2Schema>;
export type FailureKindV2 = z.infer<typeof failureKindV2Schema>;
export type FailureInfoV2 = z.infer<typeof failureInfoV2Schema>;
export type BlockInfoV2 = z.infer<typeof blockInfoV2Schema>;
export type JudgmentDecisionV2 = z.infer<typeof judgmentDecisionV2Schema>;
export type OperatorAcceptanceV2 = z.infer<typeof operatorAcceptanceV2Schema>;
export type OperatorResolutionV2 = z.infer<typeof operatorResolutionV2Schema>;
export type RunFailureInfoV2 = z.infer<typeof runFailureInfoV2Schema>;
export type NodeResultV2 = z.infer<typeof nodeResultV2Schema>;
export type ValidatorOutcomeV2 = z.infer<typeof validatorOutcomeV2Schema>;
export type NodeAttemptOutcomeV2 = z.infer<typeof nodeAttemptOutcomeV2Schema>;
export type RunOutcomeV2 = z.infer<typeof runOutcomeV2Schema>;
