import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { withAbortSignal, withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationId, type Cursor, type DocumentWatch, type JsonObject, type Task, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { buildFailureFeedback, hashFailureEvidence } from "../../attempt/build-failure-feedback.js";
import { resolveRetryLimit } from "../../definition/resolve-retry-limit.js";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import { parseModel } from "../../definition/parse-model.js";
import type { ResolvedExecutionSite } from "../../definition/schema-resolved.js";
import { nodeIdSchema, workflowIdSchema } from "../../definition/schema.js";
import { parseTextResult, parseTaggedWorkerResult } from "../../attempt/parse-tagged-result.js";
import { parseVerifierResult } from "../../attempt/parse-verifier-result.js";
import { committedHumanAnswer, reconstructProcessStdin } from "../../attempt/build-process-stdin.js";
import { readCaptureBytes } from "../../process/read-retained-capture.js";
import { locateWorkflowDirectory } from "../../run/locate-run-files.js";
import { installationDocumentV1Schema } from "../../installation/schema.js";
import { executionIdSchema, incarnationIdSchema } from "../../process/schema.js";
import {
  attemptIdSchema,
  blockInfoSchema,
  failureInfoSchema,
  nodeAttemptOutcomeSchema,
  nodeResultSchema,
  nativeExecutionReceiptSchema,
  runIdSchema,
  validatorOutcomePasses,
  validatorOutcomeSchema,
  nodeResultStatus,
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
import {
  agentExecutionTaskInputSchema,
  agentExecutionTaskResultSchema,
  type AgentExecutionTaskDefinition,
  type AgentExecutionTaskInput,
  type AgentExecutionTaskResult,
} from "./define-agent-execution-task.js";

const positive = z.number().int().positive().refine(Number.isSafeInteger);
type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;
type PersistedNodeAttempt = z.infer<typeof persistedNodeAttemptSchema>;
type NodeRuntime = TaskRuntime<NodeAttemptTaskInput, NodeCheckpoint, NodeAttemptOutcome, object>;
type AwaitProcessCheckpoint = Extract<NodeCheckpoint, { transport: "process" }>;
type AwaitAgentCheckpoint = Extract<NodeCheckpoint, { transport: "agent" }>;
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

const nodeCheckpointSchema = z.union([
  z.strictObject({ phase: z.literal("prepare") }),
  z.strictObject({ phase: z.literal("awaitWorker"), transport: z.literal("process"), processTaskId: positive, executionId: executionIdSchema, incarnationId: incarnationIdSchema, incarnationNumber: positive }),
  z.strictObject({ phase: z.literal("awaitWorker"), transport: z.literal("agent"), agentTaskId: positive, executionId: executionIdSchema }),
  z.strictObject({ phase: z.literal("launchValidator") }),
  z.strictObject({ phase: z.literal("awaitValidator"), transport: z.literal("process"), processTaskId: positive, executionId: executionIdSchema, incarnationId: incarnationIdSchema, incarnationNumber: positive }),
  z.strictObject({ phase: z.literal("awaitValidator"), transport: z.literal("agent"), agentTaskId: positive, executionId: executionIdSchema }),
  z.strictObject({ phase: z.literal("finish") }),
]);
type NodeCheckpoint = z.infer<typeof nodeCheckpointSchema>;

export function defineNodeAttemptTask(
  ProcessExecutionTask: ProcessExecutionTaskDefinition,
  activeBootId: string,
  canLaunch: () => boolean = () => true,
  AgentExecutionTask?: AgentExecutionTaskDefinition,
  waitForAdmission?: (signal: AbortSignal) => Promise<void>,
): NodeAttemptTaskDefinition {
  if (AgentExecutionTask !== undefined && waitForAdmission === undefined) {
    throw new Error("native agent attempts require an admission wait callback");
  }
  const awaitAdmission = waitForAdmission ?? ((signal: AbortSignal) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!canLaunch()) return Promise.reject(new Error("gated command attempts require an admission wait callback"));
    return Promise.resolve();
  });
  return defineTask<NodeAttemptTaskInput, NodeCheckpoint, NodeAttemptOutcome>({
    name: "workshop.node-attempt",
    version: 5,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, awaitAdmission);
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
        if (attempt.result.kind === "candidate_committed" || attempt.result.kind === "worker_failure_committed") {
          if (attempt.workerExecutionId === null || attempt.validatorExecutionId !== null) {
            const block = blockInfo("integrity_failed", "operator candidate acceptance does not match process history", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: attempt.result.kind === "candidate_committed" ? attempt.result.candidate : null, validator: null }, "interrupted", context);
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
        if (settings.run.kind === "agent") {
          if (AgentExecutionTask === undefined) {
            const block = blockInfo("runtime_incompatible", "native agent execution task is unavailable", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
            return;
          }
          const executionId = executionIdSchema.parse(randomUUID());
          const startedAt = runtime.now();
          let deadlineAt: number | null;
          try { deadlineAt = absoluteAgentDeadline(startedAt, settings.run.timeoutMs); }
          catch {
            const failure = failureInfo("runtime_fault", "configured agent timeout exceeds the supported timestamp range", input, runtime.now());
            await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
            return;
          }
          await launchNativeAgentExecution({ runtime, input, taskId: Number(runtime.taskId), role: "worker",
            site: settings.run, executionId, startedAt, deadlineAt, AgentExecutionTask, context });
          return;
        }
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
            checkpoint: { phase: "awaitWorker", transport: "process", processTaskId: Number(processTaskId), executionId, incarnationId, incarnationNumber: 1 },
            on: [processTaskId],
            policy: "allSettled",
          };
        }, context);
      },
      awaitWorker: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, awaitAdmission);
        const input = parseNodeInput(task.input);
        const checkpoint = nodeCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "awaitWorker") throw new Error("NodeAttempt checkpoint lacks its worker task identity");
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (attempt.workerExecutionId !== checkpoint.executionId || attempt.result.kind !== "pending") {
          const block = blockInfo("integrity_failed", "worker checkpoint differs from canonical attempt state", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        if (checkpoint.transport === "agent") {
          await completeNativeWorker({ task, runtime, input, run, attempt, checkpoint, context });
          return;
        }
        if (run.resolvedSettings.nodes[input.nodeId]?.run.kind !== "command") {
          const block = blockInfo("integrity_failed", "worker process checkpoint does not match frozen command settings", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", context);
          return;
        }
        const taskOutcome = (await runtime.outcomes([durableTaskId<ProcessExecutionTaskResult>(checkpoint.processTaskId)], context))[0];
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
          await handleWorkerFailure(runtime, input, failure, context);
          return;
        }
        if (process.exit.kind !== "code" || process.exit.code !== 0) {
          const failure = failureInfo("process_error", "worker exited unsuccessfully", input, runtime.now());
          await handleWorkerFailure(runtime, input, failure, context);
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
          await handleWorkerFailure(runtime, input, failure, context);
          return;
        }
        if (!("formatVersion" in run.resolvedSettings) || run.resolvedSettings.formatVersion !== 4) throw new Error("format 3 execution is unsupported");
        const mode = run.resolvedSettings.nodes[input.nodeId]!.result;
        const parsed = mode === "text" ? parseTextResult(Buffer.from(stdout.text, "utf8")) : parseTaggedWorkerResult(Buffer.from(stdout.text, "utf8"));
        if (!parsed.ok) {
          const failure = failureInfo(parsed.failure.kind, parsed.failure.message, input, runtime.now());
          await handleWorkerFailure(runtime, input, failure, context);
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
        await waitForLaunchPermission(runtime, canLaunch, awaitAdmission);
        const input = parseNodeInput(task.input);
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const settings = run.resolvedSettings.nodes[input.nodeId];
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (settings === undefined || settings.validator === null || (attempt.result.kind !== "candidate_committed" && attempt.result.kind !== "worker_failure_committed")) {
          throw new Error("validator checkpoint lacks a committed candidate and frozen validator");
        }
        const candidate = attempt.result.kind === "candidate_committed" ? attempt.result.candidate : null;
        const missingArtifact = candidate?.artifacts.find((artifact) => artifact.availability === "missing");
        if (missingArtifact !== undefined) {
          const failure = failureInfo("artifact_missing", missingArtifactFailureMessage(missingArtifact.path), input, runtime.now());
          await settleAttempt(task, runtime, input, { kind: "failed", failure, candidate, validator: null }, "failed", context);
          return;
        }
        const predecessor = run.chain.predecessors[input.nodeId];
        if (predecessor === undefined) throw new Error("frozen node has no predecessor snapshot");
        if (settings.validator.kind === "agent") {
          if (AgentExecutionTask === undefined) {
            const block = blockInfo("runtime_incompatible", "native agent execution task is unavailable", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
            return;
          }
          const executionId = executionIdSchema.parse(randomUUID());
          const startedAt = runtime.now();
          let agentDeadlineAt: number | null;
          try { agentDeadlineAt = absoluteAgentDeadline(startedAt, settings.validator.timeoutMs); }
          catch {
            await blockVerifier(runtime, input, candidate, "configured verifier timeout exceeds the supported timestamp range", context);
            return;
          }
          await launchNativeAgentExecution({ runtime, input, taskId: Number(runtime.taskId), role: "validator",
            site: settings.validator, executionId, startedAt, deadlineAt: agentDeadlineAt, AgentExecutionTask, context });
          return;
        }
        const launchIntentAt = timestamp(runtime.now());
        let deadlineAt: string | null;
        try {
          deadlineAt = deadline(launchIntentAt, settings.validator.timeoutMs);
        } catch {
          await blockVerifier(runtime, input, candidate, "configured verifier timeout exceeds the supported timestamp range", context);
          return;
        }
        const executionId = executionIdSchema.parse(randomUUID());
        const incarnationId = incarnationIdSchema.parse(randomUUID());
        await runtime.commit(async (tx) => {
          const { draft, run: current } = await runDraft(tx, runtime.conversationId);
          assertNodeIdentity(input, current, runtime.taskId);
          const currentAttempt = requireAttempt(current, input.nodeId, input.attemptId);
          if ((currentAttempt.result.kind !== "candidate_committed" && currentAttempt.result.kind !== "worker_failure_committed") || currentAttempt.validatorExecutionId !== null) {
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
            checkpoint: { phase: "awaitValidator", transport: "process", processTaskId: Number(processTaskId), executionId, incarnationId, incarnationNumber: 1 },
            on: [processTaskId],
            policy: "allSettled",
          };
        }, context);
      },
      awaitValidator: async (task, runtime, context) => {
        await waitForLaunchPermission(runtime, canLaunch, awaitAdmission);
        const input = parseNodeInput(task.input);
        const checkpoint = nodeCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "awaitValidator") throw new Error("NodeAttempt checkpoint lacks its validator task identity");
        const run = await snapshotRun(runtime, context);
        assertNodeIdentity(input, run, runtime.taskId);
        const attempt = requireAttempt(run, input.nodeId, input.attemptId);
        if (attempt.validatorExecutionId !== checkpoint.executionId || (attempt.result.kind !== "candidate_committed" && attempt.result.kind !== "worker_failure_committed")) {
          const block = blockInfo("integrity_failed", "validator checkpoint differs from committed worker state", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          const candidate = attempt.result.kind === "candidate_committed" ? attempt.result.candidate : null;
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
          return;
        }
        const candidate = attempt.result.kind === "candidate_committed" ? attempt.result.candidate : null;
        if (checkpoint.transport === "agent") {
          await completeNativeValidator({ task, runtime, input, attempt, checkpoint, candidate, context });
          return;
        }
        const validatorSite = run.resolvedSettings.nodes[input.nodeId]?.validator;
        if (validatorSite?.kind !== "command") {
          const block = blockInfo("integrity_failed", "validator process checkpoint does not match frozen command settings", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
          await settleAttempt(task, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
          return;
        }
        const taskOutcome = (await runtime.outcomes([durableTaskId<ProcessExecutionTaskResult>(checkpoint.processTaskId)], context))[0];
        if (taskOutcome === undefined || taskOutcome.status !== "completed") {
          const block = blockInfo("process_death_unconfirmed", "verifier process task ended without a checked retirement receipt", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
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
        if (process.timedOut || process.exit.kind !== "code" || process.exit.code === 126 || process.exit.code === 127) {
          await blockVerifier(runtime, input, candidate, "verifier process failed (launch, timeout, signal, or invalid exit)", context);
          return;
        }
        const validator = validatorOutcomeSchema.parse({
          kind: "command",
          exit: process.exit,
          stdoutHash: process.stdoutCaptureHash,
          stderrHash: process.stderrCaptureHash,
        });
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

async function waitForLaunchPermission(
  runtime: NodeRuntime,
  canLaunch: () => boolean,
  waitForAdmission: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  while (true) {
    await waitForAdmission(runtime.signal);
    if (canLaunch()) return;
  }
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
    return { status: "running", checkpoint: { phase: hasValidator ? "launchValidator" : "finish" } };
  }, context);
}

async function commitValidatorOutcome(
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  candidate: NodeResult | null,
  validator: ValidatorOutcome,
  context: Context,
): Promise<void> {
  const checkedCandidate = candidate === null ? null : nodeResultSchema.parse(candidate);
  const checkedValidator = validatorOutcomeSchema.parse(validator);
  await runtime.commit(async (tx) => {
    const { draft, run } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, run, runtime.taskId);
    const attempt = requireAttempt(run, input.nodeId, input.attemptId);
    if (attempt.result.kind === "worker_failure_committed") {
      const failure = attempt.result.failure;
      assign(draft, replaceRunAttempt(run, input.nodeId, input.attemptId, (value) => ({
        ...value, status: "validating", phase: "finish",
        result: { kind: "worker_failure_committed", failure, validator: checkedValidator },
      })));
      await appendEvent(tx, runtime.conversationId, {
        version: 1, eventId: randomUUID(), type: "validator_result_committed", runId: input.runId,
        nodeId: input.nodeId, attemptId: input.attemptId, validator: checkedValidator, occurredAt: timestamp(runtime.now()),
      });
      return { status: "running", checkpoint: { phase: "finish" } };
    }
    if (checkedCandidate === null) throw new Error("verifier candidate disappeared");
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

type NativeAgentSite = Extract<ResolvedExecutionSite, { kind: "agent" }>;
type AgentTextResult = Extract<AgentExecutionTaskResult, { kind: "completed" | "too_large" }>;

async function launchNativeAgentExecution(args: {
  runtime: NodeRuntime;
  input: NodeAttemptTaskInput;
  taskId: number;
  role: "worker" | "validator";
  site: NativeAgentSite;
  executionId: ProcessExecutionTaskEnvironmentInput["executionId"];
  startedAt: number;
  deadlineAt: number | null;
  AgentExecutionTask: AgentExecutionTaskDefinition;
  context: Context;
}): Promise<void> {
  await args.runtime.commit(async (tx) => {
    const { draft, run: current } = await runDraft(tx, args.runtime.conversationId);
    assertNodeIdentity(args.input, current, args.runtime.taskId);
    const attempt = requireAttempt(current, args.input.nodeId, args.input.attemptId);
    if (args.role === "worker") {
      if (attempt.status !== "prepared" || attempt.workerExecutionId !== null || attempt.result.kind !== "pending") {
        throw new Error("node attempt is not ready to admit its native worker");
      }
    } else if ((attempt.result.kind !== "candidate_committed" && attempt.result.kind !== "worker_failure_committed")
      || attempt.validatorExecutionId !== null) {
      throw new Error("node attempt is not ready to admit its native verifier");
    }
    if (!("formatVersion" in current.resolvedSettings) || current.resolvedSettings.formatVersion !== 4) {
      throw new Error("native execution requires frozen format 4 settings");
    }
    const settings = current.resolvedSettings.nodes[args.input.nodeId];
    const site = args.role === "worker" ? settings?.run : settings?.validator;
    if (settings === undefined || site?.kind !== "agent" || canonicalHash(site) !== canonicalHash(args.site)) {
      throw new Error("native execution differs from frozen agent settings");
    }
    const prompt = reconstructProcessStdin({
      role: args.role,
      nodeId: args.input.nodeId,
      attemptId: args.input.attemptId,
      executionId: args.executionId,
    }, current);
    const nativeInput = agentExecutionTaskInputSchema.parse({
      executionId: args.executionId,
      role: args.role === "worker" ? "worker" : "verifier",
      model: (() => {
        const model = parseModel(site.model);
        return { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinking };
      })(),
      cwd: site.cwd,
      shellPath: site.shell,
      promptText: Buffer.from(prompt.bytes).toString("utf8"),
      env: buildNativeWorkshopEnvironment(current, args.input, args.role, args.executionId, site),
      startedAt: args.startedAt,
      deadlineAt: args.deadlineAt,
    });
    const childId = await tx.createTask(args.AgentExecutionTask, nativeInput, {
      ownership: { kind: "task", taskId: args.runtime.taskId },
      conversationId: args.runtime.conversationId,
    });
    const phase = args.role === "worker" ? "awaitWorker" : "awaitValidator";
    const next = replaceRunAttempt(current, args.input.nodeId, args.input.attemptId, (value) => ({
      ...value,
      status: args.role === "worker" ? "executing" : "validating",
      phase,
      ...(args.role === "worker" ? { workerExecutionId: args.executionId } : { validatorExecutionId: args.executionId }),
    }));
    assign(draft, next);
    return {
      status: "waiting",
      checkpoint: args.role === "worker"
        ? { phase: "awaitWorker" as const, transport: "agent" as const, agentTaskId: Number(childId), executionId: args.executionId }
        : { phase: "awaitValidator" as const, transport: "agent" as const, agentTaskId: Number(childId), executionId: args.executionId },
      on: [childId],
      policy: "allSettled",
    };
  }, args.context);
}

function buildNativeWorkshopEnvironment(
  run: ReadyRun,
  input: NodeAttemptTaskInput,
  role: "worker" | "validator",
  executionId: string,
  site: NativeAgentSite,
): Record<string, string> {
  const model = parseModel(site.model);
  const directory = locateWorkflowDirectory(run);
  const env: Record<string, string> = {
    WORKSHOP_RUN_ID: run.runId,
    WORKSHOP_WORKFLOW_ID: run.workflowId,
    WORKSHOP_STEP_ID: input.nodeId,
    WORKSHOP_ATTEMPT: String(input.attemptNumber),
    WORKSHOP_EXECUTION_ID: executionId,
    WORKSHOP_RESULTS_PATH: join(directory, "results.md"),
    WORKSHOP_LOG_PATH: join(directory, "execution.log"),
    WORKSHOP_PROVIDER: model.provider,
    WORKSHOP_MODEL_ID: model.modelId,
    WORKSHOP_MODEL: model.provider + "/" + model.modelId,
    WORKSHOP_THINKING: model.thinking,
    WORKSHOP_MODEL_WITH_THINKING: model.full,
  };
  const answer = committedHumanAnswer(run, input.nodeId);
  if (answer !== null) env.WORKSHOP_ANSWER = answer;
  return env;
}

function absoluteAgentDeadline(startedAt: number, timeoutMs: number | null): number | null {
  if (timeoutMs === null) return null;
  const deadlineAt = startedAt + timeoutMs;
  if (!Number.isSafeInteger(deadlineAt) || !Number.isFinite(new Date(deadlineAt).getTime())) {
    throw new Error("agent deadline exceeds the supported timestamp range");
  }
  return deadlineAt;
}

async function readNativeAgentResult(
  runtime: NodeRuntime,
  checkpoint: AwaitAgentCheckpoint,
  expectedRole: "worker" | "verifier",
  context: Context,
): Promise<AgentExecutionTaskResult | undefined> {
  const taskId = durableTaskId<AgentExecutionTaskResult>(checkpoint.agentTaskId);
  const task = await runtime.getTask(taskId, context);
  if (task === undefined || task.kind !== "workshop.agent-execution" || task.owner !== runtime.taskId
    || task.conversationId !== runtime.conversationId) return undefined;
  const taskInput = agentExecutionTaskInputSchema.safeParse(task.input);
  if (!taskInput.success || taskInput.data.executionId !== checkpoint.executionId || taskInput.data.role !== expectedRole) return undefined;
  const outcome = (await runtime.outcomes([taskId], context))[0];
  if (outcome === undefined || outcome.status !== "completed") return undefined;
  const result = agentExecutionTaskResultSchema.safeParse(outcome.result);
  if (!result.success || result.data.executionId !== checkpoint.executionId
    || result.data.requestId !== "workshop.agent-execution:" + checkpoint.executionId
    || result.data.startedAt !== taskInput.data.startedAt || result.data.finishedAt < taskInput.data.startedAt) return undefined;
  return result.data;
}

async function completeNativeWorker(args: {
  task: unknown;
  runtime: NodeRuntime;
  input: NodeAttemptTaskInput;
  run: ReadyRun;
  attempt: PersistedNodeAttempt;
  checkpoint: AwaitAgentCheckpoint;
  context: Context;
}): Promise<void> {
  const result = await readNativeAgentResult(args.runtime, args.checkpoint, "worker", args.context);
  if (result === undefined) {
    const block = blockInfo("external_outcome_unknown", "native worker ended without a checked execution receipt", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind === "blocked") {
    const block = blockInfo("external_outcome_unknown", "native worker has an interrupted unsafe tool call", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind === "timed_out") {
    const block = blockInfo("external_outcome_unknown", "native worker timed out before a checked final answer", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind === "guard_failed") {
    const block = blockInfo("integrity_failed", result.reason, args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind === "cancelled") {
    const block = blockInfo("external_outcome_unknown", "native worker was cancelled without an operator stop receipt", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind === "failed") {
    await handleWorkerFailure(args.runtime, args.input,
      failureInfo("process_error", result.reason, args.input, args.runtime.now()), args.context);
    return;
  }
  if (result.kind === "too_large") {
    const failure = failureInfo("result_too_large", "worker final text exceeded the 1 MiB result limit", args.input,
      args.runtime.now(), nativeFailureReceipt(result));
    await persistNativeWorkerFailure(args.runtime, args.input, failure, args.checkpoint, args.context);
    await handleWorkerFailure(args.runtime, args.input, failure, args.context);
    return;
  }
  const bytes = Buffer.from(result.finalText, "utf8");
  if (sha256(bytes) !== result.finalTextSha256) {
    const block = blockInfo("integrity_failed", "native worker final-text hash does not match its receipt", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: null, validator: null }, "interrupted", args.context);
    return;
  }
  if (!("formatVersion" in args.run.resolvedSettings) || args.run.resolvedSettings.formatVersion !== 4) {
    throw new Error("native worker requires frozen format 4 settings");
  }
  const settings = args.run.resolvedSettings.nodes[args.input.nodeId];
  if (settings === undefined) throw new Error("frozen node settings disappeared");
  const parsed = settings.result === "text" ? parseTextResult(bytes) : parseTaggedWorkerResult(bytes);
  if (!parsed.ok) {
    const failure = failureInfo(parsed.failure.kind, parsed.failure.message, args.input,
      args.runtime.now(), nativeFailureReceipt(result));
    await persistNativeWorkerFailure(args.runtime, args.input, failure, args.checkpoint, args.context);
    await handleWorkerFailure(args.runtime, args.input, failure, args.context);
    return;
  }
  const candidate = nodeResultSchema.parse({
    version: 3,
    source: "agent",
    output: parsed.value.output,
    summary: "reason" in parsed.value ? parsed.value.reason ?? "" : "",
    artifacts: [],
    sourceBytesHash: result.finalTextSha256,
    nativeExecution: nativeReceipt(result),
    agentResult: {
      version: 1,
      mode: settings.result,
      status: parsed.value.status,
      reason: "reason" in parsed.value ? parsed.value.reason : null,
      question: "question" in parsed.value ? parsed.value.question : null,
    },
  });
  await commitWorkerCandidate(args.runtime, args.input, candidate, settings.validator !== null, args.context);
}

async function completeNativeValidator(args: {
  task: unknown;
  runtime: NodeRuntime;
  input: NodeAttemptTaskInput;
  attempt: PersistedNodeAttempt;
  checkpoint: AwaitAgentCheckpoint;
  candidate: NodeResult | null;
  context: Context;
}): Promise<void> {
  const result = await readNativeAgentResult(args.runtime, args.checkpoint, "verifier", args.context);
  if (result === undefined) {
    const block = blockInfo("process_death_unconfirmed", "native verifier ended without a checked execution receipt", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: args.candidate, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind === "blocked" || result.kind === "timed_out") {
    const block = blockInfo("external_outcome_unknown", "native verifier ended with an unknown tool outcome", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: args.candidate, validator: null }, "interrupted", args.context);
    return;
  }
  if (result.kind !== "completed") {
    const reason = result.kind === "guard_failed" ? result.reason
      : result.kind === "failed" ? result.reason
        : result.kind === "too_large" ? "agent verifier final text exceeded the 1 MiB result limit"
          : "native verifier was cancelled without a checked operator stop";
    await blockVerifier(args.runtime, args.input, args.candidate, reason, args.context);
    return;
  }
  const bytes = Buffer.from(result.finalText, "utf8");
  if (sha256(bytes) !== result.finalTextSha256) {
    const block = blockInfo("integrity_failed", "native verifier final-text hash does not match its receipt", args.input.runId, args.input.nodeId, args.input.attemptId, timestamp(args.runtime.now()));
    await settleAttempt(args.task, args.runtime, args.input, { kind: "blocked", block, candidate: args.candidate, validator: null }, "interrupted", args.context);
    return;
  }
  const parsed = parseVerifierResult(bytes);
  if (!parsed.ok) {
    await blockVerifier(args.runtime, args.input, args.candidate, parsed.failure.message, args.context);
    return;
  }
  if (args.candidate === null && parsed.value.decision === "accept") {
    await blockVerifier(args.runtime, args.input, args.candidate, "only retry or block is valid after worker failure", args.context);
    return;
  }
  const validator = validatorOutcomeSchema.parse({
    kind: "native_agent",
    nativeExecution: nativeReceipt(result),
    verdict: { version: 2, decision: parsed.value.decision, reason: parsed.value.reason },
    resultBytesHash: result.finalTextSha256,
  });
  await commitValidatorOutcome(args.runtime, args.input, args.candidate, validator, args.context);
}

function nativeReceipt(result: Extract<AgentExecutionTaskResult, { kind: "completed" }>) {
  return {
    executionId: result.executionId,
    conversationId: result.conversationId,
    requestId: result.requestId,
    assistantEntryId: result.assistantEntryId,
    finalTextSha256: result.finalTextSha256,
    byteCount: Buffer.byteLength(result.finalText, "utf8"),
    finalText: result.finalText,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}

function nativeFailureReceipt(result: Extract<AgentExecutionTaskResult, { kind: "completed" | "too_large" }>) {
  return nativeExecutionReceiptSchema.parse({
    executionId: result.executionId,
    conversationId: result.conversationId,
    requestId: result.requestId,
    assistantEntryId: result.assistantEntryId,
    finalTextSha256: result.finalTextSha256,
    byteCount: result.kind === "completed" ? Buffer.byteLength(result.finalText, "utf8") : result.byteCount,
    ...(result.kind === "completed" ? { finalText: result.finalText } : {}),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  });
}

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
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
  if (args.site.kind !== "command") throw new Error("native agent execution cannot use ProcessExecution");
  const files = processExecutionFiles(
    { role: args.role, nodeId: args.input.nodeId, incarnationNumber: args.incarnationNumber ?? 1, executionId: args.executionId },
    locateWorkflowDirectory(args.run),
    args.run.runId,
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
    command: args.site.command,
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
      : latestAttempt.result.kind === "candidate_committed" || latestAttempt.result.kind === "worker_failure_committed";
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
      ? { phase: "awaitWorker" as const, transport: "process" as const, processTaskId: Number(processTaskId), executionId: replay.executionId, incarnationId: replay.incarnationId, incarnationNumber: replay.incarnationNumber }
      : { phase: "awaitValidator" as const, transport: "process" as const, processTaskId: Number(processTaskId), executionId: replay.executionId, incarnationId: replay.incarnationId, incarnationNumber: replay.incarnationNumber };
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
    await waitForRunChange(runtime, input, context);
  }
}

async function waitForRunChange(runtime: NodeRuntime, input: NodeAttemptTaskInput, context: Context): Promise<void> {
  const parentContext = withAbortSignal(runtime.signal, context);
  const { context: watchContext, cancel } = withCancel(parentContext);
  let watch: DocumentWatch<JsonObject> | undefined;
  try {
    watch = await runtime.watchDoc(WorkshopRunDoc, runtime.conversationId, watchContext);
    if (watch === undefined) throw new Error("NodeAttempt run document is unavailable for watching");
    const initial = readyRun(watch.value);
    assertNodeIdentity(input, initial, runtime.taskId);
    let notify!: () => void;
    const changed = new Promise<void>((resolve) => { notify = resolve; });
    watch.start(async (value) => {
      const observed = readyRun(value);
      assertNodeIdentity(input, observed, runtime.taskId);
      notify();
    });
    const current = await snapshotRun(runtime, watchContext);
    assertNodeIdentity(input, current, runtime.taskId);
    if (canonicalHash(current) !== canonicalHash(initial)) return;

    const result = await Promise.race([
      changed.then(() => ({ kind: "changed" as const })),
      watch.closed.then((end) => ({ kind: "closed" as const, end })),
    ]);
    if (result.kind === "changed") return;
    if (runtime.signal.aborted || watchContext.abortSignal?.aborted) {
      throw runtime.signal.reason ?? watchContext.abortSignal?.reason ?? new Error("run-state wait was cancelled");
    }
    if (result.end.reason === "listener_error") throw result.end.error;
    throw new Error("NodeAttempt run document watch ended: " + result.end.reason);
  } finally {
    cancel();
    if (watch !== undefined) {
      const end = await watch.stop();
      if (end.reason === "listener_error" && !runtime.signal.aborted && !watchContext.abortSignal?.aborted) {
        throw end.error;
      }
    }
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

function validatorFailureReason(validator: ValidatorOutcome): string {
  if (validator.kind === "command") {
    return validator.exit.kind === "code"
      ? "command validator exited with code " + validator.exit.code
      : "command validator exited by " + validator.exit.kind;
  }
  return validator.verdict.reason;
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
    return (attempt.result.kind === "candidate_committed" || attempt.result.kind === "worker_failure_committed") && hasWorkerReceipt
      && attempt.validatorExecutionId === null;
  }
  if (checkpoint.phase === "finish") return false;
  if (checkpoint.transport !== "process") return false;
  const expectedRole = checkpoint.phase === "awaitWorker" ? "worker" : "validator";
  if ((expectedRole === "worker" && attempt.result.kind !== "pending")
    || (expectedRole === "validator" && ((attempt.result.kind !== "candidate_committed" && attempt.result.kind !== "worker_failure_committed") || !hasWorkerReceipt))) return false;
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
  if (attempt.result.kind === "worker_failure_committed") {
    const { failure, validator } = attempt.result;
    if ((validator?.kind === "agent" || validator?.kind === "native_agent") && validator.verdict.version === 2 && validator.verdict.decision === "block") {
      const block = blockInfo("verifier_block", validator.verdict.reason, input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
      await settleAttempt(null, runtime, input, { kind: "blocked", block, candidate: null, validator }, "interrupted", context);
    } else {
      await settleAttempt(null, runtime, input, { kind: "failed", failure, candidate: null, validator }, "failed", context);
    }
    return;
  }
  const candidate = attempt.result.kind === "candidate_committed" || attempt.result.kind === "validation_committed"
    ? attempt.result.candidate
    : null;
  if (candidate === null) throw new Error("attempt has no committed candidate to settle");
  const validator = attempt.result.kind === "validation_committed" ? attempt.result.validator : null;
  if ((validator?.kind === "agent" || validator?.kind === "native_agent") && validator.verdict.version === 2 && validator.verdict.decision === "block") {
    const reason = validator.verdict.reason;
    const block = blockInfo("verifier_block", reason, input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
    await settleAttempt(null, runtime, input, { kind: "blocked", block, candidate, validator }, "interrupted", context);
    return;
  }
  const missingArtifact = candidate?.artifacts.find((artifact) => artifact.availability === "missing");
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
        failure: failureInfo("validator_rejection", buildFailureFeedback(validatorFailureReason(validator)), input, runtime.now()),
        candidate,
        validator,
      })
      : nodeAttemptOutcomeSchema.parse({ kind: "succeeded", candidate, validator });
  await settleAttempt(null, runtime, input, outcome, outcome.kind === "succeeded" ? "succeeded" : "failed", context);
}


async function settleAttempt(
  _task: unknown,
  runtime: NodeRuntime,
  input: NodeAttemptTaskInput,
  outcome: NodeAttemptOutcome,
  status: "succeeded" | "failed" | "interrupted" | "cancelled",
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
    const failureMetadata = committedOutcome.kind === "failed"
      ? await buildAttemptFailureMetadata(tx, runtime.conversationId, run, input, committedOutcome)
      : {};
    const next = replaceRunAttempt(run, input.nodeId, input.attemptId, (currentAttempt) => ({
      ...currentAttempt,
      ...failureMetadata,
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

function failureInfo(
  kind: FailureInfo["kind"], message: string, input: NodeAttemptTaskInput, at: number,
  nativeExecution?: z.infer<typeof nativeExecutionReceiptSchema>,
): FailureInfo {
  return failureInfoSchema.parse({ kind, message, failedAt: timestamp(at), nodeId: input.nodeId, attemptId: input.attemptId,
    ...(nativeExecution === undefined ? {} : { nativeExecution }) });
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

async function persistNativeWorkerFailure(
  runtime: NodeRuntime, input: NodeAttemptTaskInput, failure: FailureInfo,
  checkpoint: AwaitAgentCheckpoint, context: Context,
): Promise<void> {
  await runtime.commit(async (tx) => {
    const { draft, run } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, run, runtime.taskId);
    const attempt = requireAttempt(run, input.nodeId, input.attemptId);
    if (attempt.workerExecutionId !== failure.nativeExecution?.executionId) {
      throw new Error("native worker failure receipt does not match the active worker execution");
    }
    assign(draft, replaceRunAttempt(run, input.nodeId, input.attemptId, (value) => ({
      ...value, workerFailure: failure,
    })));
    return { status: "running", checkpoint };
  }, context);
}

async function handleWorkerFailure(runtime: NodeRuntime, input: NodeAttemptTaskInput, failure: FailureInfo, context: Context): Promise<void> {
  const run = await snapshotRun(runtime, context);
  const attempt = requireAttempt(run, input.nodeId, input.attemptId);
  const settings = run.resolvedSettings.nodes[input.nodeId];
  if (settings === undefined) throw new Error("failed worker lost its frozen settings");
  const limit = resolveRetryLimit(settings);
  const retryPermitted = settings.run.replay === "safe" && (limit === "unlimited" || attempt.number <= limit);
  if (!retryPermitted || settings.validator?.kind !== "agent") {
    await settleAttempt(null, runtime, input, { kind: "failed", failure, candidate: null, validator: null }, "failed", context);
    return;
  }
  await runtime.commit(async (tx) => {
    const { draft, run: current } = await runDraft(tx, runtime.conversationId);
    assertNodeIdentity(input, current, runtime.taskId);
    const metadata = await buildAttemptFailureMetadata(tx, runtime.conversationId, current, input,
      { kind: "failed", failure, candidate: null, validator: null });
    assign(draft, replaceRunAttempt(current, input.nodeId, input.attemptId, (value) => ({
      ...value, ...metadata, workerFailure: failure, phase: "captureCandidate",
      result: { kind: "worker_failure_committed", failure, validator: null },
    })));
    return { status: "running", checkpoint: { phase: "launchValidator" } };
  }, context);
}

async function blockVerifier(runtime: NodeRuntime, input: NodeAttemptTaskInput, candidate: NodeResult | null, reason: string, context: Context): Promise<void> {
  const block = blockInfo("verifier_failed", reason, input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
  await settleAttempt(null, runtime, input, { kind: "blocked", block, candidate, validator: null }, "interrupted", context);
}

async function buildAttemptFailureMetadata(
  tx: Tx,
  conversationId: ConversationId,
  run: ReadyRun,
  input: NodeAttemptTaskInput,
  outcome: Extract<NodeAttemptOutcome, { kind: "failed" }>,
) {
  const attempt = requireAttempt(run, input.nodeId, input.attemptId);
  const role = outcome.candidate === null ? "worker" : "validator";
  const executionId = role === "worker" ? attempt.workerExecutionId : attempt.validatorExecutionId;
  let process: z.infer<typeof workshopProcessV1Schema>["process"] | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId }, 256, cursor);
    for (const entry of page.items) {
      if (!WorkshopProcessEntry.is(entry)) continue;
      const record = workshopProcessV1Schema.parse(entry.data);
      if (record.attemptId !== input.attemptId || record.process.executionId !== executionId || record.process.status !== "exited") continue;
      if (process === undefined || record.process.incarnationNumber > process.incarnationNumber) process = record.process;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  const stderr = process?.captures.find((capture) => capture.stream === "stderr");
  const stdout = process?.captures.find((capture) => capture.stream === "stdout");
  const stderrBytes = Buffer.from(stderr?.retained?.bytes ?? "", "base64");
  const verifier = outcome.validator;
  const verifierReason = (verifier?.kind === "agent" || verifier?.kind === "native_agent") && verifier.verdict.version === 2 ? verifier.verdict.reason : null;
  const feedbackText = verifier !== null && verifierReason !== null
    ? validatorFailureReason(verifier)
    : outcome.failure.message + "\n\nstdout:\n" + (stdout?.retained === undefined ? "unavailable" : readCaptureBytes(Buffer.from(stdout.retained.bytes, "base64")))
      + "\n\nstderr:\n" + (stderr?.retained === undefined ? "unavailable" : readCaptureBytes(stderrBytes))
      + ((stdout?.truncatedBytes ?? 0) + (stderr?.truncatedBytes ?? 0) > 0 ? "\n[Captured failure output truncated.]" : "");
  return {
    failureEvidenceHash: hashFailureEvidence(role, process?.exit ?? null, stderrBytes, verifierReason),
    feedback: { nodeId: input.nodeId, attemptId: input.attemptId, attemptNumber: attempt.number, text: buildFailureFeedback(feedbackText) },
  };
}
