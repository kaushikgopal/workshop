import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationId, type Cursor, type Task, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import type { ResolvedExecutionSite } from "../../definition/schema-resolved.js";
import { nodeIdSchema, workflowIdSchema } from "../../definition/schema.js";
import { parseTextResult, parseTaggedWorkerResult, parseTaggedVerifierDecision } from "../../attempt/parse-tagged-result.js";
import { reconstructProcessStdin } from "../../attempt/build-process-stdin.js";
import { installationDocumentV1Schema } from "../../installation/schema.js";
import { executionIdSchema, incarnationIdSchema } from "../../process/schema.js";
import {
  attemptIdSchema,
  blockInfoSchema,
  failureInfoSchema,
  nodeAttemptOutcomeSchema,
  nodeResultSchema,
  runIdSchema,
  validatorOutcomePasses,
  validatorOutcomeSchema,
  type BlockInfo,
  type FailureInfo,
  type NodeAttemptOutcome,
  type NodeResult,
  type ValidatorOutcome,
} from "../../run/schema.js";
import {
  persistedNodeAttemptSchema,
  workflowRunDocumentV1Schema,
  workshopEventV1Schema,
  workshopProcessV1Schema,
  type WorkflowRunDocumentV1,
} from "../../run/records.js";
import { WorkshopEventEntry, WorkshopInstallationDoc, WorkshopProcessEntry, WorkshopRunDoc } from "./define-workshop-records.js";
import {
  buildProcessExecutionEnvironment,
  processExecutionFiles,
  processExecutionTaskInputSchema,
  processExecutionTaskResultSchema,
  type ProcessExecutionTaskEnvironmentInput,
  type ProcessExecutionTaskInput,
  type ProcessExecutionTaskResult,
  type ProcessExecutionTaskDefinition,
} from "./define-process-execution-task.js";
import { utcTimestampSchema } from "../../util/schema.js";

const positive = z.number().int().positive().refine(Number.isSafeInteger);
type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;
type PersistedNodeAttempt = z.infer<typeof persistedNodeAttemptSchema>;
type NodeRuntime = TaskRuntime<NodeAttemptTaskInput, NodeCheckpoint, NodeAttemptOutcome, object>;
type AwaitProcessCheckpoint = Extract<NodeCheckpoint, { phase: "awaitWorker" | "awaitValidator" }>;
type ReplayableProcessResult = Extract<ProcessExecutionTaskResult, { kind: "replayable" }>;
export type NodeAttemptTaskDefinition = Task<NodeAttemptTaskInput, NodeCheckpoint, NodeAttemptOutcome, object>;

export const nodeAttemptTaskInputSchema = z.strictObject({
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: z.string().min(1),
  occurrenceId: z.string().min(1),
  workflowTaskId: positive,
  nodeId: nodeIdSchema,
  attemptId: attemptIdSchema,
  attemptNumber: positive,
});
export type NodeAttemptTaskInput = z.infer<typeof nodeAttemptTaskInputSchema>;

const nodeCheckpointSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("prepare") }),
  z.strictObject({ phase: z.literal("awaitWorker"), processTaskId: positive, executionId: executionIdSchema, incarnationId: incarnationIdSchema, incarnationNumber: positive }),
  z.strictObject({ phase: z.literal("launchValidator") }),
  z.strictObject({ phase: z.literal("awaitValidator"), processTaskId: positive, executionId: executionIdSchema, incarnationId: incarnationIdSchema, incarnationNumber: positive }),
  z.strictObject({ phase: z.literal("finish") }),
]);
type NodeCheckpoint = z.infer<typeof nodeCheckpointSchema>;

export function defineNodeAttemptTask(
  ProcessExecutionTask: ProcessExecutionTaskDefinition,
  activeBootId: string,
  canLaunch: () => boolean = () => true,
): NodeAttemptTaskDefinition {
  return defineTask<NodeAttemptTaskInput, NodeCheckpoint, NodeAttemptOutcome>({
    name: "workshop.node-attempt",
    version: 4,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, context);
        const input = parseNodeInput(task.input);
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const settings = run.resolvedSettings.nodes[input.nodeId];
        if (settings === undefined) {
          const block = blockInfo("runtime_incompatible", "node has no frozen execution settings", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (attempt.result.kind === "candidate_committed") {
          if (attempt.workerExecutionId === null || attempt.validatorExecutionId !== null) {
            const block = blockInfo("integrity_failed", "operator candidate acceptance does not match process history", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: attempt.result.candidate, validator: null }, "interrupted", context);
            return;
          }
          await runtime.commit(() => ({ status: "running", checkpoint: {
            phase: settings.validator === null ? "finish" : "launchValidator",
          } }), context);
          return;
        }
        if (attempt.result.kind === "validation_committed") {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish" } }), context);
          return;
        }
        const predecessor = run.chain.predecessors[input.nodeId];
        if (predecessor === undefined) throw new Error("frozen node has no predecessor snapshot");
        const launchIntentAt = timestamp(runtime.now());
        let deadlineAt: string | null;
        try {
          deadlineAt = deadline(launchIntentAt, settings.run.timeoutMs);
        } catch {
          const failure = failureInfo("runtime_fault", "configured process timeout exceeds the supported timestamp range", input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
          return;
        }
        const executionId = executionIdSchema.parse(randomUUID());
        const incarnationId = incarnationIdSchema.parse(randomUUID());
        await runtime.commit(async (tx) => {
          const { draft, run: current } = await runDraft(tx, runtime.conversationId);
          assertNodeIdentity(input, current, runtime.taskId);
          const attempt = requireAttempt(current, input.nodeId, input.attemptId);
          if (attempt.status !== "prepared" || attempt.workerExecutionId !== null || attempt.result.kind !== "pending") {
            throw new Error("node attempt is not ready to admit its first worker process");
          }
          const currentSettings = current.resolvedSettings.nodes[input.nodeId];
          if (currentSettings === undefined) throw new Error("canonical node lost its frozen execution settings");
          const processInput = createProcessInput({
            run: current,
            taskId: Number(runtime.taskId),
            input,
            role: "worker",
            site: currentSettings.run,
            executionId,
            incarnationId,
            serviceBootId: activeBootId,
            launchIntentAt,
            deadlineAt,
          });
          const processTaskId = await tx.createTask(ProcessExecutionTask, processInput, {
            ownership: { kind: "task", taskId: runtime.taskId },
            conversationId: runtime.conversationId,
          });
          const next = replaceRunAttempt(current, input.nodeId, input.attemptId, (value) => ({
            ...value,
            status: "executing",
            phase: "awaitWorker",
            workerExecutionId: executionId,
          }));
          assign(draft, next);
          return {
            status: "waiting",
            checkpoint: { phase: "awaitWorker", processTaskId: Number(processTaskId), executionId, incarnationId, incarnationNumber: 1 },
            on: [processTaskId],
            policy: "allSettled",
          };
        }, context);
      },
      awaitWorker: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, context);
        const input = parseNodeInput(task.input);
        const checkpoint = nodeCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "awaitWorker") throw new Error("NodeAttempt checkpoint lacks its worker task identity");
        const taskOutcome = (await runtime.outcomes([durableTaskId<ProcessExecutionTaskResult>(checkpoint.processTaskId)], context))[0];
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (attempt.workerExecutionId !== checkpoint.executionId || attempt.result.kind !== "pending") {
          const block = blockInfo("integrity_failed", "worker checkpoint differs from canonical attempt state", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        if (taskOutcome === undefined || taskOutcome.status !== "completed") {
          const block = blockInfo("external_outcome_unknown", "worker process task ended without a checked receipt", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        const checked = processExecutionTaskResultSchema.safeParse(taskOutcome.result);
        if (!checked.success) {
          const block = blockInfo("integrity_failed", "worker process result failed runtime validation", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        if (checked.data.kind === "cancelled") {
          if (run.desiredState === "stopped" && run.block === null
            && await checkedOperatorStopRetirement(runtime, input, run, attempt, checkpoint, context)) {
            await settleAttempt(task, runtime, input, cancelledAttemptOutcome(attempt), "cancelled", context, "completed", true);
          } else {
            const block = blockInfo("external_outcome_unknown", "worker stop lacks matching retirement evidence", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          }
          return;
        }
        if (checked.data.kind === "replayable") {
          await scheduleSafeProcessReplay({ task, runtime, ProcessExecutionTask, activeBootId, input, run, attempt, checkpoint, replay: checked.data, context });
          return;
        }
        if (checked.data.kind === "blocked") {
          await settleAttempt(task, runtime, input, { kind: "blocked", block: checked.data.block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        const process = checked.data;
        if (process.timedOut) {
          const failure = failureInfo("timeout", "worker exceeded its absolute deadline", input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
          return;
        }
        if (process.exit.kind !== "code" || process.exit.code !== 0) {
          const failure = failureInfo("process_error", "worker exited unsuccessfully", input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
          return;
        }
        const settings = run.resolvedSettings.nodes[input.nodeId];
        if (settings === undefined) throw new Error("frozen node settings disappeared");
        const stdout = process.semanticStdout;
        if (stdout.kind === "not_captured") {
          const block = blockInfo("integrity_failed", "worker omitted stdout evidence", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        if (stdout.kind !== "captured") {
          const failure = failureInfo(stdout.kind === "too_large" ? "result_too_large" : "result_invalid",
            stdout.kind === "too_large" ? "worker stdout exceeded the 1 MiB result limit" : "worker stdout is not valid UTF-8", input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
          return;
        }
        if (!("formatVersion" in run.resolvedSettings) || run.resolvedSettings.formatVersion !== 4) throw new Error("format 3 execution is unsupported");
        const mode = run.resolvedSettings.nodes[input.nodeId]!.result;
        const parsed = mode === "text" ? parseTextResult(Buffer.from(stdout.text, "utf8")) : parseTaggedWorkerResult(Buffer.from(stdout.text, "utf8"));
        if (!parsed.ok) {
          const failure = failureInfo(parsed.failure.kind, parsed.failure.message, input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
          return;
        }
        const candidate = nodeResultSchema.parse({
          version: 2,
          source: settings.run.kind,
          output: parsed.value.output,
          summary: "reason" in parsed.value ? parsed.value.reason ?? "" : "",
          artifacts: [],
          sourceBytesHash: parsed.sourceBytesHash,
          exit: process.exit,
          stdioResult: { version: 1, mode, status: parsed.value.status,
            reason: "reason" in parsed.value ? parsed.value.reason : null,
            question: "question" in parsed.value ? parsed.value.question : null },
        });
        await commitWorkerCandidate(runtime, input, candidate, settings.validator !== null, context);
      },
      launchValidator: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, context);
        const input = parseNodeInput(task.input);
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const settings = run.resolvedSettings.nodes[input.nodeId];
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (settings === undefined || settings.validator === null || attempt.result.kind !== "candidate_committed") {
          throw new Error("validator checkpoint lacks a committed candidate and frozen validator");
        }
        const candidate = attempt.result.candidate;
        const missingArtifact = candidate.artifacts.find((artifact) => artifact.availability === "missing");
        if (missingArtifact !== undefined) {
          const failure = failureInfo("artifact_missing", missingArtifactFailureMessage(missingArtifact.path), input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
          return;
        }
        const predecessor = run.chain.predecessors[input.nodeId];
        if (predecessor === undefined) throw new Error("frozen node has no predecessor snapshot");
        const launchIntentAt = timestamp(runtime.now());
        let deadlineAt: string | null;
        try {
          deadlineAt = deadline(launchIntentAt, settings.validator.timeoutMs);
        } catch {
          const failure = failureInfo("runtime_fault", "configured validator timeout exceeds the supported timestamp range", input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
          return;
        }
        const executionId = executionIdSchema.parse(randomUUID());
        const incarnationId = incarnationIdSchema.parse(randomUUID());
        await runtime.commit(async (tx) => {
          const { draft, run: current } = await runDraft(tx, runtime.conversationId);
          assertNodeIdentity(input, current, runtime.taskId);
          const currentAttempt = requireAttempt(current, input.nodeId, input.attemptId);
          if (currentAttempt.result.kind !== "candidate_committed" || currentAttempt.validatorExecutionId !== null) {
            throw new Error("node attempt is not ready to admit its validator");
          }
          const currentSettings = current.resolvedSettings.nodes[input.nodeId];
          if (currentSettings === undefined || currentSettings.validator === null) {
            throw new Error("canonical node no longer has a frozen validator");
          }
          const processInput = createProcessInput({
            run: current,
            taskId: Number(runtime.taskId),
            input,
            role: "validator",
            site: currentSettings.validator,
            executionId,
            incarnationId,
            serviceBootId: activeBootId,
            launchIntentAt,
            deadlineAt,
          });
          const processTaskId = await tx.createTask(ProcessExecutionTask, processInput, {
            ownership: { kind: "task", taskId: runtime.taskId },
            conversationId: runtime.conversationId,
          });
          const next = replaceRunAttempt(current, input.nodeId, input.attemptId, (value) => ({
            ...value,
            status: "validating",
            phase: "awaitValidator",
            validatorExecutionId: executionId,
          }));
          assign(draft, next);
          return {
            status: "waiting",
            checkpoint: { phase: "awaitValidator", processTaskId: Number(processTaskId), executionId, incarnationId, incarnationNumber: 1 },
            on: [processTaskId],
            policy: "allSettled",
          };
        }, context);
      },
      awaitValidator: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, context);
        const input = parseNodeInput(task.input);
        const checkpoint = nodeCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "awaitValidator") throw new Error("NodeAttempt checkpoint lacks its validator task identity");
        const taskOutcome = (await runtime.outcomes([durableTaskId<ProcessExecutionTaskResult>(checkpoint.processTaskId)], context))[0];
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (attempt.validatorExecutionId !== checkpoint.executionId || attempt.result.kind !== "candidate_committed") {
          const block = blockInfo("integrity_failed", "validator checkpoint differs from committed worker state", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          const candidate = attempt.result.kind === "candidate_committed" ? attempt.result.candidate : null;
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
          return;
        }
        const candidate = attempt.result.candidate;
        if (taskOutcome === undefined || taskOutcome.status !== "completed") {
          const block = blockInfo("external_outcome_unknown", "validator process task ended without a checked receipt", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
          return;
        }
        const checked = processExecutionTaskResultSchema.safeParse(taskOutcome.result);
        if (!checked.success) {
          const block = blockInfo("integrity_failed", "validator process result failed runtime validation", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
          return;
        }
        if (checked.data.kind === "cancelled") {
          if (run.desiredState === "stopped" && run.block === null
            && await checkedOperatorStopRetirement(runtime, input, run, attempt, checkpoint, context)) {
            await settleAttempt(task, runtime, input, cancelledAttemptOutcome(attempt), "cancelled", context, "completed", true);
          } else {
            const block = blockInfo("external_outcome_unknown", "validator stop lacks matching retirement evidence", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
          }
          return;
        }
        if (checked.data.kind === "replayable") {
          await scheduleSafeProcessReplay({ task, runtime, ProcessExecutionTask, activeBootId, input, run, attempt, checkpoint, replay: checked.data, context });
          return;
        }
        if (checked.data.kind === "blocked") {
          await settleAttempt(task, runtime, input, { kind: "blocked", block: checked.data.block, candidate, validator: null }, "interrupted", context);
          return;
        }
        const process = checked.data;
        if (process.timedOut) {
          const failure = failureInfo("timeout", "validator exceeded its absolute deadline", input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
          return;
        }
        const validatorSite = run.resolvedSettings.nodes[input.nodeId]?.validator;
        if (validatorSite === undefined || validatorSite === null) throw new Error("frozen validator settings disappeared");
        let validator: ValidatorOutcome;
        if (validatorSite.kind === "command") {
          validator = validatorOutcomeSchema.parse({
            kind: "command",
            exit: process.exit,
            stdoutHash: process.stdoutCaptureHash,
            stderrHash: process.stderrCaptureHash,
          });
        } else {
          if (process.exit.kind !== "code" || process.exit.code !== 0) {
            const failure = failureInfo("process_error", "agent validator exited unsuccessfully", input, runtime.now());
            await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
            return;
          }
          const stdout = process.semanticStdout;
          if (stdout.kind !== "captured") {
            const failure = failureInfo(stdout.kind === "too_large" ? "result_too_large" : "result_invalid", "agent verifier stdout is unavailable, oversized, or invalid UTF-8", input, runtime.now());
            await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
            return;
          }
          const parsed = parseTaggedVerifierDecision(Buffer.from(stdout.text, "utf8"));
          if (!parsed.ok) {
            const failure = failureInfo(parsed.failure.kind, parsed.failure.message, input, runtime.now());
            await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
            return;
          }
          validator = validatorOutcomeSchema.parse({
            kind: "agent",
            exit: process.exit,
            verdict: { version: 2, decision: parsed.value.decision, reason: parsed.value.reason, corrections: parsed.value.corrections },
            resultBytesHash: parsed.sourceBytesHash,
          });
        }
        await commitValidatorOutcome(runtime, input, candidate, validator, context);
      },
      finish: async (task, runtime, context) => {
        const input = parseNodeInput(task.input);
        await finishNodeAttempt(runtime, input, context);
      },
    },
    abort: async (task, runtime, context) => {
      const input = parseNodeInput(task.input);
      const run = await snapshotRun(runtime, context);
      assertNodeIdentity(input, run, runtime.taskId);
      const attempt = requireAttempt(run, input.nodeId, input.attemptId);
      const checkpoint = nodeCheckpointSchema.safeParse(task.state.checkpoint);
      if (run.desiredState === "stopped" && run.block === null && checkpoint.success
        && checkpoint.data.phase === "finish") {
        await finishNodeAttempt(runtime, input, context);
        return;
      }
      if (run.desiredState === "stopped" && run.block === null && checkpoint.success
        && await checkedOperatorStopRetirement(runtime, input, run, attempt, checkpoint.data, context)) {
        await settleAttempt(task, runtime, input, cancelledAttemptOutcome(attempt), "cancelled", context, "completed", true);
        return;
      }
      const candidate = attempt.result.kind === "candidate_committed" || attempt.result.kind === "validation_committed"
        ? attempt.result.candidate
        : null;
      const validator = attempt.result.kind === "validation_committed" ? attempt.result.validator : null;
      const reason = candidate === null
        ? "node attempt stopped before a checked worker result was committed"
        : "node attempt stopped before committed worker and validator evidence was settled";
      const block = blockInfo("external_outcome_unknown", reason, input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
      await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator }, "interrupted", context, "aborted");
    },
  });
}

async function waitForLaunchPermission(runtime: NodeRuntime, canLaunch: () => boolean, context: Context): Promise<void> {
  while (!canLaunch()) await runtime.sleep(runtime.now() + 250, context);
}

async function commitWorkerCandidate(
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  candidate: NodeResult,
  hasValidator: boolean,
  context: Context,
): Promise<void> {
  const checkedCandidate = nodeResultSchema.parse(candidate);
  await runtime.commit(async (tx) => {
    const { draft, run } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, run, runtime.taskId);
    const attempt = requireAttempt(run, input.nodeId, input.attemptId);
    if (attempt.workerExecutionId === null || attempt.result.kind !== "pending") {
      throw new Error("worker candidate cannot be committed outside a pending worker attempt");
    }
    assign(draft, replaceRunAttempt(run, input.nodeId, input.attemptId, (value) => ({
      ...value,
      status: "executing",
      phase: "captureCandidate",
      result: { kind: "candidate_committed", candidate: checkedCandidate },
    })));
    await appendEvent(tx, runtime.conversationId, {
      version: 1,
      eventId: randomUUID(),
      type: "worker_result_committed",
      runId: input.runId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      candidate: checkedCandidate,
      occurredAt: timestamp(runtime.now()),
    });
    const gatedWorkerResult = workerResultRequiresRuntimeGate(checkedCandidate);
    return { status: "running", checkpoint: { phase: gatedWorkerResult ? "finish" : hasValidator ? "launchValidator" : "finish" } };
  }, context);
}

async function commitValidatorOutcome(
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  candidate: NodeResult,
  validator: ValidatorOutcome,
  context: Context,
): Promise<void> {
  const checkedCandidate = nodeResultSchema.parse(candidate);
  const checkedValidator = validatorOutcomeSchema.parse(validator);
  await runtime.commit(async (tx) => {
    const { draft, run } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, run, runtime.taskId);
    const attempt = requireAttempt(run, input.nodeId, input.attemptId);
    if (attempt.result.kind !== "candidate_committed"
      || canonicalHash(attempt.result.candidate) !== canonicalHash(checkedCandidate)
      || attempt.validatorExecutionId === null) {
      throw new Error("validator outcome differs from the committed worker candidate");
    }
    assign(draft, replaceRunAttempt(run, input.nodeId, input.attemptId, (value) => ({
      ...value,
      status: "validating",
      phase: "finish",
      result: { kind: "validation_committed", candidate: checkedCandidate, validator: checkedValidator },
    })));
    await appendEvent(tx, runtime.conversationId, {
      version: 1,
      eventId: randomUUID(),
      type: "validator_result_committed",
      runId: input.runId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      validator: checkedValidator,
      occurredAt: timestamp(runtime.now()),
    });
    return { status: "running", checkpoint: { phase: "finish" } };
  }, context);
}

function createProcessInput(args: {
  run: ReadyRun;
  taskId: number;
  input: NodeAttemptTaskInput;
  role: "worker" | "validator";
  site: ResolvedExecutionSite;
  executionId: ProcessExecutionTaskEnvironmentInput["executionId"];
  incarnationId: ProcessExecutionTaskEnvironmentInput["incarnationId"];
  incarnationNumber?: number;
  serviceBootId: ProcessExecutionTaskEnvironmentInput["serviceBootId"];
  launchIntentAt: string;
  deadlineAt: string | null;
}): ProcessExecutionTaskInput {
  const files = processExecutionFiles(
    { role: args.role, nodeId: args.input.nodeId, incarnationNumber: args.incarnationNumber ?? 1, executionId: args.executionId },
    args.run.paths.runDirectory,
    args.input.attemptNumber,
  );
  const stdin = reconstructProcessStdin({ role: args.role, nodeId: args.input.nodeId, attemptId: args.input.attemptId, executionId: args.executionId }, args.run);
  const base: ProcessExecutionTaskEnvironmentInput = {
    ioVersion: 1,
    stdinSha256: stdin.sha256,
    stdinByteCount: stdin.byteCount,
    runId: args.run.runId,
    workflowId: args.run.workflowId,
    activationId: args.run.activationId,
    occurrenceId: args.run.occurrenceId,
    workflowTaskId: args.run.durable.workflowTaskId,
    nodeTaskId: args.taskId,
    nodeId: args.input.nodeId,
    attemptId: args.input.attemptId,
    executionId: args.executionId,
    incarnationId: args.incarnationId,
    incarnationNumber: args.incarnationNumber ?? 1,
    serviceBootId: args.serviceBootId,
    role: args.role,
    launchIntentAt: args.launchIntentAt,
    deadlineAt: args.deadlineAt,
    shell: args.site.shell,
    command: args.site.kind === "command" ? args.site.command : args.site.harnessCommand,
    cwd: args.site.cwd,
    timeoutMs: args.site.timeoutMs,
    streamCapBytes: args.site.streamCapBytes,
    replay: args.site.replay,
    stdoutPath: files.stdoutPath,
    stderrPath: files.stderrPath,
  };
  return processExecutionTaskInputSchema.parse({
    ...base,
    env: buildProcessExecutionEnvironment(base, args.run, args.input.attemptNumber),
  });
}

async function scheduleSafeProcessReplay(args: {
  task: unknown;
  runtime: NodeRuntime;
  ProcessExecutionTask: ProcessExecutionTaskDefinition;
  activeBootId: string;
  input: NodeAttemptTaskInput;
  run: ReadyRun;
  attempt: PersistedNodeAttempt;
  checkpoint: AwaitProcessCheckpoint;
  replay: ReplayableProcessResult;
  context: Context;
}): Promise<void> {
  const { task, runtime, ProcessExecutionTask, activeBootId, input, run, attempt, checkpoint, replay, context } = args;
  const role = checkpoint.phase === "awaitWorker" ? "worker" : "validator";
  const settings = run.resolvedSettings.nodes[input.nodeId];
  const site = role === "worker" ? settings?.run : settings?.validator;
  const candidate = role === "validator" && attempt.result.kind === "candidate_committed" ? attempt.result.candidate : null;
  const executionIncarnations = attempt.processIncarnations.filter((item) => item.executionId === checkpoint.executionId);
  const expectedDeadline = site !== undefined && site !== null
    && replayDeadlineMatches(replay.launchIntentAt, replay.deadlineAt, site.timeoutMs);
  if (settings === undefined || site === undefined || site === null || site.replay !== "safe"
    || replay.executionId !== checkpoint.executionId
    || replay.incarnationId === checkpoint.incarnationId
    || replay.incarnationNumber !== checkpoint.incarnationNumber + 1
    || executionIncarnations.length !== checkpoint.incarnationNumber
    || !executionIncarnations.some((item) => item.incarnationId === checkpoint.incarnationId)
    || executionIncarnations.some((item) => item.incarnationId === replay.incarnationId)
    || !expectedDeadline) {
    const block = blockInfo("integrity_failed", "safe process replay differs from the frozen execution or incarnation history", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
    await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
    return;
  }
  const resumableRun = await waitForNodeReplayResume(runtime, input, context);
  if (resumableRun.desiredState === "stopped" || (resumableRun.status !== "running" && resumableRun.status !== "paused")) {
    const block = blockInfo("external_outcome_unknown", "run no longer authorizes repeating the interrupted process", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
    await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
    return;
  }
  const currentAttempt = requireAttempt(resumableRun, input.nodeId, input.attemptId);
  const currentCandidate = role === "validator" && currentAttempt.result.kind === "candidate_committed"
    ? currentAttempt.result.candidate
    : null;
  await runtime.commit(async (tx) => {
    const { draft, run: current } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, current, runtime.taskId);
    const latestAttempt = requireAttempt(current, input.nodeId, input.attemptId);
    const expectedExecutionId = role === "worker" ? latestAttempt.workerExecutionId : latestAttempt.validatorExecutionId;
    const expectedResult = role === "worker"
      ? latestAttempt.result.kind === "pending"
      : latestAttempt.result.kind === "candidate_committed";
    if (expectedExecutionId !== checkpoint.executionId || !expectedResult) {
      throw new Error("process replay no longer matches the active semantic attempt");
    }
    if (current.desiredState !== "running" || current.status !== "running") {
      return { status: "running", checkpoint };
    }
    const currentSettings = current.resolvedSettings.nodes[input.nodeId];
    const currentSite = role === "worker" ? currentSettings?.run : currentSettings?.validator;
    let replayInput: ProcessExecutionTaskInput;
    try {
      if (currentSite === undefined || currentSite === null) throw new Error("frozen replay execution site is missing");
      replayInput = createProcessInput({
        run: current,
        taskId: Number(runtime.taskId),
        input,
        role,
        site: currentSite,
        executionId: replay.executionId,
        incarnationId: replay.incarnationId,
        incarnationNumber: replay.incarnationNumber,
        serviceBootId: activeBootId,
        launchIntentAt: replay.launchIntentAt,
        deadlineAt: replay.deadlineAt,
      });
    } catch {
      return await blockReplayIntegrityFailure(tx, runtime.conversationId, draft, current, input, latestAttempt, runtime.now());
    }
    if (!await processInputMatchesCommittedStdin(tx, runtime.conversationId, replayInput, checkpoint.incarnationId)) {
      return await blockReplayIntegrityFailure(tx, runtime.conversationId, draft, current, input, latestAttempt, runtime.now());
    }
    assign(draft, current);
    const processTaskId = await tx.createTask(ProcessExecutionTask, replayInput, {
      ownership: { kind: "task", taskId: runtime.taskId },
      conversationId: runtime.conversationId,
    });
    const nextCheckpoint = role === "worker"
      ? { phase: "awaitWorker" as const, processTaskId: Number(processTaskId), executionId: replay.executionId, incarnationId: replay.incarnationId, incarnationNumber: replay.incarnationNumber }
      : { phase: "awaitValidator" as const, processTaskId: Number(processTaskId), executionId: replay.executionId, incarnationId: replay.incarnationId, incarnationNumber: replay.incarnationNumber };
    return { status: "waiting", checkpoint: nextCheckpoint, on: [processTaskId], policy: "allSettled" };
  }, context);
}

async function blockReplayIntegrityFailure(
  tx: Tx,
  conversationId: ConversationId,
  draft: object,
  run: ReadyRun,
  input: NodeAttemptTaskInput,
  attempt: PersistedNodeAttempt,
  now: number,
): Promise<{ status: "terminal"; outcome: { status: "completed"; result: NodeAttemptOutcome } }> {
  const at = timestamp(now);
  const block = blockInfo("integrity_failed", "replay input differs from the original execution identity", input.runId, input.nodeId, input.attemptId, at);
  const outcome = nodeAttemptOutcomeSchema.parse({
    kind: "blocked",
    block,
    candidate: attempt.result.kind === "candidate_committed" || attempt.result.kind === "validation_committed" ? attempt.result.candidate : null,
    validator: attempt.result.kind === "validation_committed" ? attempt.result.validator : null,
  });
  assign(draft, replaceRunAttempt(run, input.nodeId, input.attemptId, (value) => ({
    ...value,
    status: "interrupted",
    phase: null,
    finishedAt: at,
    elapsedMs: value.startedAt === null ? null : Date.parse(at) - Date.parse(value.startedAt),
    result: { kind: "settled", outcome },
    blockIds: [...value.blockIds, block.blockId],
  })));
  await appendEvent(tx, conversationId, {
    version: 1,
    eventId: randomUUID(),
    type: "attempt_settled",
    runId: input.runId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    outcome,
    occurredAt: at,
  });
  return { status: "terminal", outcome: { status: "completed", result: outcome } };
}

async function processInputMatchesCommittedStdin(
  tx: Tx,
  conversationId: ConversationId,
  input: ProcessExecutionTaskInput,
  previousIncarnationId: string,
): Promise<boolean> {
  const records: z.infer<typeof workshopProcessV1Schema>[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId }, 256, cursor);
    for (const entry of page.items) {
      if (!WorkshopProcessEntry.is(entry)) continue;
      const parsed = workshopProcessV1Schema.safeParse(entry.data);
      if (!parsed.success) return false;
      if (parsed.data.process.executionId === input.executionId) records.push(parsed.data);
    }
    cursor = page.next;
  } while (cursor !== undefined);

  const first = records.filter((record) => record.process.incarnationNumber === 1);
  if (first.length === 0) return false;
  const original = first[0]!.process;
  const originalStdio = original.stdio;
  if (originalStdio === undefined || originalStdio.version !== 1
    || originalStdio.stdinSha256 !== input.stdinSha256 || originalStdio.stdinByteCount !== input.stdinByteCount) return false;
  if (first.some((record) => record.process.incarnationId !== original.incarnationId)) return false;

  const incarnationIds = new Map<number, string>();
  for (const record of records) {
    const process = record.process;
    const knownIncarnationId = incarnationIds.get(process.incarnationNumber);
    if (knownIncarnationId !== undefined && knownIncarnationId !== process.incarnationId) return false;
    incarnationIds.set(process.incarnationNumber, process.incarnationId);
    if (record.runId !== input.runId || record.nodeId !== input.nodeId || record.attemptId !== input.attemptId
      || process.executionId !== input.executionId || process.role !== input.role || process.incarnationNumber >= input.incarnationNumber
      || process.stdio?.version !== 1
      || process.stdio.stdinSha256 !== originalStdio.stdinSha256
      || process.stdio.stdinByteCount !== originalStdio.stdinByteCount) return false;
  }
  if (incarnationIds.get(input.incarnationNumber - 1) !== previousIncarnationId) return false;
  for (let number = 1; number < input.incarnationNumber; number += 1) {
    if (!incarnationIds.has(number)) return false;
  }
  return true;
}

async function waitForNodeReplayResume(runtime: NodeRuntime, input: NodeAttemptTaskInput, context: Context): Promise<ReadyRun> {
  for (;;) {
    const run = await snapshotRun(runtime, context);
    assertNodeIdentity(input, run, runtime.taskId);
    if (run.desiredState === "stopped" || run.status === "blocked" || ["completed", "failed", "cancelled"].includes(run.status)) {
      return run;
    }
    if (run.desiredState === "paused" && run.status === "running") {
      await runtime.commit(async (tx) => {
        const { draft, run: current } = await runDraft(tx, runtime.conversationId);
        assertNodeIdentity(input, current, runtime.taskId);
        if (current.desiredState !== "paused" || current.status !== "running") return undefined;
        const at = timestamp(runtime.now());
        assign(draft, workflowRunDocumentV1Schema.parse({ ...current, status: "paused" }));
        await pauseInstallationRun(tx, current);
        await appendEvent(tx, runtime.conversationId, {
          version: 1,
          eventId: randomUUID(),
          type: "run_state_changed",
          runId: input.runId,
          from: "running",
          to: "paused",
          occurredAt: at,
        });
        return undefined;
      }, context);
      continue;
    }
    if (run.desiredState === "running" && run.status === "running"
      && (run.durable.capacityGateTaskId === null || run.durable.capacityGateTaskId === undefined)) {
      return run;
    }
    // A queued run remains here until its persisted CapacityGate acquires a slot.
    await runtime.sleep(runtime.now() + 250, context);
  }
}

export function resolveWorkerArtifacts(
  cwd: string,
  artifacts: readonly { kind: string; path: string }[],
): NodeResult["artifacts"] {
  return artifacts.map((artifact) => {
    const path = resolve(cwd, artifact.path);
    try {
      const stat = statSync(path);
      return {
        kind: artifact.kind,
        path,
        availability: "available" as const,
        byteCount: Number.isSafeInteger(stat.size) ? stat.size : null,
        sha256: null,
      };
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ENAMETOOLONG") throw error;
      return { kind: artifact.kind, path, availability: "missing" as const, byteCount: null, sha256: null };
    }
  });
}

function workerResultRequiresRuntimeGate(candidate: NodeResult): boolean {
  return candidate.version === 2
    && (candidate.stdioResult.status === "needs_input" || candidate.stdioResult.status === "success_and_complete");
}

function validatorFailureReason(validator: ValidatorOutcome): string {
  if (validator.kind === "command") {
    return validator.exit.kind === "code"
      ? `command validator exited with code ${validator.exit.code}`
      : `command validator exited by ${validator.exit.kind}`;
  }
  return validator.verdict.version === 2 && validator.verdict.corrections !== null
    ? validator.verdict.reason + "\n\nCorrections:\n" + validator.verdict.corrections
    : validator.verdict.reason;
}

function cancelledAttemptOutcome(attempt: PersistedNodeAttempt): NodeAttemptOutcome {
  const candidate = attempt.result.kind === "candidate_committed" || attempt.result.kind === "validation_committed"
    ? attempt.result.candidate
    : null;
  const validator = attempt.result.kind === "validation_committed" ? attempt.result.validator : null;
  return nodeAttemptOutcomeSchema.parse({ kind: "cancelled", candidate, validator });
}

function cancellationReceiptMatches(
  checkpoint: AwaitProcessCheckpoint,
  result: ProcessExecutionTaskResult,
  attempt: PersistedNodeAttempt,
  serviceBootId: string,
 ): boolean {
  return result.kind === "cancelled"
    && result.executionId === checkpoint.executionId
    && result.incarnationId === checkpoint.incarnationId
    && result.incarnationNumber === checkpoint.incarnationNumber
    && result.cleanupState === "confirmed_dead"
    && result.identity.serviceBootId === serviceBootId
    && result.identity.pid === result.identity.pgid
    && attempt.processIncarnations.some((reference) => reference.executionId === checkpoint.executionId
      && reference.incarnationId === checkpoint.incarnationId);
}

async function checkedOperatorStopRetirement(
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  run: ReadyRun,
  attempt: PersistedNodeAttempt,
  checkpoint: NodeCheckpoint,
  context: Context,
): Promise<boolean> {
  if (checkpoint.phase === "prepare") {
    return attempt.status === "prepared" && attempt.result.kind === "pending"
      && attempt.workerExecutionId === null && attempt.validatorExecutionId === null
      && attempt.processIncarnations.length === 0;
  }
  const hasWorkerReceipt = attempt.workerExecutionId !== null
    && attempt.processIncarnations.some((reference) => reference.executionId === attempt.workerExecutionId);
  if (checkpoint.phase === "launchValidator") {
    return attempt.result.kind === "candidate_committed" && hasWorkerReceipt
      && attempt.validatorExecutionId === null;
  }
  if (checkpoint.phase === "finish") return false;
  const expectedRole = checkpoint.phase === "awaitWorker" ? "worker" : "validator";
  if ((expectedRole === "worker" && attempt.result.kind !== "pending")
    || (expectedRole === "validator" && (attempt.result.kind !== "candidate_committed" || !hasWorkerReceipt))) return false;
  const processTaskId = durableTaskId<ProcessExecutionTaskResult>(checkpoint.processTaskId);
  const processTask = await runtime.getTask(processTaskId, context);
  if (processTask === undefined || processTask.kind !== "workshop.process-execution"
    || processTask.owner !== runtime.taskId || processTask.conversationId !== runtime.conversationId
    || processTask.state.status !== "terminal") return false;
  const parsedInput = processExecutionTaskInputSchema.safeParse(processTask.input);
  if (!parsedInput.success) return false;
  const processInput = parsedInput.data;
  if (processInput.runId !== input.runId || processInput.workflowId !== input.workflowId
    || processInput.workflowTaskId !== run.durable.workflowTaskId || processInput.nodeTaskId !== Number(runtime.taskId)
    || processInput.nodeId !== input.nodeId || processInput.attemptId !== input.attemptId
    || processInput.role !== expectedRole || processInput.executionId !== checkpoint.executionId
    || processInput.incarnationId !== checkpoint.incarnationId
    || processInput.incarnationNumber !== checkpoint.incarnationNumber) return false;
  const processReferenceExists = attempt.processIncarnations.some((reference) => reference.executionId === checkpoint.executionId
    && reference.incarnationId === checkpoint.incarnationId);
  const taskOutcome = processTask.state.outcome;
  if (taskOutcome.status === "aborted") {
    return taskOutcome.reason === "process was aborted before launch intent" && !processReferenceExists;
  }
  if (taskOutcome.status !== "completed") return false;
  const checked = processExecutionTaskResultSchema.safeParse(taskOutcome.result);
  if (!checked.success) return false;
  if (checked.data.kind === "cancelled") {
    return cancellationReceiptMatches(checkpoint, checked.data, attempt, processInput.serviceBootId);
  }
  return checked.data.kind === "exited" && processReferenceExists;
}

async function finishNodeAttempt(
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  context: Context,
 ): Promise<void> {
  const run = await snapshotRun(runtime, context);
  assertNodeIdentity(input, run, runtime.taskId);
  const attempt = requireAttempt(run, input.nodeId, input.attemptId);
  const candidate = attempt.result.kind === "candidate_committed" || attempt.result.kind === "validation_committed"
    ? attempt.result.candidate
    : null;
  if (candidate === null) throw new Error("attempt has no committed candidate to settle");
  const validator = attempt.result.kind === "validation_committed" ? attempt.result.validator : null;
  const gatedStatus = workerResultRequiresRuntimeGate(candidate);
  const gatedVerdict = validator?.kind === "agent" && validator.verdict.version === 2 && validator.verdict.decision === "block";
  if (gatedStatus || gatedVerdict) {
    const reason = gatedStatus ? "worker status requires a later runtime package" : "verifier block requires a later runtime package";
    const block = blockInfo("runtime_incompatible", reason, input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
    await settleAttempt(null, runtime, input, { kind: "blocked", block, candidate, validator }, "interrupted", context);
    return;
  }
  const missingArtifact = candidate.artifacts.find((artifact) => artifact.availability === "missing");
  const outcome = missingArtifact !== undefined
    ? nodeAttemptOutcomeSchema.parse({
      kind: "failed",
      failure: failureInfo("artifact_missing", missingArtifactFailureMessage(missingArtifact.path), input, runtime.now()),
      candidate,
      validator,
    })
    : validator !== null && !validatorOutcomePasses(validator)
      ? nodeAttemptOutcomeSchema.parse({
        kind: "failed",
        failure: failureInfo("validator_rejection", validatorFailureReason(validator), input, runtime.now()),
        candidate,
        validator,
      })
      : nodeAttemptOutcomeSchema.parse({ kind: "succeeded", candidate, validator });
  await runtime.commit(async (tx) => {
    const { draft, run: current } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, current, runtime.taskId);
    const at = timestamp(runtime.now());
    const next = replaceRunAttempt(current, input.nodeId, input.attemptId, (value) => ({
      ...value,
      status: outcome.kind === "succeeded" ? "succeeded" : "failed",
      phase: null,
      finishedAt: at,
      elapsedMs: value.startedAt === null ? null : Date.parse(at) - Date.parse(value.startedAt),
      result: { kind: "settled", outcome },
    }));
    assign(draft, next);
    await appendEvent(tx, runtime.conversationId, {
      version: 1,
      eventId: randomUUID(),
      type: "attempt_settled",
      runId: input.runId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      outcome,
      occurredAt: at,
    });
    return { status: "terminal", outcome: { status: "completed", result: outcome } };
  }, context);
}


async function settleAttempt(
  _task: unknown,
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  outcome: NodeAttemptOutcome,
  status: "failed" | "interrupted" | "cancelled",
  context: Context,
  taskOutcome: "completed" | "aborted" = "completed",
  requireOperatorStop = false,
 ): Promise<void> {
  const checked = nodeAttemptOutcomeSchema.parse(outcome);
  await runtime.commit(async (tx) => {
    const { draft, run } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, run, runtime.taskId);
    const attempt = requireAttempt(run, input.nodeId, input.attemptId);
    const operatorStopStillEligible = !requireOperatorStop
      || (run.desiredState === "stopped" && run.block === null
        && run.currentNodeId === input.nodeId && run.currentAttemptId === input.attemptId
        && attempt.result.kind !== "settled");
    const committedStatus = operatorStopStillEligible ? status : "interrupted";
    const committedOutcome = operatorStopStillEligible ? checked : nodeAttemptOutcomeSchema.parse({
      kind: "blocked",
      block: blockInfo("external_outcome_unknown", "operator stop lost eligibility before checked attempt settlement", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now())),
      candidate: checked.kind === "cancelled" ? checked.candidate : null,
      validator: checked.kind === "cancelled" ? checked.validator : null,
    });
    const at = timestamp(runtime.now());
    const next = replaceRunAttempt(run, input.nodeId, input.attemptId, (currentAttempt) => ({
      ...currentAttempt,
      status: committedStatus,
      phase: null,
      finishedAt: at,
      elapsedMs: currentAttempt.startedAt === null ? null : Date.parse(at) - Date.parse(currentAttempt.startedAt),
      result: { kind: "settled", outcome: committedOutcome },
      blockIds: committedOutcome.kind === "blocked" ? [...currentAttempt.blockIds, committedOutcome.block.blockId] : currentAttempt.blockIds,
    }));
    assign(draft, next);
    await appendEvent(tx, runtime.conversationId, {
      version: 1,
      eventId: randomUUID(),
      type: "attempt_settled",
      runId: input.runId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      outcome: committedOutcome,
      occurredAt: at,
    });
    return taskOutcome === "aborted"
      ? { status: "terminal", outcome: { status: "aborted", reason: "node attempt stopped with an unresolved outcome" } }
      : { status: "terminal", outcome: { status: "completed", result: committedOutcome } };
  }, context);
}

async function pauseInstallationRun(tx: Tx, run: ReadyRun): Promise<void> {
  const draft = await tx.doc(WorkshopInstallationDoc);
  const parsed = installationDocumentV1Schema.safeParse(draft);
  if (!parsed.success || parsed.data.state !== "ready") throw new Error("installation document failed runtime validation");
  const workflow = parsed.data.workflows[run.workflowId];
  const reference = workflow?.runs.find((item) => item.runId === run.runId);
  if (run.status !== "running" || workflow === undefined || reference === undefined || reference.status !== "running") {
    throw new Error("installation run reference diverged from the canonical running run");
  }
  reference.status = "paused";
  workflow.capacityReservations = workflow.capacityReservations.filter((id) => id !== run.runId);
  const checked = installationDocumentV1Schema.safeParse(parsed.data);
  if (!checked.success) throw new Error(`installation transition failed validation: ${checked.error.message}`);
  Object.assign(draft, checked.data);
}

async function appendEvent(tx: Tx, conversationId: ConversationId, value: unknown): Promise<void> {
  const checked = workshopEventV1Schema.safeParse(value);
  if (!checked.success) throw new Error(`workshop event failed validation: ${checked.error.message}`);
  await tx.appendEntry(WorkshopEventEntry, conversationId, { data: checked.data });
}

function replaceRunAttempt(run: ReadyRun, nodeId: string, attemptId: string, update: (attempt: PersistedNodeAttempt) => PersistedNodeAttempt): ReadyRun {
  return readyRun({
    ...run,
    nodes: run.nodes.map((node) => node.nodeId !== nodeId ? node : {
      ...node,
      attempts: node.attempts.map((attempt) => attempt.attemptId === attemptId ? update(attempt) : attempt),
    }),
  });
}

function requireAttempt(run: ReadyRun, nodeId: string, attemptId: string) {
  const attempt = run.nodes.find((node) => node.nodeId === nodeId)?.attempts.find((value) => value.attemptId === attemptId);
  if (attempt === undefined) throw new Error("canonical attempt is missing");
  return attempt;
}


function durableTaskId<R>(value: number): TaskId<R> {
  const checked = positive.parse(value);
  // SAFETY: these IDs were written with the same atomic checkpoint that now contains them.
  return checked as TaskId<R>;
}

function readyRun(value: unknown): ReadyRun {
  const parsed = workflowRunDocumentV1Schema.safeParse(value);
  if (!parsed.success) throw new Error(`canonical run document failed validation: ${parsed.error.message}`);
  if (parsed.data.state !== "ready") throw new Error("canonical run document is uninitialized");
  return parsed.data;
}

async function snapshotRun<I, S extends { phase: string }, R, H extends object>(runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<ReadyRun> {
  return readyRun(await runtime.snapshot(WorkshopRunDoc, runtime.conversationId, context));
}

async function runDraft(tx: Tx, conversationId: ConversationId) {
  const draft = await tx.doc(WorkshopRunDoc, conversationId);
  return { draft, run: readyRun(draft) };
}

function assign(draft: object, value: unknown): void {
  Object.assign(draft, readyRun(value));
}



function parseNodeInput(value: unknown): NodeAttemptTaskInput {
  const parsed = nodeAttemptTaskInputSchema.safeParse(value);
  if (!parsed.success) throw new Error(`NodeAttempt input failed validation: ${parsed.error.message}`);
  return parsed.data;
}




function assertNodeIdentity(input: NodeAttemptTaskInput, run: ReadyRun, taskId: number): void {
  const attempt = requireAttempt(run, input.nodeId, input.attemptId);
  if (input.runId !== run.runId || input.workflowId !== run.workflowId
    || input.activationId !== run.activationId || input.occurrenceId !== run.occurrenceId
    || input.attemptNumber !== attempt.number || input.workflowTaskId !== run.durable.workflowTaskId || attempt.taskId !== taskId) {
    throw new Error("NodeAttempt identity differs from canonical run");
  }
}


function blockInfo(
  kind: BlockInfo["kind"],
  reason: string,
  runId: string,
  nodeId: string | null,
  attemptId: string | null,
  blockedAt: string,
): BlockInfo {
  runIdSchema.parse(runId);
  return blockInfoSchema.parse({ blockId: randomUUID(), kind, reason, blockedAt, nodeId, attemptId });
}

function missingArtifactFailureMessage(path: string): string {
  const prefix = "worker artifact is missing: ";
  const fullMessage = `${prefix}${path}`;
  if (Buffer.byteLength(fullMessage, "utf8") <= 64 * 1024) return fullMessage;
  const digest = createHash("sha256").update(path, "utf8").digest("hex");
  const marker = `…[${Buffer.byteLength(path, "utf8")} UTF-8 bytes; sha256:${digest}]…`;
  return `${prefix}${utf8Prefix(path, 128)}${marker}${utf8Suffix(path, 128)}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    end += character.length;
    bytes += characterBytes;
  }
  return value.slice(0, end);
}

function utf8Suffix(value: string, maxBytes: number): string {
  let start = value.length;
  let cursor = value.length;
  let bytes = 0;
  while (cursor > 0) {
    let characterStart = cursor - 1;
    const lastCodeUnit = value.charCodeAt(characterStart);
    if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && characterStart > 0) {
      const previousCodeUnit = value.charCodeAt(characterStart - 1);
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) characterStart -= 1;
    }
    const character = value.slice(characterStart, cursor);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    start = characterStart;
    cursor = characterStart;
    bytes += characterBytes;
  }
  return value.slice(start);
}

function failureInfo(kind: FailureInfo["kind"], message: string, input: NodeAttemptTaskInput, at: number): FailureInfo {
  return failureInfoSchema.parse({ kind, message, failedAt: timestamp(at), nodeId: input.nodeId, attemptId: input.attemptId });
}

function timestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error("task clock returned an invalid timestamp");
  return utcTimestampSchema.parse(new Date(ms).toISOString());
}

function deadline(startedAt: string, timeoutMs: number | null): string | null {
  if (timeoutMs === null) return null;
  const at = Date.parse(startedAt) + timeoutMs;
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new Error("process deadline exceeds the safe timestamp range");
  return timestamp(at);
}
function replayDeadlineMatches(launchIntentAt: string, deadlineAt: string | null, timeoutMs: number | null): boolean {
  if (timeoutMs === null) return deadlineAt === null;
  if (deadlineAt === null) return false;
  const launchTime = Date.parse(launchIntentAt);
  const deadlineTime = Date.parse(deadlineAt);
  const remaining = deadlineTime - launchTime;
  return Number.isSafeInteger(launchTime) && Number.isSafeInteger(deadlineTime)
    && Number.isFinite(new Date(deadlineTime).getTime())
    && remaining >= 0 && remaining <= timeoutMs;
}
