import type { WorkflowStep } from "./types.ts";

export function isRetryProfileCompatible(
  step: WorkflowStep,
  profile: string,
  profileCommands: Readonly<Record<string, readonly string[]>>,
): boolean {
  if (step.kind !== "agent") return false;
  return profileCommands[profile]?.[0] === profileCommands[step.profile ?? ""]?.[0];
}

export function computeRetryProfiles(
  step: WorkflowStep,
  profileCommands: Readonly<Record<string, readonly string[]>>,
): string[] {
  if (step.kind !== "agent") return [];
  const executable = profileCommands[step.profile ?? ""]?.[0];
  if (executable === undefined) return [];
  return Object.entries(profileCommands)
    .filter(([name]) => isRetryProfileCompatible(step, name, profileCommands))
    .map(([name]) => name);
}
