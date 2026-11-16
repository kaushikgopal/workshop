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

async function executeAttempt(
  input: WorkflowAttemptEnvironment,
  request: WorkflowAttemptRequest,
): Promise<WorkflowAttemptResult> {
  const { step, profile, pipeInput, feedback, attempt } = request;
  const id = stepId(step);
  const stepTimeout = timeoutMilliseconds(step.timeout ?? input.workflow.timeout);
  let output: string;
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
    output = result.stdout;
    if (result.exitCode === 99 && !result.timedOut && result.error === undefined) return { kind: "nothing-to-do", output };
    if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
      return { kind: "failed", output, reason: processFailure(id, result, stepTimeout) };
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
    output = result.stdout;
    if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
      return { kind: "failed", output, reason: processFailure(`${id} profile`, result, stepTimeout) };
    }
  }

  if (step.check && input.signal?.aborted) {
    throw new Error(`${id} was cancelled before its check could start`);
  }
  if (!step.check) return { kind: "accepted", output };
  const checkId = `${id}.check`;
  const checkTimeout = timeoutMilliseconds(step.check.timeout ?? step.timeout ?? input.workflow.timeout);
  if (step.check.kind === "command") {
    const file = input.files[step.check.file];
    if (file === undefined) throw new Error(`${checkId} file was not loaded when the step started`);
    const result = await input.executeProcess({
      kind: "command-check",
      command: [step.check.file.endsWith(".ts") ? process.execPath : "sh", file],
      input: output,
      step: checkId,
      feedback,
      timeoutMs: checkTimeout,
      attempt,
    });
    if (result.exitCode === 0 && !result.timedOut && result.error === undefined) return { kind: "accepted", output };
    const reason = result.timedOut || result.error !== undefined
      ? processFailure(checkId, result, checkTimeout)
      : [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || `${checkId} exited ${result.exitCode}`;
    return { kind: "failed", output, reason };
  }

  const checkProfile = step.check.profile ?? profile ?? step.profile;
  const command = input.profileCommands[checkProfile ?? ""];
  if (!command) throw new Error(`${checkId} selects an unknown profile "${checkProfile ?? ""}"`);
  const prompt = input.documents[step.check.file];
  if (prompt === undefined) throw new Error(`${checkId} prompt was not loaded when the step started`);
  const result = await input.executeProcess({
    kind: "agent-check",
    command,
    input: renderAgentPrompt(prompt, output, ""),
    step: checkId,
    feedback: "",
    timeoutMs: checkTimeout,
    attempt,
    profile: checkProfile,
  });
  if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
    return { kind: "failed", output, reason: processFailure(checkId, result, checkTimeout) };
  }
  const verdict = parseMarkdownVerdict(result.stdout);
  return verdict.accepted ? { kind: "accepted", output } : { kind: "failed", output, reason: verdict.reason };
}

export async function executeWorkflowAttempt(
  input: WorkflowAttemptEnvironment,
  request: WorkflowAttemptRequest,
): Promise<WorkflowAttemptResult> {
  return await executeAttempt(input, request);
}
