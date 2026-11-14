import type { AttemptHistoryEntry, Workflow, WorkflowStep } from "./types.ts";

export type OrchestratorBriefInput = {
  round: 1 | 2;
  workflow: Workflow;
  step: WorkflowStep;
  stepId: string;
  stepContent: string;
  lastOutput: string;
  lastError: string;
  attemptHistory: readonly AttemptHistoryEntry[];
  allowedRetryProfiles: readonly string[];
};

export type OrchestratorBrief = {
  prompt: string;
  allowedRetryProfiles: readonly string[];
  lastOutput: string;
};

const outputLimit = 12_000;
const errorLimit = 4_000;

function tail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[truncated; showing last ${limit} characters]\n${value.slice(-limit)}`;
}

export function buildOrchestratorBrief(input: OrchestratorBriefInput): OrchestratorBrief {
  const allowedActions = input.lastOutput.trim().length > 0
    ? ["retry", "skip", "accept", "fail", "give_up"]
    : ["retry", "skip", "fail", "give_up"];
  const attemptHistory = input.attemptHistory.map((attempt) => ({
    ...attempt,
    output: tail(attempt.output, 2_000),
    ...(attempt.error === undefined ? {} : { error: tail(attempt.error, 2_000) }),
  }));
  const prompt = [
    `You are Workshop's automatic failure orchestrator. This is round ${input.round} of 2.`,
    "Do not run shell commands, edit workflow files, or invent results. Choose one allowed action based only on the supplied evidence.",
    "Return exactly one strict JSON object and no Markdown. The object must have a string note. Valid shapes:",
    '{"action":"retry","hint":"optional","profile":"optional allowed profile","after":"optional duration such as 30s","note":"why"}',
    '{"action":"skip|accept|fail|give_up","note":"why"}',
    "Use give_up when you cannot justify another safe action. Fail ends this round: round 1 escalates, and round 2 waits for chat. Accept is allowed only when last_output is non-empty.",
    `Allowed actions: ${allowedActions.join(", ")}.`,
    `Allowed retry profiles: ${input.allowedRetryProfiles.length ? input.allowedRetryProfiles.join(", ") : "none (command steps cannot change profile)"}. Omit profile to keep the current profile.`,
    "",
    "## Workflow description",
    input.workflow.description || "(empty)",
    "",
    `## Step ${input.stepId} (${input.step.kind})`,
    `File: ${input.step.file}`,
    `Current profile: ${input.step.profile ?? "none"}`,
    "Step file content:",
    input.stepContent || "(empty)",
    "",
    "## Last output",
    tail(input.lastOutput, outputLimit) || "(empty)",
    "",
    "## Last error (tail)",
    tail(input.lastError, errorLimit) || "(empty)",
    "",
    "## Attempt history",
    JSON.stringify(attemptHistory, null, 2),
  ].join("\n");
  return { prompt, allowedRetryProfiles: input.allowedRetryProfiles, lastOutput: input.lastOutput };
}
