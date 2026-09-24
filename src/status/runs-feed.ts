import type { RunRow } from "../store/store.js";

/**
 * The runs feed — a workflow's occurrences as a viewer reads them.
 *
 * `status --json` answers "what is true now" and deliberately carries only the
 * unresolved current run, so a viewer cannot draw a recurring workflow as a
 * stream of occurrences from it. This is the second half of the projection:
 * what happened, newest first. It is its own versioned shape rather than an
 * extension of the status DTO, whose size would then depend on run history.
 */

export const RUNS_DTO_VERSION = 1;

/** How many occurrences the human feed shows before it says what it hid. */
export const DEFAULT_RUNS_LIMIT = 50;

export interface RunsFeedEntry {
  id: string;
  status: string;
  desiredState: string;
  startedAt: string;
  finishedAt: string | null;
  blocker: string | null;
}

export interface RunsFeed {
  version: number;
  workflowId: string;
  /** Every occurrence this workflow has, regardless of the cap below. */
  total: number;
  /** Newest first, capped. */
  runs: RunsFeedEntry[];
}

/**
 * Build the feed from run rows. The caller passes rows in `seq` order, the
 * runtime's own chronology; the feed reverses them so the line a reader looks
 * at first is the one that just happened.
 */
export function buildRunsFeed(input: {
  workflowId: string;
  runs: RunRow[];
  all?: boolean;
  limit?: number;
}): RunsFeed {
  const newestFirst = [...input.runs].reverse();
  const capped = input.all ? newestFirst : newestFirst.slice(0, input.limit ?? DEFAULT_RUNS_LIMIT);
  return {
    version: RUNS_DTO_VERSION,
    workflowId: input.workflowId,
    total: input.runs.length,
    runs: capped.map((run) => ({
      id: run.run_id,
      status: run.status,
      desiredState: run.desired_state,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      blocker: run.block_kind,
    })),
  };
}
