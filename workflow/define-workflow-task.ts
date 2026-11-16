import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type TaskId, type TaskRuntime } from "@earendil-works/pi-durable";
import { applyWorkflowDecision } from "./apply-workflow-decision.ts";
import { buildOrchestratorBrief } from "./build-orchestrator-brief.ts";
import { computeRetryProfiles } from "./compute-retry-profiles.ts";
import { StepAttemptTask } from "./define-step-attempt-task.ts";
import { loadWorkflowStep } from "./load-workflow-step.ts";
import type { WorkflowAttemptRequest, WorkflowAttemptResult, WorkflowDecisionRequest, WorkflowInterpretation } from "./interpret-workflow.ts";
import type { AttemptHistoryEntry, OrchestratorDecision, Workflow, WorkflowDecision, WorkflowStep, WorkflowStepResult } from "./types.ts";
import { appendRecent, workshopStateDocument } from "../run/workshop-state.ts";

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

type ActiveAttempt = {
  taskId: TaskId<WorkflowAttemptResult>;
  request: WorkflowAttemptRequest;
};
type CheckpointPosition = {
  stepIndex: number;
  pipeInput: string;
  results: WorkflowStepResult[];
  attemptHistory: AttemptHistoryEntry[];
  localRetriesLeft: number;
  profile?: string;
  feedback: string;
  decisionNumber: number;
  automaticRoundUsed: boolean;
  waitUntil?: number;
};
type StepCheckpoint = CheckpointPosition & { phase: "step" };
type AttemptCheckpoint = CheckpointPosition & { phase: "attempt"; activeAttempt: ActiveAttempt };
type BlockedCheckpoint = CheckpointPosition & { phase: "blocked"; failure: WorkflowDecisionRequest; roundStatus?: "pending" | "settled" };
type DecisionCheckpoint = CheckpointPosition & { phase: "decision"; failure: WorkflowDecisionRequest; decision: WorkflowDecision; decisionSource?: "chat" | "round" };
export type WorkflowTaskCheckpoint = StepCheckpoint | AttemptCheckpoint | BlockedCheckpoint | DecisionCheckpoint;
export type WorkflowTaskResult = WorkflowInterpretation;
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

function stepId(step: WorkflowStep): string {
  return `${step.number}-${step.name}`;
}

function retryLimit(step: WorkflowStep, workflow: Workflow): number {
  return step.retries ?? step.check?.retries ?? workflow.retries ?? 0;
}

function durationMilliseconds(value: string): number {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) throw new Error(`Invalid retry delay: ${value}`);
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * factor;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) throw new Error(`Retry delay is too large: ${value}`);
  return milliseconds;
}

function attemptRecord(request: WorkflowAttemptRequest, result: WorkflowAttemptResult): AttemptHistoryEntry {
  return {
    attempt: request.attempt,
    ...(request.step.kind === "agent" && request.profile !== undefined ? { profile: request.profile } : {}),
    output: result.output,
    ...(result.kind === "failed" ? { error: result.reason } : {}),
  };
}

function resultForDecision(failure: WorkflowDecisionRequest, action: "accept" | "skip"): WorkflowStepResult {
  return action === "accept"
    ? { step: failure.step, status: "completed", output: failure.lastOutput, attempts: failure.attemptHistory }
    : { step: failure.step, status: "skipped", output: "", attempts: failure.attemptHistory };
}

function checkpointForNextStep(input: WorkflowTaskInput, position: CheckpointPosition, stepResult: WorkflowStepResult, pipeInput: string): StepCheckpoint {
  const stepIndex = position.stepIndex + 1;
  const nextStep = input.workflow.steps[stepIndex];
  return {
    phase: "step",
    stepIndex,
    pipeInput,
    results: [...position.results, stepResult],
    attemptHistory: [],
    localRetriesLeft: nextStep === undefined ? 0 : retryLimit(nextStep, input.workflow),
    ...(nextStep?.profile === undefined ? {} : { profile: nextStep.profile }),
    feedback: "",
    decisionNumber: position.decisionNumber,
    automaticRoundUsed: false,
  };
}

async function commitStepResult(
  input: WorkflowTaskInput,
  position: CheckpointPosition,
  stepResult: WorkflowStepResult,
  pipeInput: string,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const next = checkpointForNextStep(input, position, stepResult, pipeInput);
  if (next.stepIndex >= input.workflow.steps.length) {
    const result: WorkflowTaskResult = {
      status: "completed",
      output: pipeInput,
      completedSteps: next.results.filter((item) => item.status !== "nothing-to-do").length,
      steps: next.results,
    };
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
    return;
  }
  await runtime.commit(() => ({ status: "running", checkpoint: next }), context);
}

async function finishNothingToDo(
  input: WorkflowTaskInput,
  checkpoint: CheckpointPosition,
  step: WorkflowStep,
  result: WorkflowAttemptResult,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const steps = [...checkpoint.results, {
    step: stepId(step),
    status: "nothing-to-do" as const,
    output: result.output,
    attempts: checkpoint.attemptHistory,
  }];
  const completedSteps = steps.filter((item) => item.status !== "nothing-to-do").length;
  const workflowResult: WorkflowTaskResult = {
    status: "nothing-to-do",
    output: result.output,
    completedSteps,
    steps,
  };
  void input;
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: workflowResult } }), context);
}

async function finishFailed(
  step: WorkflowStep,
  failure: WorkflowDecisionRequest,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const error = { message: `${stepId(step)} failed: ${failure.lastError}` };
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error } }), context);
}


function failureFor(input: WorkflowTaskInput, checkpoint: CheckpointPosition, step: WorkflowStep, lastError: string, lastOutput: string): WorkflowDecisionRequest {
  return {
    workflow: input.workflowName,
    runId: input.runId,
    step: stepId(step),
    stepKind: step.kind,
    retryProfiles: computeRetryProfiles(step, input.profileCommands),
    lastError,
    lastOutput,
    attemptHistory: checkpoint.attemptHistory,
    decisionNumber: checkpoint.decisionNumber + 1,
  };
}

async function blockRun(
  checkpoint: CheckpointPosition,
  failure: WorkflowDecisionRequest,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
  roundStatus: "pending" | "settled",
): Promise<void> {
  const blocked: BlockedCheckpoint = {
    phase: "blocked",
    stepIndex: checkpoint.stepIndex,
    pipeInput: checkpoint.pipeInput,
    results: checkpoint.results,
    attemptHistory: failure.attemptHistory,
    localRetriesLeft: checkpoint.localRetriesLeft,
    ...(checkpoint.profile === undefined ? {} : { profile: checkpoint.profile }),
    feedback: checkpoint.feedback,
    decisionNumber: failure.decisionNumber,
    automaticRoundUsed: true,
    failure,
    roundStatus,
  };
  await runtime.commit(() => ({ status: "running", checkpoint: blocked }), context);
}

async function applyDecision(
  input: WorkflowTaskInput,
  checkpoint: DecisionCheckpoint,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const step = input.workflow.steps[checkpoint.stepIndex];
  if (!step) throw new Error(`Workflow step ${checkpoint.failure.step} is missing from the workflow`);
  const applied = applyWorkflowDecision({
    decision: checkpoint.decision,
    step,
    currentProfile: checkpoint.profile ?? checkpoint.attemptHistory.at(-1)?.profile ?? step.profile,
    profileCommands: input.profileCommands,
    lastError: checkpoint.failure.lastError,
  });
  if (applied.action === "fail") {
    await finishFailed(step, checkpoint.failure, runtime, context);
    return;
  }
  if (applied.action === "retry") {
    const nextCheckpoint: StepCheckpoint = {
      phase: "step",
      stepIndex: checkpoint.stepIndex,
      pipeInput: checkpoint.pipeInput,
      results: checkpoint.results,
      attemptHistory: checkpoint.failure.attemptHistory,
      localRetriesLeft: retryLimit(step, input.workflow),
      ...(applied.profile === undefined ? {} : { profile: applied.profile }),
      feedback: applied.feedback,
      decisionNumber: checkpoint.decisionNumber,
      automaticRoundUsed: checkpoint.automaticRoundUsed || checkpoint.decisionSource === "round",
    };
    if (applied.after !== undefined) {
      const waitUntil = runtime.now() + durationMilliseconds(applied.after);
      await runtime.sleepUntil(waitUntil, { ...nextCheckpoint, waitUntil }, context);
    } else {
      await runtime.commit(() => ({ status: "running", checkpoint: nextCheckpoint }), context);
    }
    return;
  }
  const stepResult = resultForDecision(checkpoint.failure, applied.action);
  const nextPipe = applied.action === "accept" ? checkpoint.failure.lastOutput : checkpoint.pipeInput;
  await commitStepResult(input, checkpoint, stepResult, nextPipe, runtime, context);
}


function roundFailureNote(settled: { status: string; reason?: string }): string {
  return settled.status === "unanswered"
    ? `Automatic failure round gave up: ${settled.reason ?? "the submission was unanswered"}`
    : "Automatic failure round returned without a decision; the run remains blocked.";
}

async function submitFailureRound(
  input: WorkflowTaskInput,
  checkpoint: BlockedCheckpoint,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const step = input.workflow.steps[checkpoint.stepIndex];
  if (!step) throw new Error(`Workflow step ${checkpoint.failure.step} is missing from the workflow`);
  const loaded = loadWorkflowStep(join(input.projectRoot, "workflows"), input.workflow, step);
  const brief = buildOrchestratorBrief({
    workflow: input.workflow,
    step,
    stepId: checkpoint.failure.step,
    runId: input.runId,
    decisionNumber: checkpoint.failure.decisionNumber,
    stepContent: loaded.contents[step.file] ?? loaded.documents[step.file] ?? "",
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
    return { status: "running", checkpoint: { ...checkpoint, roundStatus: "settled" } };
  }, context);
}

async function waitForDecision(
  input: WorkflowTaskInput,
  checkpoint: BlockedCheckpoint,
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
    const acceptedDecisionNumber = accepted.decisionNumber ?? checkpoint.decisionNumber;
    await runtime.commit(async (tx) => {
      const document = await tx.doc(workflowDecisionDocument, runtime.taskId);
      const current = document.choice;
      if (current === null || current.requestId !== accepted.requestId || acceptedDecisionNumber !== checkpoint.decisionNumber || (current.decisionNumber !== undefined && current.decisionNumber !== checkpoint.decisionNumber)) {
        throw new Error("Decision changed or became stale before the workflow task accepted it");
      }
      if (accepted.decision.action === "accept" && checkpoint.failure.lastOutput.trim().length === 0) {
        throw new Error("Cannot accept a blocked step with empty output");
      }
      document.choice = null;
      const decisionCheckpoint: DecisionCheckpoint = {
        phase: "decision",
        stepIndex: checkpoint.stepIndex,
        pipeInput: checkpoint.pipeInput,
        results: checkpoint.results,
        attemptHistory: checkpoint.attemptHistory,
        localRetriesLeft: checkpoint.localRetriesLeft,
        ...(checkpoint.profile === undefined ? {} : { profile: checkpoint.profile }),
        feedback: checkpoint.feedback,
        decisionNumber: checkpoint.decisionNumber,
        automaticRoundUsed: checkpoint.automaticRoundUsed,
        failure: checkpoint.failure,
        decision: accepted.decision,
        decisionSource: accepted.source ?? "chat",
      };
      return { status: "running", checkpoint: decisionCheckpoint };
    }, context);
  } finally {
    await watch.stop();
  }
}

async function blockAfterFailure(
  input: WorkflowTaskInput,
  checkpoint: AttemptCheckpoint,
  step: WorkflowStep,
  result: Extract<WorkflowAttemptResult, { kind: "failed" }>,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const failure = failureFor(input, checkpoint, step, result.reason, result.output);
  await blockRun(checkpoint, failure, runtime, context, checkpoint.automaticRoundUsed ? "settled" : "pending");
}

async function startStepAttempt(
  input: WorkflowTaskInput,
  checkpoint: StepCheckpoint,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  if (checkpoint.waitUntil !== undefined && runtime.now() < checkpoint.waitUntil) {
    await runtime.sleepUntil(checkpoint.waitUntil, checkpoint, context);
    return;
  }
  const step = input.workflow.steps[checkpoint.stepIndex];
  if (!step) {
    const result: WorkflowTaskResult = {
      status: "completed",
      output: checkpoint.pipeInput,
      completedSteps: checkpoint.results.filter((item) => item.status !== "nothing-to-do").length,
      steps: checkpoint.results,
    };
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
    return;
  }
  const loaded = loadWorkflowStep(join(input.projectRoot, "workflows"), input.workflow, step);
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
    documents: loaded.documents,
    files: loaded.files,
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
    const nextCheckpoint: AttemptCheckpoint = {
      ...checkpoint,
      phase: "attempt",
      activeAttempt: { taskId, request },
    };
    return { status: "running", checkpoint: nextCheckpoint };
  }, context);
}

async function receiveStepAttempt(
  input: WorkflowTaskInput,
  checkpoint: AttemptCheckpoint,
  runtime: WorkflowTaskRuntime,
  context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
  const settled = await runtime.waitForTask(checkpoint.activeAttempt.taskId, context);
  const outcome = settled.state.outcome;
  const attemptResult: WorkflowAttemptResult = outcome.status === "completed"
    ? outcome.result
    : {
      kind: "failed",
      output: "",
      reason: outcome.status === "aborted"
        ? outcome.reason ?? "Step attempt was aborted"
        : outcome.status === "failed"
          ? outcome.error?.message ?? "Step attempt failed"
          : "Step attempt ended without a result",
    };
  const history = [...checkpoint.attemptHistory, attemptRecord(checkpoint.activeAttempt.request, attemptResult)];
  const position: AttemptCheckpoint = { ...checkpoint, attemptHistory: history };
  const step = checkpoint.activeAttempt.request.step;

  if (attemptResult.kind === "nothing-to-do") {
    await finishNothingToDo(input, position, step, attemptResult, runtime, context);
    return;
  }
  if (attemptResult.kind === "accepted") {
    const stepResult: WorkflowStepResult = { step: stepId(step), status: "completed", output: attemptResult.output, attempts: history };
    await commitStepResult(input, position, stepResult, attemptResult.output, runtime, context);
    return;
  }
  if (checkpoint.localRetriesLeft > 0) {
    const nextCheckpoint: StepCheckpoint = {
      phase: "step",
      stepIndex: checkpoint.stepIndex,
      pipeInput: checkpoint.pipeInput,
      results: checkpoint.results,
      attemptHistory: history,
      localRetriesLeft: checkpoint.localRetriesLeft - 1,
      ...(checkpoint.activeAttempt.request.profile === undefined ? {} : { profile: checkpoint.activeAttempt.request.profile }),
      feedback: attemptResult.reason,
      decisionNumber: checkpoint.decisionNumber,
      automaticRoundUsed: checkpoint.automaticRoundUsed,
    };
    await runtime.commit(() => ({ status: "running", checkpoint: nextCheckpoint }), context);
    return;
  }
  await blockAfterFailure(input, position, step, attemptResult, runtime, context);
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
    step: async (task, runtime, context) => startStepAttempt(task.input, task.state.checkpoint, runtime, context),
    attempt: async (task, runtime, context) => receiveStepAttempt(task.input, task.state.checkpoint, runtime, context),
    blocked: async (task, runtime, context) => waitForDecision(task.input, task.state.checkpoint, runtime, context),
    decision: async (task, runtime, context) => applyDecision(task.input, task.state.checkpoint, runtime, context),
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), context);
  },
});
