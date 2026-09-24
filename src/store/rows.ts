import type { RunRow, RunStatus, StoreCtx } from "./types.js";

/**
 * Shared run-row reads. The store's transition modules all need the same run
 * lookups and terminal-status predicate; keeping them here — types only —
 * lets the run, attempt, and workflow modules share one copy without
 * importing one another.
 */

const UNRESOLVED_RUN_STATUSES = "('queued','running','paused','blocked')";

export function getRun(ctx: StoreCtx, runId: string): RunRow | null {
  return ctx.db.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId) ?? null;
}

export function getUnresolvedRun(ctx: StoreCtx, workflowId: string): RunRow | null {
  return (
    ctx.db
      .query<RunRow, [string]>(
        `SELECT * FROM runs WHERE workflow_id = ? AND status IN ${UNRESOLVED_RUN_STATUSES} ORDER BY started_at DESC LIMIT 1`,
      )
      .get(workflowId) ?? null
  );
}

export function getMostRecentRun(ctx: StoreCtx, workflowId: string): RunRow | null {
  return (
    ctx.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE workflow_id = ? ORDER BY seq DESC LIMIT 1")
      .get(workflowId) ?? null
  );
}

export function listRuns(ctx: StoreCtx, workflowId?: string): RunRow[] {
  if (workflowId) {
    return ctx.db.query<RunRow, [string]>("SELECT * FROM runs WHERE workflow_id = ? ORDER BY seq").all(workflowId);
  }
  return ctx.db.query<RunRow, []>("SELECT * FROM runs ORDER BY workflow_id, seq").all();
}

export function listUnresolvedRuns(ctx: StoreCtx): RunRow[] {
  return ctx.db
    .query<RunRow, []>(`SELECT * FROM runs WHERE status IN ${UNRESOLVED_RUN_STATUSES} ORDER BY started_at`)
    .all();
}

export function listPendingAdmissions(ctx: StoreCtx): RunRow[] {
  return ctx.db
    .query<RunRow, []>("SELECT * FROM runs WHERE admission_state = 'pending' ORDER BY started_at, run_id")
    .all();
}

export function isTerminal(status: RunStatus): boolean {
  return status === "failed" || status === "completed" || status === "cancelled";
}
