import { recentRuns } from "./read-run-index.ts";
import type { BlockedWorkflowStep, RunIndexEntry } from "./types.ts";

export type WorkflowRunSummary = {
  run_id: string | null;
  workflow: string;
  slot: string | null;
  started_at: string;
  status: string;
  reason?: string;
  blocked_step?: string;
  last_error?: string;
};

export async function listWorkflowRuns(
  entries: readonly RunIndexEntry[],
  input: { limit: number; workflow?: string },
  ports: {
    getStatus(runId: string): Promise<string>;
    readBlocked(runId: string): BlockedWorkflowStep | undefined;
  },
): Promise<WorkflowRunSummary[]> {
  const recent = recentRuns(entries, input.limit, input.workflow);
  const indexed = entries.filter((entry) => input.workflow === undefined || entry.workflow === input.workflow).slice().reverse();
  const blocked = new Map<string, RunIndexEntry>();
  for (const entry of indexed) {
    if (entry.run_id !== null && !blocked.has(entry.run_id) && ports.readBlocked(entry.run_id) !== undefined) {
      blocked.set(entry.run_id, entry);
    }
  }
  const seenRuns = new Set<string>();
  const selected = [...blocked.values(), ...recent].filter((entry) => {
    if (entry.run_id === null) return true;
    if (seenRuns.has(entry.run_id)) return false;
    seenRuns.add(entry.run_id);
    return true;
  });
  return Promise.all(selected.map(async (entry) => {
    if (entry.run_id === null) {
      return {
        run_id: null,
        workflow: entry.workflow,
        slot: entry.slot,
        started_at: entry.at,
        status: "skipped",
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      };
    }
    try {
      const [status, blocked] = await Promise.all([
        ports.getStatus(entry.run_id),
        Promise.resolve(ports.readBlocked(entry.run_id)),
      ]);
      return {
        run_id: entry.run_id,
        workflow: entry.workflow,
        slot: entry.slot,
        started_at: entry.at,
        status,
        ...(blocked === undefined ? {} : { blocked_step: blocked.step, last_error: blocked.last_error }),
      };
    } catch (error) {
      return {
        run_id: entry.run_id,
        workflow: entry.workflow,
        slot: entry.slot,
        started_at: entry.at,
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}
