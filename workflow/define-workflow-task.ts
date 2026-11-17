import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type TaskOutcome, type TaskRuntime } from "@earendil-works/pi-durable";
import {
  advanceWorkflowState,
  decodeWorkflowTaskCheckpoint,
  retryLimit,
  WorkflowCheckpointIntegrityError,
  type WorkflowExecutionState,
  type WorkflowStateContext,
  type WorkflowTaskCheckpoint,
  type WorkflowTaskResult,
} from "./advance-workflow-state.ts";
import { buildOrchestratorBrief } from "./build-orchestrator-brief.ts";
import { StepAttemptTask, type StepAttemptSource } from "./define-step-attempt-task.ts";
import { loadWorkflowStep, WorkflowStepLoadError } from "./load-workflow-step.ts";
import type { WorkflowAttemptRequest, WorkflowAttemptResult } from "./execute-workflow-attempt.ts";
import type { OrchestratorDecision, Workflow, WorkflowDecision } from "./types.ts";
import { appendRecent, workshopStateDocument } from "./define-workshop-state.ts";

export type { WorkflowTaskCheckpoint, WorkflowTaskResult } from "./advance-workflow-state.ts";

export const WORKFLOW_TASK_NAME = "workshop.workflow";

export type WorkflowTaskInput = {
  runId: string;
  workflowName: string;
  startedAt: string;
  slot: string | null;
  projectRoot: string;
  dataDirectory: string;
  stateDirectory: string;
  workflow: Workflow;
  profileCommands: Record<string, string[]>;
};

type WorkflowTaskRuntime = TaskRuntime<WorkflowTaskInput, WorkflowTaskCheckpoint, WorkflowTaskResult, object>;

type DecisionDocument = {
  choice: { requestId: string; decisionNumber?: number; decision: WorkflowDecision; source?: "chat" | "round" } | null;
};

export const workflowDecisionDocument = defineDoc<DecisionDocument>({
  kind: "workshop.workflow-decision",
  version: 1,
  scope: "task",
  initial: () => ({ choice: null }),
  checkpointWhen: () => true,
});


function stateContext(input: WorkflowTaskInput): WorkflowStateContext {
  return {
    workflow: input.workflow,
    workflowName: input.workflowName,
    runId: input.runId,
    profileCommands: input.profileCommands,
  };
}

function decodeCheckpoint(value: unknown, input: WorkflowTaskInput): WorkflowTaskCheckpoint {
  return decodeWorkflowTaskCheckpoint(value, stateContext(input));
}

function checkpointForStep(value: unknown, input: WorkflowTaskInput): Extract<WorkflowTaskCheckpoint, { phase: "step" }> {
  const checkpoint = decodeCheckpoint(value, input);
  if (checkpoint.phase !== "step") throw new WorkflowCheckpointIntegrityError("checkpoint.phase", `step handler received ${checkpoint.phase}`);
  return checkpoint;
}

function checkpointForAttempt(value: unknown, input: WorkflowTaskInput): Extract<WorkflowTaskCheckpoint, { phase: "attempt" }> {
  const checkpoint = decodeCheckpoint(value, input);
  if (checkpoint.phase !== "attempt") throw new WorkflowCheckpointIntegrityError("checkpoint.phase", `attempt handler received ${checkpoint.phase}`);
  return checkpoint;
}

function checkpointForBlocked(value: unknown, input: WorkflowTaskInput): Extract<WorkflowTaskCheckpoint, { phase: "blocked" }> {
  const checkpoint = decodeCheckpoint(value, input);
  if (checkpoint.phase !== "blocked") throw new WorkflowCheckpointIntegrityError("checkpoint.phase", `blocked handler received ${checkpoint.phase}`);
  return checkpoint;
}

function checkpointForDecision(value: unknown, input: WorkflowTaskInput): Extract<WorkflowTaskCheckpoint, { phase: "decision" }> {
  const checkpoint = decodeCheckpoint(value, input);
  if (checkpoint.phase !== "decision") throw new WorkflowCheckpointIntegrityError("checkpoint.phase", `decision handler received ${checkpoint.phase}`);
  return checkpoint;
}

function requireAccepted(transition: ReturnType<typeof advanceWorkflowState>): WorkflowExecutionState {
  if (transition.kind === "rejected") throw new Error(`Workflow transition rejected (${transition.code}): ${transition.message}`);
  return transition.state;
}

async function commitExecutionState(
  state: WorkflowExecutionState,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  if (state.phase === "finished") {
    await runtime.commit(() => ({ status: "terminal", outcome: state.outcome }), context);
  } else {
    await runtime.commit(() => ({ status: "running", checkpoint: state }), context);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeAttemptResult(value: unknown): WorkflowAttemptResult {
  if (!isRecord(value)) throw new Error("Step attempt result integrity error: result must be an object");
  const result = value;
  switch (result.kind) {
    case "accepted":
    case "nothing-to-do":
      if (typeof result.output !== "string") throw new Error(`Step attempt result integrity error: ${result.kind}.output must be a string`);
      return { kind: result.kind, output: result.output };
    case "failed":
      if (typeof result.output !== "string" || typeof result.reason !== "string") throw new Error("Step attempt result integrity error: failed result needs string output and reason");
      return { kind: "failed", output: result.output, reason: result.reason };
    default:
      throw new Error("Step attempt result integrity error: kind is unknown");
  }
}

export function decodeStepAttemptOutcome(outcome: TaskOutcome<WorkflowAttemptResult>): WorkflowAttemptResult {
  switch (outcome.status) {
    case "completed":
      return decodeAttemptResult(outcome.result);
    case "aborted":
      return { kind: "failed", output: "", reason: outcome.reason ?? "Step attempt was aborted" };
    case "failed":
    case "faulted":
      return { kind: "failed", output: "", reason: outcome.error.message };
    case "orphaned":
      return { kind: "failed", output: "", reason: outcome.reason };
  }
}

function roundFailureNote(settled: { status: string; reason?: string }): string {
  return settled.status === "unanswered"
    ? `Automatic failure round gave up: ${settled.reason ?? "the submission was unanswered"}`
    : "Automatic failure round returned without a decision; the run remains blocked.";
}

async function submitFailureRound(
  input: WorkflowTaskInput,
  checkpoint: Extract<WorkflowTaskCheckpoint, { phase: "blocked" }>,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const step = input.workflow.steps[checkpoint.stepIndex];
  if (!step) throw new WorkflowCheckpointIntegrityError("checkpoint.stepIndex", "does not identify a workflow step");
  let stepContent = "";
  try {
    const loaded = loadWorkflowStep(join(input.projectRoot, "workflows"), input.workflow, step);
    stepContent = loaded.stepContent;
  } catch (error) {
    if (!(error instanceof WorkflowStepLoadError)) throw error;
  }
  const brief = buildOrchestratorBrief({
    workflow: input.workflow,
    step,
    stepId: checkpoint.failure.step,
    runId: input.runId,
    decisionNumber: checkpoint.failure.decisionNumber,
    stepContent,
    lastOutput: checkpoint.failure.lastOutput,
    lastError: checkpoint.failure.lastError,
    attemptHistory: checkpoint.failure.attemptHistory,
    allowedRetryProfiles: checkpoint.failure.retryProfiles,
  });
  const conversation = await runtime.conversation(runtime.conversationId, context);
  if (!conversation) throw new Error("Root orchestrator conversation is unavailable");
  const attempt = checkpoint.failure.attemptHistory.at(-1)?.attempt ?? 1;
  const submission = await conversation.submit({
    type: "input",
    content: brief.prompt,
    requestId: `round:${input.runId}:${checkpoint.failure.step}:${attempt}`,
    whenBusy: "followUp",
  }, context);
  const settled = await submission.wait(context);
  await runtime.commit(async (tx) => {
    const decision = await tx.doc(workflowDecisionDocument, runtime.taskId);
    if (decision.choice === null) {
      const state = await tx.doc(workshopStateDocument);
      const note = roundFailureNote(settled);
      const action: OrchestratorDecision = { action: "give_up", note };
      appendRecent(state.actions, {
        at: new Date(runtime.now()).toISOString(),
        workflow: input.workflowName,
        run_id: input.runId,
        step: checkpoint.failure.step,
        source: "round",
        decision: action,
        note,
      });
    }
    const next = requireAccepted(advanceWorkflowState(checkpoint, { kind: "round-settled" }, stateContext(input)));
    if (next.phase !== "blocked") throw new Error("Settling a failure round unexpectedly left the blocked phase");
    return { status: "running", checkpoint: next };
  }, context);
}

async function waitForDecision(
  input: WorkflowTaskInput,
  checkpoint: Extract<WorkflowTaskCheckpoint, { phase: "blocked" }>,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const latest = await runtime.snapshot(workflowDecisionDocument, runtime.taskId, context);
  if (latest === undefined) throw new Error("Decision document is missing");
  if (latest.choice === null && checkpoint.roundStatus === "pending") {
    await submitFailureRound(input, checkpoint, runtime, context);
    return;
  }
  const watch = await runtime.watchDoc(workflowDecisionDocument, runtime.taskId, context);
  if (!watch) throw new Error("Decision document is missing");
  try {
    let accepted = watch.value?.choice ?? null;
    if (accepted === null) {
      accepted = await new Promise<NonNullable<DecisionDocument["choice"]>>((resolveChoice, rejectChoice) => {
        let settled = false;
        const finish = (value?: NonNullable<DecisionDocument["choice"]>, error?: Error) => {
          if (settled) return;
          settled = true;
          runtime.signal.removeEventListener("abort", onAbort);
          if (error) rejectChoice(error);
          else if (value) resolveChoice(value);
        };
        const onAbort = () => finish(undefined, new Error("Workflow task was aborted while waiting for a decision"));
        if (runtime.signal.aborted) return onAbort();
        runtime.signal.addEventListener("abort", onAbort, { once: true });
        watch.start(async (call) => {
          if (call.kind !== "value") return;
          const next = call.value?.choice ?? null;
          if (next !== null) finish(next);
        });
      });
    }
    await runtime.commit(async (tx) => {
      const document = await tx.doc(workflowDecisionDocument, runtime.taskId);
      const current = document.choice;
      if (current === null || current.requestId !== accepted.requestId || accepted.decisionNumber !== checkpoint.decisionNumber || current.decisionNumber !== checkpoint.decisionNumber) {
        throw new Error("Decision changed or became stale before the workflow task accepted it");
      }
      if (accepted.decision.action === "accept" && checkpoint.failure.lastOutput.trim().length === 0) {
        throw new Error("Cannot accept a blocked step with empty output");
      }
      document.choice = null;
      const next = requireAccepted(advanceWorkflowState(checkpoint, {
        kind: "decision-recorded",
        decisionNumber: checkpoint.decisionNumber,
        decision: accepted.decision,
        source: accepted.source ?? "chat",
      }, stateContext(input)));
      if (next.phase !== "decision") throw new Error("Recording a decision unexpectedly left the decision phase");
      return { status: "running", checkpoint: next };
    }, context);
  } finally {
    await watch.stop();
  }
}

async function startStepAttempt(
  input: WorkflowTaskInput,
  checkpoint: Extract<WorkflowTaskCheckpoint, { phase: "step" }>,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  if (checkpoint.waitUntil !== undefined && runtime.now() < checkpoint.waitUntil) {
    await runtime.sleepUntil(checkpoint.waitUntil, checkpoint, context);
    return;
  }
  const step = input.workflow.steps[checkpoint.stepIndex];
  if (!step) throw new WorkflowCheckpointIntegrityError("checkpoint.stepIndex", "does not identify a workflow step");
  let source: StepAttemptSource;
  try {
    const { documents, files } = loadWorkflowStep(join(input.projectRoot, "workflows"), input.workflow, step);
    source = { documents, files };
  } catch (error) {
    if (!(error instanceof WorkflowStepLoadError)) throw error;
    // Save expected load failures as attempts so retries and blocked decisions still apply.
    source = { loadError: error.message };
  }
  const request: WorkflowAttemptRequest = {
    step,
    ...(checkpoint.profile === undefined ? {} : { profile: checkpoint.profile }),
    pipeInput: checkpoint.pipeInput,
    feedback: checkpoint.feedback,
    attempt: checkpoint.attemptHistory.length + 1,
  };
  const attemptInput = {
    projectRoot: input.projectRoot,
    workflow: input.workflow,
    step,
    ...source,
    profileCommands: input.profileCommands,
    runId: input.runId,
    dataDirectory: input.dataDirectory,
    stateDirectory: input.stateDirectory,
    request,
  };
  await runtime.commit(async (tx) => {
    const taskId = await tx.createTask(StepAttemptTask, attemptInput, {
      ownership: { kind: "task", taskId: runtime.taskId },
    });
    const next = requireAccepted(advanceWorkflowState(checkpoint, {
      kind: "attempt-started",
      activeAttempt: { taskId, request },
    }, stateContext(input)));
    if (next.phase !== "attempt") throw new Error("Starting an attempt unexpectedly left the attempt phase");
    return { status: "running", checkpoint: next };
  }, context);
}

async function receiveStepAttempt(
  input: WorkflowTaskInput,
  checkpoint: Extract<WorkflowTaskCheckpoint, { phase: "attempt" }>,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const settled = await runtime.waitForTask(checkpoint.activeAttempt.taskId, context);
  const attemptResult = decodeStepAttemptOutcome(settled.state.outcome);
  const transition = advanceWorkflowState(checkpoint, {
    kind: "attempt-settled",
    attempt: checkpoint.activeAttempt.request.attempt,
    result: attemptResult,
  }, stateContext(input));
  const next = requireAccepted(transition);
  await commitExecutionState(next, runtime, context);
}

async function applyDecision(
  input: WorkflowTaskInput,
  checkpoint: Extract<WorkflowTaskCheckpoint, { phase: "decision" }>,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const now = runtime.now();
  const next = requireAccepted(advanceWorkflowState(checkpoint, {
    kind: "decision-applied",
    decisionNumber: checkpoint.decisionNumber,
    now,
  }, stateContext(input)));
  if (next.phase === "step" && next.waitUntil !== undefined) {
    await runtime.sleepUntil(next.waitUntil, next, context);
    return;
  }
  await commitExecutionState(next, runtime, context);
}

export const WorkflowTask = defineTask<WorkflowTaskInput, WorkflowTaskCheckpoint, WorkflowTaskResult, object>({
  name: WORKFLOW_TASK_NAME,
  version: 3,
  initial: (input): WorkflowTaskCheckpoint => {
    const first = input.workflow.steps[0];
    return {
      phase: "step",
      stepIndex: 0,
      pipeInput: "",
      results: [],
      attemptHistory: [],
      localRetriesLeft: first === undefined ? 0 : retryLimit(first, input.workflow),
      ...(first?.profile === undefined ? {} : { profile: first.profile }),
      feedback: "",
      decisionNumber: 0,
      automaticRoundUsed: false,
    };
  },
  phases: {
    step: async (task, runtime, context) => startStepAttempt(task.input, checkpointForStep(task.state.checkpoint, task.input), runtime, context),
    attempt: async (task, runtime, context) => receiveStepAttempt(task.input, checkpointForAttempt(task.state.checkpoint, task.input), runtime, context),
    blocked: async (task, runtime, context) => waitForDecision(task.input, checkpointForBlocked(task.state.checkpoint, task.input), runtime, context),
    decision: async (task, runtime, context) => applyDecision(task.input, checkpointForDecision(task.state.checkpoint, task.input), runtime, context),
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), context);
  },
});
