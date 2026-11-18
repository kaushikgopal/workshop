import { applyWorkflowDecision } from "./apply-workflow-decision.ts";
import { computeRetryProfiles } from "./compute-retry-profiles.ts";
import { parseWorkflowDuration } from "./parse-workflow-duration.ts";
import type { WorkflowAttemptRequest, WorkflowAttemptResult } from "./execute-workflow-attempt.ts";
import type { AttemptHistoryEntry, Workflow, WorkflowDecision, WorkflowDecisionRequest, WorkflowStep, WorkflowStepResult } from "./types.ts";

export type ActiveWorkflowAttempt = {
  taskId: number;
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
};

export type StepCheckpoint = CheckpointPosition & { phase: "step"; waitUntil?: number };
export type AttemptCheckpoint = CheckpointPosition & { phase: "attempt"; activeAttempt: ActiveWorkflowAttempt; waitUntil?: number };
export type BlockedCheckpoint = CheckpointPosition & { phase: "blocked"; failure: WorkflowDecisionRequest; roundStatus?: "pending" | "settled" };
export type DecisionCheckpoint = CheckpointPosition & { phase: "decision"; failure: WorkflowDecisionRequest; decision: WorkflowDecision; decisionSource?: "chat" | "round" };
export type WorkflowTaskCheckpoint = StepCheckpoint | AttemptCheckpoint | BlockedCheckpoint | DecisionCheckpoint;

export type WorkflowTaskResult = {
  status: "completed" | "nothing-to-do";
  output: string;
  completedSteps: number;
  steps: WorkflowStepResult[];
};

export type WorkflowExecutionState = WorkflowTaskCheckpoint | {
  phase: "finished";
  outcome:
    | { status: "completed"; result: WorkflowTaskResult }
    | { status: "failed"; error: { message: string } };
};

export type WorkflowStateContext = {
  workflow: Workflow;
  workflowName: string;
  runId: string;
  profileCommands: Readonly<Record<string, readonly string[]>>;
};

export type WorkflowStateEvent =
  | { kind: "attempt-started"; activeAttempt: ActiveWorkflowAttempt }
  | { kind: "attempt-settled"; attempt: number; result: WorkflowAttemptResult }
  | { kind: "decision-recorded"; decisionNumber: number; decision: WorkflowDecision; source: "chat" | "round" }
  | { kind: "decision-applied"; decisionNumber: number; now: number }
  | { kind: "round-settled" };

export type WorkflowStateRejectionCode = "out-of-order" | "stale-attempt" | "stale-decision" | "invalid-event";

export type WorkflowStateTransition =
  | { kind: "accepted"; state: WorkflowExecutionState }
  | { kind: "rejected"; code: WorkflowStateRejectionCode; message: string };

export class WorkflowCheckpointIntegrityError extends Error {
  constructor(field: string, reason: string) {
    super(`Workflow checkpoint integrity error at ${field}: ${reason}`);
    this.name = "WorkflowCheckpointIntegrityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integrity(field: string, reason: string): never {
  throw new WorkflowCheckpointIntegrityError(field, reason);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) return integrity(field, "must be an object");
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") return integrity(field, "must be a string");
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return integrity(field, `must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => key in right && sameJsonValue(left[key], right[key]));
  }
  return false;
}

function stepId(step: WorkflowStep): string {
  return `${step.number}-${step.name}`;
}

export function retryLimit(step: WorkflowStep, workflow: Workflow): number {
  return step.retries ?? step.check?.retries ?? workflow.retries ?? 0;
}

function sameHistory(left: readonly AttemptHistoryEntry[], right: readonly AttemptHistoryEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.attempt === other.attempt
      && entry.output === other.output
      && entry.profile === other.profile
      && entry.error === other.error;
  });
}

function decodeHistory(value: unknown, field: string): AttemptHistoryEntry[] {
  if (!Array.isArray(value)) return integrity(field, "must be an array");
  const history: AttemptHistoryEntry[] = [];
  for (const [index, rawEntry] of value.entries()) {
    const path = `${field}[${index}]`;
    const entry = record(rawEntry, path);
    const attempt = integer(entry.attempt, `${path}.attempt`, 1);
    if (attempt !== index + 1) return integrity(`${path}.attempt`, "must match its position in attempt history");
    const output = string(entry.output, `${path}.output`);
    const profile = entry.profile === undefined ? undefined : string(entry.profile, `${path}.profile`);
    const error = entry.error === undefined ? undefined : string(entry.error, `${path}.error`);
    history.push({ attempt, output, ...(profile === undefined ? {} : { profile }), ...(error === undefined ? {} : { error }) });
  }
  return history;
}

function decodeResults(value: unknown, workflow: Workflow, stepIndex: number): WorkflowStepResult[] {
  if (!Array.isArray(value)) return integrity("checkpoint.results", "must be an array");
  if (value.length !== stepIndex) return integrity("checkpoint.results", "must contain exactly the completed steps before stepIndex");
  const results: WorkflowStepResult[] = [];
  for (const [index, rawResult] of value.entries()) {
    const field = `checkpoint.results[${index}]`;
    const result = record(rawResult, field);
    const step = workflow.steps[index];
    if (!step) return integrity(field, "has no matching workflow step");
    const id = string(result.step, `${field}.step`);
    if (id !== stepId(step)) return integrity(`${field}.step`, "does not match the workflow step at this position");
    if (result.status !== "completed" && result.status !== "skipped") return integrity(`${field}.status`, "must be completed or skipped in an active checkpoint");
    const output = string(result.output, `${field}.output`);
    const attempts = decodeHistory(result.attempts, `${field}.attempts`);
    results.push({ step: id, status: result.status, output, attempts });
  }
  return results;
}

function decodeDecision(value: unknown, field: string): WorkflowDecision {
  const decision = record(value, field);
  switch (decision.action) {
    case "retry":
      return {
        action: "retry",
        ...(decision.hint === undefined ? {} : { hint: string(decision.hint, `${field}.hint`) }),
        ...(decision.profile === undefined ? {} : { profile: string(decision.profile, `${field}.profile`) }),
        ...(decision.after === undefined ? {} : { after: string(decision.after, `${field}.after`) }),
      };
    case "skip":
    case "accept":
    case "fail":
      return { action: decision.action };
    default:
      return integrity(`${field}.action`, "is not a workflow decision");
  }
}

function decodeFailure(value: unknown, context: WorkflowStateContext, position: CheckpointPosition): WorkflowDecisionRequest {
  const failure = record(value, "checkpoint.failure");
  const step = context.workflow.steps[position.stepIndex];
  if (!step) return integrity("checkpoint.stepIndex", "does not identify a workflow step");
  const workflow = string(failure.workflow, "checkpoint.failure.workflow");
  const runId = string(failure.runId, "checkpoint.failure.runId");
  const failureStep = string(failure.step, "checkpoint.failure.step");
  const stepKind = failure.stepKind;
  if (stepKind !== "agent" && stepKind !== "command") return integrity("checkpoint.failure.stepKind", "must be agent or command");
  if (workflow !== context.workflowName) return integrity("checkpoint.failure.workflow", "does not match the task input");
  if (runId !== context.runId) return integrity("checkpoint.failure.runId", "does not match the task input");
  if (failureStep !== stepId(step)) return integrity("checkpoint.failure.step", "does not match stepIndex");
  if (stepKind !== step.kind) return integrity("checkpoint.failure.stepKind", "does not match the workflow step");
  const retryProfilesRaw = failure.retryProfiles;
  if (!Array.isArray(retryProfilesRaw)) return integrity("checkpoint.failure.retryProfiles", "must be an array");
  const retryProfiles = retryProfilesRaw.map((profile, index) => string(profile, `checkpoint.failure.retryProfiles[${index}]`));
  const expectedProfiles = computeRetryProfiles(step, context.profileCommands);
  if (retryProfiles.length !== expectedProfiles.length || retryProfiles.some((profile, index) => profile !== expectedProfiles[index])) {
    return integrity("checkpoint.failure.retryProfiles", "does not match the workflow's allowed retry profiles");
  }
  const attemptHistory = decodeHistory(failure.attemptHistory, "checkpoint.failure.attemptHistory");
  if (!sameHistory(attemptHistory, position.attemptHistory)) return integrity("checkpoint.failure.attemptHistory", "does not match checkpoint.attemptHistory");
  if (attemptHistory.length === 0) return integrity("checkpoint.failure.attemptHistory", "must include the failed attempt");
  const lastAttempt = attemptHistory.at(-1);
  if (!lastAttempt) return integrity("checkpoint.failure.attemptHistory", "must include the failed attempt");
  const lastError = string(failure.lastError, "checkpoint.failure.lastError");
  const lastOutput = string(failure.lastOutput, "checkpoint.failure.lastOutput");
  if (lastAttempt.error !== lastError) return integrity("checkpoint.failure.lastError", "does not match the last attempt");
  if (lastAttempt.output !== lastOutput) return integrity("checkpoint.failure.lastOutput", "does not match the last attempt");
  const decisionNumber = integer(failure.decisionNumber, "checkpoint.failure.decisionNumber", 1);
  if (decisionNumber !== position.decisionNumber) return integrity("checkpoint.failure.decisionNumber", "does not match checkpoint.decisionNumber");
  return { workflow, runId, step: failureStep, stepKind, retryProfiles, lastError, lastOutput, attemptHistory, decisionNumber };
}

function sameStep(left: WorkflowStep, right: WorkflowStep): boolean {
  return left.kind === right.kind && left.file === right.file && left.number === right.number && left.name === right.name;
}

export function decodeWorkflowTaskCheckpoint(value: unknown, context: WorkflowStateContext): WorkflowTaskCheckpoint {
  const raw = record(value, "checkpoint");
  const workflow = context.workflow;
  if (workflow.steps.length === 0) return integrity("input.workflow.steps", "must not be empty");
  const stepIndex = integer(raw.stepIndex, "checkpoint.stepIndex", 0, workflow.steps.length - 1);
  const results = decodeResults(raw.results, workflow, stepIndex);
  const step = workflow.steps[stepIndex];
  if (!step) return integrity("checkpoint.stepIndex", "does not identify a workflow step");
  const attemptHistory = decodeHistory(raw.attemptHistory, "checkpoint.attemptHistory");
  const localRetriesLeft = integer(raw.localRetriesLeft, "checkpoint.localRetriesLeft", 0, retryLimit(step, workflow));
  const profile = raw.profile === undefined ? undefined : string(raw.profile, "checkpoint.profile");
  const position: CheckpointPosition = {
    stepIndex,
    pipeInput: string(raw.pipeInput, "checkpoint.pipeInput"),
    results,
    attemptHistory,
    localRetriesLeft,
    ...(profile === undefined ? {} : { profile }),
    feedback: string(raw.feedback, "checkpoint.feedback"),
    decisionNumber: integer(raw.decisionNumber, "checkpoint.decisionNumber", 0),
    automaticRoundUsed: typeof raw.automaticRoundUsed === "boolean"
      ? raw.automaticRoundUsed
      : integrity("checkpoint.automaticRoundUsed", "must be a boolean"),
  };
  const phase = raw.phase;
  const waitUntil = raw.waitUntil === undefined ? undefined : integer(raw.waitUntil, "checkpoint.waitUntil", 0);
  if (phase === "step") return { ...position, phase, ...(waitUntil === undefined ? {} : { waitUntil }) };
  if (phase === "attempt") {
    const active = record(raw.activeAttempt, "checkpoint.activeAttempt");
    const taskIdValue = integer(active.taskId, "checkpoint.activeAttempt.taskId", 1);
    const taskId = taskIdValue;
    const request = record(active.request, "checkpoint.activeAttempt.request");
    const requestStep = record(request.step, "checkpoint.activeAttempt.request.step");
    const requestStepKind = requestStep.kind;
    if (requestStepKind !== "agent" && requestStepKind !== "command") return integrity("checkpoint.activeAttempt.request.step.kind", "must be agent or command");
    const requestStepFile = string(requestStep.file, "checkpoint.activeAttempt.request.step.file");
    const requestStepNumber = integer(requestStep.number, "checkpoint.activeAttempt.request.step.number", 0);
    const requestStepName = string(requestStep.name, "checkpoint.activeAttempt.request.step.name");
    const requestAttempt = integer(request.attempt, "checkpoint.activeAttempt.request.attempt", 1);
    if (requestAttempt !== attemptHistory.length + 1) return integrity("checkpoint.activeAttempt.request.attempt", "must follow the saved attempt history");
    if (requestStepKind !== step.kind || requestStepFile !== step.file || requestStepNumber !== step.number || requestStepName !== step.name) {
      return integrity("checkpoint.activeAttempt.request.step", "does not match stepIndex");
    }
    if (!sameJsonValue(requestStep, step)) return integrity("checkpoint.activeAttempt.request.step", "does not match the saved workflow step");
    const requestProfile = request.profile === undefined ? undefined : string(request.profile, "checkpoint.activeAttempt.request.profile");
    if (requestProfile !== profile) return integrity("checkpoint.activeAttempt.request.profile", "does not match checkpoint.profile");
    const requestPipeInput = string(request.pipeInput, "checkpoint.activeAttempt.request.pipeInput");
    const requestFeedback = string(request.feedback, "checkpoint.activeAttempt.request.feedback");
    if (requestPipeInput !== position.pipeInput) return integrity("checkpoint.activeAttempt.request.pipeInput", "does not match checkpoint.pipeInput");
    if (requestFeedback !== position.feedback) return integrity("checkpoint.activeAttempt.request.feedback", "does not match checkpoint.feedback");
    return {
      ...position,
      phase,
      ...(waitUntil === undefined ? {} : { waitUntil }),
      activeAttempt: {
        taskId,
        request: {
          step,
          ...(requestProfile === undefined ? {} : { profile: requestProfile }),
          pipeInput: requestPipeInput,
          feedback: requestFeedback,
          attempt: requestAttempt,
        },
      },
    };
  }
  if (phase === "blocked" || phase === "decision") {
    if (waitUntil !== undefined) return integrity("checkpoint.waitUntil", "is valid only in step or attempt checkpoints");
    if (position.localRetriesLeft !== 0) return integrity("checkpoint.localRetriesLeft", "must be zero while blocked or applying a decision");
    if (!position.automaticRoundUsed) return integrity("checkpoint.automaticRoundUsed", "must be true while blocked or applying a decision");
    const failure = decodeFailure(raw.failure, context, position);
    if (phase === "blocked") {
      const roundStatus = raw.roundStatus === undefined
        ? undefined
        : raw.roundStatus === "pending" || raw.roundStatus === "settled"
          ? raw.roundStatus
          : integrity("checkpoint.roundStatus", "must be pending or settled");
      return { ...position, phase, failure, ...(roundStatus === undefined ? {} : { roundStatus }) };
    }
    const decision = decodeDecision(raw.decision, "checkpoint.decision");
    if (decision.action === "accept" && failure.lastOutput.trim().length === 0) return integrity("checkpoint.decision", "cannot accept empty output");
    const decisionSource = raw.decisionSource === undefined
      ? undefined
      : raw.decisionSource === "chat" || raw.decisionSource === "round"
        ? raw.decisionSource
        : integrity("checkpoint.decisionSource", "must be chat or round");
    return { ...position, phase, failure, decision, ...(decisionSource === undefined ? {} : { decisionSource }) };
  }
  return integrity("checkpoint.phase", "must be step, attempt, blocked, or decision");
}

function attemptRecord(request: WorkflowAttemptRequest, result: WorkflowAttemptResult): AttemptHistoryEntry {
  return {
    attempt: request.attempt,
    ...(request.step.kind === "agent" && request.profile !== undefined ? { profile: request.profile } : {}),
    output: result.output,
    ...(result.kind === "failed" ? { error: result.reason } : {}),
  };
}

function completedCount(results: readonly WorkflowStepResult[]): number {
  return results.filter((result) => result.status !== "nothing-to-do").length;
}

function advanceStep(
  context: WorkflowStateContext,
  position: CheckpointPosition,
  result: WorkflowStepResult,
  pipeInput: string,
): WorkflowExecutionState {
  const stepIndex = position.stepIndex + 1;
  const results = [...position.results, result];
  if (stepIndex >= context.workflow.steps.length) {
    return {
      phase: "finished",
      outcome: {
        status: "completed",
        result: { status: "completed", output: pipeInput, completedSteps: completedCount(results), steps: results },
      },
    };
  }
  const nextStep = context.workflow.steps[stepIndex];
  if (!nextStep) return { phase: "finished", outcome: { status: "failed", error: { message: `Workflow checkpoint integrity error at stepIndex: ${stepIndex} has no matching step` } } };
  return {
    phase: "step",
    stepIndex,
    pipeInput,
    results,
    attemptHistory: [],
    localRetriesLeft: retryLimit(nextStep, context.workflow),
    ...(nextStep.profile === undefined ? {} : { profile: nextStep.profile }),
    feedback: "",
    decisionNumber: position.decisionNumber,
    automaticRoundUsed: false,
  };
}

function retryDelay(value: string): number {
  const duration = parseWorkflowDuration(value);
  if (duration.kind === "invalid") throw new Error(`Invalid retry delay: ${value}`);
  if (duration.kind === "too-large") throw new Error(`Retry delay is too large: ${value}`);
  return duration.milliseconds;
}

function accepted(state: WorkflowExecutionState): WorkflowStateTransition {
  return { kind: "accepted", state };
}

function rejected(code: WorkflowStateRejectionCode, message: string): WorkflowStateTransition {
  return { kind: "rejected", code, message };
}

export function advanceWorkflowState(
  state: WorkflowExecutionState,
  event: WorkflowStateEvent,
  context: WorkflowStateContext,
): WorkflowStateTransition {
  if (state.phase === "finished") return rejected("out-of-order", "Workflow execution is already finished");
  switch (event.kind) {
    case "attempt-started": {
      if (state.phase !== "step") return rejected("out-of-order", `Cannot start an attempt while workflow phase is ${state.phase}`);
      const currentStep = context.workflow.steps[state.stepIndex];
      if (!currentStep || !sameStep(event.activeAttempt.request.step, currentStep)) return rejected("invalid-event", "Attempt step does not match the current workflow step");
      if (event.activeAttempt.request.attempt !== state.attemptHistory.length + 1) return rejected("stale-attempt", "Attempt number does not follow the current history");
      if (event.activeAttempt.request.pipeInput !== state.pipeInput || event.activeAttempt.request.feedback !== state.feedback || event.activeAttempt.request.profile !== state.profile) {
        return rejected("invalid-event", "Attempt request does not match the current step checkpoint");
      }
      return accepted({ ...state, phase: "attempt", activeAttempt: event.activeAttempt });
    }
    case "attempt-settled": {
      if (state.phase !== "attempt") return rejected("out-of-order", `Cannot settle an attempt while workflow phase is ${state.phase}`);
      if (event.attempt !== state.activeAttempt.request.attempt) return rejected("stale-attempt", "Attempt result does not match the active attempt");
      const step = context.workflow.steps[state.stepIndex];
      if (!step) return rejected("invalid-event", "Current workflow step is missing");
      const history = [...state.attemptHistory, attemptRecord(state.activeAttempt.request, event.result)];
      const position: CheckpointPosition = { ...state, attemptHistory: history };
      if (event.result.kind === "nothing-to-do") {
        const steps = [...state.results, { step: stepId(step), status: "nothing-to-do" as const, output: event.result.output, attempts: history }];
        return accepted({
          phase: "finished",
          outcome: { status: "completed", result: { status: "nothing-to-do", output: event.result.output, completedSteps: completedCount(steps), steps } },
        });
      }
      if (event.result.kind === "accepted") {
        return accepted(advanceStep(context, position, { step: stepId(step), status: "completed", output: event.result.output, attempts: history }, event.result.output));
      }
      if (state.localRetriesLeft > 0) {
        return accepted({
          phase: "step",
          stepIndex: state.stepIndex,
          pipeInput: state.pipeInput,
          results: state.results,
          attemptHistory: history,
          localRetriesLeft: state.localRetriesLeft - 1,
          ...(state.activeAttempt.request.profile === undefined ? {} : { profile: state.activeAttempt.request.profile }),
          feedback: event.result.reason,
          decisionNumber: state.decisionNumber,
          automaticRoundUsed: state.automaticRoundUsed,
        });
      }
      if (state.decisionNumber === Number.MAX_SAFE_INTEGER) return rejected("invalid-event", "Decision number exceeds the safe integer range");
      const failure: WorkflowDecisionRequest = {
        workflow: context.workflowName,
        runId: context.runId,
        step: stepId(step),
        stepKind: step.kind,
        retryProfiles: computeRetryProfiles(step, context.profileCommands),
        lastError: event.result.reason,
        lastOutput: event.result.output,
        attemptHistory: history,
        decisionNumber: state.decisionNumber + 1,
      };
      return accepted({
        phase: "blocked",
        stepIndex: state.stepIndex,
        pipeInput: state.pipeInput,
        results: state.results,
        attemptHistory: history,
        localRetriesLeft: state.localRetriesLeft,
        ...(state.profile === undefined ? {} : { profile: state.profile }),
        feedback: state.feedback,
        decisionNumber: failure.decisionNumber,
        automaticRoundUsed: true,
        failure,
        roundStatus: state.automaticRoundUsed ? "settled" : "pending",
      });
    }
    case "decision-recorded": {
      if (state.phase !== "blocked") return rejected("out-of-order", `Cannot record a decision while workflow phase is ${state.phase}`);
      if (event.decisionNumber !== state.decisionNumber) return rejected("stale-decision", "Decision number does not match the blocked occurrence");
      if (event.decision.action === "accept" && state.failure.lastOutput.trim().length === 0) return rejected("invalid-event", "Cannot accept a blocked step with empty output");
      return accepted({
        phase: "decision",
        stepIndex: state.stepIndex,
        pipeInput: state.pipeInput,
        results: state.results,
        attemptHistory: state.attemptHistory,
        localRetriesLeft: state.localRetriesLeft,
        ...(state.profile === undefined ? {} : { profile: state.profile }),
        feedback: state.feedback,
        decisionNumber: state.decisionNumber,
        automaticRoundUsed: state.automaticRoundUsed,
        failure: state.failure,
        decision: event.decision,
        decisionSource: event.source,
      });
    }
    case "decision-applied": {
      if (state.phase !== "decision") return rejected("out-of-order", `Cannot apply a decision while workflow phase is ${state.phase}`);
      if (event.decisionNumber !== state.decisionNumber) return rejected("stale-decision", "Decision number does not match the applying occurrence");
      const step = context.workflow.steps[state.stepIndex];
      if (!step) return rejected("invalid-event", "Current workflow step is missing");
      let applied;
      try {
        applied = applyWorkflowDecision({
          decision: state.decision,
          step,
          currentProfile: state.profile ?? state.attemptHistory.at(-1)?.profile ?? step.profile,
          profileCommands: context.profileCommands,
          lastError: state.failure.lastError,
        });
      } catch (error) {
        return rejected("invalid-event", error instanceof Error ? error.message : String(error));
      }
      if (applied.action === "fail") {
        return accepted({ phase: "finished", outcome: { status: "failed", error: { message: `${stepId(step)} failed: ${state.failure.lastError}` } } });
      }
      if (applied.action === "retry") {
        let waitUntil: number | undefined;
        if (applied.after !== undefined) {
          if (!Number.isSafeInteger(event.now) || event.now < 0) return rejected("invalid-event", "Current time is outside the safe integer range");
          try {
            waitUntil = event.now + retryDelay(applied.after);
            if (!Number.isSafeInteger(waitUntil)) return rejected("invalid-event", "Retry deadline is outside the safe integer range");
          } catch (error) {
            return rejected("invalid-event", error instanceof Error ? error.message : String(error));
          }
        }
        return accepted({
          phase: "step",
          stepIndex: state.stepIndex,
          pipeInput: state.pipeInput,
          results: state.results,
          attemptHistory: state.failure.attemptHistory,
          localRetriesLeft: retryLimit(step, context.workflow),
          ...(applied.profile === undefined ? {} : { profile: applied.profile }),
          feedback: applied.feedback,
          decisionNumber: state.decisionNumber,
          automaticRoundUsed: state.automaticRoundUsed || state.decisionSource === "round",
          ...(waitUntil === undefined ? {} : { waitUntil }),
        });
      }
      const stepResult: WorkflowStepResult = applied.action === "accept"
        ? { step: state.failure.step, status: "completed", output: state.failure.lastOutput, attempts: state.failure.attemptHistory }
        : { step: state.failure.step, status: "skipped", output: "", attempts: state.failure.attemptHistory };
      const nextPipe = applied.action === "accept" ? state.failure.lastOutput : state.pipeInput;
      return accepted(advanceStep(context, state, stepResult, nextPipe));
    }
    case "round-settled":
      if (state.phase !== "blocked" || state.roundStatus !== "pending") return rejected("out-of-order", "There is no pending failure round to settle");
      return accepted({ ...state, roundStatus: "settled" });
  }
}
