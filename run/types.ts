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
  token: string;
  at: string;
};
