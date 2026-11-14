import { resolve } from "node:path";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { readBlockedStep } from "../../run/read-blocked-step.ts";

export type BlockedWorkflowProgress = {
  workflow: string;
  run_id: string;
  step: string;
  last_error: string;
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
    at: blocked.at,
  };
}
