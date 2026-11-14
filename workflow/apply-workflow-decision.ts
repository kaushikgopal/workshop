import type { WorkflowDecision, WorkflowStep } from "./types.ts";

export type AppliedWorkflowDecision =
  | { action: "retry"; profile: string | undefined; feedback: string; after?: string }
  | { action: "skip" }
  | { action: "accept" }
  | { action: "fail" };

export function applyWorkflowDecision(input: {
  decision: WorkflowDecision;
  step: WorkflowStep;
  currentProfile: string | undefined;
  profileCommands: Readonly<Record<string, readonly string[]>>;
  lastError: string;
}): AppliedWorkflowDecision {
  const { decision } = input;
  if (decision.action !== "retry") return decision;

  let profile = input.currentProfile;
  if (decision.profile !== undefined) {
    if (input.step.kind !== "agent") throw new Error(`${input.step.number}-${input.step.name} cannot retry with a profile because it is a command step`);
    const retryCommand = input.profileCommands[decision.profile];
    if (!retryCommand) throw new Error(`Unknown retry profile "${decision.profile}" for ${input.step.number}-${input.step.name}`);
    const originalExecutable = input.profileCommands[input.step.profile ?? ""]?.[0];
    if (retryCommand[0] !== originalExecutable) {
      throw new Error(`Retry profile "${decision.profile}" must use the same executable as ${input.step.profile}`);
    }
    profile = decision.profile;
  }

  const feedback = [input.lastError, decision.hint ? `Hint: ${decision.hint}` : ""].filter(Boolean).join("\n\n");
  return {
    action: "retry",
    profile,
    feedback,
    ...(decision.after === undefined ? {} : { after: decision.after }),
  };
}
