import { isAbsolute } from "node:path";
import { z } from "zod";
import { canonicalHash, hashSourceText } from "../definition/hash-canonical-json.js";
import { checkChain } from "../definition/check-chain.js";
import { nodeIdSchema, workflowIdSchema, workflowSchema } from "../definition/schema.js";
import { resolvedWorkflowSettingsSchema } from "../definition/schema-resolved.js";
import {
  attemptIdSchema,
  attemptPhaseSchema,
  attemptStatusSchema,
  blockInfoSchema,
  evidenceIdSchema,
  failureInfoSchema,
  judgmentDecisionSchema,
  judgmentIdSchema,
  nodeAttemptOutcomeSchema,
  occurrenceIdSchema,
  operatorResolutionSchema,
  runFailureInfoSchema,
  runIdSchema,
  runStatusSchema,
  desiredStateSchema,
  activationIdSchema,
  nodeResultSchema,
  validatorOutcomeSchema,
} from "./schema.js";
import {
  executionIdSchema,
  incarnationIdSchema,
  processIncarnationSchema,
} from "../process/schema.js";
import { sha256Schema, utcTimestampSchema } from "../util/schema.js";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const absolutePath = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes("\u0000"),
  "path must be absolute and contain no NUL",
);
const terminalAttemptStatuses = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

export const runChainSnapshotSchema = z.strictObject({
  order: z.array(nodeIdSchema).min(1),
  predecessors: z.record(nodeIdSchema, nodeIdSchema.nullable()),
}).superRefine((chain, context) => {
  const seen = new Set<string>();
  for (const [index, nodeId] of chain.order.entries()) {
    if (seen.has(nodeId)) context.addIssue({ code: "custom", path: ["order", index], message: "chain order has unique nodes" });
    seen.add(nodeId);
    const expected = chain.order[index - 1] ?? null;
    if (chain.predecessors[nodeId] !== expected) {
      context.addIssue({ code: "custom", path: ["predecessors", nodeId], message: "predecessor snapshot follows chain order" });
    }
  }
  for (const nodeId of Object.keys(chain.predecessors)) {
    if (!seen.has(nodeId)) context.addIssue({ code: "custom", path: ["predecessors", nodeId], message: "predecessors contain only nodes in chain order" });
  }
});

export const runSnapshotPathsSchema = z.strictObject({
  projectCwd: absolutePath,
  runDirectory: absolutePath,
  archiveDirectory: absolutePath,
});

export const runtimeManifestSchema = z.strictObject({
  durableVersion: z.string().min(1),
  integrationManifestHash: sha256Schema,
  taskVersions: z.strictObject({
    workflowRun: positiveSafeInteger.optional(),
    nodeAttempt: positiveSafeInteger.optional(),
    processExecution: positiveSafeInteger.optional(),
    capacityGate: positiveSafeInteger.optional(),
    failureJudgment: positiveSafeInteger.optional(),
    scheduleWakeup: positiveSafeInteger.optional(),
  }),
});

export const processEvidenceReferenceSchema = z.strictObject({
  executionId: executionIdSchema,
  incarnationId: incarnationIdSchema,
});

const judgmentApplicationReceiptSchema = z.strictObject({
  eventId: evidenceIdSchema,
  appliedAt: utcTimestampSchema,
});
export const persistedJudgmentSchema = z.strictObject({
  judgmentId: judgmentIdSchema,
  conversationId: positiveSafeInteger,
  submissionRequestId: z.string().min(1),
  taskId: positiveSafeInteger,
  status: z.enum(["pending", "decided", "failed", "cancelled"]),
  decision: judgmentDecisionSchema.nullable(),
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  decidedAt: utcTimestampSchema.nullable(),
  applicationReceipt: judgmentApplicationReceiptSchema.nullable(),
}).superRefine((judgment, context) => {
  if (judgment.startedAt !== null && judgment.finishedAt !== null
    && Date.parse(judgment.finishedAt) < Date.parse(judgment.startedAt)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "judgment cannot finish before it starts" });
  }
  const hasDecision = judgment.decision !== null && judgment.decidedAt !== null && judgment.finishedAt !== null;
  if ((judgment.status === "decided") !== hasDecision
    || (judgment.status === "pending" && (judgment.finishedAt !== null || judgment.applicationReceipt !== null))
    || ((judgment.status === "failed" || judgment.status === "cancelled")
      && (judgment.decision !== null || judgment.decidedAt !== null || judgment.finishedAt === null || judgment.applicationReceipt !== null))) {
    context.addIssue({ code: "custom", path: ["status"], message: "judgment status matches its recorded decision and receipt" });
  }
  if (judgment.applicationReceipt !== null
    && (judgment.decidedAt === null || Date.parse(judgment.applicationReceipt.appliedAt) < Date.parse(judgment.decidedAt))) {
    context.addIssue({ code: "custom", path: ["applicationReceipt"], message: "application receipt follows the accepted decision" });
  }
});

const pendingAttemptResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pending") }),
  z.strictObject({ kind: z.literal("worker_failure_committed"), failure: failureInfoSchema, validator: validatorOutcomeSchema.nullable() }),
  z.strictObject({ kind: z.literal("candidate_committed"), candidate: nodeResultSchema }),
  z.strictObject({
    kind: z.literal("validation_committed"),
    candidate: nodeResultSchema,
    validator: validatorOutcomeSchema,
  }),
  z.strictObject({ kind: z.literal("settled"), outcome: nodeAttemptOutcomeSchema }),
]);

export const persistedNodeAttemptSchema = z.strictObject({
  attemptId: attemptIdSchema,
  number: positiveSafeInteger,
  taskId: positiveSafeInteger,
  status: attemptStatusSchema,
  phase: attemptPhaseSchema.nullable(),
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  elapsedMs: nonnegativeSafeInteger.nullable(),
  workerExecutionId: executionIdSchema.nullable(),
  validatorExecutionId: executionIdSchema.nullable(),
  supersededValidatorExecutionIds: z.array(executionIdSchema).optional(),
  result: pendingAttemptResultSchema,
  processIncarnations: z.array(processEvidenceReferenceSchema),
  blockIds: z.array(z.string().min(1)),
  judgments: z.array(persistedJudgmentSchema),
  failureEvidenceHash: sha256Schema.optional(),
  workerFailure: failureInfoSchema.optional(),
  feedback: z.strictObject({
    nodeId: nodeIdSchema,
    attemptId: attemptIdSchema,
    attemptNumber: positiveSafeInteger,
    text: z.string().refine((value) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 64 * 1024),
  }).optional(),
}).superRefine((attempt, context) => {
  if (attempt.feedback !== undefined && (attempt.feedback.attemptId !== attempt.attemptId || attempt.feedback.attemptNumber !== attempt.number)) {
    context.addIssue({ code: "custom", path: ["feedback"], message: "feedback identifies its source attempt" });
  }
  if (attempt.workerFailure !== undefined && (attempt.workerFailure.attemptId !== attempt.attemptId || attempt.status === "succeeded")) {
    context.addIssue({ code: "custom", path: ["workerFailure"], message: "worker failure identifies an unsuccessful source attempt" });
  }
  const isSettled = attempt.result.kind === "settled";
  if (terminalAttemptStatuses.has(attempt.status) !== isSettled) {
    context.addIssue({ code: "custom", path: ["result"], message: "terminal attempt state matches its committed domain outcome" });
  }
  if (attempt.result.kind === "settled") {
    const kind = attempt.result.outcome.kind;
    if ((attempt.status === "succeeded" && kind !== "succeeded")
      || (attempt.status === "failed" && kind !== "failed")
      || ((attempt.status === "interrupted" && kind !== "blocked")
        || (attempt.status === "cancelled" && kind !== "cancelled"))) {
      context.addIssue({ code: "custom", path: ["result", "outcome"], message: "attempt status matches its terminal outcome" });
    }
  }
  if ((attempt.startedAt === null || attempt.finishedAt === null) !== (attempt.elapsedMs === null)) {
    context.addIssue({ code: "custom", path: ["elapsedMs"], message: "elapsed time requires both attempt timestamps" });
  }
  if (attempt.startedAt !== null && attempt.finishedAt !== null && attempt.elapsedMs !== null
    && Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt) !== attempt.elapsedMs) {
    context.addIssue({ code: "custom", path: ["elapsedMs"], message: "elapsed time matches the recorded timestamp difference" });
  }
  const superseded = attempt.supersededValidatorExecutionIds ?? [];
  if (new Set(superseded).size !== superseded.length
    || superseded.some((id) => id === attempt.workerExecutionId || id === attempt.validatorExecutionId)) {
    context.addIssue({ code: "custom", path: ["supersededValidatorExecutionIds"], message: "superseded verifier IDs are unique and distinct from active executions" });
  }
  const processIds = new Map<string, Set<string>>();
  const executionIds = new Set([attempt.workerExecutionId, attempt.validatorExecutionId, ...(attempt.supersededValidatorExecutionIds ?? [])].filter((id) => id !== null));
  for (const [index, process] of attempt.processIncarnations.entries()) {
    const incarnations = processIds.get(process.executionId) ?? new Set<string>();
    if (incarnations.has(process.incarnationId)) {
      context.addIssue({ code: "custom", path: ["processIncarnations", index], message: "process incarnation references are unique" });
    }
    if (!executionIds.has(process.executionId)) {
      context.addIssue({ code: "custom", path: ["processIncarnations", index, "executionId"], message: "process evidence belongs to this attempt's worker or validator" });
    }
    incarnations.add(process.incarnationId);
    processIds.set(process.executionId, incarnations);
  }
  const blockIds = new Set<string>();
  for (const [index, blockId] of attempt.blockIds.entries()) {
    if (blockIds.has(blockId)) context.addIssue({ code: "custom", path: ["blockIds", index], message: "attempt block references are unique" });
    blockIds.add(blockId);
  }
  const judgmentIds = new Set<string>();
  for (const [index, judgment] of attempt.judgments.entries()) {
    if (judgmentIds.has(judgment.judgmentId)) {
      context.addIssue({ code: "custom", path: ["judgments", index, "judgmentId"], message: "judgment IDs are unique within an attempt" });
    }
    judgmentIds.add(judgment.judgmentId);
  }
});

export const persistedNodeSchema = z.strictObject({
  nodeId: nodeIdSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "blocked", "cancelled", "skipped"]),
  successfulAttemptId: attemptIdSchema.nullable(),
  attempts: z.array(persistedNodeAttemptSchema),
}).superRefine((node, context) => {
  const attemptIds = new Set<string>();
  let successfulAttempt: z.infer<typeof persistedNodeAttemptSchema> | undefined;
  for (const [index, attempt] of node.attempts.entries()) {
    if (attempt.number !== index + 1) {
      context.addIssue({ code: "custom", path: ["attempts", index, "number"], message: "attempt numbers are contiguous and ordered" });
    }
    if (attemptIds.has(attempt.attemptId)) {
      context.addIssue({ code: "custom", path: ["attempts", index, "attemptId"], message: "attempt IDs are unique within a node" });
    }
    attemptIds.add(attempt.attemptId);
    if (attempt.result.kind === "settled" && attempt.result.outcome.kind === "succeeded") successfulAttempt = attempt;
  }
  if ((node.status === "succeeded") !== (node.successfulAttemptId !== null)) {
    context.addIssue({ code: "custom", path: ["successfulAttemptId"], message: "only succeeded nodes reference a successful attempt" });
  }
  if (node.successfulAttemptId !== null
    && (successfulAttempt?.attemptId !== node.successfulAttemptId || node.attempts.at(-1)?.attemptId !== node.successfulAttemptId)) {
    context.addIssue({ code: "custom", path: ["successfulAttemptId"], message: "successful node points to its final succeeded attempt" });
  }
  if ((node.status === "pending" || node.status === "skipped") && node.attempts.length > 0) {
    context.addIssue({ code: "custom", path: ["attempts"], message: "pending nodes have no semantic attempts" });
  }
});

export const preflightStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not_configured") }),
  z.strictObject({ kind: z.literal("pending"), cacheKeyHash: sha256Schema, processExecutionIds: z.array(executionIdSchema) }),
  z.strictObject({ kind: z.literal("passed"), cacheKeyHash: sha256Schema, passedAt: utcTimestampSchema, processExecutionIds: z.array(executionIdSchema) }),
  z.strictObject({
    kind: z.literal("failed"),
    cacheKeyHash: sha256Schema,
    failure: failureInfoSchema,
    block: blockInfoSchema,
    processExecutionIds: z.array(executionIdSchema),
  }),
]);

const admittedRunDocumentV1Schema = z.strictObject({
  state: z.literal("ready"),
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: activationIdSchema,
  occurrenceId: occurrenceIdSchema,
  requestId: z.string().min(1).nullable(),
  admissionSequence: positiveSafeInteger,
  admittedAt: utcTimestampSchema,
  sourceText: z.string(),
  sourceHash: sha256Schema,
  canonicalDefinition: workflowSchema,
  canonicalHash: sha256Schema,
  resolvedSettings: resolvedWorkflowSettingsSchema,
  chain: runChainSnapshotSchema,
  paths: runSnapshotPathsSchema,
  runtimeManifest: runtimeManifestSchema,
  durable: z.strictObject({
    conversationId: positiveSafeInteger,
    workflowTaskId: positiveSafeInteger,
    capacityGateTaskId: positiveSafeInteger.nullable().optional(),
  }),
  status: runStatusSchema,
  desiredState: desiredStateSchema,
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  currentNodeId: nodeIdSchema.nullable(),
  currentAttemptId: attemptIdSchema.nullable(),
  block: blockInfoSchema.nullable(),
  failure: runFailureInfoSchema.nullable(),
  preflight: preflightStateSchema,
  nodes: z.array(persistedNodeSchema).min(1),
  resolutions: z.array(operatorResolutionSchema),
  terminalOutput: z.string().nullable(),
}).superRefine((run, context) => {
  if (run.sourceHash !== hashSourceText(run.sourceText)) {
    context.addIssue({ code: "custom", path: ["sourceHash"], message: "source hash matches the exact retained UTF-8 bytes" });
  }
  if (run.canonicalHash !== canonicalHash(run.canonicalDefinition)) {
    context.addIssue({ code: "custom", path: ["canonicalHash"], message: "canonical hash matches the frozen definition" });
  }
  try {
    const checkedChain = checkChain(run.canonicalDefinition);
    const expectedPredecessors = Object.fromEntries(checkedChain.order.map((nodeId) => [
      nodeId,
      checkedChain.prev.get(nodeId) ?? null,
    ]));
    if (canonicalHash(checkedChain.order) !== canonicalHash(run.chain.order)
      || canonicalHash(expectedPredecessors) !== canonicalHash(run.chain.predecessors)) {
      context.addIssue({ code: "custom", path: ["chain"], message: "chain snapshot matches the checked frozen topology" });
    }
  } catch (error) {
    context.addIssue({ code: "custom", path: ["canonicalDefinition", "nodes"], message: error instanceof Error ? error.message : "frozen topology is invalid" });
  }
  const nodeIds = new Set(run.nodes.map((node) => node.nodeId));
  const attemptIds = new Set<string>();
  const resolutionIds = new Set<string>();
  for (const [nodeIndex, node] of run.nodes.entries()) {
    for (const [attemptIndex, attempt] of node.attempts.entries()) {
      if (attemptIds.has(attempt.attemptId)) {
        context.addIssue({ code: "custom", path: ["nodes", nodeIndex, "attempts", attemptIndex, "attemptId"], message: "attempt IDs are unique within the run" });
      }
      attemptIds.add(attempt.attemptId);
    }
  }
  for (const [index, resolution] of run.resolutions.entries()) {
    if (resolutionIds.has(resolution.resolutionId)) {
      context.addIssue({ code: "custom", path: ["resolutions", index, "resolutionId"], message: "resolution IDs are unique within the run" });
    }
    resolutionIds.add(resolution.resolutionId);
  }
  if (run.workflowId !== run.canonicalDefinition.id) {
    context.addIssue({ code: "custom", path: ["workflowId"], message: "run identity matches its frozen definition" });
  }
  if (run.chain.order.length !== run.nodes.length
    || run.chain.order.some((nodeId, index) => nodeId !== run.nodes[index]?.nodeId)) {
    context.addIssue({ code: "custom", path: ["chain", "order"], message: "persisted nodes follow the frozen chain order" });
  }
  if (Object.keys(run.resolvedSettings.nodes).length !== nodeIds.size
    || run.nodes.some((node) => run.resolvedSettings.nodes[node.nodeId] === undefined)) {
    context.addIssue({ code: "custom", path: ["resolvedSettings"], message: "every frozen node has exactly one resolved setting" });
  }
  const currentNode = run.currentNodeId === null ? undefined : run.nodes.find((node) => node.nodeId === run.currentNodeId);
  if (run.currentNodeId !== null && currentNode === undefined) {
    context.addIssue({ code: "custom", path: ["currentNodeId"], message: "current node exists in the frozen chain" });
  }
  if (run.currentAttemptId !== null
    && (currentNode?.attempts.at(-1)?.attemptId !== run.currentAttemptId)) {
    context.addIssue({ code: "custom", path: ["currentAttemptId"], message: "current attempt belongs to the current node and is its latest attempt" });
  }
  if ((currentNode?.attempts.length ?? 0) === 0 && run.currentAttemptId !== null) {
    context.addIssue({ code: "custom", path: ["currentAttemptId"], message: "current attempt is null before the first attempt" });
  }
  if (currentNode !== undefined && currentNode.status === "succeeded") {
    context.addIssue({ code: "custom", path: ["currentNodeId"], message: "current node is not already succeeded" });
  }
  if (run.status === "completed" && (run.currentNodeId !== null || run.currentAttemptId !== null)) {
    context.addIssue({ code: "custom", path: ["currentNodeId"], message: "completed runs have no current node or attempt" });
  }
  let nonSuccessSeen = false;
  let pendingSeen = false;
  for (const [index, node] of run.nodes.entries()) {
    if (node.status === "pending" || node.status === "skipped") pendingSeen = true;
    else if (node.status === "succeeded") {
      if (nonSuccessSeen || pendingSeen) context.addIssue({ code: "custom", path: ["nodes", index, "status"], message: "succeeded nodes form a prefix" });
    } else {
      if (pendingSeen || nonSuccessSeen) context.addIssue({ code: "custom", path: ["nodes", index, "status"], message: "one current non-success node precedes a pending suffix" });
      nonSuccessSeen = true;
    }
  }
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  if (terminal !== (run.finishedAt !== null)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "terminal run state matches its finish timestamp" });
  }
  const waitingForCapacity = run.durable.capacityGateTaskId !== null && run.durable.capacityGateTaskId !== undefined;
  if ((run.status === "queued" && run.startedAt !== null && !waitingForCapacity)
    || (waitingForCapacity && run.status !== "queued")
    || (["running", "completed", "failed"].includes(run.status) && run.startedAt === null)) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "run start time matches its lifecycle state" });
  }
  if ((run.status === "blocked") !== (run.block !== null)) {
    context.addIssue({ code: "custom", path: ["block"], message: "only blocked runs carry a current block" });
  }
  if ((run.status === "failed") !== (run.failure !== null)) {
    context.addIssue({ code: "custom", path: ["failure"], message: "failed runs carry terminal failure data" });
  }
  if ((run.status === "completed") !== (run.terminalOutput !== null)) {
    context.addIssue({ code: "custom", path: ["terminalOutput"], message: "completed runs retain terminal output, including an empty string" });
  }
  if (run.status === "cancelled" && run.desiredState !== "stopped") {
    context.addIssue({ code: "custom", path: ["desiredState"], message: "cancelled runs require stopped intent" });
  }
  const firstSkipped = run.nodes.findIndex((node) => node.status === "skipped");
  const completingNode = firstSkipped < 0 ? undefined : run.nodes[firstSkipped - 1];
  const completingAttempt = completingNode?.attempts.at(-1);
  const earlyCompletion = completingAttempt?.result.kind === "settled" && completingAttempt.result.outcome.kind === "succeeded"
    && completingAttempt.result.outcome.candidate.version === 2
    && completingAttempt.result.outcome.candidate.stdioResult.status === "success_and_complete";
  if (firstSkipped >= 0 && (run.status !== "completed" || !earlyCompletion
    || run.nodes.slice(firstSkipped).some((node) => node.status !== "skipped"))) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "skipped nodes form the suffix of accepted early completion" });
  }
  const chainSucceeded = run.nodes.every((node) => node.status === "succeeded" || node.status === "skipped");
  if ((run.status === "completed") !== chainSucceeded) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "a fully succeeded chain is completed, and completed runs have a fully succeeded chain" });
  }
  if (run.preflight.kind === "failed" && run.status === "blocked"
    && run.block?.blockId !== run.preflight.block.blockId) {
    context.addIssue({ code: "custom", path: ["preflight"], message: "an unresolved preflight failure remains the current run block" });
  }
});

export const workflowRunDocumentV1Schema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("uninitialized") }),
  admittedRunDocumentV1Schema,
]);

const runAdmittedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("run_admitted"),
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: activationIdSchema,
  occurrenceId: occurrenceIdSchema,
  admissionSequence: positiveSafeInteger,
  canonicalHash: sha256Schema,
  schedule: z.strictObject({
    slotAt: utcTimestampSchema,
    missedSlots: nonnegativeSafeInteger,
    firstMissedSlotAt: utcTimestampSchema.nullable(),
    lastMissedSlotAt: utcTimestampSchema.nullable(),
  }).optional(),
  occurredAt: utcTimestampSchema,
});
const runStateChangedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("run_state_changed"),
  runId: runIdSchema,
  from: runStatusSchema,
  to: runStatusSchema,
  occurredAt: utcTimestampSchema,
});
const runControlEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("run_control_requested"),
  runId: runIdSchema,
  action: z.enum(["pause", "resume", "stop"]),
  previousDesiredState: desiredStateSchema,
  desiredState: desiredStateSchema,
  occurredAt: utcTimestampSchema,
});
const attemptStartedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("attempt_started"),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  number: positiveSafeInteger,
  occurredAt: utcTimestampSchema,
});
const workerResultCommittedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("worker_result_committed"),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  candidate: nodeResultSchema,
  occurredAt: utcTimestampSchema,
});
const validatorResultCommittedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("validator_result_committed"),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  validator: validatorOutcomeSchema,
  occurredAt: utcTimestampSchema,
});
const attemptSettledEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("attempt_settled"),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  outcome: nodeAttemptOutcomeSchema,
  occurredAt: utcTimestampSchema,
});
const runResolvedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("run_resolved"),
  runId: runIdSchema,
  resolution: operatorResolutionSchema,
  occurredAt: utcTimestampSchema,
});
const judgmentAppliedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("judgment_applied"),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  judgmentId: judgmentIdSchema,
  decision: judgmentDecisionSchema,
  occurredAt: utcTimestampSchema,
});
const runSettledEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("run_settled"),
  runId: runIdSchema,
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("completed"), terminalOutput: z.string() }),
    z.strictObject({ kind: z.literal("failed"), failure: runFailureInfoSchema }),
    z.strictObject({ kind: z.literal("blocked"), block: blockInfoSchema }),
    z.strictObject({ kind: z.literal("cancelled") }),
  ]),
  occurredAt: utcTimestampSchema,
});

const scheduleSlotsSkippedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("schedule_slots_skipped"),
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: activationIdSchema,
  firstSlotAt: utcTimestampSchema,
  lastSlotAt: utcTimestampSchema,
  skippedCount: positiveSafeInteger,
  occurredAt: utcTimestampSchema,
});

const viewProjectionFailedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdSchema,
  type: z.literal("view_projection_failed"),
  runId: runIdSchema,
  nodeId: nodeIdSchema.nullable(),
  message: z.string().min(1).max(4096),
  occurredAt: utcTimestampSchema,
});

export const workshopEventV1Schema = z.discriminatedUnion("type", [
  viewProjectionFailedEventV1Schema,
  runAdmittedEventV1Schema,
  runStateChangedEventV1Schema,
  runControlEventV1Schema,
  attemptStartedEventV1Schema,
  workerResultCommittedEventV1Schema,
  validatorResultCommittedEventV1Schema,
  attemptSettledEventV1Schema,
  runResolvedEventV1Schema,
  judgmentAppliedEventV1Schema,
  runSettledEventV1Schema,
  scheduleSlotsSkippedEventV1Schema,
 ]);

export const workshopProcessV1Schema = z.strictObject({
  version: z.literal(1),
  runId: runIdSchema,
  nodeId: nodeIdSchema.nullable(),
  attemptId: attemptIdSchema.nullable(),
  taskId: positiveSafeInteger,
  recordedAt: utcTimestampSchema,
  process: processIncarnationSchema,
});

const workshopJudgmentFieldsV1 = {
  version: z.literal(1),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  judgmentId: judgmentIdSchema,
  conversationId: positiveSafeInteger,
  taskId: positiveSafeInteger,
  submissionRequestId: z.string().min(1),
  recordedAt: utcTimestampSchema,
};
const judgmentDecisionRecordedV1Schema = z.strictObject({
  ...workshopJudgmentFieldsV1,
  phase: z.literal("decision_recorded"),
  decision: judgmentDecisionSchema,
  decidedAt: utcTimestampSchema,
});
const judgmentDecisionAppliedV1Schema = z.strictObject({
  ...workshopJudgmentFieldsV1,
  phase: z.literal("decision_applied"),
  decision: judgmentDecisionSchema,
  decidedAt: utcTimestampSchema,
  applicationReceipt: judgmentApplicationReceiptSchema,
}).superRefine((evidence, context) => {
  if (Date.parse(evidence.applicationReceipt.appliedAt) < Date.parse(evidence.decidedAt)) {
    context.addIssue({ code: "custom", path: ["applicationReceipt", "appliedAt"], message: "application receipt follows the decision" });
  }
});
export const workshopJudgmentV1Schema = z.discriminatedUnion("phase", [
  z.strictObject({ ...workshopJudgmentFieldsV1, phase: z.literal("prepared") }),
  judgmentDecisionRecordedV1Schema,
  judgmentDecisionAppliedV1Schema,
  z.strictObject({ ...workshopJudgmentFieldsV1, phase: z.literal("failed"), block: blockInfoSchema }),
  z.strictObject({ ...workshopJudgmentFieldsV1, phase: z.literal("cancelled") }),
]);

export type PersistedJudgment = z.infer<typeof persistedJudgmentSchema>;
export type PersistedNodeAttempt = z.infer<typeof persistedNodeAttemptSchema>;
export type PersistedNode = z.infer<typeof persistedNodeSchema>;
export type WorkflowRunDocumentV1 = z.infer<typeof workflowRunDocumentV1Schema>;
export type WorkshopEventV1 = z.infer<typeof workshopEventV1Schema>;
export type WorkshopProcessV1 = z.infer<typeof workshopProcessV1Schema>;
export type WorkshopJudgmentV1 = z.infer<typeof workshopJudgmentV1Schema>;
