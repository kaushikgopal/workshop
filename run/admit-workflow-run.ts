import { startedCountForWorkflow } from "./read-run-index.ts";
import type { RunIndexEntry } from "./types.ts";

export type WorkflowAdmissionDecision =
  | { kind: "start" }
  | { kind: "resume" }
  | { kind: "skip"; reason: string };

export function decideWorkflowAdmission(input: {
  entries: readonly RunIndexEntry[];
  workflow: string;
  runId: string;
  slot: string | null;
  maxRuns?: number;
}): WorkflowAdmissionDecision {
  if (input.slot === null) return { kind: "start" };

  const sameRunAlreadyStarted = input.entries.some((entry) =>
    entry.workflow === input.workflow &&
    entry.slot === input.slot &&
    entry.run_id === input.runId &&
    entry.outcome === "started",
  );
  if (sameRunAlreadyStarted) return { kind: "resume" };

  const slotAlreadyIndexed = input.entries.some((entry) =>
    entry.workflow === input.workflow && entry.slot === input.slot,
  );
  if (slotAlreadyIndexed) return { kind: "skip", reason: "slot already indexed" };

  if (input.maxRuns !== undefined && startedCountForWorkflow(input.entries, input.workflow) >= input.maxRuns) {
    return { kind: "skip", reason: "max_runs reached" };
  }
  return { kind: "start" };
}
