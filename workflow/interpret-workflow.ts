import type { AttemptHistoryEntry, Workflow, WorkflowStep } from "./types.ts";

export type ProcessExecutionKind = "command" | "agent" | "command-check" | "agent-check";

export type ProcessExecutionRequest = {
  kind: ProcessExecutionKind;
  command: readonly string[];
  input: string;
  step: string;
  feedback: string;
  timeoutMs?: number;
  attempt: number;
  profile?: string;
};

export type ProcessExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: string | null;
  error?: string;
};

export type WorkflowDecisionRequest = {
  workflow: string;
  runId: string;
  step: string;
  stepKind: WorkflowStep["kind"];
  retryProfiles: string[];
  lastError: string;
  lastOutput: string;
  attemptHistory: AttemptHistoryEntry[];
  decisionNumber: number;
};

export type WorkflowAttemptRequest = {
  step: WorkflowStep;
  profile?: string;
  pipeInput: string;
  feedback: string;
  attempt: number;
};

export type WorkflowAttemptResult =
  | { kind: "accepted"; output: string }
  | { kind: "failed"; output: string; reason: string }
  | { kind: "nothing-to-do"; output: string };
export type WorkflowAttemptState =
  | { kind: "worker" }
  | { kind: "checking"; output: string }
  | { kind: "accepted"; output: string }
  | { kind: "rejected"; output: string; feedback: string }
  | { kind: "failed"; output: string; reason: string }
  | { kind: "nothing-to-do"; output: string }
  | { kind: "cancelled"; output: string; reason: string };

export type WorkflowAttemptEvent =
  | { kind: "worker-succeeded"; output: string; hasCheck: boolean }
  | { kind: "worker-failed"; output: string; reason: string }
  | { kind: "worker-nothing-to-do"; output: string }
  | { kind: "check-accepted" }
  | { kind: "check-rejected"; feedback: string }
  | { kind: "cancelled"; output: string; reason: string };

export type WorkflowAttemptEffect = { kind: "check"; output: string };

export type WorkflowAttemptTransition =
  | { kind: "accepted"; state: WorkflowAttemptState; effects: WorkflowAttemptEffect[] }
  | { kind: "rejected"; code: "out-of-order" | "already-terminal"; message: string };

function acceptAttemptState(
  state: WorkflowAttemptState,
  effects: WorkflowAttemptEffect[] = [],
 ): WorkflowAttemptTransition {
  return { kind: "accepted", state, effects };
}

function rejectAttemptEvent(state: WorkflowAttemptState, event: WorkflowAttemptEvent): WorkflowAttemptTransition {
  if (state.kind === "accepted" || state.kind === "rejected" || state.kind === "failed" || state.kind === "nothing-to-do" || state.kind === "cancelled") {
    return { kind: "rejected", code: "already-terminal", message: `Attempt is already ${state.kind}` };
  }
  return {
    kind: "rejected",
    code: "out-of-order",
    message: event.kind === "check-accepted"
      ? `Cannot accept a check while attempt phase is ${state.kind}`
      : event.kind === "check-rejected"
        ? `Cannot reject a check while attempt phase is ${state.kind}`
        : `Cannot complete ${event.kind.startsWith("worker-") ? "the worker" : "the attempt"} while attempt phase is ${state.kind}`,
  };
}

export function transitionWorkflowAttempt(
  state: WorkflowAttemptState,
  event: WorkflowAttemptEvent,
 ): WorkflowAttemptTransition {
  if (state.kind === "worker") {
    if (event.kind === "worker-succeeded") {
      return event.hasCheck
        ? acceptAttemptState({ kind: "checking", output: event.output }, [{ kind: "check", output: event.output }])
        : acceptAttemptState({ kind: "accepted", output: event.output });
    }
    if (event.kind === "worker-failed") return acceptAttemptState({ kind: "failed", output: event.output, reason: event.reason });
    if (event.kind === "worker-nothing-to-do") return acceptAttemptState({ kind: "nothing-to-do", output: event.output });
    if (event.kind === "cancelled") return acceptAttemptState({ kind: "cancelled", output: event.output, reason: event.reason });
    return rejectAttemptEvent(state, event);
  }
  if (state.kind === "checking") {
    if (event.kind === "check-accepted") return acceptAttemptState({ kind: "accepted", output: state.output });
    if (event.kind === "check-rejected") return acceptAttemptState({ kind: "rejected", output: state.output, feedback: event.feedback });
    if (event.kind === "cancelled") return acceptAttemptState({ kind: "cancelled", output: state.output, reason: event.reason });
    return rejectAttemptEvent(state, event);
  }
  return rejectAttemptEvent(state, event);
}

export type WorkflowAttemptEnvironment = {
  workflow: Workflow;
  documents: Record<string, string>;
  files: Record<string, string>;
  profileCommands: Record<string, string[]>;
  executeProcess(request: ProcessExecutionRequest): Promise<ProcessExecutionResult>;
  signal?: AbortSignal;
};

function timeoutMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) throw new Error(`Invalid workflow timeout: ${value}`);
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * factor;
  // Persisted workflow inputs can resume without passing through loader validation.
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new Error(`Workflow timeout is too large for Node timers: ${value}`);
  }
  return milliseconds;
}

function stepId(step: WorkflowStep): string {
  return `${step.number}-${step.name}`;
}

function renderAgentPrompt(body: string, input: string, feedback: string): string {
  const sections = [body];
  if (input.length > 0) sections.push(`## Input\n\n${input}`);
  if (feedback.length > 0) sections.push(`## Feedback\n\n${feedback}`);
  return sections.join("\n\n");
}

function processFailure(label: string, result: ProcessExecutionResult, timeoutMs?: number): string {
  if (result.timedOut) return `${label} timed out${timeoutMs === undefined ? "" : ` after ${timeoutMs}ms`}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`;
  if (result.error) return `${label} could not start: ${result.error}`;
  const status = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.exitCode}`;
  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return `${label} failed with ${status}${details ? `: ${details}` : ""}`;
}

export function parseMarkdownVerdict(output: string): { accepted: boolean; reason: string } {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^(ACCEPT|REJECT)(?=$|\s|:|-)(?:\s*[:-]?\s*(.*))?$/i.exec(firstLine);
  if (!match) return { accepted: false, reason: `check must start with ACCEPT or REJECT; received "${firstLine}"` };
  const decision = match[1]?.toUpperCase();
  const reason = match[2]?.trim() ?? "";
  return {
    accepted: decision === "ACCEPT",
    reason: reason || (decision === "ACCEPT" ? "accepted" : "check rejected the output"),
  };
}

function attemptResult(state: WorkflowAttemptState): WorkflowAttemptResult {
  switch (state.kind) {
    case "accepted":
      return { kind: "accepted", output: state.output };
    case "rejected":
      return { kind: "failed", output: state.output, reason: state.feedback };
    case "failed":
      return { kind: "failed", output: state.output, reason: state.reason };
    case "nothing-to-do":
      return { kind: "nothing-to-do", output: state.output };
    case "cancelled":
      throw new Error(state.reason);
    case "worker":
    case "checking":
      throw new Error(`Attempt did not reach a terminal phase: ${state.kind}`);
  }
}

async function executeAttempt(
  input: WorkflowAttemptEnvironment,
  request: WorkflowAttemptRequest,
 ): Promise<WorkflowAttemptResult> {
  const { step, profile, pipeInput, feedback, attempt } = request;
  const id = stepId(step);
  const stepTimeout = timeoutMilliseconds(step.timeout ?? input.workflow.timeout);
  let state: WorkflowAttemptState = { kind: "worker" };
  const transition = (event: WorkflowAttemptEvent) => {
    const result = transitionWorkflowAttempt(state, event);
    if (result.kind === "rejected") throw new Error(`Workflow attempt transition rejected (${result.code}): ${result.message}`);
    state = result.state;
    return result;
  };
  let workerOutput: string;
  if (step.kind === "command") {
    const file = input.files[step.file];
    if (file === undefined) throw new Error(`${id} file was not loaded when the step started`);
    const result = await input.executeProcess({
      kind: "command",
      command: [step.file.endsWith(".ts") ? process.execPath : "sh", file],
      input: pipeInput,
      step: id,
      feedback,
      timeoutMs: stepTimeout,
      attempt,
    });
    workerOutput = result.stdout;
    if (result.exitCode === 99 && !result.timedOut && result.error === undefined) {
      return attemptResult(transition({ kind: "worker-nothing-to-do", output: workerOutput }).state);
    }
    if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
      return attemptResult(transition({ kind: "worker-failed", output: workerOutput, reason: processFailure(id, result, stepTimeout) }).state);
    }
  } else {
    const command = input.profileCommands[profile ?? step.profile ?? ""];
    if (!command) throw new Error(`${id} selects an unknown profile "${profile ?? step.profile ?? ""}"`);
    const body = input.documents[step.file];
    if (body === undefined) throw new Error(`${id} prompt was not loaded when the step started`);
    const result = await input.executeProcess({
      kind: "agent",
      command,
      input: renderAgentPrompt(body, pipeInput, feedback),
      step: id,
      feedback,
      timeoutMs: stepTimeout,
      attempt,
      ...(profile === undefined ? {} : { profile }),
    });
    workerOutput = result.stdout;
    if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
      return attemptResult(transition({
        kind: "worker-failed", output: workerOutput, reason: processFailure(`${id} profile`, result, stepTimeout),
      }).state);
    }
  }

  const workerTransition = transition({ kind: "worker-succeeded", output: workerOutput, hasCheck: step.check !== undefined });
  state = workerTransition.state;
  if (state.kind === "accepted") return attemptResult(state);
  const checkEffect = workerTransition.effects.find((effect) => effect.kind === "check");
  if (state.kind !== "checking" || !checkEffect) throw new Error(`Successful worker entered unexpected attempt phase ${state.kind}`);
  workerOutput = checkEffect.output;
  if (step.check && input.signal?.aborted) {
    return attemptResult(transition({ kind: "cancelled", output: workerOutput, reason: `${id} was cancelled before its check could start` }).state);
  }
  if (!step.check) throw new Error("Attempt entered checking without a check definition");
  const checkId = `${id}.check`;
  const checkTimeout = timeoutMilliseconds(step.check.timeout ?? step.timeout ?? input.workflow.timeout);
  if (step.check.kind === "command") {
    const file = input.files[step.check.file];
    if (file === undefined) throw new Error(`${checkId} file was not loaded when the step started`);
    const result = await input.executeProcess({
      kind: "command-check",
      command: [step.check.file.endsWith(".ts") ? process.execPath : "sh", file],
      input: workerOutput,
      step: checkId,
      feedback,
      timeoutMs: checkTimeout,
      attempt,
    });
    if (result.exitCode === 0 && !result.timedOut && result.error === undefined) {
      return attemptResult(transition({ kind: "check-accepted" }).state);
    }
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    const reason = result.timedOut || result.error !== undefined
      ? processFailure(checkId, result, checkTimeout)
      : result.exitCode === null && Boolean(result.signal)
        ? `${checkId} failed with signal ${result.signal}${details ? `: ${details}` : ""}`
        : details || `${checkId} exited ${result.exitCode}`;
    return attemptResult(transition({ kind: "check-rejected", feedback: reason }).state);
  }

  const checkProfile = step.check.profile ?? profile ?? step.profile;
  const command = input.profileCommands[checkProfile ?? ""];
  if (!command) throw new Error(`${checkId} selects an unknown profile "${checkProfile ?? ""}"`);
  const prompt = input.documents[step.check.file];
  if (prompt === undefined) throw new Error(`${checkId} prompt was not loaded when the step started`);
  const result = await input.executeProcess({
    kind: "agent-check",
    command,
    input: renderAgentPrompt(prompt, workerOutput, ""),
    step: checkId,
    feedback,
    timeoutMs: checkTimeout,
    attempt,
    profile: checkProfile,
  });
  if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
    return attemptResult(transition({
      kind: "check-rejected", feedback: processFailure(checkId, result, checkTimeout),
    }).state);
  }
  const verdict = parseMarkdownVerdict(result.stdout);
  return attemptResult(transition(verdict.accepted
    ? { kind: "check-accepted" }
    : { kind: "check-rejected", feedback: verdict.reason }).state);
}

export async function executeWorkflowAttempt(
  input: WorkflowAttemptEnvironment,
  request: WorkflowAttemptRequest,
): Promise<WorkflowAttemptResult> {
  return await executeAttempt(input, request);
}
