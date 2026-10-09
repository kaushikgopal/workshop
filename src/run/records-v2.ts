import { isAbsolute } from "node:path";
import { z } from "zod";
import { canonicalHash, hashSourceText } from "../definition/hash-canonical-json.js";
import { checkChainV2 } from "../definition/check-chain.js";
import { nodeIdV2, workflowIdV2, workflowSchemaV2 } from "../definition/schema-v2.js";
import { resolvedWorkflowSettingsV2Schema } from "../definition/schema-resolved-v2.js";
import {
  attemptIdV2Schema,
  attemptPhaseV2Schema,
  attemptStatusV2Schema,
  blockInfoV2Schema,
  evidenceIdV2Schema,
  failureInfoV2Schema,
  judgmentDecisionV2Schema,
  judgmentIdV2Schema,
  nodeAttemptOutcomeV2Schema,
  occurrenceIdV2Schema,
  operatorResolutionV2Schema,
  runFailureInfoV2Schema,
  runIdV2Schema,
  runStatusV2Schema,
  desiredStateV2Schema,
  activationIdV2Schema,
  nodeResultV2Schema,
  validatorOutcomeV2Schema,
} from "./schema-v2.js";
import {
  executionIdV2Schema,
  incarnationIdV2Schema,
  processIncarnationV2Schema,
} from "../process/schema-v2.js";
import { sha256V2Schema, utcTimestampV2Schema } from "../util/schema-v2.js";

const positiveSafeIntegerV2 = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeSafeIntegerV2 = z.number().int().nonnegative().refine(Number.isSafeInteger);
const absolutePathV2 = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes("\u0000"),
  "path must be absolute and contain no NUL",
);
const terminalAttemptStatusesV2 = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

export const runChainSnapshotV2Schema = z.strictObject({
  order: z.array(nodeIdV2).min(1),
  predecessors: z.record(nodeIdV2, nodeIdV2.nullable()),
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

export const runSnapshotPathsV2Schema = z.strictObject({
  projectCwd: absolutePathV2,
  runDirectory: absolutePathV2,
  definitionSnapshot: absolutePathV2,
  worklog: absolutePathV2,
  inputDirectory: absolutePathV2,
  outputDirectory: absolutePathV2,
  captureDirectory: absolutePathV2,
});

export const runtimeManifestV2Schema = z.strictObject({
  durableVersion: z.string().min(1),
  integrationManifestHash: sha256V2Schema,
  taskVersions: z.strictObject({
    workflowRun: positiveSafeIntegerV2.optional(),
    nodeAttempt: positiveSafeIntegerV2.optional(),
    processExecution: positiveSafeIntegerV2.optional(),
    capacityGate: positiveSafeIntegerV2.optional(),
    failureJudgment: positiveSafeIntegerV2.optional(),
    scheduleWakeup: positiveSafeIntegerV2.optional(),
  }),
});

export const processEvidenceReferenceV2Schema = z.strictObject({
  executionId: executionIdV2Schema,
  incarnationId: incarnationIdV2Schema,
});

const judgmentApplicationReceiptV2Schema = z.strictObject({
  eventId: evidenceIdV2Schema,
  appliedAt: utcTimestampV2Schema,
});
export const persistedJudgmentV2Schema = z.strictObject({
  judgmentId: judgmentIdV2Schema,
  conversationId: positiveSafeIntegerV2,
  submissionRequestId: z.string().min(1),
  taskId: positiveSafeIntegerV2,
  status: z.enum(["pending", "decided", "failed", "cancelled"]),
  decision: judgmentDecisionV2Schema.nullable(),
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  decidedAt: utcTimestampV2Schema.nullable(),
  applicationReceipt: judgmentApplicationReceiptV2Schema.nullable(),
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

const pendingAttemptResultV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pending") }),
  z.strictObject({ kind: z.literal("candidate_committed"), candidate: nodeResultV2Schema }),
  z.strictObject({
    kind: z.literal("validation_committed"),
    candidate: nodeResultV2Schema,
    validator: validatorOutcomeV2Schema,
  }),
  z.strictObject({ kind: z.literal("settled"), outcome: nodeAttemptOutcomeV2Schema }),
]);

export const persistedNodeAttemptV2Schema = z.strictObject({
  attemptId: attemptIdV2Schema,
  number: positiveSafeIntegerV2,
  taskId: positiveSafeIntegerV2,
  status: attemptStatusV2Schema,
  phase: attemptPhaseV2Schema.nullable(),
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  elapsedMs: nonnegativeSafeIntegerV2.nullable(),
  workerExecutionId: executionIdV2Schema.nullable(),
  validatorExecutionId: executionIdV2Schema.nullable(),
  result: pendingAttemptResultV2Schema,
  processIncarnations: z.array(processEvidenceReferenceV2Schema),
  blockIds: z.array(z.string().min(1)),
  judgments: z.array(persistedJudgmentV2Schema),
}).superRefine((attempt, context) => {
  const isSettled = attempt.result.kind === "settled";
  if (terminalAttemptStatusesV2.has(attempt.status) !== isSettled) {
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
  const processIds = new Map<string, Set<string>>();
  const executionIds = new Set([attempt.workerExecutionId, attempt.validatorExecutionId].filter((id) => id !== null));
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

export const persistedNodeV2Schema = z.strictObject({
  nodeId: nodeIdV2,
  status: z.enum(["pending", "running", "succeeded", "failed", "blocked", "cancelled"]),
  successfulAttemptId: attemptIdV2Schema.nullable(),
  attempts: z.array(persistedNodeAttemptV2Schema),
}).superRefine((node, context) => {
  const attemptIds = new Set<string>();
  let successfulAttempt: z.infer<typeof persistedNodeAttemptV2Schema> | undefined;
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
  if (node.status === "pending" && node.attempts.length > 0) {
    context.addIssue({ code: "custom", path: ["attempts"], message: "pending nodes have no semantic attempts" });
  }
});

export const preflightStateV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not_configured") }),
  z.strictObject({ kind: z.literal("pending"), cacheKeyHash: sha256V2Schema, processExecutionIds: z.array(executionIdV2Schema) }),
  z.strictObject({ kind: z.literal("passed"), cacheKeyHash: sha256V2Schema, passedAt: utcTimestampV2Schema, processExecutionIds: z.array(executionIdV2Schema) }),
  z.strictObject({
    kind: z.literal("failed"),
    cacheKeyHash: sha256V2Schema,
    failure: failureInfoV2Schema,
    block: blockInfoV2Schema,
    processExecutionIds: z.array(executionIdV2Schema),
  }),
]);

const admittedRunDocumentV1Schema = z.strictObject({
  state: z.literal("ready"),
  runId: runIdV2Schema,
  workflowId: workflowIdV2,
  activationId: activationIdV2Schema,
  occurrenceId: occurrenceIdV2Schema,
  requestId: z.string().min(1).nullable(),
  admissionSequence: positiveSafeIntegerV2,
  admittedAt: utcTimestampV2Schema,
  sourceText: z.string(),
  sourceHash: sha256V2Schema,
  canonicalDefinition: workflowSchemaV2,
  canonicalHash: sha256V2Schema,
  resolvedSettings: resolvedWorkflowSettingsV2Schema,
  chain: runChainSnapshotV2Schema,
  paths: runSnapshotPathsV2Schema,
  runtimeManifest: runtimeManifestV2Schema,
  durable: z.strictObject({
    conversationId: positiveSafeIntegerV2,
    workflowTaskId: positiveSafeIntegerV2,
    capacityGateTaskId: positiveSafeIntegerV2.nullable().optional(),
  }),
  status: runStatusV2Schema,
  desiredState: desiredStateV2Schema,
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  currentNodeId: nodeIdV2.nullable(),
  currentAttemptId: attemptIdV2Schema.nullable(),
  block: blockInfoV2Schema.nullable(),
  failure: runFailureInfoV2Schema.nullable(),
  preflight: preflightStateV2Schema,
  nodes: z.array(persistedNodeV2Schema).min(1),
  resolutions: z.array(operatorResolutionV2Schema),
  terminalOutput: z.string().nullable(),
}).superRefine((run, context) => {
  if (run.sourceHash !== hashSourceText(run.sourceText)) {
    context.addIssue({ code: "custom", path: ["sourceHash"], message: "source hash matches the exact retained UTF-8 bytes" });
  }
  if (run.canonicalHash !== canonicalHash(run.canonicalDefinition)) {
    context.addIssue({ code: "custom", path: ["canonicalHash"], message: "canonical hash matches the frozen definition" });
  }
  try {
    const checkedChain = checkChainV2(run.canonicalDefinition);
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
    if (node.status === "pending") pendingSeen = true;
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
  const chainSucceeded = run.nodes.every((node) => node.status === "succeeded");
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
  eventId: evidenceIdV2Schema,
  type: z.literal("run_admitted"),
  runId: runIdV2Schema,
  workflowId: workflowIdV2,
  activationId: activationIdV2Schema,
  occurrenceId: occurrenceIdV2Schema,
  admissionSequence: positiveSafeIntegerV2,
  canonicalHash: sha256V2Schema,
  schedule: z.strictObject({
    slotAt: utcTimestampV2Schema,
    missedSlots: nonnegativeSafeIntegerV2,
    firstMissedSlotAt: utcTimestampV2Schema.nullable(),
    lastMissedSlotAt: utcTimestampV2Schema.nullable(),
  }).optional(),
  occurredAt: utcTimestampV2Schema,
});
const runStateChangedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("run_state_changed"),
  runId: runIdV2Schema,
  from: runStatusV2Schema,
  to: runStatusV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const runControlEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("run_control_requested"),
  runId: runIdV2Schema,
  action: z.enum(["pause", "resume", "stop"]),
  previousDesiredState: desiredStateV2Schema,
  desiredState: desiredStateV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const attemptStartedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("attempt_started"),
  runId: runIdV2Schema,
  nodeId: nodeIdV2,
  attemptId: attemptIdV2Schema,
  number: positiveSafeIntegerV2,
  occurredAt: utcTimestampV2Schema,
});
const workerResultCommittedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("worker_result_committed"),
  runId: runIdV2Schema,
  nodeId: nodeIdV2,
  attemptId: attemptIdV2Schema,
  candidate: nodeResultV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const validatorResultCommittedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("validator_result_committed"),
  runId: runIdV2Schema,
  nodeId: nodeIdV2,
  attemptId: attemptIdV2Schema,
  validator: validatorOutcomeV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const attemptSettledEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("attempt_settled"),
  runId: runIdV2Schema,
  nodeId: nodeIdV2,
  attemptId: attemptIdV2Schema,
  outcome: nodeAttemptOutcomeV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const runResolvedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("run_resolved"),
  runId: runIdV2Schema,
  resolution: operatorResolutionV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const judgmentAppliedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("judgment_applied"),
  runId: runIdV2Schema,
  nodeId: nodeIdV2,
  attemptId: attemptIdV2Schema,
  judgmentId: judgmentIdV2Schema,
  decision: judgmentDecisionV2Schema,
  occurredAt: utcTimestampV2Schema,
});
const runSettledEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("run_settled"),
  runId: runIdV2Schema,
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("completed"), terminalOutput: z.string() }),
    z.strictObject({ kind: z.literal("failed"), failure: runFailureInfoV2Schema }),
    z.strictObject({ kind: z.literal("blocked"), block: blockInfoV2Schema }),
    z.strictObject({ kind: z.literal("cancelled") }),
  ]),
  occurredAt: utcTimestampV2Schema,
});

const scheduleSlotsSkippedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("schedule_slots_skipped"),
  runId: runIdV2Schema,
  workflowId: workflowIdV2,
  activationId: activationIdV2Schema,
  firstSlotAt: utcTimestampV2Schema,
  lastSlotAt: utcTimestampV2Schema,
  skippedCount: positiveSafeIntegerV2,
  occurredAt: utcTimestampV2Schema,
});

const viewRefreshFailedEventV1Schema = z.strictObject({
  version: z.literal(1),
  eventId: evidenceIdV2Schema,
  type: z.literal("view_refresh_failed"),
  runId: runIdV2Schema,
  view: z.enum(["definition", "input", "output", "worklog"]),
  nodeId: nodeIdV2.nullable(),
  errorCode: z.string().min(1).max(128).nullable(),
  occurredAt: utcTimestampV2Schema,
});

export const workshopEventV1Schema = z.discriminatedUnion("type", [
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
  viewRefreshFailedEventV1Schema,
 ]);

export const workshopProcessV1Schema = z.strictObject({
  version: z.literal(1),
  runId: runIdV2Schema,
  nodeId: nodeIdV2.nullable(),
  attemptId: attemptIdV2Schema.nullable(),
  taskId: positiveSafeIntegerV2,
  recordedAt: utcTimestampV2Schema,
  process: processIncarnationV2Schema,
});

const workshopJudgmentFieldsV1 = {
  version: z.literal(1),
  runId: runIdV2Schema,
  nodeId: nodeIdV2,
  attemptId: attemptIdV2Schema,
  judgmentId: judgmentIdV2Schema,
  conversationId: positiveSafeIntegerV2,
  taskId: positiveSafeIntegerV2,
  submissionRequestId: z.string().min(1),
  recordedAt: utcTimestampV2Schema,
};
const judgmentDecisionRecordedV1Schema = z.strictObject({
  ...workshopJudgmentFieldsV1,
  phase: z.literal("decision_recorded"),
  decision: judgmentDecisionV2Schema,
  decidedAt: utcTimestampV2Schema,
});
const judgmentDecisionAppliedV1Schema = z.strictObject({
  ...workshopJudgmentFieldsV1,
  phase: z.literal("decision_applied"),
  decision: judgmentDecisionV2Schema,
  decidedAt: utcTimestampV2Schema,
  applicationReceipt: judgmentApplicationReceiptV2Schema,
}).superRefine((evidence, context) => {
  if (Date.parse(evidence.applicationReceipt.appliedAt) < Date.parse(evidence.decidedAt)) {
    context.addIssue({ code: "custom", path: ["applicationReceipt", "appliedAt"], message: "application receipt follows the decision" });
  }
});
export const workshopJudgmentV1Schema = z.discriminatedUnion("phase", [
  z.strictObject({ ...workshopJudgmentFieldsV1, phase: z.literal("prepared") }),
  judgmentDecisionRecordedV1Schema,
  judgmentDecisionAppliedV1Schema,
  z.strictObject({ ...workshopJudgmentFieldsV1, phase: z.literal("failed"), block: blockInfoV2Schema }),
  z.strictObject({ ...workshopJudgmentFieldsV1, phase: z.literal("cancelled") }),
]);

export type ProcessEvidenceReferenceV2 = z.infer<typeof processEvidenceReferenceV2Schema>;
export type PersistedJudgmentV2 = z.infer<typeof persistedJudgmentV2Schema>;
export type PersistedNodeAttemptV2 = z.infer<typeof persistedNodeAttemptV2Schema>;
export type PersistedNodeV2 = z.infer<typeof persistedNodeV2Schema>;
export type WorkflowRunDocumentV1 = z.infer<typeof workflowRunDocumentV1Schema>;
export type WorkshopEventV1 = z.infer<typeof workshopEventV1Schema>;
export type WorkshopProcessV1 = z.infer<typeof workshopProcessV1Schema>;
export type WorkshopJudgmentV1 = z.infer<typeof workshopJudgmentV1Schema>;
