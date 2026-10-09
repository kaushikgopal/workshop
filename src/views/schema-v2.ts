import { isAbsolute } from "node:path";
import { z } from "zod";
import { nodeIdV2, workflowIdV2 } from "../definition/schema-v2.js";
import {
  resolvedExecutionSiteV2Schema,
  resolvedNodeSettingsV2Schema,
} from "../definition/schema-resolved-v2.js";
import {
  activationIdV2Schema,
  attemptIdV2Schema,
  attemptPhaseV2Schema,
  attemptStatusV2Schema,
  blockInfoV2Schema,
  desiredStateV2Schema,
  evidenceIdV2Schema,
  failureInfoV2Schema,
  judgmentDecisionV2Schema,
  occurrenceIdV2Schema,
  operatorAcceptanceV2Schema,
  operatorResolutionV2Schema,
  runIdV2Schema,
  runStatusV2Schema,
  runFailureInfoV2Schema,
} from "../run/schema-v2.js";
import {
  executionIdV2Schema,
  processCaptureV2Schema,
  processIncarnationV2Schema,
} from "../process/schema-v2.js";
import {
  byteCountV2Schema,
  elapsedMillisecondsV2Schema,
  sha256V2Schema,
  utcTimestampV2Schema,
} from "../util/schema-v2.js";

const positiveSafeIntegerV2 = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeSafeIntegerV2 = z.number().int().nonnegative().refine(Number.isSafeInteger);
const preflightCheckIdV2Schema = z.string().min(1).brand<"PreflightCheckIdV2">();
const boundedTextV2 = (maxBytes: number) => z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
  `text must be at most ${maxBytes} UTF-8 bytes`,
);
const logContentV2 = z.string().refine((value) => value.isWellFormed(), "log content must be well-formed Unicode");
const absolutePathV2 = z.string().min(1).refine((value) => isAbsolute(value) && !value.includes("\u0000"), "path must be absolute and contain no NUL");
const timestampMillisecondsV2 = (value: string): number => Date.parse(value);
type ProcessIncarnationValueV2 = z.infer<typeof processIncarnationV2Schema>;
type BlockInfoValueV2 = z.infer<typeof blockInfoV2Schema>;
type IssuePathV2 = (string | number)[];
type ReportIssueV2 = (path: IssuePathV2, message: string) => void;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameBlockV2(left: BlockInfoValueV2, right: BlockInfoValueV2): boolean {
  return left.blockId === right.blockId && left.kind === right.kind && left.reason === right.reason
    && left.blockedAt === right.blockedAt && left.nodeId === right.nodeId && left.attemptId === right.attemptId;
}

function processGroupsReconciledV2(processes: readonly ProcessIncarnationValueV2[]): boolean {
  return processes.every((process) => process.status === "prepared" || process.cleanupState === "confirmed_dead");
}

function sameFailureV2(
  left: z.infer<typeof failureInfoV2Schema>,
  right: z.infer<typeof failureInfoV2Schema>,
): boolean {
  return left.kind === right.kind && left.message === right.message && left.failedAt === right.failedAt
    && left.nodeId === right.nodeId && left.attemptId === right.attemptId;
}

function checkProcessIncarnations(
  processes: readonly ProcessIncarnationValueV2[],
  report: ReportIssueV2,
  path: IssuePathV2,
  expectedRole?: "worker" | "validator" | "preflight",
): void {
  const groups = new Map<string, { index: number; value: ProcessIncarnationValueV2 }[]>();
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
    let previous: ProcessIncarnationValueV2 | undefined;
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
            || timestampMillisecondsV2(process.launchIntentAt) < timestampMillisecondsV2(previous.finishedAt)) {
            report([...processPath, "launchIntentAt"], "replacement launch follows confirmed prior completion");
          }
        }
      }
      previous = process;
    }
  }
}


export const activationStateV2Schema = z.enum(["active", "paused", "stopped", "exhausted"]);

export const workflowActivationDtoV2Schema = z.strictObject({
  activationId: activationIdV2Schema,
  state: activationStateV2Schema,
  admittedCount: nonnegativeSafeIntegerV2,
  maxRuns: z.union([positiveSafeIntegerV2, z.literal("unlimited")]),
  activatedAt: utcTimestampV2Schema,
  nextDueAt: utcTimestampV2Schema.nullable(),
  skippedSlots: nonnegativeSafeIntegerV2.default(0),
  lastSkippedSlotAt: utcTimestampV2Schema.nullable().default(null),
});

export const serviceMetadataDtoV2Schema = z.strictObject({
  state: z.enum(["starting", "running", "stopping", "stopped", "unavailable"]),
  pid: positiveSafeIntegerV2.nullable(),
  bootId: z.string().min(1).nullable(),
  startedAt: utcTimestampV2Schema.nullable(),
  socketPath: absolutePathV2.nullable(),
  error: boundedTextV2(64 * 1024).nullable(),
});

export const runSummaryDtoV2Schema = z.strictObject({
  runId: runIdV2Schema,
  workflowId: workflowIdV2,
  activationId: activationIdV2Schema,
  occurrenceId: occurrenceIdV2Schema,
  definitionHash: sha256V2Schema,
  status: runStatusV2Schema,
  desiredState: desiredStateV2Schema,
  waitingForCapacity: z.boolean(),
  admittedAt: utcTimestampV2Schema,
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  currentNodeId: nodeIdV2.nullable(),
  currentAttemptNumber: positiveSafeIntegerV2.nullable(),
  block: blockInfoV2Schema.nullable(),
  failure: runFailureInfoV2Schema.nullable(),
  terminalOutput: boundedTextV2(1024 * 1024).nullable(),
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
  if (summary.startedAt !== null && timestampMillisecondsV2(summary.startedAt) < timestampMillisecondsV2(summary.admittedAt)) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "run start cannot precede admission" });
  }
  if (summary.startedAt !== null && summary.finishedAt !== null
    && timestampMillisecondsV2(summary.finishedAt) < timestampMillisecondsV2(summary.startedAt)) {
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
    && timestampMillisecondsV2(summary.failure.failedAt) > timestampMillisecondsV2(summary.finishedAt)) {
    context.addIssue({ code: "custom", path: ["failure", "failedAt"], message: "failure cannot follow terminal completion" });
  }
  if ((summary.status === "completed") !== (summary.terminalOutput !== null)) {
    context.addIssue({ code: "custom", path: ["terminalOutput"], message: "completed runs require terminal output, including an empty string" });
  }
});

export const workflowStatusDtoV2Schema = z.strictObject({
  workflowId: workflowIdV2,
  description: boundedTextV2(4 * 1024).nullable(),
  definitionHash: sha256V2Schema.nullable(),
  configurationError: boundedTextV2(64 * 1024).nullable(),
  activation: workflowActivationDtoV2Schema.nullable(),
  unresolvedRun: runSummaryDtoV2Schema.nullable(),
}).superRefine((workflow, context) => {
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

export const statusDtoV2Schema = z.strictObject({
  version: z.literal(2),
  generatedAt: utcTimestampV2Schema,
  installationId: z.string().min(1),
  service: serviceMetadataDtoV2Schema,
  workflows: z.array(workflowStatusDtoV2Schema),
}).superRefine((status, context) => {
  let previousId: string | undefined;
  for (const [index, workflow] of status.workflows.entries()) {
    if (previousId !== undefined && compareCodeUnits(previousId, workflow.workflowId) >= 0) {
      context.addIssue({ code: "custom", path: ["workflows", index], message: "workflows must be unique and sorted by ID" });
    }
    previousId = workflow.workflowId;
  }
});

export const runsDtoV2Schema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdV2,
  total: nonnegativeSafeIntegerV2,
  truncated: z.boolean(),
  runs: z.array(runSummaryDtoV2Schema),
}).superRefine((projection, context) => {
  if (projection.total < projection.runs.length || projection.truncated !== (projection.total > projection.runs.length)) {
    context.addIssue({ code: "custom", path: ["truncated"], message: "truncation must match the total and returned run count" });
  }
  let previous: z.infer<typeof runSummaryDtoV2Schema> | undefined;
  const runIds = new Set<string>();
  for (const [index, run] of projection.runs.entries()) {
    if (runIds.has(run.runId)) context.addIssue({ code: "custom", path: ["runs", index, "runId"], message: "run IDs must be unique" });
    runIds.add(run.runId);
    if (run.workflowId !== projection.workflowId) {
      context.addIssue({ code: "custom", path: ["runs", index, "workflowId"], message: "run belongs to a different workflow" });
    }
    if (previous !== undefined) {
      const timeOrder = timestampMillisecondsV2(previous.admittedAt) - timestampMillisecondsV2(run.admittedAt);
      if (timeOrder < 0 || (timeOrder === 0 && compareCodeUnits(previous.runId, run.runId) >= 0)) {
        context.addIssue({ code: "custom", path: ["runs", index], message: "runs must be unique, newest first, with run ID as the stable tie-break" });
      }
    }
    previous = run;
  }
});

export const resolvedExecutionSiteDtoV2Schema = resolvedExecutionSiteV2Schema;
export const resolvedNodeSettingsDtoV2Schema = resolvedNodeSettingsV2Schema;

const attemptProcessV2Schema = processIncarnationV2Schema.refine(
  (process) => process.role !== "preflight",
  "preflight processes belong to the run, not a semantic attempt",
);
const preflightProcessV2Schema = processIncarnationV2Schema.refine(
  (process) => process.role === "preflight",
  "run preflight evidence must have the preflight role",
);

/** `sha256` hashes retained evidence; result `sourceBytesHash` hashes exact checked file bytes. */
const evidenceReferenceFieldsV2 = {
  evidenceId: evidenceIdV2Schema,
  sha256: sha256V2Schema,
  byteCount: byteCountV2Schema,
  recordedAt: utcTimestampV2Schema,
};
export const evidenceReferenceDtoV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...evidenceReferenceFieldsV2,
    kind: z.literal("candidate"),
    sourceBytesHash: sha256V2Schema,
  }),
  z.strictObject({
    ...evidenceReferenceFieldsV2,
    kind: z.literal("verdict"),
    sourceBytesHash: sha256V2Schema,
  }),
  z.strictObject({
    ...evidenceReferenceFieldsV2,
    kind: z.literal("judgment"),
    sourceBytesHash: z.null(),
    decision: judgmentDecisionV2Schema,
  }),
]);

export const attemptDetailDtoV2Schema = z.strictObject({
  attemptId: attemptIdV2Schema,
  number: positiveSafeIntegerV2,
  status: attemptStatusV2Schema,
  phase: attemptPhaseV2Schema.nullable(),
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  elapsedMs: elapsedMillisecondsV2Schema.nullable(),
  workerExecutionId: executionIdV2Schema.nullable(),
  validatorExecutionId: executionIdV2Schema.nullable(),
  candidate: evidenceReferenceDtoV2Schema.nullable(),
  verdict: evidenceReferenceDtoV2Schema.nullable(),
  judgments: z.array(evidenceReferenceDtoV2Schema),
  operatorAcceptances: z.array(operatorAcceptanceV2Schema),
  blocks: z.array(blockInfoV2Schema),
  failure: failureInfoV2Schema.nullable(),
  processes: z.array(attemptProcessV2Schema),
}).superRefine((attempt, context) => {
  const report: ReportIssueV2 = (path, message) => context.addIssue({ code: "custom", path, message });
  const blockIds = new Set<string>();
  let previousBlockTime: number | undefined;
  for (const [index, block] of attempt.blocks.entries()) {
    if (blockIds.has(block.blockId)) report(["blocks", index, "blockId"], "block IDs must be unique within an attempt");
    blockIds.add(block.blockId);
    if (block.nodeId === null) report(["blocks", index, "nodeId"], "attempt-history blocks identify their node");
    if (block.attemptId !== null && block.attemptId !== attempt.attemptId) {
      report(["blocks", index, "attemptId"], "attempt-scoped blocks identify their attempt");
    }
    const blockedAt = timestampMillisecondsV2(block.blockedAt);
    if (previousBlockTime !== undefined && blockedAt < previousBlockTime) {
      report(["blocks", index, "blockedAt"], "block history must be ordered by time");
    }
    previousBlockTime = blockedAt;
    if (attempt.startedAt !== null && blockedAt < timestampMillisecondsV2(attempt.startedAt)) {
      report(["blocks", index, "blockedAt"], "attempt blocks cannot precede attempt start");
    }
    // WorkflowRun records judge/orchestrator blocks after the child attempt commits its outcome.
    if (attempt.finishedAt !== null && blockedAt > timestampMillisecondsV2(attempt.finishedAt)
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
    if (!attempt.blocks.some((block) => sameBlockV2(block, acceptance.sourceBlock))) {
      report(["operatorAcceptances", index, "sourceBlock", "blockId"], "accepted results must retain the exact source block in attempt history");
    }
    if (acceptance.sourceBlock.attemptId !== attempt.attemptId) {
      report(["operatorAcceptances", index, "sourceBlock", "attemptId"], "acceptance source block must identify its attempt");
    }
    if (acceptance.sourceBlock.kind !== "external_outcome_unknown") {
      report(["operatorAcceptances", index, "sourceBlock", "kind"], "only unknown external outcomes can be accepted");
    }
    const resolvedAt = timestampMillisecondsV2(acceptance.resolvedAt);
    if (resolvedAt < timestampMillisecondsV2(acceptance.sourceBlock.blockedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "acceptance follows its source block");
    }
    const blocksBeforeAcceptance = attempt.blocks.filter((block) =>
      timestampMillisecondsV2(block.blockedAt) <= resolvedAt);
    const latestBlockAtAcceptance = blocksBeforeAcceptance.at(-1);
    if (latestBlockAtAcceptance === undefined || !sameBlockV2(latestBlockAtAcceptance, acceptance.sourceBlock)) {
      report(["operatorAcceptances", index, "sourceBlock"], "acceptance identifies the latest block at its resolution time");
    }
    if (attempt.blocks.some((block) => timestampMillisecondsV2(block.blockedAt) > resolvedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "all source attempt blocks precede acceptance");
    }
    const acceptedRole = acceptance.target === "worker" ? "worker" : "validator";
    const targetProcesses = attempt.processes.filter((process) => process.role === acceptedRole);
    const launchedTargetProcesses = targetProcesses.filter((process) => process.launchIntentAt !== null
      && timestampMillisecondsV2(process.launchIntentAt) <= resolvedAt);
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
      && timestampMillisecondsV2(process.launchIntentAt) > resolvedAt)) {
      report(["operatorAcceptances", index, "resolvedAt"], "accepted execution roles do not launch again after resolution");
    }
    if (launchedTargetProcesses.some((process) => process.finishedAt !== null
      && timestampMillisecondsV2(process.finishedAt) > resolvedAt)) {
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
      if (timestampMillisecondsV2(acceptedEvidence.recordedAt) < resolvedAt) {
        report(["operatorAcceptances", index, "resolvedAt"], "accepted evidence is recorded at or after its resolution");
      }
    }
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
    && attempt.elapsedMs !== timestampMillisecondsV2(attempt.finishedAt) - timestampMillisecondsV2(attempt.startedAt)) {
    report(["elapsedMs"], "elapsed time must equal the recorded timestamp difference");
  }
  if (attempt.startedAt !== null && attempt.finishedAt !== null
    && timestampMillisecondsV2(attempt.finishedAt) < timestampMillisecondsV2(attempt.startedAt)) {
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
  if (attempt.validatorExecutionId !== null && attempt.candidate === null) {
    report(["candidate"], "validator execution requires a committed candidate");
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

  checkProcessIncarnations(attempt.processes, report, ["processes"]);
  if (attempt.workerExecutionId !== null && !attempt.processes.some((process) => process.role === "worker")) {
    report(["processes"], "worker execution IDs require process-incarnation evidence");
  }
  if (attempt.validatorExecutionId !== null && !attempt.processes.some((process) => process.role === "validator")) {
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
      && timestampMillisecondsV2(attempt.candidate.recordedAt) < timestampMillisecondsV2(lastWorker.finishedAt)) {
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
      .map(timestampMillisecondsV2)
      .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
    if (attempt.candidate === null || lastWorker === undefined
      || workerProcesses.some((process) => process.cleanupState !== "confirmed_dead")) {
      report(["processes"], "validator launch requires a committed candidate and confirmed worker-group death");
    }
    if (!Number.isFinite(workerReadyAt)) report(["processes"], "validator launch requires worker completion or acceptance time");
    for (const [index, process] of validatorProcesses.entries()) {
      if (process.launchIntentAt !== null && timestampMillisecondsV2(process.launchIntentAt) < workerReadyAt) {
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
        && timestampMillisecondsV2(process.finishedAt) >= timestampMillisecondsV2(process.deadlineAt)
        && timestampMillisecondsV2(attempt.failure.failedAt) >= timestampMillisecondsV2(process.deadlineAt)
        && process.cleanupState === "confirmed_dead";
      if (!deadlineReached && !acceptedUnknown) {
        report(["processes"], "a failed attempt cannot classify an unaccepted exitless blocked process as a known failure without a confirmed deadline timeout");
        break;
      }
    }
  }
  for (const [index, process] of attempt.processes.entries()) {
    const expectedExecutionId = process.role === "worker" ? attempt.workerExecutionId : attempt.validatorExecutionId;
    if (expectedExecutionId === null || process.executionId !== expectedExecutionId) {
      report(["processes", index, "executionId"], `${process.role} process must match its attempt execution ID`);
    }
    if (attempt.startedAt !== null && process.launchIntentAt !== null
      && timestampMillisecondsV2(process.launchIntentAt) < timestampMillisecondsV2(attempt.startedAt)) {
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

const preflightOutcomeV2Schema = z.enum(["pending", "passed", "failed"]);
const preflightCheckDtoV2Schema = z.strictObject({
  checkId: preflightCheckIdV2Schema,
  outcome: preflightOutcomeV2Schema,
  startedAt: utcTimestampV2Schema.nullable(),
  finishedAt: utcTimestampV2Schema.nullable(),
  failure: failureInfoV2Schema.nullable(),
  block: blockInfoV2Schema.nullable(),
  processes: z.array(preflightProcessV2Schema),
}).superRefine((check, context) => {
  const report: ReportIssueV2 = (path, message) => context.addIssue({ code: "custom", path, message });
  checkProcessIncarnations(check.processes, report, ["processes"], "preflight");
  for (const [index, process] of check.processes.entries()) {
    if (process.replay !== "safe") report(["processes", index, "replay"], "preflight must be repeat-safe");
    if (check.startedAt !== null && process.launchIntentAt !== null
      && timestampMillisecondsV2(process.launchIntentAt) < timestampMillisecondsV2(check.startedAt)) {
      report(["processes", index, "launchIntentAt"], "preflight process cannot launch before its check");
    }
    if (check.finishedAt !== null && process.finishedAt !== null
      && timestampMillisecondsV2(process.finishedAt) > timestampMillisecondsV2(check.finishedAt)) {
      report(["processes", index, "finishedAt"], "preflight process cannot finish after its check");
    }
  }
  if (check.startedAt !== null && check.finishedAt !== null
    && timestampMillisecondsV2(check.finishedAt) < timestampMillisecondsV2(check.startedAt)) {
    report(["finishedAt"], "preflight check cannot finish before it starts");
  }
  if (check.outcome === "pending") {
    if (check.finishedAt !== null || check.failure !== null || check.block !== null) {
      report(["outcome"], "pending preflight checks have no result, failure, or block");
    }
  } else {
    if (check.startedAt === null || check.finishedAt === null || check.processes.length === 0) {
      report(["finishedAt"], "settled preflight checks require timestamps and process evidence");
    }
    if (check.processes.some((process) => {
      const settledStatus = process.status === "exited" || process.status === "blocked";
      return !settledStatus || process.cleanupState !== "confirmed_dead";
    })) {
      report(["processes"], "settled preflight checks require reconciled process groups");
    }
    const finalProcess = check.processes[check.processes.length - 1];
    if (check.outcome === "passed") {
      if (check.failure !== null || check.block !== null) report(["failure"], "passed preflight has no failure or block");
      if (finalProcess === undefined || finalProcess.status !== "exited" || finalProcess.exit?.kind !== "code" || finalProcess.exit.code !== 0) {
        report(["processes"], "passed preflight ends with exit code zero");
      }
    } else {
      if (check.failure === null || check.block?.kind !== "preflight_failed") {
        report(["failure"], "failed preflight requires typed failure and preflight_failed block evidence");
      }
      if (check.failure !== null && (check.failure.nodeId !== null || check.failure.attemptId !== null)) {
        report(["failure"], "preflight failure has no node or attempt");
      }
      if (check.block !== null && (check.block.nodeId !== null || check.block.attemptId !== null)) {
        report(["block"], "preflight block has no node or attempt");
      }
    }
  }
  if (check.failure !== null && check.startedAt !== null
    && timestampMillisecondsV2(check.failure.failedAt) < timestampMillisecondsV2(check.startedAt)) {
    report(["failure", "failedAt"], "preflight failure cannot precede check start");
  }
  if (check.failure !== null && check.finishedAt !== null
    && timestampMillisecondsV2(check.failure.failedAt) > timestampMillisecondsV2(check.finishedAt)) {
    report(["failure", "failedAt"], "preflight failure cannot follow check completion");
  }
  if (check.block !== null && check.startedAt !== null
    && timestampMillisecondsV2(check.block.blockedAt) < timestampMillisecondsV2(check.startedAt)) {
    report(["block", "blockedAt"], "preflight block cannot precede check start");
  }
  if (check.block !== null && check.finishedAt !== null
    && timestampMillisecondsV2(check.block.blockedAt) > timestampMillisecondsV2(check.finishedAt)) {
    report(["block", "blockedAt"], "preflight block cannot follow check completion");
  }
});

export const preflightDtoV2Schema = z.strictObject({
  cacheKeyHash: sha256V2Schema,
  outcome: preflightOutcomeV2Schema,
  reusedFrom: z.strictObject({
    runId: runIdV2Schema,
    passedAt: utcTimestampV2Schema,
    cacheKeyHash: sha256V2Schema,
  }).nullable(),
  checks: z.array(preflightCheckDtoV2Schema),
}).superRefine((preflight, context) => {
  const report: ReportIssueV2 = (path, message) => context.addIssue({ code: "custom", path, message });
  const checkIds = new Set<string>();
  const executionChecks = new Map<string, string>();
  const incarnationIds = new Set<string>();
  let previousFinishedAt: number | undefined;
  let hasPendingCheck = false;
  for (const [index, check] of preflight.checks.entries()) {
    if (checkIds.has(check.checkId)) report(["checks", index, "checkId"], "preflight check IDs must be unique");
    checkIds.add(check.checkId);
    if (hasPendingCheck) report(["checks", index], "pending preflight check must be last");
    hasPendingCheck = check.outcome === "pending";
    if (previousFinishedAt !== undefined && check.startedAt !== null
      && timestampMillisecondsV2(check.startedAt) < previousFinishedAt) {
      report(["checks", index, "startedAt"], "preflight checks must be chronological");
    }
    if (check.finishedAt !== null) previousFinishedAt = timestampMillisecondsV2(check.finishedAt);
    for (const process of check.processes) {
      const ownerCheck = executionChecks.get(process.executionId);
      if (ownerCheck !== undefined && ownerCheck !== check.checkId) {
        report(["checks", index, "processes"], "each preflight check has a distinct process execution ID");
      }
      executionChecks.set(process.executionId, check.checkId);
      if (incarnationIds.has(process.incarnationId)) {
        report(["checks", index, "processes"], "preflight incarnation IDs are unique within a run");
      }
      incarnationIds.add(process.incarnationId);
    }
  }
  if (preflight.reusedFrom !== null) {
    if (preflight.outcome !== "passed" || preflight.checks.length !== 0
      || preflight.reusedFrom.cacheKeyHash !== preflight.cacheKeyHash) {
      report(["reusedFrom"], "reused preflight passes match the cache key and have no local executions");
    }
  } else {
    const lastCheck = preflight.checks[preflight.checks.length - 1];
    if (preflight.outcome === "pending" && lastCheck?.outcome === "passed") {
      report(["outcome"], "a passed preflight check cannot return to pending");
    }
    if (preflight.outcome !== "pending" && (lastCheck === undefined || lastCheck.outcome !== preflight.outcome)) {
      report(["outcome"], "settled preflight outcome matches its final check");
    }
  }
});

export type PreflightCheckDtoV2 = z.infer<typeof preflightCheckDtoV2Schema>;
export type PreflightDtoV2 = z.infer<typeof preflightDtoV2Schema>;

export const nodeStatusDtoV2Schema = z.enum(["pending", "running", "succeeded", "failed", "blocked", "cancelled"]);

export const nodeDetailDtoV2Schema = z.strictObject({
  nodeId: nodeIdV2,
  position: positiveSafeIntegerV2,
  predecessorId: nodeIdV2.nullable(),
  successorId: nodeIdV2.nullable(),
  status: nodeStatusDtoV2Schema,
  block: blockInfoV2Schema.nullable(),
  resolvedSettings: resolvedNodeSettingsDtoV2Schema,
  successfulOutput: boundedTextV2(1024 * 1024).nullable(),
  attempts: z.array(attemptDetailDtoV2Schema),
}).superRefine((node, context) => {
  const report: ReportIssueV2 = (path, message) => context.addIssue({ code: "custom", path, message });
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
  if (node.status === "pending" && node.attempts.length > 0) {
    report(["attempts"], "pending nodes have no semantic attempts");
  }
  if (node.status === "cancelled" && lastAttempt !== undefined && lastAttempt.status !== "cancelled") {
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
      && timestampMillisecondsV2(attempt.startedAt) < previousAttemptFinish) {
      report(["attempts", index, "startedAt"], "semantic attempts must be chronological");
    }
    if (attempt.finishedAt !== null) previousAttemptFinish = timestampMillisecondsV2(attempt.finishedAt);
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

export const runDetailDtoV2Schema = z.strictObject({
  version: z.literal(2),
  summary: runSummaryDtoV2Schema,
  preflight: preflightDtoV2Schema.nullable(),
  resolutions: z.array(operatorResolutionV2Schema),
  nodes: z.array(nodeDetailDtoV2Schema).min(1),
}).superRefine((detail, context) => {
  const report: ReportIssueV2 = (path, message) => context.addIssue({ code: "custom", path, message });
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, z.infer<typeof nodeDetailDtoV2Schema>>();
  const attemptsById = new Map<string, { nodeId: string; attempt: z.infer<typeof attemptDetailDtoV2Schema> }>();
  const historyBlocks = new Map<string, BlockInfoValueV2>();
  const historicalBlockIds = new Set<string>();
  const processRecords: ProcessIncarnationValueV2[] = [];
  const processOwners = new Map<string, string>();
  const resolutionIds = new Set<string>();
  const resolvedBlockIds = new Set<string>();
  const evidenceIds = new Set<string>();
  let nonSuccessPosition: number | undefined;
  let pendingSuffixStarted = false;

  const rememberHistoryBlock = (block: BlockInfoValueV2, path: IssuePathV2): void => {
    if (historicalBlockIds.has(block.blockId)) report([...path, "blockId"], "historical block IDs must be unique within a run");
    historicalBlockIds.add(block.blockId);
    historyBlocks.set(block.blockId, block);
  };
  const requireKnownBlock = (block: BlockInfoValueV2, path: IssuePathV2): void => {
    const recorded = historyBlocks.get(block.blockId);
    if (recorded === undefined || !sameBlockV2(recorded, block)) report([...path, "blockId"], "block reference must match retained historical evidence");
  };

  for (const [nodeIndex, node] of detail.nodes.entries()) {
    if (nodeIds.has(node.nodeId)) report(["nodes", nodeIndex, "nodeId"], "node IDs must be unique");
    nodeIds.add(node.nodeId);
    nodesById.set(node.nodeId, node);
    if (node.position !== nodeIndex + 1) report(["nodes", nodeIndex, "position"], "nodes must be ordered by contiguous chain position");
    const expectedPredecessor = detail.nodes[nodeIndex - 1]?.nodeId ?? null;
    const expectedSuccessor = detail.nodes[nodeIndex + 1]?.nodeId ?? null;
    if (node.predecessorId !== expectedPredecessor || node.successorId !== expectedSuccessor) {
      report(["nodes", nodeIndex], "node links must match the selected historical chain");
    }
    if (node.status === "pending") {
      pendingSuffixStarted = true;
    } else if (node.status === "succeeded") {
      if (pendingSuffixStarted || nonSuccessPosition !== undefined) {
        report(["nodes", nodeIndex, "status"], "succeeded nodes form a prefix before the current node");
      }
    } else {
      if (pendingSuffixStarted) report(["nodes", nodeIndex, "status"], "active or terminal nodes cannot follow pending nodes");
      if (nonSuccessPosition !== undefined) report(["nodes", nodeIndex, "status"], "the linear chain has at most one active or terminal non-success node");
      nonSuccessPosition = nodeIndex;
    }

    for (const [attemptIndex, attempt] of node.attempts.entries()) {
      if (attemptsById.has(attempt.attemptId)) report(["nodes", nodeIndex, "attempts", attemptIndex, "attemptId"], "attempt IDs must be unique within a run");
      attemptsById.set(attempt.attemptId, { nodeId: node.nodeId, attempt });
      for (const [blockIndex, block] of attempt.blocks.entries()) {
        rememberHistoryBlock(block, ["nodes", nodeIndex, "attempts", attemptIndex, "blocks", blockIndex]);
      }
      for (const process of attempt.processes) {
        processRecords.push(process);
        const owner = `attempt:${attempt.attemptId}`;
        const previousOwner = processOwners.get(process.executionId);
        if (previousOwner !== undefined && previousOwner !== owner) {
          report(["nodes", nodeIndex, "attempts", attemptIndex, "processes"], "semantic attempts use distinct process execution IDs");
        }
        processOwners.set(process.executionId, owner);
      }
      for (const acceptance of attempt.operatorAcceptances) {
        if (resolutionIds.has(acceptance.resolutionId)) report(["nodes", nodeIndex, "attempts", attemptIndex, "operatorAcceptances"], "operator resolution IDs are unique within a run");
        resolutionIds.add(acceptance.resolutionId);
        if (resolvedBlockIds.has(acceptance.sourceBlock.blockId)) {
          report(["nodes", nodeIndex, "attempts", attemptIndex, "operatorAcceptances"], "each block has at most one resolution or acceptance");
        }
        resolvedBlockIds.add(acceptance.sourceBlock.blockId);
        requireKnownBlock(acceptance.sourceBlock, ["nodes", nodeIndex, "attempts", attemptIndex, "operatorAcceptances"]);
      }
      for (const evidence of [attempt.candidate, attempt.verdict]) {
        if (evidence !== null) {
          if (evidenceIds.has(evidence.evidenceId)) report(["nodes", nodeIndex, "attempts", attemptIndex], "evidence IDs must be unique within a run");
          evidenceIds.add(evidence.evidenceId);
        }
      }
      for (const judgment of attempt.judgments) {
        if (evidenceIds.has(judgment.evidenceId)) report(["nodes", nodeIndex, "attempts", attemptIndex, "judgments"], "evidence IDs must be unique within a run");
        evidenceIds.add(judgment.evidenceId);
      }
    }

    if (node.block !== null) {
      if (node.block.attemptId !== null && !attemptsById.has(node.block.attemptId)) {
        report(["nodes", nodeIndex, "block", "attemptId"], "node block attempt ID must resolve in the run");
      }
      const recorded = historyBlocks.get(node.block.blockId);
      if (recorded === undefined && node.block.attemptId !== null) {
        report(["nodes", nodeIndex, "block", "blockId"], "attempt-linked node blocks remain in attempt history");
      } else if (recorded === undefined) {
        historyBlocks.set(node.block.blockId, node.block);
      } else if (!sameBlockV2(recorded, node.block)) {
        report(["nodes", nodeIndex, "block"], "current node block must match retained evidence");
      }
    }
  }

  if (detail.preflight !== null) {
    const preflightProcesses = detail.preflight.checks.flatMap((check) => check.processes);
    for (const process of preflightProcesses) processRecords.push(process);
    checkProcessIncarnations(preflightProcesses, report, ["preflight", "checks", "processes"], "preflight");
    for (const [checkIndex, check] of detail.preflight.checks.entries()) {
      if (check.block !== null) rememberHistoryBlock(check.block, ["preflight", "checks", checkIndex, "block"]);
      for (const process of check.processes) {
        const owner = `preflight:${check.checkId}`;
        const previousOwner = processOwners.get(process.executionId);
        if (previousOwner !== undefined && previousOwner !== owner) {
          report(["preflight", "checks", checkIndex, "processes"], "preflight execution IDs are distinct from node attempts");
        }
        processOwners.set(process.executionId, owner);
      }
    }
    if (detail.preflight.reusedFrom !== null
      && timestampMillisecondsV2(detail.preflight.reusedFrom.passedAt) > timestampMillisecondsV2(detail.summary.admittedAt)) {
      report(["preflight", "reusedFrom", "passedAt"], "reused preflight pass predates this run admission");
    }
    if (detail.preflight.reusedFrom?.runId === detail.summary.runId) {
      report(["preflight", "reusedFrom", "runId"], "a run cannot reuse its own preflight pass");
    }
    if (detail.preflight.outcome !== "passed" && detail.nodes.some((node) => node.attempts.length > 0)) {
      report(["nodes"], "node attempts require a successful configured preflight");
    }
    if (detail.preflight.outcome === "failed" && detail.summary.status === "blocked"
      && detail.summary.block?.kind !== "preflight_failed") {
      report(["summary", "block"], "failed preflight remains the current run block");
    }
    if (detail.summary.block?.kind === "preflight_failed" && detail.preflight.outcome !== "failed") {
      report(["preflight", "outcome"], "current preflight block requires a failed check");
    }
  } else if (detail.summary.block?.kind === "preflight_failed") {
    report(["preflight"], "preflight failure requires its check history");
  }

  for (const [checkIndex, check] of detail.preflight?.checks.entries() ?? []) {
    if (check.block !== null) requireKnownBlock(check.block, ["preflight", "checks", checkIndex, "block"]);
  }
  checkProcessIncarnations(processRecords, report, ["processes"]);

  const checkNoWorkInsideBlockWindow = (source: BlockInfoValueV2, resolvedAt: number, path: IssuePathV2): void => {
    const blockedAt = timestampMillisecondsV2(source.blockedAt);
    if (detail.nodes.some((node) => node.attempts.some((attempt) => attempt.startedAt !== null
      && timestampMillisecondsV2(attempt.startedAt) >= blockedAt
      && timestampMillisecondsV2(attempt.startedAt) < resolvedAt))) {
      report(path, "semantic attempts cannot start while a source block is unresolved");
    }
    if (processRecords.some((process) => process.launchIntentAt !== null
      && timestampMillisecondsV2(process.launchIntentAt) >= blockedAt
      && timestampMillisecondsV2(process.launchIntentAt) < resolvedAt)) {
      report(path, "process launches cannot occur while a source block is unresolved");
    }
    if ((detail.preflight?.checks ?? []).some((check) => check.startedAt !== null
      && timestampMillisecondsV2(check.startedAt) >= blockedAt
      && timestampMillisecondsV2(check.startedAt) < resolvedAt)) {
      report(path, "preflight checks cannot start while a source block is unresolved");
    }
  };

  const operatorResolutions = new Map<string, z.infer<typeof operatorResolutionV2Schema>>();
  let previousResolutionAt: number | undefined;
  for (const [index, resolution] of detail.resolutions.entries()) {
    if (resolutionIds.has(resolution.resolutionId)) report(["resolutions", index, "resolutionId"], "operator resolution IDs are unique within a run");
    resolutionIds.add(resolution.resolutionId);
    if (resolvedBlockIds.has(resolution.sourceBlock.blockId)) {
      report(["resolutions", index, "sourceBlock"], "each block has at most one resolution or acceptance");
    }
    resolvedBlockIds.add(resolution.sourceBlock.blockId);
    operatorResolutions.set(resolution.resolutionId, resolution);
    const resolvedAt = timestampMillisecondsV2(resolution.resolvedAt);
    if (previousResolutionAt !== undefined && resolvedAt < previousResolutionAt) report(["resolutions", index, "resolvedAt"], "operator resolutions must be ordered by time");
    previousResolutionAt = resolvedAt;
    const knownSource = historyBlocks.get(resolution.sourceBlock.blockId);
    if (knownSource === undefined && resolution.sourceBlock.attemptId === null) {
      historyBlocks.set(resolution.sourceBlock.blockId, resolution.sourceBlock);
    } else {
      requireKnownBlock(resolution.sourceBlock, ["resolutions", index, "sourceBlock"]);
    }
    const source = resolution.sourceBlock;
    checkNoWorkInsideBlockWindow(source, resolvedAt, ["resolutions", index, "resolvedAt"]);
    const recordedSourceProcesses = source.attemptId !== null
      ? attemptsById.get(source.attemptId)?.attempt.processes
      : processRecords;
    const sourceProcesses = recordedSourceProcesses?.filter((process) => process.launchIntentAt !== null
      && timestampMillisecondsV2(process.launchIntentAt) <= resolvedAt);
    if (sourceProcesses === undefined) {
      report(["resolutions", index, "sourceBlock"], "resolution source process history must resolve");
    } else {
      if (!processGroupsReconciledV2(sourceProcesses)) {
        report(["resolutions", index, "processGroupsConfirmedDead"], "operator resolution requires every source process group to be reconciled");
      }
      if (sourceProcesses.some((process) => process.finishedAt !== null
        && timestampMillisecondsV2(process.finishedAt) > resolvedAt)) {
        report(["resolutions", index, "resolvedAt"], "operator resolution follows recorded process completion");
      }
      if (source.kind === "external_outcome_unknown"
        && !sourceProcesses.some((process) => process.launchIntentAt !== null)) {
        report(["resolutions", index, "sourceBlock"], "unknown external outcomes retain a launched process record");
      }
    }
    if (resolution.action === "fail" && processRecords.some((process) => process.launchIntentAt !== null
      && timestampMillisecondsV2(process.launchIntentAt) > resolvedAt)) {
      report(["resolutions", index, "resolvedAt"], "a fail resolution cannot precede later process launches");
    }
    if (resolution.action === "retry" && source.attemptId !== null
      && attemptsById.get(source.attemptId)?.attempt.processes.some((process) => process.launchIntentAt !== null
        && timestampMillisecondsV2(process.launchIntentAt) > resolvedAt)) {
      report(["resolutions", index, "resolvedAt"], "an attempt-scoped retry cannot precede more launches in its source attempt");
    }
    if ((detail.summary.block !== null && sameBlockV2(detail.summary.block, source))
      || detail.nodes.some((node) => node.block !== null && sameBlockV2(node.block, source))) {
      report(["resolutions", index, "sourceBlock"], "resolved blocks are no longer current");
    }
    if (source.attemptId !== null) {
      const attemptRecord = attemptsById.get(source.attemptId);
      if (attemptRecord === undefined || attemptRecord.nodeId !== source.nodeId) {
        report(["resolutions", index, "sourceBlock"], "resolution source node and attempt must resolve together");
      }
      if (attemptRecord !== undefined && !attemptRecord.attempt.blocks.some((block) => sameBlockV2(block, source))) {
        report(["resolutions", index, "sourceBlock"], "attempt resolution source remains in block history");
      }
      if (attemptRecord !== undefined && resolution.action === "retry"
        && attemptRecord.attempt.status !== "failed" && attemptRecord.attempt.status !== "interrupted") {
        report(["resolutions", index, "sourceBlock"], "attempt-scoped retry requires a failed or interrupted source attempt");
      }
      if (attemptRecord !== undefined && (resolution.action === "retry" || resolution.action === "fail")) {
        const blocksBeforeResolution = attemptRecord.attempt.blocks.filter((block) =>
          timestampMillisecondsV2(block.blockedAt) <= resolvedAt);
        const latestBlock = blocksBeforeResolution.at(-1);
        if (latestBlock !== undefined && !sameBlockV2(latestBlock, source)) {
          report(["resolutions", index, "sourceBlock"], "attempt-scoped resolution identifies the latest block at its resolution time");
        }
        if (attemptRecord.attempt.blocks.some((block) => timestampMillisecondsV2(block.blockedAt) > resolvedAt)) {
          report(["resolutions", index, "resolvedAt"], "all source attempt blocks precede its resolution");
        }
      }
      if (attemptRecord !== undefined && resolution.action === "retry") {
        const node = nodesById.get(attemptRecord.nodeId);
        if (node !== undefined) {
          const exhausted = attemptRecord.attempt.number >= node.resolvedSettings.maxAttempts;
          if (resolution.extraAttempt !== exhausted) report(["resolutions", index, "extraAttempt"], "extra-attempt override is required exactly when the semantic bound is exhausted");
          const repeatRequired = source.kind === "external_outcome_unknown"
            || attemptRecord.attempt.processes.some((process) => process.replay === "never");
          if (resolution.allowRepeat !== repeatRequired) report(["resolutions", index, "allowRepeat"], "repeat override records whether this retry may repeat external work");
        }
      }
    }
    if (source.nodeId !== null && !nodesById.has(source.nodeId)) report(["resolutions", index, "sourceBlock", "nodeId"], "resolution source node must resolve in run history");
    if (source.attemptId === null && resolution.action === "retry"
      && (resolution.allowRepeat || resolution.extraAttempt)) {
      report(["resolutions", index], "run-level retries do not consume or repeat semantic attempts");
    }
    if (source.attemptId === null && resolution.action === "retry" && source.kind === "preflight_failed") {
      const sourceCheckIndex = detail.preflight?.checks.findIndex((check) =>
        check.block !== null && sameBlockV2(check.block, source)) ?? -1;
      if (sourceCheckIndex < 0) {
        report(["resolutions", index, "sourceBlock"], "preflight retry identifies its retained failed check");
      } else {
        for (const [checkIndex, check] of (detail.preflight?.checks ?? []).entries()) {
          if (checkIndex <= sourceCheckIndex) continue;
          if (check.startedAt !== null && timestampMillisecondsV2(check.startedAt) < resolvedAt) {
            report(["preflight", "checks", checkIndex, "startedAt"], "retried preflight checks start at or after resolution");
          }
          if (check.processes.some((process) => process.launchIntentAt !== null
            && timestampMillisecondsV2(process.launchIntentAt) < resolvedAt)) {
            report(["preflight", "checks", checkIndex, "processes"], "retried preflight launches follow resolution");
          }
        }
      }
    }
    if (source.attemptId === null && source.nodeId !== null && resolution.action === "retry") {
      const sourceNode = nodesById.get(source.nodeId);
      const firstAttempt = sourceNode?.attempts[0];
      if (firstAttempt?.startedAt !== null && firstAttempt?.startedAt !== undefined
        && timestampMillisecondsV2(firstAttempt.startedAt) < resolvedAt) {
        report(["nodes"], "a node's first semantic attempt starts at or after its pre-attempt retry resolution");
      }
      if (firstAttempt?.processes.some((process) => process.launchIntentAt !== null
        && timestampMillisecondsV2(process.launchIntentAt) < resolvedAt)) {
        report(["nodes"], "a node's first process launch follows its pre-attempt retry resolution");
      }
    }
  }

  for (const [nodeIndex, node] of detail.nodes.entries()) {
    for (const [attemptIndex, attempt] of node.attempts.entries()) {
      for (const [acceptanceIndex, acceptance] of attempt.operatorAcceptances.entries()) {
        const resolvedAt = timestampMillisecondsV2(acceptance.resolvedAt);
        checkNoWorkInsideBlockWindow(acceptance.sourceBlock, resolvedAt, [
          "nodes", nodeIndex, "attempts", attemptIndex, "operatorAcceptances", acceptanceIndex, "resolvedAt",
        ]);
      }
    }
  }
  for (const block of historyBlocks.values()) {
    const isCurrent = (detail.summary.status === "blocked" && detail.summary.block !== null
      && sameBlockV2(detail.summary.block, block))
      || detail.nodes.some((node) => node.status === "blocked" && node.block !== null
        && sameBlockV2(node.block, block));
    const hasResolution = detail.resolutions.some((resolution) => sameBlockV2(resolution.sourceBlock, block));
    const hasAcceptance = detail.nodes.some((node) => node.attempts.some((attempt) =>
      attempt.operatorAcceptances.some((acceptance) => sameBlockV2(acceptance.sourceBlock, block))));
    if (!isCurrent && !hasResolution && !hasAcceptance) {
      report(["blocks", block.blockId], "every block remains current or has an audited resolution");
    }
  }

  const passedPreflightAt = detail.preflight?.outcome === "passed"
    ? detail.preflight.reusedFrom?.passedAt ?? detail.preflight.checks.at(-1)?.finishedAt ?? null
    : null;
  if (passedPreflightAt !== null) {
    const preflightFinishedAt = timestampMillisecondsV2(passedPreflightAt);
    for (const [nodeIndex, node] of detail.nodes.entries()) {
      for (const [attemptIndex, attempt] of node.attempts.entries()) {
        if (attempt.startedAt !== null && timestampMillisecondsV2(attempt.startedAt) < preflightFinishedAt) {
          report(["nodes", nodeIndex, "attempts", attemptIndex, "startedAt"], "node attempts start after the final passed preflight check");
        }
        if (attempt.processes.some((process) => process.launchIntentAt !== null
          && timestampMillisecondsV2(process.launchIntentAt) < preflightFinishedAt)) {
          report(["nodes", nodeIndex, "attempts", attemptIndex, "processes"], "node process launches follow the final passed preflight check");
        }
      }
    }
  }

  const runFailure = detail.summary.failure;
  if (runFailure !== null && runFailure.kind !== "operator") {
    if (runFailure.attemptId !== null && !attemptsById.has(runFailure.attemptId)) report(["summary", "failure", "attemptId"], "run failure attempt must resolve in run history");
    if (runFailure.nodeId !== null && !nodesById.has(runFailure.nodeId)) report(["summary", "failure", "nodeId"], "run failure node must resolve in selected chain");
    if (runFailure.attemptId !== null) {
      const attemptRecord = attemptsById.get(runFailure.attemptId);
      if (attemptRecord !== undefined && runFailure.nodeId !== attemptRecord.nodeId) report(["summary", "failure", "nodeId"], "run failure node and attempt must agree");
    }
    if (runFailure.nodeId !== null) {
      const node = nodesById.get(runFailure.nodeId);
      const lastAttempt = node?.attempts.at(-1);
      const currentBlockedAttempt = node?.status === "blocked" && (node.block?.attemptId === runFailure.attemptId
        || (node.block?.attemptId === null && node.block.nodeId === runFailure.nodeId));
      if ((node?.status !== "failed" && !currentBlockedAttempt)
        || lastAttempt?.status !== "failed" || lastAttempt.failure === null
        || runFailure.attemptId !== lastAttempt.attemptId || !sameFailureV2(runFailure, lastAttempt.failure)) {
        report(["summary", "failure"], "node-scoped run failure matches the failed or currently blocked attempt");
      }
    }
    if (detail.summary.finishedAt !== null && timestampMillisecondsV2(runFailure.failedAt) > timestampMillisecondsV2(detail.summary.finishedAt)) {
      report(["summary", "failure", "failedAt"], "run failure cannot follow terminal completion");
    }
  }
  if (runFailure?.kind === "operator") {
    requireKnownBlock(runFailure.sourceBlock, ["summary", "failure", "sourceBlock"]);
    const resolution = operatorResolutions.get(runFailure.resolutionId);
    if (resolution?.action !== "fail" || resolution.reason !== runFailure.reason
      || resolution.resolvedAt !== runFailure.failedAt
      || !sameBlockV2(resolution.sourceBlock, runFailure.sourceBlock)) {
      report(["summary", "failure", "resolutionId"], "operator run failure must match its fail resolution");
    }
    if (runFailure.sourceBlock.attemptId !== null) {
      const attemptRecord = attemptsById.get(runFailure.sourceBlock.attemptId);
      const node = runFailure.sourceBlock.nodeId === null ? undefined : nodesById.get(runFailure.sourceBlock.nodeId);
      const lastAttempt = node?.attempts.at(-1);
      if (attemptRecord === undefined || attemptRecord.nodeId !== runFailure.sourceBlock.nodeId
        || node?.status !== "failed" || lastAttempt?.attemptId !== runFailure.sourceBlock.attemptId
        || (lastAttempt.status !== "interrupted" && lastAttempt.status !== "failed")) {
        report(["summary", "failure", "sourceBlock"], "operator failure source must be its failed node's latest attempt");
      }
    } else if (runFailure.sourceBlock.nodeId !== null) {
      const sourceNode = nodesById.get(runFailure.sourceBlock.nodeId);
      const lastAttempt = sourceNode?.attempts.at(-1);
      const priorAttemptFailure = sourceNode?.status === "failed"
        && (lastAttempt?.status === "failed" || lastAttempt?.status === "interrupted");
      const unstartedNode = sourceNode?.status === "pending" && sourceNode.attempts.length === 0;
      if (sourceNode === undefined || (!priorAttemptFailure && !unstartedNode)) {
        report(["summary", "failure", "sourceBlock"], "a node-scoped operator failure without an attempt preserves a prior failure or ends an unstarted node");
      }
    }
    if (detail.summary.finishedAt !== null && timestampMillisecondsV2(runFailure.failedAt) > timestampMillisecondsV2(detail.summary.finishedAt)) {
      report(["summary", "failure", "failedAt"], "operator failure cannot follow terminal completion");
    }
  }
  for (const [index, resolution] of detail.resolutions.entries()) {
    if (resolution.action === "fail" && (runFailure?.kind !== "operator" || runFailure.resolutionId !== resolution.resolutionId)) {
      report(["resolutions", index], "a fail resolution is retained as the terminal run failure");
    }
  }
  for (const [nodeIndex, node] of detail.nodes.entries()) {
    const lastAttempt = node.attempts.at(-1);
    const operatorBlockRequiresNodeLink = runFailure?.kind === "operator"
      && runFailure.sourceBlock.nodeId !== null;
    const requiresAttemptLinkedOperatorFailure = lastAttempt?.status === "interrupted"
      || (lastAttempt?.status === "failed" && operatorBlockRequiresNodeLink);
    const operatorFailureIdentifiesLatestAttempt = runFailure?.kind === "operator"
      && (runFailure.sourceBlock.nodeId === null || runFailure.sourceBlock.nodeId === node.nodeId)
      && (runFailure.sourceBlock.attemptId === null
        || (runFailure.sourceBlock.nodeId === node.nodeId
          && runFailure.sourceBlock.attemptId === lastAttempt?.attemptId
          && lastAttempt.blocks.some((block) => sameBlockV2(block, runFailure.sourceBlock))));
    if (node.status === "failed" && lastAttempt !== undefined && requiresAttemptLinkedOperatorFailure
      && !operatorFailureIdentifiesLatestAttempt) {
      report(["nodes", nodeIndex, "status"], "operator-ended attempts require a retained fail resolution for their current block");
    }
    for (const [attemptIndex, attempt] of node.attempts.entries()) {
      for (const [acceptanceIndex, acceptance] of attempt.operatorAcceptances.entries()) {
        if ((detail.summary.block !== null && sameBlockV2(detail.summary.block, acceptance.sourceBlock))
          || detail.nodes.some((otherNode) => otherNode.block !== null && sameBlockV2(otherNode.block, acceptance.sourceBlock))) {
          report(["nodes", nodeIndex, "attempts", attemptIndex, "operatorAcceptances", acceptanceIndex], "accepted blocks are no longer current");
        }
      }
      const nextAttempt = node.attempts[attemptIndex + 1];
      if (nextAttempt === undefined) continue;
      if (attempt.status !== "failed" && attempt.status !== "interrupted") {
        report(["nodes", nodeIndex, "attempts", attemptIndex, "status"], "only a failed or interrupted attempt can have a successor");
      }
      if (!processGroupsReconciledV2(attempt.processes)) {
        report(["nodes", nodeIndex, "attempts", attemptIndex, "processes"], "a successor waits for every prior process group to be confirmed dead");
      }
      const retry = detail.resolutions.find((resolution) =>
        resolution.action === "retry" && resolution.sourceBlock.attemptId === attempt.attemptId);
      if (attempt.status === "interrupted" && retry === undefined) {
        report(["nodes", nodeIndex, "attempts", attemptIndex], "an interrupted attempt resumes only through its linked operator retry resolution");
      }
      if (retry !== undefined) {
        if (attempt.finishedAt !== null && timestampMillisecondsV2(retry.resolvedAt) < timestampMillisecondsV2(attempt.finishedAt)) {
          report(["resolutions"], "retry resolution follows its source attempt");
        }
        if (nextAttempt.startedAt !== null && timestampMillisecondsV2(retry.resolvedAt) > timestampMillisecondsV2(nextAttempt.startedAt)) {
          report(["resolutions"], "retry resolution precedes the successor attempt");
        }
      }
      if (nextAttempt.number > node.resolvedSettings.maxAttempts && !(retry?.action === "retry" && retry.extraAttempt)) {
        report(["nodes", nodeIndex, "attempts", attemptIndex], "attempts above maxAttempts require an operator extra-attempt resolution");
      }
      if (attempt.status === "failed" && retry === undefined) {
        const judgment = attempt.judgments.at(-1);
        if (judgment?.kind !== "judgment" || judgment.decision.action !== "retry") {
          report(["nodes", nodeIndex, "attempts", attemptIndex, "judgments"], "a failed attempt's successor requires a checked retry decision or operator resolution");
        }
        if (attempt.number >= node.resolvedSettings.maxAttempts) {
          report(["nodes", nodeIndex, "attempts", attemptIndex], "judge retry requires remaining semantic attempts");
        }
        const workerWasLaunched = attempt.processes.some((process) => process.role === "worker" && process.launchIntentAt !== null);
        const validatorWasLaunched = attempt.processes.some((process) => process.role === "validator" && process.launchIntentAt !== null);
        const unsafeWorkerRepeat = workerWasLaunched && node.resolvedSettings.run.replay !== "safe";
        const unsafeValidatorRepeat = validatorWasLaunched
          && node.resolvedSettings.validator?.replay !== "safe";
        if (unsafeWorkerRepeat || unsafeValidatorRepeat) {
          report(["nodes", nodeIndex, "attempts", attemptIndex], "judge retry requires safe replay for every previously launched role");
        }
      }
    }
  }

  if (detail.summary.currentNodeId !== null) {
    const currentNode = nodesById.get(detail.summary.currentNodeId);
    if (currentNode === undefined) {
      report(["summary", "currentNodeId"], "current node must resolve in selected chain");
    } else {
      const expectedAttemptNumber = currentNode.attempts.at(-1)?.number ?? null;
      if (detail.summary.currentAttemptNumber !== expectedAttemptNumber) {
        report(["summary", "currentAttemptNumber"], "current attempt number must match the selected node's latest attempt");
      }
    }
  }

  if (detail.summary.block !== null) {
    const currentBlock = detail.summary.block;
    const recorded = historyBlocks.get(currentBlock.blockId);
    if (recorded === undefined && currentBlock.nodeId === null && currentBlock.attemptId === null) {
      historyBlocks.set(currentBlock.blockId, currentBlock);
    } else if (recorded === undefined || !sameBlockV2(recorded, currentBlock)) {
      report(["summary", "block"], "current run block must match retained evidence");
    }
    if (currentBlock.attemptId !== null && !attemptsById.has(currentBlock.attemptId)) report(["summary", "block", "attemptId"], "run block attempt must resolve in run history");
    if (currentBlock.nodeId !== null) {
      const blockedNode = nodesById.get(currentBlock.nodeId);
      if (blockedNode?.status !== "blocked" || blockedNode.block === null || !sameBlockV2(blockedNode.block, currentBlock)) {
        report(["summary", "block"], "node-specific run block must match the currently blocked node");
      }
    }
    const currentBlockAt = timestampMillisecondsV2(currentBlock.blockedAt);
    if (detail.nodes.some((node) => node.attempts.some((attempt) => attempt.startedAt !== null
      && timestampMillisecondsV2(attempt.startedAt) >= currentBlockAt))
      || processRecords.some((process) => process.launchIntentAt !== null
        && timestampMillisecondsV2(process.launchIntentAt) >= currentBlockAt)
      || (detail.preflight?.checks ?? []).some((check) => check.startedAt !== null
        && timestampMillisecondsV2(check.startedAt) >= currentBlockAt)) {
      report(["summary", "block"], "a current block has no later attempt, process, or preflight starts");
    }
  }

  const blockedNodes = detail.nodes.filter((node) => node.status === "blocked");
  if (blockedNodes.length > 1 || (blockedNodes.length > 0 && detail.summary.status !== "blocked")) {
    report(["nodes"], "a blocked run has at most one currently blocked node");
  }
  const blockedNode = blockedNodes[0];
  if (blockedNode !== undefined
    && (detail.summary.block === null || blockedNode.block === null
      || !sameBlockV2(detail.summary.block, blockedNode.block))) {
    report(["summary", "block"], "the summary and blocked node identify the same current block");
  }
  if (detail.summary.status === "completed" && detail.nodes.some((node) => node.status !== "succeeded")) {
    report(["nodes"], "completed runs require every node to have succeeded");
  }
  if (detail.summary.status === "completed"
    && detail.summary.terminalOutput !== detail.nodes.at(-1)?.successfulOutput) {
    report(["summary", "terminalOutput"], "terminal output matches the final node's successful output");
  }
  if (detail.summary.status === "failed") {
    if (detail.nodes.some((node) => node.status === "running" || node.status === "blocked" || node.status === "cancelled")) {
      report(["nodes"], "failed runs have no running, blocked, or cancelled nodes");
    }
    const failedNodes = detail.nodes.filter((node) => node.status === "failed");
    const failedAtPreflight = runFailure?.kind === "operator"
      && runFailure.sourceBlock.kind === "preflight_failed" && detail.preflight?.outcome === "failed";
    const failedAtRunLevel = runFailure?.kind === "operator"
      && runFailure.sourceBlock.attemptId === null
      && runFailure.sourceBlock.kind !== "preflight_failed";
    if (failedAtPreflight) {
      if (detail.nodes.some((node) => node.status !== "pending")) {
        report(["nodes"], "operator-failed preflight leaves every node unstarted");
      }
    } else if (failedAtRunLevel) {
      const sourceBlock = runFailure.sourceBlock;
      const failedNode = failedNodes[0];
      const failedAttempt = failedNode?.attempts.at(-1);
      const preservedPriorFailure = failedNodes.length === 1
        && (sourceBlock.nodeId === null || sourceBlock.nodeId === failedNode?.nodeId)
        && (failedAttempt?.status === "failed" || failedAttempt?.status === "interrupted");
      const unstartedNodeBlock = sourceBlock.nodeId !== null && failedNodes.length === 0
        && nodesById.get(sourceBlock.nodeId)?.status === "pending"
        && nodesById.get(sourceBlock.nodeId)?.attempts.length === 0;
      if (failedNodes.length > 0 && !preservedPriorFailure) {
        report(["nodes"], "run-level operator failure preserves at most one already failed node");
      }
      if (sourceBlock.nodeId !== null && !unstartedNodeBlock && !preservedPriorFailure) {
        report(["summary", "failure", "sourceBlock"], "node-scoped run-level failure applies to an unstarted node or its preserved failed attempt");
      }
    } else if (failedNodes.length !== 1) {
      report(["nodes"], "failed runs retain one failed node, a run-level operator failure, or a failed preflight");
    } else if (runFailure?.kind !== "operator") {
      const failedNode = failedNodes[0];
      const lastAttempt = failedNode?.attempts.at(-1);
      if (failedNode === undefined || lastAttempt?.status !== "failed" || lastAttempt.failure === null
        || runFailure?.nodeId !== failedNode.nodeId || runFailure.attemptId !== lastAttempt.attemptId
        || !sameFailureV2(runFailure, lastAttempt.failure)) {
        report(["summary", "failure"], "failed run cause matches its failed node's latest attempt");
      }
    }
  }
  if (detail.summary.status === "cancelled" && detail.nodes.some((node) => node.status === "running" || node.status === "blocked")) {
    report(["nodes"], "cancelled runs have no running or blocked nodes");
  }
  if (detail.summary.status === "cancelled" && detail.nodes.every((node) => node.status === "succeeded")) {
    report(["summary", "status"], "a fully successful chain is completed rather than cancelled");
  }
  const terminalRun = ["completed", "failed", "cancelled"].includes(detail.summary.status);
  if (terminalRun && detail.nodes.some((node) => node.attempts.some((attempt) =>
    !["succeeded", "failed", "interrupted", "cancelled"].includes(attempt.status)))) {
    report(["nodes"], "terminal runs contain only terminal semantic attempts");
  }
  if (terminalRun && processRecords.some((process) => {
    const settledStatus = process.status === "prepared" || process.status === "exited" || process.status === "blocked";
    const confirmed = process.status === "prepared" || process.cleanupState === "confirmed_dead";
    return !settledStatus || !confirmed;
  })) {
    report(["summary", "status"], "terminal runs have no live or uncertain process groups; only prepared or reconciled process incarnations are valid");
  }
});

export const nodeDescriptionDtoV2Schema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdV2,
  definitionHash: sha256V2Schema,
  runId: runIdV2Schema.nullable(),
  runStatus: runStatusV2Schema.nullable(),
  runFailure: runFailureInfoV2Schema.nullable(),
  node: nodeDetailDtoV2Schema,
}).superRefine((description, context) => {
  const report: ReportIssueV2 = (path, message) => context.addIssue({ code: "custom", path, message });
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
  if (runStatus === "queued" && node.status !== "pending") {
    report(["node", "status"], "queued runs contain only pending nodes");
  }
  if (runStatus === "completed" && node.status !== "succeeded") {
    report(["node", "status"], "completed runs contain only succeeded nodes");
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
      || !lastAttempt.blocks.some((block) => sameBlockV2(block, sourceBlock))) {
      report(["runFailure", "sourceBlock"], "node-scoped operator failure identifies the failed latest attempt");
    }
  }
  if (node.status === "failed" && lastAttempt?.status === "interrupted"
    && (runStatus !== "failed" || operatorFailure === null
      || (operatorFailure.sourceBlock.attemptId !== null
        && (operatorFailure.sourceBlock.nodeId !== node.nodeId
          || operatorFailure.sourceBlock.attemptId !== lastAttempt.attemptId
          || !lastAttempt.blocks.some((block) => sameBlockV2(block, operatorFailure.sourceBlock)))))) {
    report(["runFailure"], "operator-ended interrupted attempts require their run-level failure cause");
  }
  if (runFailure !== null && runFailure.kind !== "operator" && runFailure.nodeId === node.nodeId
    && (runFailure.attemptId === null
      || (node.status !== "failed"
        && !(node.status === "blocked" && runStatus === "blocked"
          && (node.block?.attemptId === runFailure.attemptId
            || (node.block?.attemptId === null && node.block.nodeId === node.nodeId))))
      || lastAttempt?.attemptId !== runFailure.attemptId || lastAttempt.failure === null
      || !sameFailureV2(runFailure, lastAttempt.failure))) {
    report(["runFailure"], "node-scoped run failures identify their failed latest attempt");
  }
  if (runStatus === "failed" && node.status === "failed" && lastAttempt?.status === "failed"
    && runFailure?.kind !== "operator"
    && (runFailure === null || runFailure.nodeId !== node.nodeId || runFailure.attemptId !== lastAttempt.attemptId
      || lastAttempt.failure === null || !sameFailureV2(runFailure, lastAttempt.failure))) {
    report(["runFailure"], "failed attempts retain their terminal run failure cause");
  }

});

export const diagramDtoV2Schema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdV2,
  definitionHash: sha256V2Schema,
  runId: runIdV2Schema.nullable(),
  nodes: z.array(z.strictObject({
    nodeId: nodeIdV2,
    position: positiveSafeIntegerV2,
    successorId: nodeIdV2.nullable(),
    status: nodeStatusDtoV2Schema.nullable(),
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

const textLogSectionV2Schema = z.strictObject({
  kind: z.enum(["worklog", "event", "attempt", "judgment"]),
  sectionId: z.string().min(1),
  order: nonnegativeSafeIntegerV2,
  label: z.string().min(1),
  content: logContentV2,
  omittedBytes: byteCountV2Schema,
});

const captureLogSectionV2Schema = z.strictObject({
  kind: z.literal("capture"),
  sectionId: z.string().min(1),
  order: nonnegativeSafeIntegerV2,
  label: z.string().min(1),
  executionId: executionIdV2Schema,
  incarnationNumber: positiveSafeIntegerV2,
  capture: processCaptureV2Schema,
  content: logContentV2.nullable(),
  unavailableReason: boundedTextV2(64 * 1024).nullable(),
  omittedBytes: byteCountV2Schema,
}).superRefine((section, context) => {
  if ((section.content === null) !== (section.unavailableReason !== null)) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "unavailable captures require a reason; loaded captures forbid one" });
  }
  if (section.content === null && section.omittedBytes !== 0) {
    context.addIssue({ code: "custom", path: ["omittedBytes"], message: "unavailable captures have no projection omission count" });
  }
});

export const logSectionDtoV2Schema = z.discriminatedUnion("kind", [textLogSectionV2Schema, captureLogSectionV2Schema]);

export const logsDtoV2Schema = z.strictObject({
  version: z.literal(2),
  runId: runIdV2Schema,
  sections: z.array(logSectionDtoV2Schema),
  projection: z.strictObject({
    truncated: z.boolean(),
    omittedSections: nonnegativeSafeIntegerV2,
    omittedBytes: byteCountV2Schema,
  }),
}).superRefine((logs, context) => {
  let previousOrder: number | undefined;
  let omittedBytes = 0;
  const sectionIds = new Set<string>();
  for (const [index, section] of logs.sections.entries()) {
    if (previousOrder !== undefined && previousOrder >= section.order) {
      context.addIssue({ code: "custom", path: ["sections", index], message: "log sections must be uniquely ordered" });
    }
    previousOrder = section.order;
    if (sectionIds.has(section.sectionId)) {
      context.addIssue({ code: "custom", path: ["sections", index, "sectionId"], message: "log section IDs must be unique" });
    }
    sectionIds.add(section.sectionId);
    if (section.omittedBytes > Number.MAX_SAFE_INTEGER - omittedBytes) {
      context.addIssue({ code: "custom", path: ["sections", index, "omittedBytes"], message: "aggregate omitted bytes exceed exact numeric range" });
    } else {
      omittedBytes += section.omittedBytes;
    }
  }
  if (logs.projection.omittedBytes < omittedBytes) {
    context.addIssue({ code: "custom", path: ["projection", "omittedBytes"], message: "projection omission total must include section omissions" });
  }
  if (logs.projection.truncated !== (logs.projection.omittedSections > 0 || logs.projection.omittedBytes > 0)) {
    context.addIssue({ code: "custom", path: ["projection", "truncated"], message: "truncation flag must reflect omitted sections or bytes" });
  }
});

export type StatusDtoV2 = z.infer<typeof statusDtoV2Schema>;
export type WorkflowStatusDtoV2 = z.infer<typeof workflowStatusDtoV2Schema>;
export type RunSummaryDtoV2 = z.infer<typeof runSummaryDtoV2Schema>;
export type RunsDtoV2 = z.infer<typeof runsDtoV2Schema>;
export type ResolvedExecutionSiteDtoV2 = z.infer<typeof resolvedExecutionSiteDtoV2Schema>;
export type ResolvedNodeSettingsDtoV2 = z.infer<typeof resolvedNodeSettingsDtoV2Schema>;
export type EvidenceReferenceDtoV2 = z.infer<typeof evidenceReferenceDtoV2Schema>;
export type AttemptDetailDtoV2 = z.infer<typeof attemptDetailDtoV2Schema>;
export type NodeDetailDtoV2 = z.infer<typeof nodeDetailDtoV2Schema>;
export type RunDetailDtoV2 = z.infer<typeof runDetailDtoV2Schema>;
export type NodeDescriptionDtoV2 = z.infer<typeof nodeDescriptionDtoV2Schema>;
export type LogsDtoV2 = z.infer<typeof logsDtoV2Schema>;
export type DiagramDtoV2 = z.infer<typeof diagramDtoV2Schema>;
