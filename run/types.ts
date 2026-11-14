import type { AttemptHistoryEntry } from "../workflow/types.ts";
export type RunIndexEntry = {
  workflow: string;
  slot: string | null;
  run_id: string | null;
  outcome: "started" | "skipped";
  reason?: string;
  at: string;
};

export type BlockedWorkflowStep = {
  workflow: string;
  run_id: string;
  step: string;
  step_kind: "agent" | "command";
  retry_profiles: string[];
  last_error: string;
  last_output?: string;
  attempt_history?: AttemptHistoryEntry[];
  token: string;
  at: string;
};
