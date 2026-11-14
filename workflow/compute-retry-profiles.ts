import type { WorkflowStep } from "./types.ts";

export function computeRetryProfiles(
  step: WorkflowStep,
  profileCommands: Readonly<Record<string, readonly string[]>>,
): string[] {
  if (step.kind !== "agent") return [];
  const executable = profileCommands[step.profile ?? ""]?.[0];
  if (executable === undefined) return [];
  return Object.entries(profileCommands)
    .filter(([, command]) => command[0] === executable)
    .map(([name]) => name);
}
