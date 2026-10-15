import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { validatorVerdictSchema } from "../attempt/parse-result.js";
import { executionIdSchema, processExitSchema } from "../process/schema.js";
import { nodeIdSchema } from "../definition/schema.js";
import { byteCountSchema, sha256Schema, utcTimestampSchema } from "../util/schema.js";

export const runIdSchema = z.string().min(1).brand<"RunId">();
export const activationIdSchema = z.string().min(1).brand<"ActivationId">();
export const occurrenceIdSchema = z.string().min(1).brand<"OccurrenceId">();
export const attemptIdSchema = z.string().min(1).brand<"AttemptId">();
export const judgmentIdSchema = z.string().min(1).brand<"JudgmentId">();
export const evidenceIdSchema = z.string().min(1).brand<"EvidenceId">();
export const blockIdSchema = z.string().min(1).brand<"BlockId">();
export const resolutionIdSchema = z.string().min(1).brand<"ResolutionId">();

export const runStatusSchema = z.enum(["queued", "running", "paused", "blocked", "waiting", "completed", "failed", "cancelled"]);
export const waitIdSchema = z.string().uuid();
export const humanAnswerSchema = z.string().min(1)
  .refine((value) => value.trim().length > 0 && value.isWellFormed(), "answer must contain well-formed non-whitespace text")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024, "answer must be at most 64 KiB in UTF-8");

export const desiredStateSchema = z.enum(["running", "paused", "stopped"]);
export const humanReplyResultSchema = z.strictObject({
  workflowId: z.string().min(1),
  runId: runIdSchema,
  waitId: waitIdSchema,
  status: runStatusSchema,
  desiredState: desiredStateSchema,
  resolvedAt: utcTimestampSchema,
});

export const humanWaitSchema = z.strictObject({
  waitId: waitIdSchema,
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  question: humanAnswerSchema,
  output: z.string().min(1),
  createdAt: utcTimestampSchema,
  settlement: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }),
    z.strictObject({ kind: z.literal("stopped"), resolvedAt: utcTimestampSchema }),
    z.strictObject({
      kind: z.literal("replied"),
      provenance: z.literal("human"),
      action: z.enum(["continue", "reject"]),
      answer: humanAnswerSchema,
      response: humanReplyResultSchema,
    }),
  ]),
});

export const attemptStatusSchema = z.enum(["prepared", "executing", "validating", "succeeded", "failed", "interrupted", "cancelled"]);
export const attemptPhaseSchema = z.enum(["prepare", "awaitWorker", "captureCandidate", "awaitValidator", "finish"]);

export const blockKindSchema = z.enum([
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
  "verifier_block",
  "verifier_failed",
  "repeated_failure",
]);

export const failureKindSchema = z.enum([
  "process_error",
  "timeout",
  "result_invalid",
  "result_too_large",
  "validator_rejection",
  "artifact_missing",
  "runtime_fault",
]);

const boundedReason = z.string().min(1).refine(
  (value) => value.isWellFormed(),
  "reason must be well-formed Unicode",
 ).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
  "reason must be at most 64 KiB in UTF-8",
 );
const boundedCandidateText = (maxBytes: number) => z.string()
  .refine((value) => value.isWellFormed(), "text must be well-formed Unicode")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
    `text must be at most ${maxBytes} UTF-8 bytes`,
  );

export const nativeExecutionReceiptSchema = z.strictObject({
  executionId: executionIdSchema,
  conversationId: z.number().int().positive().refine(Number.isSafeInteger),
  requestId: z.string().min(1),
  assistantEntryId: z.number().int().positive().refine(Number.isSafeInteger),
  finalTextSha256: sha256Schema,
  byteCount: byteCountSchema,
  finalText: boundedCandidateText(1024 * 1024).optional(),
  startedAt: z.number().int().nonnegative().refine(Number.isSafeInteger),
  finishedAt: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).superRefine((receipt, context) => {
  if (receipt.finishedAt < receipt.startedAt) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "native execution finishes after it starts" });
  }
  if (receipt.finalText !== undefined) {
    if (Buffer.byteLength(receipt.finalText, "utf8") !== receipt.byteCount) {
      context.addIssue({ code: "custom", path: ["byteCount"], message: "native execution byte count matches its recorded text" });
    }
    const finalTextSha256 = "sha256:" + createHash("sha256").update(receipt.finalText, "utf8").digest("hex");
    if (finalTextSha256 !== receipt.finalTextSha256) {
      context.addIssue({ code: "custom", path: ["finalText"], message: "native execution text matches its recorded hash" });
    }
  }
});


export const failureInfoSchema = z.strictObject({
  kind: failureKindSchema,
  message: boundedReason,
  failedAt: utcTimestampSchema,
  nodeId: nodeIdSchema.nullable(),
  attemptId: attemptIdSchema.nullable(),
  nativeExecution: nativeExecutionReceiptSchema.optional(),
});

export const blockInfoSchema = z.strictObject({
  blockId: blockIdSchema,
  kind: blockKindSchema,
  reason: boundedReason,
  blockedAt: utcTimestampSchema,
  nodeId: nodeIdSchema.nullable(),
  attemptId: attemptIdSchema.nullable(),
});

export const operatorAcceptanceSchema = z.strictObject({
  kind: z.literal("operator_acceptance"),
  resolutionId: resolutionIdSchema,
  provenance: z.enum(["operator", "human"]),
  target: z.enum(["worker", "validator"]),
  reason: boundedReason,
  resolvedAt: utcTimestampSchema,
  processGroupsConfirmedDead: z.literal(true),
  acknowledgedEffects: z.literal(true),
  sourceBlock: blockInfoSchema.refine(
    (block) => block.kind === "external_outcome_unknown" && block.nodeId !== null && block.attemptId !== null,
    "operator acceptance applies to an unknown attempt outcome",
  ),
  resultBytesHash: sha256Schema,
}).superRefine((acceptance, context) => {
  if (Date.parse(acceptance.resolvedAt) < Date.parse(acceptance.sourceBlock.blockedAt)) {
    context.addIssue({ code: "custom", path: ["resolvedAt"], message: "acceptance cannot precede its source block" });
  }
});

const operatorResolutionFields = {
  resolutionId: resolutionIdSchema,
  provenance: z.enum(["operator", "human", "bot"]),
  reason: boundedReason,
  resolvedAt: utcTimestampSchema,
  processGroupsConfirmedDead: z.literal(true),
  sourceBlock: blockInfoSchema,
};

/** Retry/fail audit data; acceptance is retained with the accepted result bytes. */
export const operatorResolutionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...operatorResolutionFields,
    action: z.literal("retry"),
    target: z.literal("judgment").optional(),
    allowRepeat: z.boolean(),
    extraAttempt: z.boolean(),
  }),
  z.strictObject({
    ...operatorResolutionFields,
    action: z.literal("fail"),
  }),
]).superRefine((resolution, context) => {
  if (Date.parse(resolution.resolvedAt) < Date.parse(resolution.sourceBlock.blockedAt)) {
    context.addIssue({ code: "custom", path: ["resolvedAt"], message: "resolution cannot precede its source block" });
  }
});

/** Attempt failures keep §11's fixed kinds; operator-forced termination is a separate run cause. */
export const operatorRunFailureSchema = z.strictObject({
  kind: z.literal("operator"),
  resolutionId: resolutionIdSchema,
  provenance: z.enum(["operator", "human", "bot"]),
  reason: boundedReason,
  failedAt: utcTimestampSchema,
  processGroupsConfirmedDead: z.literal(true),
  sourceBlock: blockInfoSchema,
}).superRefine((failure, context) => {
  if (Date.parse(failure.failedAt) < Date.parse(failure.sourceBlock.blockedAt)) {
    context.addIssue({ code: "custom", path: ["failedAt"], message: "operator failure cannot precede its source block" });
  }
});

export const runFailureInfoSchema = z.discriminatedUnion("kind", [failureInfoSchema, operatorRunFailureSchema]);

const absoluteArtifactPath = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes("\u0000"),
  "artifact path must be absolute and contain no NUL",
);

export const resultArtifactSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    kind: z.string().min(1),
    path: absoluteArtifactPath,
    availability: z.literal("available"),
    byteCount: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
    sha256: sha256Schema.nullable(),
  }).superRefine((artifact, context) => {
    if (artifact.sha256 !== null && artifact.byteCount === null) {
      context.addIssue({ code: "custom", path: ["byteCount"], message: "hashed artifacts require a byte count" });
    }
  }),
  z.strictObject({
    kind: z.string().min(1),
    path: absoluteArtifactPath,
    availability: z.literal("missing"),
    byteCount: z.null(),
    sha256: z.null(),
  }),
]);

const nodeResultV1Fields = {
  version: z.literal(1),
  output: boundedCandidateText(1024 * 1024),
  summary: boundedCandidateText(64 * 1024),
  artifacts: z.array(resultArtifactSchema).max(100),
  sourceBytesHash: sha256Schema,
};

const nodeResultV1Schema = z.discriminatedUnion("source", [
  z.strictObject({ ...nodeResultV1Fields, source: z.literal("command"), exit: processExitSchema }),
  z.strictObject({ ...nodeResultV1Fields, source: z.literal("agent"), exit: processExitSchema }),
  z.strictObject({
    ...nodeResultV1Fields,
    source: z.literal("operator"),
    workerKind: z.enum(["command", "agent"]),
    exit: z.null(),
    acceptance: operatorAcceptanceSchema,
  }),
]);

const nonemptyWellFormedCandidateField = (maximumBytes: number, label: string) => z.string().min(1)
  .refine((value) => value.trim().length > 0, label + " must contain non-whitespace text")
  .refine((value) => value.isWellFormed(), label + " must be well-formed Unicode")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
    label + " must be at most " + maximumBytes + " UTF-8 bytes",
  );

const parsedAgentResultSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["text", "tagged"]),
  status: z.enum(["succeeded", "success_and_complete", "needs_input"]),
  reason: nonemptyWellFormedCandidateField(64 * 1024, "reason").nullable(),
  question: nonemptyWellFormedCandidateField(64 * 1024, "question").nullable(),
});

const stdioResultSchema = parsedAgentResultSchema;

const nodeResultV2Fields = {
  version: z.literal(2),
  output: boundedCandidateText(1024 * 1024),
  summary: boundedCandidateText(64 * 1024),
  artifacts: z.array(resultArtifactSchema).max(100),
  sourceBytesHash: sha256Schema,
  stdioResult: stdioResultSchema,
};

const nodeResultV2Schema = z.discriminatedUnion("source", [
  z.strictObject({ ...nodeResultV2Fields, source: z.literal("command"), exit: processExitSchema }),
  z.strictObject({ ...nodeResultV2Fields, source: z.literal("agent"), exit: processExitSchema }),
  z.strictObject({
    ...nodeResultV2Fields, source: z.literal("operator"), workerKind: z.enum(["command", "agent"]),
    exit: z.null(), acceptance: operatorAcceptanceSchema,
  }),
]);

const nodeResultV3Schema = z.strictObject({
  version: z.literal(3),
  source: z.literal("agent"),
  output: boundedCandidateText(1024 * 1024),
  summary: boundedCandidateText(64 * 1024),
  artifacts: z.array(resultArtifactSchema).max(100),
  sourceBytesHash: sha256Schema,
  nativeExecution: nativeExecutionReceiptSchema,
  agentResult: parsedAgentResultSchema,
});

/** Canonical checked candidate. Operator acceptance preserves its own provenance and source block. */
export const nodeResultSchema = z.union([nodeResultV1Schema, nodeResultV2Schema, nodeResultV3Schema]).superRefine((result, context) => {
  if (result.version === 1) {
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
    return;
  }

  if (result.version === 3) {
    if (result.sourceBytesHash !== result.nativeExecution.finalTextSha256) {
      context.addIssue({ code: "custom", path: ["sourceBytesHash"], message: "native result hash matches its execution receipt" });
    }
    if (result.artifacts.length !== 0) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "native agent candidates do not contain artifacts" });
    }
    if (result.summary !== (result.agentResult.reason ?? "")) {
      context.addIssue({ code: "custom", path: ["summary"], message: "native candidate summary matches its reason" });
    }
    if (result.agentResult.mode === "text" && (result.agentResult.status !== "succeeded"
      || result.agentResult.reason !== null || result.agentResult.question !== null)) {
      context.addIssue({ code: "custom", path: ["agentResult"], message: "text results have succeeded status without tagged fields" });
    }
    if (result.agentResult.status === "needs_input") {
      if (result.agentResult.question === null) {
        context.addIssue({ code: "custom", path: ["agentResult", "question"], message: "needs_input requires a question" });
      }
      if (result.output.trim().length === 0) {
        context.addIssue({ code: "custom", path: ["output"], message: "needs_input requires nonempty output" });
      }
    } else if (result.agentResult.question !== null) {
      context.addIssue({ code: "custom", path: ["agentResult", "question"], message: "question is only valid for needs_input" });
    }
    return;
  }

  const { stdioResult } = result;
  if (result.source === "operator") {
    if (result.acceptance.provenance !== "human" || result.acceptance.target !== "worker"
      || result.acceptance.resultBytesHash !== result.sourceBytesHash) {
      context.addIssue({ code: "custom", path: ["acceptance"], message: "stdout acceptance requires human worker provenance and matching bytes" });
    }
  } else if (result.exit.kind !== "code" || result.exit.code !== 0) {
    context.addIssue({ code: "custom", path: ["exit"], message: "successful candidate results require exit code 0" });
  }
  if (result.artifacts.length !== 0) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "stdout candidates do not contain artifacts" });
  }
  if (result.summary !== (stdioResult.reason ?? "")) {
    context.addIssue({ code: "custom", path: ["summary"], message: "stdout candidate summary matches its reason" });
  }
  if (stdioResult.mode === "text" && (stdioResult.status !== "succeeded" || stdioResult.reason !== null || stdioResult.question !== null)) {
    context.addIssue({ code: "custom", path: ["stdioResult"], message: "text results have succeeded status without tagged fields" });
  }
  if (stdioResult.status === "needs_input") {
    if (stdioResult.question === null) {
      context.addIssue({ code: "custom", path: ["stdioResult", "question"], message: "needs_input requires a question" });
    }
    if (result.output.trim().length === 0) {
      context.addIssue({ code: "custom", path: ["output"], message: "needs_input requires nonempty output" });
    }
  } else if (stdioResult.question !== null) {
    context.addIssue({ code: "custom", path: ["stdioResult", "question"], message: "question is only valid for needs_input" });
  }
});

const successfulValidatorExitSchema = z.strictObject({
  kind: z.literal("code"),
  code: z.literal(0),
});

export const agentValidatorVerdictSchema = z.strictObject({
  version: z.literal(2),
  decision: z.enum(["accept", "retry", "block"]),
  reason: nonemptyWellFormedCandidateField(64 * 1024, "reason"),
});

export const validatorOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    exit: processExitSchema,
    stdoutHash: sha256Schema.nullable(),
    stderrHash: sha256Schema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("agent"),
    exit: successfulValidatorExitSchema,
    verdict: z.union([validatorVerdictSchema, agentValidatorVerdictSchema]),
    resultBytesHash: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("native_agent"),
    nativeExecution: nativeExecutionReceiptSchema,
    verdict: agentValidatorVerdictSchema,
    resultBytesHash: sha256Schema,
  }).superRefine((outcome, context) => {
    if (outcome.resultBytesHash !== outcome.nativeExecution.finalTextSha256) {
      context.addIssue({ code: "custom", path: ["resultBytesHash"], message: "native verifier hash matches its execution receipt" });
    }
  }),
  z.strictObject({
    kind: z.literal("operator"),
    verdict: validatorVerdictSchema,
    resultBytesHash: sha256Schema,
    acceptance: operatorAcceptanceSchema,
  }).superRefine((outcome, context) => {
    if (outcome.acceptance.target !== "validator") {
      context.addIssue({ code: "custom", path: ["acceptance", "target"], message: "verdict acceptance must target a validator result" });
    }
    if (outcome.acceptance.resultBytesHash !== outcome.resultBytesHash) {
      context.addIssue({ code: "custom", path: ["resultBytesHash"], message: "accepted verdict hash must match its supplied result bytes" });
    }
  }),
]);

type ValidatorOutcomeValue = z.infer<typeof validatorOutcomeSchema>;
export function validatorOutcomePasses(outcome: ValidatorOutcomeValue): boolean {
  if (outcome.kind === "command") return outcome.exit.kind === "code" && outcome.exit.code === 0;
  return outcome.verdict.version === 1 ? outcome.verdict.passed : outcome.verdict.decision === "accept";
}

export const nodeAttemptOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("succeeded"),
    candidate: nodeResultSchema,
    validator: validatorOutcomeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("failed"),
    failure: failureInfoSchema,
    candidate: nodeResultSchema.nullable(),
    validator: validatorOutcomeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    block: blockInfoSchema,
    candidate: nodeResultSchema.nullable(),
    validator: validatorOutcomeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("cancelled"),
    candidate: nodeResultSchema.nullable().optional(),
    validator: validatorOutcomeSchema.nullable().optional(),
  }),
]).superRefine((outcome, context) => {
  if (outcome.kind === "succeeded" && outcome.validator && !validatorOutcomePasses(outcome.validator)) {
    context.addIssue({ code: "custom", path: ["validator"], message: "a succeeded attempt requires a passing validator" });
  }
  if (outcome.kind === "failed" || outcome.kind === "blocked") {
    if (outcome.validator !== null && outcome.candidate === null
      && !((outcome.validator.kind === "agent" || outcome.validator.kind === "native_agent")
        && outcome.validator.verdict.version === 2 && outcome.validator.verdict.decision !== "accept")) {
      context.addIssue({ code: "custom", path: ["candidate"], message: "validator outcomes require a committed candidate" });
    }
  }
  if (outcome.kind === "cancelled" && outcome.validator != null && outcome.candidate == null) {
    context.addIssue({ code: "custom", path: ["candidate"], message: "cancelled validator history retains its worker candidate" });
  }
  if (outcome.kind === "failed") {
    const rejected = outcome.failure.kind === "validator_rejection";
    const validatorFailed = outcome.validator !== null && !validatorOutcomePasses(outcome.validator);
    const validatorPassed = outcome.validator !== null && validatorOutcomePasses(outcome.validator);
    if (rejected && (outcome.candidate === null || !validatorFailed)) {
      context.addIssue({ code: "custom", path: ["validator"], message: "validator rejection requires a candidate and a failing validator result" });
    }
    const executionFailure = ["timeout", "process_error", "runtime_fault"].includes(outcome.failure.kind);
    const resultFailure = ["result_invalid", "result_too_large"].includes(outcome.failure.kind);
    if (["timeout", "process_error", "result_invalid", "result_too_large"].includes(outcome.failure.kind) && validatorPassed) {
      context.addIssue({ code: "custom", path: ["validator"], message: "execution failures cannot retain a passing validator result" });
    }
    if ((executionFailure || resultFailure) && (outcome.validator?.kind === "agent" || outcome.validator?.kind === "native_agent")
      && !(outcome.candidate === null && outcome.validator.verdict.version === 2 && outcome.validator.verdict.decision === "retry")) {
      context.addIssue({ code: "custom", path: ["validator"], message: "execution failures retain process evidence, not an agent verdict" });
    }
    if (validatorFailed && !rejected && !executionFailure && !(resultFailure && outcome.candidate === null)) {
      context.addIssue({ code: "custom", path: ["failure", "kind"], message: "failing validator results are rejections unless execution failed" });
    }
  }
});

export const judgmentDecisionSchema = z.strictObject({
  action: z.enum(["retry", "block", "fail"]),
  reason: boundedReason,
});

export const runOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed"), terminalOutput: boundedCandidateText(1024 * 1024) }),
  z.strictObject({ kind: z.literal("failed"), failure: runFailureInfoSchema }),
  z.strictObject({ kind: z.literal("blocked"), block: blockInfoSchema }),
  z.strictObject({ kind: z.literal("waiting"), waitId: waitIdSchema }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);

export type FailureInfo = z.infer<typeof failureInfoSchema>;
export type BlockInfo = z.infer<typeof blockInfoSchema>;
export type JudgmentDecision = z.infer<typeof judgmentDecisionSchema>;
export type NodeResult = z.infer<typeof nodeResultSchema>;
export type ValidatorOutcome = z.infer<typeof validatorOutcomeSchema>;
export type NodeAttemptOutcome = z.infer<typeof nodeAttemptOutcomeSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export function nodeResultStatus(candidate: NodeResult): "succeeded" | "success_and_complete" | "needs_input" {
  if (candidate.version === 2) return candidate.stdioResult.status;
  if (candidate.version === 3) return candidate.agentResult.status;
  return "succeeded";
}

export function nodeResultQuestion(candidate: NodeResult): string | null {
  if (candidate.version === 2) return candidate.stdioResult.question;
  if (candidate.version === 3) return candidate.agentResult.question;
  return null;
}
