import { resolve } from "node:path";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { readBlockedStep } from "../../run/read-blocked-step.ts";
import type { AttemptHistoryEntry } from "../../workflow/types.ts";

export type BlockedWorkflowProgress = {
  workflow: string;
  run_id: string;
  step: string;
  last_error: string;
  last_output?: string;
  attempt_history?: AttemptHistoryEntry[];
  at: string;
};

// Eve's public getRun() exposes status and the eventual return value, not progress while a run waits on a hook.
export function readBlockedWorkflowStep(runId: string, stateRoot = resolve(process.cwd(), "state")): BlockedWorkflowProgress | undefined {
  const blocked = readBlockedStep(locateBlockedStep(stateRoot, runId));
  if (!blocked) return undefined;
  return {
    workflow: blocked.workflow,
    run_id: blocked.run_id,
    step: blocked.step,
    last_error: blocked.last_error,
    ...(blocked.last_output === undefined ? {} : { last_output: blocked.last_output }),
    ...(blocked.attempt_history === undefined ? {} : { attempt_history: blocked.attempt_history }),
    at: blocked.at,
  };
}
