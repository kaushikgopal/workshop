import { isAbsolute } from "node:path";
import { z } from "zod";
import { nodeIdSchema, workflowIdSchema } from "../definition/schema.js";
import { resolvedNodeSettingsSchema } from "../definition/schema-resolved.js";
import {
  activationIdSchema,
  attemptIdSchema,
  attemptPhaseSchema,
  attemptStatusSchema,
  blockInfoSchema,
  desiredStateSchema,
  evidenceIdSchema,
  failureInfoSchema,
  judgmentDecisionSchema,
  occurrenceIdSchema,
  operatorAcceptanceSchema,
  runIdSchema,
  runStatusSchema,
  humanWaitSchema,
  runFailureInfoSchema,
} from "../run/schema.js";
import {
  executionIdSchema,
  processCaptureSchema,
  processIncarnationSchema,
} from "../process/schema.js";
import {
  byteCountSchema,
  elapsedMillisecondsSchema,
  sha256Schema,
  utcTimestampSchema,
} from "../util/schema.js";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const boundedText = (maxBytes: number) => z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
  `text must be at most ${maxBytes} UTF-8 bytes`,
);
const logContent = z.string().refine((value) => value.isWellFormed(), "log content must be well-formed Unicode");
const absolutePath = z.string().min(1).refine((value) => isAbsolute(value) && !value.includes("\u0000"), "path must be absolute and contain no NUL");
const timestampMilliseconds = (value: string): number => Date.parse(value);
type ProcessIncarnationValue = z.infer<typeof processIncarnationSchema>;
type BlockInfoValue = z.infer<typeof blockInfoSchema>;
type IssuePath = (string | number)[];
type ReportIssue = (path: IssuePath, message: string) => void;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameBlock(left: BlockInfoValue, right: BlockInfoValue): boolean {
  return left.blockId === right.blockId && left.kind === right.kind && left.reason === right.reason
    && left.blockedAt === right.blockedAt && left.nodeId === right.nodeId && left.attemptId === right.attemptId;
}

function sameFailure(
  left: z.infer<typeof failureInfoSchema>,
  right: z.infer<typeof failureInfoSchema>,
): boolean {
  return left.kind === right.kind && left.message === right.message && left.failedAt === right.failedAt
    && left.nodeId === right.nodeId && left.attemptId === right.attemptId;
}

function checkProcessIncarnations(
  processes: readonly ProcessIncarnationValue[],
  report: ReportIssue,
  path: IssuePath,
  expectedRole?: "worker" | "validator" | "preflight",
): void {
  const groups = new Map<string, { index: number; value: ProcessIncarnationValue }[]>();
  const incarnationIds = new Set<string>();
  for (const [index, process] of processes.entries()) {
    if (expectedRole !== undefined && process.role !== expectedRole) {
      report([...path, index, "role"], `process evidence must have role ${expectedRole}`);
    }
    if (incarnationIds.has(process.incarnationId)) {
      report([...path, index, "incarnationId"], "incarnation IDs must be unique within the execution scope");
    }
    incarnationIds.add(process.incarnationId);
    const group = groups.get(process.executionId) ?? [];
    group.push({ index, value: process });
    groups.set(process.executionId, group);
  }

  for (const incarnations of groups.values()) {
    let previous: ProcessIncarnationValue | undefined;
    for (const [numberIndex, entry] of incarnations.entries()) {
      const process = entry.value;
      const processPath = [...path, entry.index];
      if (process.incarnationNumber !== numberIndex + 1 || process.incarnationNumber > 3) {
        report([...processPath, "incarnationNumber"], "incarnations must be contiguous from one with at most two relaunches");
      }
      if (process.incarnationNumber > 1) {
        if (process.replay !== "safe") {
          report([...processPath, "replay"], "process replays require replay=safe");
        }
        if (previous === undefined || previous.status !== "blocked" || previous.exit !== null
          || previous.cleanupState !== "confirmed_dead" || previous.finishedAt === null) {
          report(processPath, "a replacement requires a finished, exitless blocked incarnation with confirmed group death");
        } else {
          if (previous.replay !== "safe" || previous.role !== process.role
            || previous.commandHash !== process.commandHash || previous.deadlineAt !== process.deadlineAt) {
            report(processPath, "safe replays preserve role, replay policy, command hash, and deadline");
          }
          if (process.launchIntentAt === null
            || timestampMilliseconds(process.launchIntentAt) < timestampMilliseconds(previous.finishedAt)) {
            report([...processPath, "launchIntentAt"], "replacement launch follows confirmed prior completion");
          }
        }
      }
      previous = process;
    }
  }
}


const activationStateSchema = z.enum(["active", "paused", "stopped", "exhausted"]);

const workflowActivationDtoSchema = z.strictObject({
  activationId: activationIdSchema,
  state: activationStateSchema,
  admittedCount: nonnegativeSafeInteger,
  maxRuns: z.union([positiveSafeInteger, z.literal("unlimited")]),
  activatedAt: utcTimestampSchema,
  nextDueAt: utcTimestampSchema.nullable(),
  skippedSlots: nonnegativeSafeInteger.default(0),
  lastSkippedSlotAt: utcTimestampSchema.nullable().default(null),
});

const serviceMetadataDtoSchema = z.strictObject({
  state: z.enum(["starting", "running", "stopping", "stopped", "unavailable"]),
  pid: positiveSafeInteger.nullable(),
  bootId: z.string().min(1).nullable(),
  startedAt: utcTimestampSchema.nullable(),
  socketPath: absolutePath.nullable(),
  error: boundedText(64 * 1024).nullable(),
});

export const runSummaryDtoSchema = z.strictObject({
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: activationIdSchema,
  occurrenceId: occurrenceIdSchema,
  definitionHash: sha256Schema,
  status: runStatusSchema,
  desiredState: desiredStateSchema,
  waitingForCapacity: z.boolean(),
  wait: humanWaitSchema.nullable().optional(),
  admittedAt: utcTimestampSchema,
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  currentNodeId: nodeIdSchema.nullable(),
  currentAttemptNumber: positiveSafeInteger.nullable(),
  block: blockInfoSchema.nullable(),
  failure: runFailureInfoSchema.nullable(),
  terminalOutput: boundedText(1024 * 1024).nullable(),
}).superRefine((summary, context) => {
  const terminal = ["completed", "failed", "cancelled"].includes(summary.status);
  if (terminal !== (summary.finishedAt !== null)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "terminal runs require a finish time and nonterminal runs forbid one" });
  }
  if ((summary.status === "queued" && summary.startedAt !== null && !summary.waitingForCapacity)
    || (summary.waitingForCapacity && summary.status !== "queued")
    || (summary.status === "running" && summary.startedAt === null)
    || ((summary.status === "completed" || summary.status === "failed") && summary.startedAt === null)) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "queued runs have no start time; running and completed runs require one" });
  }
  if (summary.startedAt !== null && timestampMilliseconds(summary.startedAt) < timestampMilliseconds(summary.admittedAt)) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "run start cannot precede admission" });
  }
  if (summary.startedAt !== null && summary.finishedAt !== null
    && timestampMilliseconds(summary.finishedAt) < timestampMilliseconds(summary.startedAt)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "run finish cannot precede start" });
  }
  if (summary.status === "cancelled" && summary.desiredState !== "stopped") {
    context.addIssue({ code: "custom", path: ["desiredState"], message: "cancelled runs require stopped intent" });
  }
  if (summary.currentAttemptNumber !== null && summary.currentNodeId === null) {
    context.addIssue({ code: "custom", path: ["currentAttemptNumber"], message: "current attempt requires a current node" });
  }
  if ((summary.status === "blocked") !== (summary.block !== null)) {
    context.addIssue({ code: "custom", path: ["block"], message: "only blocked runs carry a current block" });
  }
  if (summary.status === "failed" && summary.failure === null) {
    context.addIssue({ code: "custom", path: ["failure"], message: "failed runs require failure data" });
  }
  if (summary.failure !== null && !["running", "paused", "blocked", "failed"].includes(summary.status)) {
    context.addIssue({ code: "custom", path: ["failure"], message: "failure data is retained only while resolving or reporting a run failure" });
  }
  if (summary.failure?.kind === "operator" && summary.status !== "failed") {
    context.addIssue({ code: "custom", path: ["failure", "kind"], message: "operator termination is a terminal run failure" });
  }
  if (summary.failure !== null && summary.failure.kind !== "operator"
    && summary.failure.attemptId !== null && summary.failure.nodeId === null) {
    context.addIssue({ code: "custom", path: ["failure", "nodeId"], message: "attempt failures identify their node" });
  }
  if (summary.failure !== null && summary.finishedAt !== null
    && timestampMilliseconds(summary.failure.failedAt) > timestampMilliseconds(summary.finishedAt)) {
    context.addIssue({ code: "custom", path: ["failure", "failedAt"], message: "failure cannot follow terminal completion" });
  }
  if ((summary.status === "completed") !== (summary.terminalOutput !== null)) {
    context.addIssue({ code: "custom", path: ["terminalOutput"], message: "completed runs require terminal output, including an empty string" });
  }
});

const workflowStatusDtoSchema = z.strictObject({
  workflowId: workflowIdSchema,
  description: boundedText(4 * 1024).nullable(),
  definitionHash: sha256Schema.nullable(),
  configurationError: boundedText(64 * 1024).nullable(),
  activation: workflowActivationDtoSchema.nullable(),
  unresolvedRun: runSummaryDtoSchema.nullable(),
  latestRun: runSummaryDtoSchema.nullable().optional(),
}).superRefine((workflow, context) => {
  if (workflow.latestRun && workflow.latestRun.workflowId !== workflow.workflowId) {
    context.addIssue({ code: "custom", path: ["latestRun", "workflowId"], message: "latest run belongs to a different workflow" });
  }
  if (workflow.unresolvedRun && workflow.unresolvedRun.workflowId !== workflow.workflowId) {
    context.addIssue({ code: "custom", path: ["unresolvedRun", "workflowId"], message: "unresolved run belongs to a different workflow" });
  }
  if (workflow.unresolvedRun && ["completed", "failed", "cancelled"].includes(workflow.unresolvedRun.status)) {
    context.addIssue({ code: "custom", path: ["unresolvedRun", "status"], message: "terminal runs are not unresolved" });
  }
  if (workflow.unresolvedRun && workflow.activation?.activationId !== workflow.unresolvedRun.activationId) {
    context.addIssue({ code: "custom", path: ["unresolvedRun", "activationId"], message: "unresolved run belongs to a different activation" });
  }
});

export const statusDtoSchema = z.strictObject({
  version: z.literal(2),
  generatedAt: utcTimestampSchema,
  installationId: z.string().min(1),
  service: serviceMetadataDtoSchema,
  workflows: z.array(workflowStatusDtoSchema),
}).superRefine((status, context) => {
  let previousId: string | undefined;
  for (const [index, workflow] of status.workflows.entries()) {
    if (previousId !== undefined && compareCodeUnits(previousId, workflow.workflowId) >= 0) {
      context.addIssue({ code: "custom", path: ["workflows", index], message: "workflows must be unique and sorted by ID" });
    }
    previousId = workflow.workflowId;
  }
});

export const runsDtoSchema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdSchema,
  total: nonnegativeSafeInteger,
  truncated: z.boolean(),
  runs: z.array(runSummaryDtoSchema),
}).superRefine((projection, context) => {
  if (projection.total < projection.runs.length || projection.truncated !== (projection.total > projection.runs.length)) {
    context.addIssue({ code: "custom", path: ["truncated"], message: "truncation must match the total and returned run count" });
  }
  let previous: z.infer<typeof runSummaryDtoSchema> | undefined;
  const runIds = new Set<string>();
  for (const [index, run] of projection.runs.entries()) {
    if (runIds.has(run.runId)) context.addIssue({ code: "custom", path: ["runs", index, "runId"], message: "run IDs must be unique" });
    runIds.add(run.runId);
    if (run.workflowId !== projection.workflowId) {
      context.addIssue({ code: "custom", path: ["runs", index, "workflowId"], message: "run belongs to a different workflow" });
    }
    if (previous !== undefined) {
      const timeOrder = timestampMilliseconds(previous.admittedAt) - timestampMilliseconds(run.admittedAt);
      if (timeOrder < 0 || (timeOrder === 0 && compareCodeUnits(previous.runId, run.runId) >= 0)) {
        context.addIssue({ code: "custom", path: ["runs", index], message: "runs must be unique, newest first, with run ID as the stable tie-break" });
      }
    }
    previous = run;
  }
});

const attemptProcessSchema = processIncarnationSchema.refine(
  (process) => process.role !== "preflight",
  "preflight processes belong to the run, not a semantic attempt",
);

/** `sha256` hashes retained evidence; result `sourceBytesHash` hashes exact checked file bytes. */
const evidenceReferenceFields = {
  evidenceId: evidenceIdSchema,
  sha256: sha256Schema,
  byteCount: byteCountSchema,
  recordedAt: utcTimestampSchema,
};
const evidenceReferenceDtoSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...evidenceReferenceFields,
    kind: z.literal("candidate"),
    sourceBytesHash: sha256Schema,
  }),
  z.strictObject({
    ...evidenceReferenceFields,
    kind: z.literal("verdict"),
    sourceBytesHash: sha256Schema,
  }),
  z.strictObject({
    ...evidenceReferenceFields,
    kind: z.literal("judgment"),
    sourceBytesHash: z.null(),
    decision: judgmentDecisionSchema,
  }),
]);

export const attemptDetailDtoSchema = z.strictObject({
  attemptId: attemptIdSchema,
  number: positiveSafeInteger,
  status: attemptStatusSchema,
  phase: attemptPhaseSchema.nullable(),
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  elapsedMs: elapsedMillisecondsSchema.nullable(),
  workerExecutionId: executionIdSchema.nullable(),
  validatorExecutionId: executionIdSchema.nullable(),
  supersededValidatorExecutionIds: z.array(executionIdSchema).optional(),
  candidate: evidenceReferenceDtoSchema.nullable(),
  verdict: evidenceReferenceDtoSchema.nullable(),
  judgments: z.array(evidenceReferenceDtoSchema),
  operatorAcceptances: z.array(operatorAcceptanceSchema),
  blocks: z.array(blockInfoSchema),
  failure: failureInfoSchema.nullable(),
  workerFailure: failureInfoSchema.optional(),
  processes: z.array(attemptProcessSchema),
}).superRefine((attempt, context) => {
  const report: ReportIssue = (path, message) => context.addIssue({ code: "custom", path, message });
  const blockIds = new Set<string>();
  let previousBlockTime: number | undefined;
  for (const [index, block] of attempt.blocks.entries()) {
    if (blockIds.has(block.blockId)) report(["blocks", index, "blockId"], "block IDs must be unique within an attempt");
    blockIds.add(block.blockId);
    if (block.nodeId === null) report(["blocks", index, "nodeId"], "attempt-history blocks identify their node");
    if (block.attemptId !== null && block.attemptId !== attempt.attemptId) {
      report(["blocks", index, "attemptId"], "attempt-scoped blocks identify their attempt");
    }
    const blockedAt = timestampMilliseconds(block.blockedAt);
    if (previousBlockTime !== undefined && blockedAt < previousBlockTime) {
      report(["blocks", index, "blockedAt"], "block history must be ordered by time");
    }
    previousBlockTime = blockedAt;
    if (attempt.startedAt !== null && blockedAt < timestampMilliseconds(attempt.startedAt)) {
      report(["blocks", index, "blockedAt"], "attempt blocks cannot precede attempt start");
    }
    // WorkflowRun records judge/orchestrator blocks after the child attempt commits its outcome.
    if (attempt.finishedAt !== null && blockedAt > timestampMilliseconds(attempt.finishedAt)
      && attempt.status !== "failed" && attempt.status !== "interrupted") {
      report(["blocks", index, "blockedAt"], "only post-attempt failure and interruption decisions may follow attempt finish");
    }
  }

  if (attempt.candidate && attempt.candidate.kind !== "candidate") {
    report(["candidate", "kind"], "candidate references must use candidate evidence");
  }
  if (attempt.verdict && attempt.verdict.kind !== "verdict") {
    report(["verdict", "kind"], "verdict references must use verdict evidence");
  }
  for (const [index, judgment] of attempt.judgments.entries()) {
    if (judgment.kind !== "judgment") report(["judgments", index, "kind"], "judgment references must use judgment evidence");
  }

  const acceptanceIds = new Set<string>();
  let previousAcceptanceTime: number | undefined;
  for (const [index, acceptance] of attempt.operatorAcceptances.entries()) {
    if (acceptanceIds.has(acceptance.resolutionId)) {
      report(["operatorAcceptances", index, "resolutionId"], "acceptance resolution IDs must be unique within an attempt");
    }
    acceptanceIds.add(acceptance.resolutionId);
    if (!attempt.blocks.some((block) => sameBlock(block, acceptance.sourceBlock))) {
      report(["operatorAcceptances", index, "sourceBlock", "blockId"], "accepted results must retain the exact source block in attempt history");
    }
    if (acceptance.sourceBlock.attemptId !== attempt.attemptId) {
      report(["operatorAcceptances", index, "sourceBlock", "attemptId"], "acceptance source block must identify its attempt");
    }
    if (acceptance.sourceBlock.kind !== "external_outcome_unknown") {
      report(["operatorAcceptances", index, "sourceBlock", "kind"], "only unknown external outcomes can be accepted");
    }
    const resolvedAt = timestampMilliseconds(acceptance.resolvedAt);
    if (resolvedAt < timestampMilliseconds(acceptance.sourceBlock.blockedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "acceptance follows its source block");
    }
    const blocksBeforeAcceptance = attempt.blocks.filter((block) =>
      timestampMilliseconds(block.blockedAt) <= resolvedAt);
    const latestBlockAtAcceptance = blocksBeforeAcceptance.at(-1);
    if (latestBlockAtAcceptance === undefined || !sameBlock(latestBlockAtAcceptance, acceptance.sourceBlock)) {
      report(["operatorAcceptances", index, "sourceBlock"], "acceptance identifies the latest block at its resolution time");
    }
    if (attempt.blocks.some((block) => timestampMilliseconds(block.blockedAt) > resolvedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "all source attempt blocks precede acceptance");
    }
    const acceptedRole = acceptance.target === "worker" ? "worker" : "validator";
    const targetProcesses = attempt.processes.filter((process) => process.role === acceptedRole);
    const launchedTargetProcesses = targetProcesses.filter((process) => process.launchIntentAt !== null
      && timestampMilliseconds(process.launchIntentAt) <= resolvedAt);
    if (launchedTargetProcesses.length === 0) {
      report(["operatorAcceptances", index, "sourceBlock"], "acceptance retains a launched process for its target role");
    }
    if (launchedTargetProcesses.some((process) => process.cleanupState !== "confirmed_dead")) {
      report(["operatorAcceptances", index, "processGroupsConfirmedDead"], "acceptance requires its target process groups to be reconciled");
    }
    if (launchedTargetProcesses.some((process) => process.status !== "blocked" || process.exit !== null)) {
      report(["operatorAcceptances", index, "target"], "acceptance requires an unknown target-process outcome without an exit receipt");
    }
    if (targetProcesses.some((process) => process.launchIntentAt !== null
      && timestampMilliseconds(process.launchIntentAt) > resolvedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "accepted execution roles do not launch again after resolution");
    }
    if (launchedTargetProcesses.some((process) => process.finishedAt !== null
      && timestampMilliseconds(process.finishedAt) > resolvedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "acceptance follows recorded target-process completion");
    }
    if (previousAcceptanceTime !== undefined && resolvedAt < previousAcceptanceTime) {
      report(["operatorAcceptances", index, "resolvedAt"], "operator acceptances must be ordered by resolution time");
    }
    previousAcceptanceTime = resolvedAt;
    const acceptedEvidence = acceptance.target === "worker" ? attempt.candidate : attempt.verdict;
    if (acceptedEvidence === null) {
      report(["operatorAcceptances", index, "target"], `${acceptance.target} acceptance requires matching evidence`);
    } else {
      if (acceptedEvidence.sourceBytesHash !== acceptance.resultBytesHash) {
        report(["operatorAcceptances", index, "resultBytesHash"], "acceptance hash must match exact accepted result bytes");
      }
      if (timestampMilliseconds(acceptedEvidence.recordedAt) < resolvedAt) {
        report(["operatorAcceptances", index, "resolvedAt"], "accepted evidence is recorded at or after its resolution");
      }
    }
  }

  if (attempt.workerFailure !== undefined && (attempt.workerFailure.attemptId !== attempt.attemptId || attempt.status === "succeeded")) {
    report(["workerFailure"], "worker failure identifies an unsuccessful source attempt");
  }
  if (attempt.status === "succeeded" && (attempt.candidate === null || attempt.failure !== null)) {
    report(["candidate"], "succeeded attempts require a candidate and carry no failure");
  }
  if ((attempt.status === "failed") !== (attempt.failure !== null)) {
    report(["failure"], "failed attempts require failure data and other attempts forbid it");
  }
  if (attempt.status === "interrupted" && attempt.blocks.length === 0) {
    report(["blocks"], "interrupted attempts retain at least one historical block");
  }
  if (["succeeded", "failed", "interrupted", "cancelled"].includes(attempt.status)
    && (attempt.finishedAt === null || (attempt.startedAt === null && attempt.status !== "cancelled")
      || attempt.phase !== null)) {
    report(["finishedAt"], "terminal attempts require finish time and no active phase; only unstarted cancellation may omit its start");
  }
  if (attempt.status === "cancelled" && attempt.startedAt === null
    && (attempt.processes.some((process) => process.launchIntentAt !== null)
      || attempt.candidate !== null || attempt.verdict !== null || attempt.judgments.length > 0
      || attempt.operatorAcceptances.length > 0)) {
    report(["startedAt"], "unstarted cancellation has no launched process or execution result");
  }
  if (["prepared", "executing", "validating"].includes(attempt.status) && attempt.finishedAt !== null) {
    report(["finishedAt"], "active attempts cannot have a finish time");
  }
  if (attempt.status === "executing" || attempt.status === "validating") {
    if (attempt.startedAt === null || attempt.phase === null) {
      report(["startedAt"], "executing and validating attempts require a start time and phase");
    }
  }
  if ((attempt.startedAt === null || attempt.finishedAt === null) !== (attempt.elapsedMs === null)) {
    report(["elapsedMs"], "elapsed time requires both start and finish timestamps");
  } else if (attempt.startedAt !== null && attempt.finishedAt !== null && attempt.elapsedMs !== null
    && attempt.elapsedMs !== timestampMilliseconds(attempt.finishedAt) - timestampMilliseconds(attempt.startedAt)) {
    report(["elapsedMs"], "elapsed time must equal the recorded timestamp difference");
  }
  if (attempt.startedAt !== null && attempt.finishedAt !== null
    && timestampMilliseconds(attempt.finishedAt) < timestampMilliseconds(attempt.startedAt)) {
    report(["finishedAt"], "attempt finish cannot precede start");
  }
  if (attempt.failure !== null && attempt.failure.attemptId !== attempt.attemptId) {
    report(["failure", "attemptId"], "attempt failure must identify its attempt");
  }
  if (attempt.failure?.kind === "validator_rejection"
    && (attempt.candidate === null || attempt.validatorExecutionId === null)) {
    report(["failure", "kind"], "validator rejection requires candidate and validator execution evidence");
  }
  if (attempt.candidate !== null && attempt.workerExecutionId === null) {
    report(["workerExecutionId"], "candidate evidence requires its worker execution ID");
  }
  if (attempt.validatorExecutionId !== null && attempt.candidate === null && attempt.workerFailure === undefined) {
    report(["candidate"], "verifier execution requires committed worker evidence");
  }
  if (attempt.verdict !== null && attempt.validatorExecutionId === null) {
    report(["validatorExecutionId"], "verdict evidence requires its validator execution ID");
  }
  if (attempt.validatorExecutionId !== null && attempt.workerExecutionId === null) {
    report(["validatorExecutionId"], "validators follow a worker execution");
  }
  if (attempt.workerExecutionId !== null && attempt.workerExecutionId === attempt.validatorExecutionId) {
    report(["validatorExecutionId"], "worker and validator execution IDs are distinct");
  }

  const superseded = attempt.supersededValidatorExecutionIds ?? [];
  if (new Set(superseded).size !== superseded.length
    || superseded.some((id) => id === attempt.workerExecutionId || id === attempt.validatorExecutionId)) {
    report(["supersededValidatorExecutionIds"], "superseded verifier IDs are unique and distinct from active executions");
  }
  for (const id of superseded) {
    if (!attempt.processes.some((process) => process.executionId === id && process.role === "validator")) {
      report(["supersededValidatorExecutionIds"], "superseded verifiers retain their process evidence");
    }
  }
  checkProcessIncarnations(attempt.processes, report, ["processes"]);
  if (attempt.workerExecutionId !== null && !attempt.processes.some((process) => process.role === "worker")
    && !(attempt.status === "executing" && attempt.phase === "awaitWorker" && attempt.candidate === null)) {
    report(["processes"], "worker execution IDs require process-incarnation evidence");
  }
  if (attempt.validatorExecutionId !== null && !attempt.processes.some((process) => process.role === "validator")
    && !(attempt.status === "validating" && attempt.phase === "awaitValidator" && attempt.verdict === null)) {
    report(["processes"], "validator execution IDs require process-incarnation evidence");
  }
  const workerProcesses = attempt.processes.filter((process) => process.role === "worker");
  const validatorProcesses = attempt.processes.filter((process) => process.role === "validator");
  if (attempt.candidate !== null && workerProcesses.length > 0) {
    const lastWorker = workerProcesses[workerProcesses.length - 1];
    const workerAcceptance = attempt.operatorAcceptances.find((acceptance) => acceptance.target === "worker");
    if (lastWorker?.status === "exited"
      && (lastWorker.exit?.kind !== "code" || lastWorker.exit.code !== 0)) {
      report(["candidate"], "worker candidates require a successful worker exit");
    }
    if (lastWorker?.status === "blocked" && workerAcceptance === undefined) {
      report(["candidate"], "unknown worker outcomes require operator acceptance");
    }
    if (lastWorker !== undefined && lastWorker.finishedAt !== null
      && timestampMilliseconds(attempt.candidate.recordedAt) < timestampMilliseconds(lastWorker.finishedAt)) {
      report(["candidate", "recordedAt"], "candidate evidence follows worker completion");
    }
  }
  if (validatorProcesses.some((process) => process.launchIntentAt !== null)) {
    const lastWorker = workerProcesses[workerProcesses.length - 1];
    const workerAcceptance = attempt.operatorAcceptances.find((acceptance) => acceptance.target === "worker");
    const workerReadyAt = [
      attempt.candidate?.recordedAt,
      workerAcceptance?.resolvedAt,
      lastWorker?.finishedAt,
    ].filter((value): value is string => value !== undefined && value !== null)
      .map(timestampMilliseconds)
      .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
    if ((attempt.candidate === null && attempt.workerFailure === undefined) || lastWorker === undefined
      || workerProcesses.some((process) => process.cleanupState !== "confirmed_dead")) {
      report(["processes"], "verifier launch requires committed worker evidence and confirmed worker-group death");
    }
    if (!Number.isFinite(workerReadyAt)) report(["processes"], "validator launch requires worker completion or acceptance time");
    for (const [index, process] of validatorProcesses.entries()) {
      if (process.launchIntentAt !== null && timestampMilliseconds(process.launchIntentAt) < workerReadyAt) {
        report(["processes", index, "launchIntentAt"], "validator launch follows worker completion and candidate commit");
      }
    }
  }
  const unreceiptedProcesses = attempt.processes.filter((process) =>
    process.status === "blocked" && process.exit === null);
  if (attempt.status === "failed") {
    for (const process of unreceiptedProcesses) {
      const acceptedUnknown = attempt.operatorAcceptances.some((acceptance) => acceptance.target === process.role);
      const deadlineReached = attempt.failure?.kind === "timeout"
        && process.deadlineAt !== null && process.finishedAt !== null
        && timestampMilliseconds(process.finishedAt) >= timestampMilliseconds(process.deadlineAt)
        && timestampMilliseconds(attempt.failure.failedAt) >= timestampMilliseconds(process.deadlineAt)
        && process.cleanupState === "confirmed_dead";
      if (!deadlineReached && !acceptedUnknown) {
        report(["processes"], "a failed attempt cannot classify an unaccepted exitless blocked process as a known failure without a confirmed deadline timeout");
        break;
      }
    }
  }
  for (const [index, process] of attempt.processes.entries()) {
    const expectedExecutionId = process.role === "worker" ? attempt.workerExecutionId : attempt.validatorExecutionId;
    const superseded = process.role === "validator" && attempt.supersededValidatorExecutionIds?.includes(process.executionId);
    if (!superseded && (expectedExecutionId === null || process.executionId !== expectedExecutionId)) {
      report(["processes", index, "executionId"], `${process.role} process must match its attempt execution ID`);
    }
    if (attempt.startedAt !== null && process.launchIntentAt !== null
      && timestampMilliseconds(process.launchIntentAt) < timestampMilliseconds(attempt.startedAt)) {
      report(["processes", index, "launchIntentAt"], "process launch cannot precede attempt start");
    }
  }
  const terminalAttempt = ["succeeded", "failed", "cancelled"].includes(attempt.status);
  if (terminalAttempt && attempt.processes.some((process) => {
    const settledStatus = process.status === "prepared" || process.status === "exited" || process.status === "blocked";
    const confirmed = process.status === "prepared" || process.cleanupState === "confirmed_dead";
    return !settledStatus || !confirmed;
  })) {
    report(["processes"], "terminal attempts have only prepared or reconciled process incarnations");
  }
});

const nodeStatusDtoSchema = z.enum(["pending", "running", "succeeded", "failed", "blocked", "cancelled", "skipped", "waiting"]);

export const nodeDetailDtoSchema = z.strictObject({
  nodeId: nodeIdSchema,
  position: positiveSafeInteger,
  predecessorId: nodeIdSchema.nullable(),
  successorId: nodeIdSchema.nullable(),
  status: nodeStatusDtoSchema,
  block: blockInfoSchema.nullable(),
  resolvedSettings: resolvedNodeSettingsSchema,
  successfulOutput: boundedText(1024 * 1024).nullable(),
  liveStderr: boundedText(256 * 1024).nullable().optional(),
  failureEvidence: boundedText(128 * 1024).nullable().optional(),
  failureReason: boundedText(64 * 1024).nullable().optional(),
  evidenceTruncated: z.boolean().optional(),
  attempts: z.array(attemptDetailDtoSchema),
  wait: humanWaitSchema.nullable().optional(),
}).superRefine((node, context) => {
  const report: ReportIssue = (path, message) => context.addIssue({ code: "custom", path, message });
  if ((node.status === "succeeded") !== (node.successfulOutput !== null)) {
    report(["successfulOutput"], "only succeeded nodes have a published output");
  }
  if ((node.status === "blocked") !== (node.block !== null)) {
    report(["block"], "blocked nodes require current block evidence");
  }
  if (node.block !== null && node.block.nodeId !== node.nodeId) {
    report(["block", "nodeId"], "node blocks must identify their node");
  }

  const lastAttempt = node.attempts.at(-1);
  if ((node.status === "pending" || node.status === "skipped") && node.attempts.length > 0) {
    report(["attempts"], "pending and skipped nodes have no semantic attempts");
  }
  if (node.status === "cancelled" && node.wait == null && lastAttempt !== undefined && lastAttempt.status !== "cancelled") {
    report(["attempts"], "cancelled nodes end with a cancelled attempt");
  }
  if (node.status === "blocked" && lastAttempt !== undefined
    && ((node.block?.attemptId !== null && node.block?.attemptId !== lastAttempt.attemptId)
      || (lastAttempt.status !== "failed" && lastAttempt.status !== "interrupted"))) {
    report(["block", "attemptId"], "a node block over prior attempts identifies the latest failed or interrupted attempt or remains attemptless");
  }
  if (node.status === "succeeded" && lastAttempt?.status !== "succeeded") {
    report(["attempts"], "succeeded nodes end with a succeeded semantic attempt");
  }
  if (node.status === "failed" && lastAttempt?.status !== "failed" && lastAttempt?.status !== "interrupted") {
    report(["attempts"], "failed nodes end with a failed or operator-interrupted attempt");
  }
  if (node.status === "running" && (lastAttempt === undefined
    || !["prepared", "executing", "validating"].includes(lastAttempt.status))) {
    report(["attempts"], "running nodes require an active final attempt");
  }

  const attemptIds = new Set<string>();
  const evidenceIds = new Set<string>();
  let previousAttemptFinish: number | undefined;
  for (const [index, attempt] of node.attempts.entries()) {
    if (attempt.number !== index + 1) report(["attempts", index, "number"], "attempts must be contiguous and ordered from one");
    if (attemptIds.has(attempt.attemptId)) report(["attempts", index, "attemptId"], "attempt IDs must be unique within a node");
    attemptIds.add(attempt.attemptId);
    if (attempt.failure !== null && attempt.failure.nodeId !== node.nodeId) {
      report(["attempts", index, "failure", "nodeId"], "attempt failure must identify its node");
    }
    const validatorProcesses = attempt.processes.filter((process) => process.role === "validator");
    const validatorAcceptance = attempt.operatorAcceptances.find((acceptance) => acceptance.target === "validator");
    if (node.resolvedSettings.validator === null && validatorProcesses.length > 0) {
      report(["attempts", index, "processes"], "unconfigured validators cannot have process evidence");
    }
    if (node.resolvedSettings.validator?.kind === "command") {
      if (attempt.workerFailure !== undefined && validatorProcesses.length > 0) {
        report(["attempts", index, "processes"], "command verifiers require a valid candidate");
      }
      const lastValidator = validatorProcesses.at(-1);
      const validatorPassed = lastValidator?.status === "exited"
        && lastValidator.exit?.kind === "code" && lastValidator.exit.code === 0;
      if (attempt.status === "succeeded" && validatorAcceptance === undefined
        && (attempt.validatorExecutionId === null || !validatorPassed)) {
        report(["attempts", index, "processes"], "successful command validation requires exit code zero and a process receipt");
      }
      if (attempt.failure?.kind === "validator_rejection") {
        const validatorRejected = lastValidator?.status === "exited"
          && (lastValidator.exit?.kind === "signal"
            || (lastValidator.exit?.kind === "code" && lastValidator.exit.code !== 0));
        if (!validatorRejected || validatorAcceptance !== undefined) {
          report(["attempts", index, "failure"], "validator rejection requires a nonzero command-validator exit without operator acceptance");
        }
      }
    }
    for (const [processIndex, process] of attempt.processes.entries()) {
      const expectedReplay = process.role === "worker"
        ? node.resolvedSettings.run.replay
        : node.resolvedSettings.validator?.replay;
      if (expectedReplay !== undefined && process.replay !== expectedReplay) {
        report(["attempts", index, "processes", processIndex, "replay"], "process replay policy matches its resolved role settings");
      }
    }
    if (attempt.startedAt !== null && previousAttemptFinish !== undefined
      && timestampMilliseconds(attempt.startedAt) < previousAttemptFinish) {
      report(["attempts", index, "startedAt"], "semantic attempts must be chronological");
    }
    if (attempt.finishedAt !== null) previousAttemptFinish = timestampMilliseconds(attempt.finishedAt);
    for (const block of attempt.blocks) {
      if (block.nodeId !== node.nodeId) report(["attempts", index, "blocks"], "attempt block must identify its node");
    }
    if (node.block !== null && node.block.attemptId === attempt.attemptId
      && !attempt.blocks.some((block) => block.blockId === node.block?.blockId)) {
      report(["block"], "current node block must remain in attempt block history");
    }
    for (const evidence of [attempt.candidate, attempt.verdict]) {
      if (evidence !== null) {
        if (evidenceIds.has(evidence.evidenceId)) report(["attempts", index], "evidence IDs must be unique within a node");
        evidenceIds.add(evidence.evidenceId);
      }
    }
    for (const judgment of attempt.judgments) {
      if (evidenceIds.has(judgment.evidenceId)) report(["attempts", index, "judgments"], "evidence IDs must be unique within a node");
      evidenceIds.add(judgment.evidenceId);
    }
    if (node.resolvedSettings.validator === null) {
      const hasValidatorEvidence = attempt.validatorExecutionId !== null || attempt.verdict !== null
        || attempt.processes.some((process) => process.role === "validator")
        || attempt.operatorAcceptances.some((acceptance) => acceptance.target === "validator");
      if (hasValidatorEvidence) report(["attempts", index], "nodes without validators have no validator execution or verdict evidence");
    } else {
      const validatorPassed = attempt.status === "succeeded";
      const validatorRejected = attempt.failure?.kind === "validator_rejection";
      const validatorAcceptance = attempt.operatorAcceptances.find((acceptance) => acceptance.target === "validator");
      if ((validatorPassed || validatorRejected) && attempt.validatorExecutionId === null) {
        report(["attempts", index, "validatorExecutionId"], "configured validation requires validator execution evidence");
      }
      if ((validatorPassed || validatorRejected) && node.resolvedSettings.validator.kind === "agent" && attempt.verdict === null) {
        report(["attempts", index, "verdict"], "agent validation requires verdict evidence");
      }
      if (node.resolvedSettings.validator.kind === "command" && attempt.verdict !== null && validatorAcceptance === undefined) {
        report(["attempts", index, "verdict"], "command validator verdict evidence requires operator acceptance");
      }
      if (node.resolvedSettings.validator.kind === "agent" && attempt.verdict !== null
        && validatorAcceptance === undefined) {
        const lastValidator = attempt.processes.filter((process) => process.role === "validator").at(-1);
        const exitedSuccessfully = lastValidator?.status === "exited"
          && lastValidator.exit?.kind === "code" && lastValidator.exit.code === 0;
        if (!exitedSuccessfully) {
          report(["attempts", index, "verdict"], "agent verdict evidence requires a successful validator process exit or operator acceptance");
        }
      }
    }
    for (const [acceptanceIndex, acceptance] of attempt.operatorAcceptances.entries()) {
      if (acceptance.target === "validator" && node.resolvedSettings.validator === null) {
        report(["attempts", index, "operatorAcceptances", acceptanceIndex], "operator cannot accept an unconfigured validator result");
      }
    }
  }
  if (node.block !== null && node.block.attemptId !== null) {
    if (!attemptIds.has(node.block.attemptId)) {
      report(["block", "attemptId"], "node block attempt ID must resolve in its history");
    }
    if (lastAttempt?.attemptId !== node.block.attemptId
      || (lastAttempt.status !== "interrupted" && lastAttempt.status !== "failed")) {
      report(["block", "attemptId"], "current attempt block belongs to the latest blocked or failed attempt");
    }
  }
});

export const nodeDescriptionDtoSchema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdSchema,
  definitionHash: sha256Schema,
  runId: runIdSchema.nullable(),
  runStatus: runStatusSchema.nullable(),
  runFailure: runFailureInfoSchema.nullable(),
  node: nodeDetailDtoSchema,
}).superRefine((description, context) => {
  const report: ReportIssue = (path, message) => context.addIssue({ code: "custom", path, message });
  const { node, runStatus, runFailure } = description;
  if (description.runId === null && (runStatus !== null || node.status !== "pending" || node.attempts.length > 0 || runFailure !== null)) {
    report(["node"], "a node without a selected run has no runtime history");
  }
  if (description.runId !== null && runStatus === null) {
    report(["runStatus"], "a selected run includes its status");
  }
  if (runStatus === "failed" && runFailure === null) {
    report(["runFailure"], "failed runs retain their terminal failure cause");
  }
  if (runStatus !== null && runFailure !== null
    && !["running", "paused", "blocked", "failed"].includes(runStatus)) {
    report(["runFailure"], "run failure details appear only while resolving or reporting a failure");
  }
  if (runFailure?.kind === "operator" && runStatus !== "failed") {
    report(["runFailure"], "operator run failure appears only on a failed run");
  }
  if (node.status === "blocked" && runStatus !== "blocked") {
    report(["node", "status"], "a blocked node belongs to a blocked run");
  }
  if (runStatus === "queued" && !["pending", "succeeded"].includes(node.status)) {
    report(["node", "status"], "queued continuations contain only pending or succeeded nodes");
  }
  if (runStatus === "completed" && node.status !== "succeeded" && node.status !== "skipped") {
    report(["node", "status"], "completed runs contain only succeeded or skipped nodes");
  }
  if (runStatus === "failed" && ["running", "blocked", "cancelled"].includes(node.status)) {
    report(["node", "status"], "failed runs have no running, blocked, or cancelled nodes");
  }
  if (runStatus === "cancelled" && ["running", "blocked"].includes(node.status)) {
    report(["node", "status"], "cancelled runs have no running or blocked nodes");
  }

  const lastAttempt = node.attempts.at(-1);
  const operatorFailure = runFailure?.kind === "operator" ? runFailure : null;
  if (operatorFailure?.sourceBlock.kind === "preflight_failed" && node.status !== "pending") {
    report(["runFailure", "sourceBlock"], "operator-failed preflight leaves every node pending");
  }
  if (operatorFailure !== null && operatorFailure.sourceBlock.nodeId !== null
    && operatorFailure.sourceBlock.nodeId !== node.nodeId && node.status === "failed") {
    report(["runFailure", "sourceBlock"], "another node's operator block cannot explain this failed node");
  }
  if (operatorFailure?.sourceBlock.nodeId === node.nodeId) {
    const sourceBlock = operatorFailure.sourceBlock;
    if (sourceBlock.attemptId === null) {
      const unstartedNode = node.status === "pending" && node.attempts.length === 0;
      const preservedFailure = node.status === "failed"
        && (lastAttempt?.status === "failed" || lastAttempt?.status === "interrupted");
      if (!unstartedNode && !preservedFailure) {
        report(["runFailure", "sourceBlock"], "a node-scoped operator failure without an attempt preserves a prior failure or ends an unstarted node");
      }
    } else if (node.status !== "failed" || lastAttempt?.attemptId !== sourceBlock.attemptId
      || !lastAttempt.blocks.some((block) => sameBlock(block, sourceBlock))) {
      report(["runFailure", "sourceBlock"], "node-scoped operator failure identifies the failed latest attempt");
    }
  }
  if (node.status === "failed" && lastAttempt?.status === "interrupted"
    && (runStatus !== "failed" || operatorFailure === null
      || (operatorFailure.sourceBlock.attemptId !== null
        && (operatorFailure.sourceBlock.nodeId !== node.nodeId
          || operatorFailure.sourceBlock.attemptId !== lastAttempt.attemptId
          || !lastAttempt.blocks.some((block) => sameBlock(block, operatorFailure.sourceBlock)))))) {
    report(["runFailure"], "operator-ended interrupted attempts require their run-level failure cause");
  }
  if (runFailure !== null && runFailure.kind !== "operator" && runFailure.nodeId === node.nodeId
    && (runFailure.attemptId === null
      || (node.status !== "failed"
        && !(node.status === "blocked" && runStatus === "blocked"
          && (node.block?.attemptId === runFailure.attemptId
            || (node.block?.attemptId === null && node.block.nodeId === node.nodeId))))
      || lastAttempt?.attemptId !== runFailure.attemptId || lastAttempt.failure === null
      || !sameFailure(runFailure, lastAttempt.failure))) {
    report(["runFailure"], "node-scoped run failures identify their failed latest attempt");
  }
  if (runStatus === "failed" && node.status === "failed" && lastAttempt?.status === "failed"
    && runFailure?.kind !== "operator"
    && (runFailure === null || runFailure.nodeId !== node.nodeId || runFailure.attemptId !== lastAttempt.attemptId
      || lastAttempt.failure === null || !sameFailure(runFailure, lastAttempt.failure))) {
    report(["runFailure"], "failed attempts retain their terminal run failure cause");
  }

});

export const diagramDtoSchema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdSchema,
  definitionHash: sha256Schema,
  runId: runIdSchema.nullable(),
  nodes: z.array(z.strictObject({
    nodeId: nodeIdSchema,
    position: positiveSafeInteger,
    successorId: nodeIdSchema.nullable(),
    status: nodeStatusDtoSchema.nullable(),
  })).min(1),
}).superRefine((diagram, context) => {
  const nodeIds = new Set<string>();
  for (const [index, node] of diagram.nodes.entries()) {
    if (nodeIds.has(node.nodeId)) context.addIssue({ code: "custom", path: ["nodes", index, "nodeId"], message: "diagram node IDs must be unique" });
    nodeIds.add(node.nodeId);
    if (node.position !== index + 1) context.addIssue({ code: "custom", path: ["nodes", index, "position"], message: "diagram nodes follow chain order" });
    if (node.successorId !== (diagram.nodes[index + 1]?.nodeId ?? null)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "successorId"], message: "diagram successor matches the next chain node" });
    }
    if ((diagram.runId === null) !== (node.status === null)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "status"], message: "only a selected run supplies diagram runtime status" });
    }
  }
});

const textLogSectionSchema = z.strictObject({
  kind: z.literal("worklog"),
  sectionId: z.string().min(1),
  order: nonnegativeSafeInteger,
  label: z.string().min(1),
  content: logContent,
});

const captureLogSectionSchema = z.strictObject({
  kind: z.literal("capture"),
  sectionId: z.string().min(1),
  order: nonnegativeSafeInteger,
  label: z.string().min(1),
  executionId: executionIdSchema,
  incarnationNumber: positiveSafeInteger,
  capture: processCaptureSchema,
  content: logContent.nullable(),
});

export const logSectionDtoSchema = z.discriminatedUnion("kind", [textLogSectionSchema, captureLogSectionSchema]);

export const logsDtoSchema = z.strictObject({
  version: z.literal(2),
  runId: runIdSchema,
  sections: z.array(logSectionDtoSchema),
}).superRefine((logs, context) => {
  const sectionIds = new Set<string>();
  if (logs.sections[0]?.kind !== "worklog") {
    context.addIssue({ code: "custom", path: ["sections", 0], message: "logs begin with their worklog" });
  }
  for (const [index, section] of logs.sections.entries()) {
    if (section.order !== index) {
      context.addIssue({ code: "custom", path: ["sections", index, "order"], message: "log sections are contiguous and ordered" });
    }
    if (sectionIds.has(section.sectionId)) {
      context.addIssue({ code: "custom", path: ["sections", index, "sectionId"], message: "log section IDs must be unique" });
    }
    sectionIds.add(section.sectionId);
  }
});

export type StatusDto = z.infer<typeof statusDtoSchema>;
export type RunSummaryDto = z.infer<typeof runSummaryDtoSchema>;
export type NodeDescriptionDto = z.infer<typeof nodeDescriptionDtoSchema>;
export type LogsDto = z.infer<typeof logsDtoSchema>;
export type DiagramDto = z.infer<typeof diagramDtoSchema>;
