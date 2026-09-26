import { toIso } from "../../util/clock.js";
import { CapacityRejected, GuardRejected, type ActivationState, type StoreCtx, type WorkflowRow } from "./types.js";
import { getUnresolvedRun } from "./query-runs.js";

export function getWorkflow(ctx: StoreCtx, workflowId: string): WorkflowRow | null {
  return ctx.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId) ?? null;
}

export function listWorkflows(ctx: StoreCtx): WorkflowRow[] {
  return ctx.db.query<WorkflowRow, []>("SELECT * FROM workflows ORDER BY workflow_id").all();
}

/** Create or refresh the activation. Only start may call this. */
export function upsertWorkflowActivation(ctx: StoreCtx, input: {
  workflowId: string;
  definitionPath: string;
  definitionHash: string;
  every: string | null;
  maxRuns: number | null;
  now: Date;
}): { created: boolean } {
  return ctx.tx(() => {
    const existing = getWorkflow(ctx, input.workflowId);
    const nowIso = toIso(input.now);
    if (!existing) {
      ctx.db
        .query(
          `INSERT INTO workflows (workflow_id, definition_path, canonical_definition_hash, activation_state,
            activation_started_at, schedule_started_runs, schedule_every, schedule_max_runs, next_run_at)
           VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?)`,
        )
        .run(
          input.workflowId,
          input.definitionPath,
          input.definitionHash,
          nowIso,
          input.every,
          input.maxRuns,
          input.every ? toIso(input.now) : null,
        );
      return { created: true };
    }
    // Definition edits apply to the next run; refresh path + hash now.
    ctx.db
      .query("UPDATE workflows SET definition_path = ?, canonical_definition_hash = ? WHERE workflow_id = ?")
      .run(input.definitionPath, input.definitionHash, input.workflowId);
    // A new activation resets the counter — only from terminal states,
    // and only when no run is unresolved.
    if (existing.activation_state !== "active") {
      const unresolved = getUnresolvedRun(ctx, input.workflowId);
      if (unresolved) {
        throw new GuardRejected(
          `workflow "${input.workflowId}" already has an unresolved run ${unresolved.run_id} (${unresolved.status}) — start is an idempotent no-op`,
        );
      }
      if (!["stopped", "exhausted", "expired"].includes(existing.activation_state)) {
        throw new GuardRejected(
          `activation is ${existing.activation_state} — use "workshop resume" to re-enable it`,
        );
      }
      ctx.db
        .query(
          `UPDATE workflows SET activation_state = 'active', activation_started_at = ?,
             schedule_started_runs = 0, schedule_every = ?, schedule_max_runs = ?, next_run_at = ?
           WHERE workflow_id = ?`,
        )
        .run(nowIso, input.every, input.maxRuns, input.every ? nowIso : null, input.workflowId);
      return { created: true };
    }
    return { created: false };
  });
}

export function setActivationState(ctx: StoreCtx, workflowId: string, state: ActivationState): void {
  ctx.tx(() => {
    const changes = ctx.db
      .query("UPDATE workflows SET activation_state = ? WHERE workflow_id = ?")
      .run(state, workflowId);
    if (Number(changes.changes) === 0) throw new GuardRejected(`no workflow "${workflowId}"`);
  });
}

/** True when a new attempt/orchestrator claim could take a top-level slot. */
export function hasExecutionCapacity(ctx: StoreCtx, maxConcurrentRuns: number): boolean {
  return occupiedRunSlots(ctx, ) < maxConcurrentRuns;
}

export function assertCapacity(ctx: StoreCtx, maxConcurrentRuns: number): void {
  if (occupiedRunSlots(ctx, ) >= maxConcurrentRuns) throw new CapacityRejected();
}

function occupiedRunSlots(ctx: StoreCtx): number {
  const row = ctx.db
    .query<{ n: number }, []>(
      `SELECT COUNT(DISTINCT run_id) AS n FROM (
         SELECT run_id FROM node_attempts WHERE status IN ('running','finishing')
         UNION ALL
         SELECT run_id FROM runs WHERE orchestrator_phase IN ('owned','applying')
       )`,
    )
    .get();
  return Number(row?.n ?? 0);
}
