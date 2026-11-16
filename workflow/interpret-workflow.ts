import { advanceOrchestratorRound, type OrchestratorRound } from "./advance-orchestrator-round.ts";
import { applyWorkflowDecision } from "./apply-workflow-decision.ts";
import { buildOrchestratorBrief } from "./build-orchestrator-brief.ts";
import { computeRetryProfiles } from "./compute-retry-profiles.ts";
import { failedOrchestratorDecision, parseOrchestratorDecision } from "./parse-orchestrator-decision.ts";
import type {
  AttemptHistoryEntry,
  OrchestratorDecision,
  Workflow,
  WorkflowDecision,
  WorkflowStep,
  WorkflowStepResult,
} from "./types.ts";

export type ProcessExecutionKind = "command" | "agent" | "command-check" | "agent-check" | "orchestrator";

export type ProcessExecutionRequest = {
  kind: ProcessExecutionKind;
  command: readonly string[];
  source?: { path: string; content: string; kind: "shell" | "typescript" };
  input: string;
  step: string;
  feedback: string;
  timeoutMs?: number;
  attempt: number;
  profile?: string;
  round?: OrchestratorRound;
  allowedRetryProfiles?: string[];
  lastOutput?: string;
};

export type ProcessExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: string | null;
  error?: string;
};

export type AutomaticDecisionLog = {
  workflow: string;
  runId: string;
  step: string;
  round: OrchestratorRound;
  decision: OrchestratorDecision;
  note: string;
};

export type WorkflowInterpreterResume = {
  profile?: string;
  feedback: string;
  attemptHistory: AttemptHistoryEntry[];
  decisionNumber: number;
  automaticRound?: 1 | 2 | 3;
  localRetriesLeft?: number;
  waitUntil?: number;
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

export type WorkflowInterpreterInput = {
  workflow: Workflow;
  documents: Record<string, string>;
  files: Record<string, string>;
  contents?: Record<string, string>;
  workflowRunId: string;
  profileCommands: Record<string, string[]>;
  initialInput?: string;
  resume?: WorkflowInterpreterResume;
  orchestrator?: {
    profile: string;
    escalationProfile: string;
    recordDecision(input: AutomaticDecisionLog): Promise<void>;
  };
  executeProcess(request: ProcessExecutionRequest): Promise<ProcessExecutionResult>;
  executeAttempt?(request: WorkflowAttemptRequest): Promise<WorkflowAttemptResult>;
  waitBeforeRetry?(duration: string, resume: WorkflowInterpreterResume): Promise<boolean>;
  waitForDecision(input: WorkflowDecisionRequest): Promise<WorkflowDecision>;
};

export type WorkflowInterpretation = {
  status: "completed" | "nothing-to-do" | "waiting";
  output: string;
  completedSteps: number;
  steps: WorkflowStepResult[];
};

type AttemptResult = WorkflowAttemptResult;

function timeoutMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) throw new Error(`Invalid workflow timeout: ${value}`);
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * factor;
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

function attemptRecord(step: WorkflowStep, profile: string | undefined, attempt: number, result: AttemptResult): AttemptHistoryEntry {
  return {
    attempt,
    ...(step.kind === "agent" && profile !== undefined ? { profile } : {}),
    output: result.output,
    ...(result.kind === "failed" ? { error: result.reason } : {}),
  };
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

async function executeAttempt(input: WorkflowInterpreterInput, step: WorkflowStep, profile: string | undefined, pipeInput: string, feedback: string, attempt: number): Promise<AttemptResult> {
  const id = stepId(step);
  const stepTimeout = timeoutMilliseconds(step.timeout ?? input.workflow.timeout);
  let output: string;
  if (step.kind === "command") {
    const file = input.files[step.file];
    const content = input.contents?.[step.file];
    if (file === undefined || content === undefined) throw new Error(`${id} file was not loaded when the step started`);
    const result = await input.executeProcess({
      kind: "command",
      command: [step.file.endsWith(".ts") ? "node" : "sh", file],
      source: { path: file, content, kind: step.file.endsWith(".ts") ? "typescript" : "shell" },
      input: pipeInput,
      step: id,
      feedback,
      timeoutMs: stepTimeout,
      attempt,
    });
    output = result.stdout;
    if (result.exitCode === 99 && !result.timedOut) return { kind: "nothing-to-do", output };
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
    });
    output = result.stdout;
    if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
      return { kind: "failed", output, reason: processFailure(`${id} profile`, result, stepTimeout) };
    }
  }

  if (!step.check) return { kind: "accepted", output };
  const checkId = `${id}.check`;
  const checkTimeout = timeoutMilliseconds(step.check.timeout ?? step.timeout ?? input.workflow.timeout);
  if (step.check.kind === "command") {
    const file = input.files[step.check.file];
    const content = input.contents?.[step.check.file];
    if (file === undefined || content === undefined) throw new Error(`${checkId} file was not loaded when the step started`);
    const result = await input.executeProcess({
      kind: "command-check",
      command: [step.check.file.endsWith(".ts") ? "node" : "sh", file],
      source: { path: file, content, kind: step.check.file.endsWith(".ts") ? "typescript" : "shell" },
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
  });
  if (result.exitCode !== 0 || result.timedOut || result.error !== undefined) {
    return { kind: "failed", output, reason: processFailure(checkId, result, checkTimeout) };
  }
  const verdict = parseMarkdownVerdict(result.stdout);
  return verdict.accepted ? { kind: "accepted", output } : { kind: "failed", output, reason: verdict.reason };
}

export async function executeWorkflowAttempt(input: WorkflowInterpreterInput, request: WorkflowAttemptRequest): Promise<WorkflowAttemptResult> {
  return await executeAttempt(input, request.step, request.profile, request.pipeInput, request.feedback, request.attempt);
}

function retryLimit(step: WorkflowStep, workflow: Workflow): number {
  return step.retries ?? step.check?.retries ?? workflow.retries ?? 0;
}

function orchestratorDecision(input: WorkflowInterpreterInput, step: WorkflowStep, stepIdValue: string, round: OrchestratorRound, result: Extract<AttemptResult, { kind: "failed" }>, attempts: AttemptHistoryEntry[]): Promise<OrchestratorDecision> {
  const profile = round === 1 ? input.orchestrator?.profile : input.orchestrator?.escalationProfile;
  if (!profile) return Promise.resolve(failedOrchestratorDecision(`orchestrator profile for round ${round} is not configured`));
  const command = input.profileCommands[profile] ?? [];
  const allowedRetryProfiles = computeRetryProfiles(step, input.profileCommands);
  const brief = buildOrchestratorBrief({
    round,
    workflow: input.workflow,
    step,
    stepId: stepIdValue,
    stepContent: input.contents?.[step.file] ?? input.documents[step.file] ?? "",
    lastOutput: result.output,
    lastError: result.reason,
    attemptHistory: attempts,
    allowedRetryProfiles,
  });
  const timeoutMs = timeoutMilliseconds(step.timeout ?? input.workflow.timeout);
  return input.executeProcess({
    kind: "orchestrator",
    command,
    profile,
    round,
    allowedRetryProfiles,
    lastOutput: result.output,
    input: brief.prompt,
    step: `${stepIdValue}.orchestrator-round-${round}`,
    feedback: "",
    timeoutMs,
    attempt: 1,
  }).then((execution) => {
    if (execution.exitCode !== 0 || execution.timedOut || execution.error !== undefined) {
      return failedOrchestratorDecision(processFailure(`orchestrator round ${round}`, execution, timeoutMs));
    }
    return parseOrchestratorDecision(execution.stdout, brief);
  });
}

function workflowDecision(decision: OrchestratorDecision): WorkflowDecision {
  if (decision.action === "give_up") throw new Error("give_up decisions cannot be applied to a workflow step");
  if (decision.action === "retry") {
    return {
      action: "retry",
      ...(decision.hint === undefined ? {} : { hint: decision.hint }),
      ...(decision.profile === undefined ? {} : { profile: decision.profile }),
      ...(decision.after === undefined ? {} : { after: decision.after }),
    };
  }
  return { action: decision.action };
}

export async function interpretWorkflow(input: WorkflowInterpreterInput): Promise<WorkflowInterpretation> {
  let pipeInput = input.initialInput ?? "";
  let completedSteps = 0;
  const steps: WorkflowStepResult[] = [];
  for (const [stepIndex, step] of input.workflow.steps.entries()) {
    const resume = stepIndex === 0 ? input.resume : undefined;
    const id = stepId(step);
    const retries = retryLimit(step, input.workflow);
    let localRetriesLeft = resume?.localRetriesLeft ?? retries;
    let totalAttempts = resume?.attemptHistory.reduce((latest, entry) => Math.max(latest, entry.attempt), 0) ?? 0;
    let decisionNumber = resume?.decisionNumber ?? 0;
    let automaticRound: 0 | 1 | 2 | 3 = resume?.automaticRound ?? (resume ? 3 : input.orchestrator ? 1 : 3);
    let feedback = resume?.feedback ?? "";
    let selectedProfile = resume?.profile ?? step.profile;
    const attemptHistory: AttemptHistoryEntry[] = [...(resume?.attemptHistory ?? [])];
    let pendingResult: AttemptResult | undefined;
    let pendingResultRecorded = false;

    while (true) {
      let result: AttemptResult;
      let resultRecorded = false;
      if (pendingResult !== undefined) {
        result = pendingResult;
        resultRecorded = pendingResultRecorded;
        pendingResult = undefined;
        pendingResultRecorded = false;
      } else {
        totalAttempts += 1;
        const request: WorkflowAttemptRequest = { step, ...(selectedProfile === undefined ? {} : { profile: selectedProfile }), pipeInput, feedback, attempt: totalAttempts };
        result = input.executeAttempt ? await input.executeAttempt(request) : await executeWorkflowAttempt(input, request);
      }
      if (result.kind === "nothing-to-do") {
        attemptHistory.push(attemptRecord(step, selectedProfile, totalAttempts, result));
        steps.push({ step: id, status: "nothing-to-do", output: result.output, attempts: attemptHistory });
        return { status: "nothing-to-do", output: result.output, completedSteps, steps };
      }
      if (result.kind === "accepted") {
        attemptHistory.push(attemptRecord(step, selectedProfile, totalAttempts, result));
        pipeInput = result.output;
        completedSteps += 1;
        steps.push({ step: id, status: "completed", output: result.output, attempts: attemptHistory });
        break;
      }

      if (!resultRecorded) attemptHistory.push(attemptRecord(step, selectedProfile, totalAttempts, result));
      if (localRetriesLeft > 0) {
        localRetriesLeft -= 1;
        feedback = result.reason;
        continue;
      }

      if (automaticRound === 1 || automaticRound === 2) {
        const round: OrchestratorRound = automaticRound;
        const decision = await orchestratorDecision(input, step, id, round, result, attemptHistory);
        await input.orchestrator?.recordDecision({
          workflow: input.workflow.name,
          runId: input.workflowRunId,
          step: id,
          round,
          decision,
          note: decision.note,
        });
        const transition = advanceOrchestratorRound(round, decision);
        if (transition.kind === "fail") {
          throw new Error(`${id} failed after ${totalAttempts} attempts: ${result.reason}`);
        }
        if (transition.kind === "escalate" || transition.kind === "wait-for-user") {
          automaticRound = round === 1 ? 2 : 3;
          pendingResult = result;
          pendingResultRecorded = true;
          continue;
        }

        const applied = applyWorkflowDecision({
          decision: workflowDecision(decision),
          step,
          currentProfile: selectedProfile,
          profileCommands: input.profileCommands,
          lastError: result.reason,
        });
        if (applied.action === "retry") {
          selectedProfile = applied.profile;
          feedback = applied.feedback;
          automaticRound = round === 1 ? 2 : 3;
          if (applied.after !== undefined) {
            if (!input.waitBeforeRetry) throw new Error("A retry delay was requested but no durable wait is configured");
            const waiting = await input.waitBeforeRetry(applied.after, {
              ...(selectedProfile === undefined ? {} : { profile: selectedProfile }),
              feedback,
              attemptHistory: [...attemptHistory],
              decisionNumber,
              automaticRound,
              localRetriesLeft,
            });
            if (waiting) return { status: "waiting", output: pipeInput, completedSteps, steps };
          }
          totalAttempts += 1;
          const retryRequest: WorkflowAttemptRequest = { step, ...(selectedProfile === undefined ? {} : { profile: selectedProfile }), pipeInput, feedback, attempt: totalAttempts };
          const retried = input.executeAttempt ? await input.executeAttempt(retryRequest) : await executeWorkflowAttempt(input, retryRequest);
          if (retried.kind === "nothing-to-do") {
            attemptHistory.push(attemptRecord(step, selectedProfile, totalAttempts, retried));
            steps.push({ step: id, status: "nothing-to-do", output: retried.output, attempts: attemptHistory });
            return { status: "nothing-to-do", output: retried.output, completedSteps, steps };
          }
          if (retried.kind === "accepted") {
            attemptHistory.push(attemptRecord(step, selectedProfile, totalAttempts, retried));
            pipeInput = retried.output;
            completedSteps += 1;
            steps.push({ step: id, status: "completed", output: retried.output, attempts: attemptHistory });
            break;
          }
          automaticRound = round === 1 ? 2 : 3;
          // Reuse the durable attempt result; do not execute the failed step again.
          pendingResult = retried;
          pendingResultRecorded = false;
          continue;
        }

        if (applied.action === "skip") {
          completedSteps += 1;
          steps.push({ step: id, status: "skipped", output: "", attempts: attemptHistory });
          break;
        }
        if (applied.action === "accept") {
          pipeInput = result.output;
          completedSteps += 1;
          steps.push({ step: id, status: "completed", output: result.output, attempts: attemptHistory });
          break;
        }
        throw new Error(`${id} failed after ${totalAttempts} attempts: ${result.reason}`);
      }

      decisionNumber += 1;
      const decision = await input.waitForDecision({
        workflow: input.workflow.name,
        runId: input.workflowRunId,
        step: id,
        stepKind: step.kind,
        retryProfiles: computeRetryProfiles(step, input.profileCommands),
        lastError: result.reason,
        lastOutput: result.output,
        attemptHistory,
        decisionNumber,
      });
      const applied = applyWorkflowDecision({
        decision,
        step,
        currentProfile: selectedProfile,
        profileCommands: input.profileCommands,
        lastError: result.reason,
      });
      if (applied.action === "retry") {
        selectedProfile = applied.profile;
        feedback = applied.feedback;
        localRetriesLeft = retries;
        if (applied.after !== undefined) {
          if (!input.waitBeforeRetry) throw new Error("A retry delay was requested but no durable wait is configured");
          const waiting = await input.waitBeforeRetry(applied.after, {
            ...(selectedProfile === undefined ? {} : { profile: selectedProfile }),
            feedback,
            attemptHistory: [...attemptHistory],
            decisionNumber,
            automaticRound: 3,
            localRetriesLeft,
          });
          if (waiting) return { status: "waiting", output: pipeInput, completedSteps, steps };
        }
        continue;
      }
      if (applied.action === "skip") {
        completedSteps += 1;
        steps.push({ step: id, status: "skipped", output: "", attempts: attemptHistory });
        break;
      }
      if (applied.action === "accept") {
        pipeInput = result.output;
        completedSteps += 1;
        steps.push({ step: id, status: "completed", output: result.output, attempts: attemptHistory });
        break;
      }
      throw new Error(`${id} failed after ${totalAttempts} attempts: ${result.reason}`);
    }
  }
  return { status: "completed", output: pipeInput, completedSteps, steps };
}
