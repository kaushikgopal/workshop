import { join } from "node:path";
import { toIso } from "../util/clock.js";
import { formatRunId, newOwnerToken } from "../util/ids.js";
import { processStartIdOrThrow } from "../util/process.js";
import { GuardRejected, type AttemptRow, type BlockKind, type DesiredState, type RunRow, type RunStatus, type StoreCtx } from "./types.js";
import { getRun, getUnresolvedRun, isTerminal } from "./rows.js";
import { assertCapacity, getWorkflow } from "./workflows.js";
import { createRetryAttempt } from "./attempts.js";

/**
 * Reserve a run with final artifact paths and exact validated source bytes.
 * Scheduled overlap consumption and run creation are serialized here so
 * competing connections cannot duplicate a run or shift the cadence.
 */
export function createRun(ctx: StoreCtx, input: {
  workflowId: string;
  definitionHash: string;
  definitionYaml: string;
  runsDir: string;
  now: Date;
  mode: "manual" | "scheduled";
  isRecurring: boolean;
  everyMs: number | null;
}): { runId: string; created: boolean } {
  return ctx.tx(() => {
    const wf = getWorkflow(ctx, input.workflowId);
    if (!wf) throw new GuardRejected(`no workflow "${input.workflowId}"`);

    if (input.isRecurring) {
      if (!wf.schedule_every || input.everyMs === null) throw new GuardRejected("workflow is not scheduled");
      if (wf.activation_state !== "active") {
        throw new GuardRejected(`activation is ${wf.activation_state} — no occurrence admitted`);
      }
      if (wf.schedule_max_runs != null && wf.schedule_max_runs > 0 && wf.schedule_started_runs >= wf.schedule_max_runs) {
        ctx.db.query("UPDATE workflows SET activation_state = 'exhausted', next_run_at = NULL WHERE workflow_id = ?").run(input.workflowId);
        throw new GuardRejected(`activation exhausted (${wf.schedule_max_runs} runs admitted)`);
      }
    }
    if (input.mode === "scheduled" && wf.next_run_at && new Date(wf.next_run_at) > input.now) {
      throw new GuardRejected(`not due until ${wf.next_run_at}`);
    }

    const unresolved = getUnresolvedRun(ctx, input.workflowId);
    if (unresolved) {
      if (input.mode === "scheduled" && input.everyMs !== null) {
        advanceScheduleCursor(ctx, input.workflowId, wf.next_run_at, input.now, input.everyMs);
      }
      return { runId: unresolved.run_id, created: false };
    }

    const seqRow = ctx.db
      .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM runs WHERE workflow_id = ?")
      .get(input.workflowId);
    const seq = (seqRow?.m ?? 0) + 1;
    const runId = formatRunId(input.workflowId, input.now, seq);
    const runDir = join(input.runsDir, runId);
    const snapshotPath = join(runDir, "definition.yaml");
    const logPath = join(runDir, "WORKSHOP_LOG.md");
    const nowIso = toIso(input.now);

    ctx.db
      .query(
        `INSERT INTO runs (run_id, seq, workflow_id, status, definition_hash, definition_snapshot_path,
           desired_state, orchestrator_phase, block_kind, run_dir, worklog_path, admission_state,
           admission_definition_yaml, started_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, 'running', 'idle', NULL, ?, ?, 'pending', ?, ?, ?)` ,
      )
      .run(runId, seq, input.workflowId, input.definitionHash, snapshotPath, runDir, logPath, input.definitionYaml, nowIso, nowIso);

    if (input.isRecurring && input.everyMs !== null) {
      const cursor = wf.next_run_at ?? nowIso;
      const next = input.mode === "manual" && new Date(cursor) > input.now
        ? cursor // an early manual start does not consume a future cadence slot
        : nextCursorAfter(cursor, input.now, input.everyMs);
      ctx.db
        .query("UPDATE workflows SET schedule_started_runs = schedule_started_runs + 1, next_run_at = ? WHERE workflow_id = ?")
        .run(next, input.workflowId);
    } else {
      ctx.db.query("UPDATE workflows SET schedule_started_runs = schedule_started_runs + 1 WHERE workflow_id = ?").run(input.workflowId);
    }

    return { runId, created: true };
  });
}

/** Consume a due slot without loading mutable workflow source. */
export function consumeScheduledOverlap(ctx: StoreCtx, workflowId: string, now: Date, everyMs: number): string | null {
  return ctx.tx(() => {
    const wf = getWorkflow(ctx, workflowId);
    if (!wf || wf.activation_state !== "active" || !wf.schedule_every) return null;
    if (wf.schedule_max_runs != null && wf.schedule_max_runs > 0 && wf.schedule_started_runs >= wf.schedule_max_runs) {
      ctx.db.query("UPDATE workflows SET activation_state = 'exhausted', next_run_at = NULL WHERE workflow_id = ?").run(workflowId);
      return null;
    }
    if (wf.next_run_at && new Date(wf.next_run_at) > now) return null;
    const unresolved = getUnresolvedRun(ctx, workflowId);
    if (!unresolved) return null;
    advanceScheduleCursor(ctx, workflowId, wf.next_run_at, now, everyMs);
    return unresolved.run_id;
  });
}

function advanceScheduleCursor(ctx: StoreCtx, workflowId: string, cursor: string | null, now: Date, everyMs: number): void {
  const from = cursor ?? toIso(now);
  ctx.db.query("UPDATE workflows SET next_run_at = ? WHERE workflow_id = ?").run(nextCursorAfter(from, now, everyMs), workflowId);
}

export function markAdmissionReady(ctx: StoreCtx, runId: string, now: Date): boolean {
  const changes = ctx.db
    .query("UPDATE runs SET admission_state = 'ready', admission_definition_yaml = NULL, admission_error = NULL, updated_at = ? WHERE run_id = ? AND admission_state = 'pending'")
    .run(toIso(now), runId);
  return Number(changes.changes) === 1;
}

export function failAdmission(ctx: StoreCtx, runId: string, error: string, now: Date): void {
  ctx.tx(() => {
    ctx.db
      .query("UPDATE runs SET admission_state = 'blocked', admission_error = ?, status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ? AND admission_state != 'ready'")
      .run(error, toIso(now), toIso(now), runId);
  });
}

export function failRunIntegrity(ctx: StoreCtx, runId: string, error: string, now: Date): void {
  ctx.tx(() => {
    ctx.db
      .query("UPDATE node_attempts SET status = 'failed', failure_kind = 'worklog_integrity', finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('pending','running','finishing')")
      .run(toIso(now), toIso(now), runId);
    ctx.db
      .query("UPDATE runs SET admission_state = 'blocked', admission_error = ?, status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
      .run(error, toIso(now), toIso(now), runId);
  });
}

/** Fail only the still-pending packet row that was actually inspected. */
export function failPendingPacketIntegrity(ctx: StoreCtx, input: { runId: string; nodeId: string; attempt: number; error: string; now: Date }): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query("UPDATE node_attempts SET status = 'failed', failure_kind = 'worklog_integrity', finished_at = ?, updated_at = ? WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'pending'")
      .run(toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt);
    if (Number(changes.changes) !== 1) return false;
    ctx.db
      .query("UPDATE runs SET admission_state = 'blocked', admission_error = ?, status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
      .run(input.error, toIso(input.now), toIso(input.now), input.runId);
    return true;
  });
}

/** Guarded desired-state change for operator controls. */
export function setDesiredState(ctx: StoreCtx, runId: string, desired: DesiredState, now: Date): void {
  ctx.tx(() => {
    const changes = ctx.db
      .query("UPDATE runs SET desired_state = ?, updated_at = ? WHERE run_id = ?")
      .run(desired, toIso(now), runId);
    if (Number(changes.changes) === 0) throw new GuardRejected(`no run "${runId}"`);
  });
}

/** Guarded run-status change with optional block kind. */
export function setRunStatus(ctx: StoreCtx, runId: string, status: RunStatus, now: Date, blockKind: BlockKind | null): void {
  ctx.tx(() => {
    const changes = ctx.db
      .query("UPDATE runs SET status = ?, block_kind = ?, updated_at = ?, finished_at = ? WHERE run_id = ?")
      .run(status, blockKind, toIso(now), isTerminal(status) ? toIso(now) : null, runId);
    if (Number(changes.changes) === 0) throw new GuardRejected(`no run "${runId}"`);
  });
}

/** Request stop durably; cancellation waits for process-group confirmation. */
export function stopRun(ctx: StoreCtx, input: { runId: string; now: Date }): void {
  ctx.tx(() => {
    const changes = ctx.db
      .query("UPDATE runs SET desired_state = 'stopped', updated_at = ? WHERE run_id = ?")
      .run(toIso(input.now), input.runId);
    if (Number(changes.changes) === 0) throw new GuardRejected(`no run "${input.runId}"`);
    // With no recorded groups, terminate-confirm is vacuous and the stop
    // can finalize immediately. Live groups keep ownership protected.
    finalizeStoppedRun(ctx, { runId: input.runId, now: input.now });
  });
}

/**
 * Final cancellation is legal only after every persisted worker, validator,
 * and orchestrator group has been cleared following confirmed death.
 */
export function finalizeStoppedRun(ctx: StoreCtx, input: { runId: string; now: Date }): boolean {
  return ctx.tx(() => {
    const run = getRun(ctx, input.runId);
    if (!run || run.desired_state !== "stopped") return false;
    const activeAttempt = ctx.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM node_attempts WHERE run_id = ? AND (worker_process_group IS NOT NULL OR validator_process_group IS NOT NULL)",
      )
      .get(input.runId);
    if (Number(activeAttempt?.n ?? 0) > 0 || run.orchestrator_process_group !== null) return false;
    ctx.db
      .query(
        `UPDATE node_attempts SET status = 'cancelled', owner_token = NULL, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND status IN ('pending','running','finishing')`,
      )
      .run(toIso(input.now), toIso(input.now), input.runId);
    ctx.db
      .query(
        `UPDATE runs SET status = 'cancelled', block_kind = NULL, finished_at = ?, updated_at = ?,
           orchestrator_phase = 'idle', orchestrator_owner_token = NULL,
           orchestrator_wrapper_pid = NULL, orchestrator_wrapper_process_start_id = NULL,
           orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
           orchestrator_process_group = NULL
         WHERE run_id = ? AND desired_state = 'stopped'
           AND status IN ('queued','running','paused','blocked')`,
      )
      .run(toIso(input.now), toIso(input.now), input.runId);
    return true;
  });
}

export function claimOrchestrator(ctx: StoreCtx, runId: string, now: Date, maxConcurrentRuns: number): { ownerToken: string } | null {
  return ctx.tx(() => {
    const run = getRun(ctx, runId);
    if (!run || run.orchestrator_phase !== "pending" || run.orchestrator_owner_token !== null ||
        run.desired_state !== "running" || run.admission_state !== "ready" ||
        !["queued", "running"].includes(run.status)) return null;
    assertCapacity(ctx, maxConcurrentRuns);
    const ownerToken = newOwnerToken();
    const wrapperStart = processStartIdOrThrow(process.pid);
    const changes = ctx.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'owned', orchestrator_owner_token = ?,
           orchestrator_wrapper_pid = ?, orchestrator_wrapper_process_start_id = ?,
           orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
           orchestrator_process_group = NULL, orchestrator_result_path = NULL,
           orchestrator_last_heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'pending' AND orchestrator_owner_token IS NULL
           AND desired_state = 'running' AND admission_state = 'ready' AND status IN ('queued','running')`,
      )
      .run(ownerToken, process.pid, wrapperStart, toIso(now), toIso(now), runId);
    return Number(changes.changes) === 1 ? { ownerToken } : null;
  });
}

/** Persist the orchestrator child identity immediately after spawn. */
export function recordOrchestratorIdentity(ctx: StoreCtx, input: {
  runId: string; ownerToken: string; childPid: number; childStartId: string; childPgid: number; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE runs SET orchestrator_worker_pid = ?, orchestrator_worker_process_start_id = ?,
           orchestrator_process_group = ?, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?
           AND orchestrator_process_group IS NULL AND desired_state = 'running'`,
      )
      .run(input.childPid, input.childStartId, input.childPgid, toIso(input.now), input.runId, input.ownerToken);
    return Number(changes.changes) === 1;
  });
}

/** Owner-guarded heartbeat. */
export function heartbeatOrchestrator(ctx: StoreCtx, input: { runId: string; ownerToken: string; now: Date }): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        "UPDATE runs SET orchestrator_last_heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?",
      )
      .run(toIso(input.now), toIso(input.now), input.runId, input.ownerToken);
    return Number(changes.changes) === 1;
  });
}

/** Clear a recorded child group only after the caller confirmed the whole PGID dead. */
export function clearOrchestratorIdentity(ctx: StoreCtx, input: {
  runId: string; ownerToken: string; childPid: number; childStartId: string; childPgid: number; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE runs SET orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
           orchestrator_process_group = NULL, updated_at = ?
         WHERE run_id = ? AND orchestrator_owner_token = ? AND orchestrator_phase IN ('owned','applying')
           AND orchestrator_worker_pid = ? AND orchestrator_worker_process_start_id = ? AND orchestrator_process_group = ?`,
      )
      .run(toIso(input.now), input.runId, input.ownerToken, input.childPid, input.childStartId, input.childPgid);
    return Number(changes.changes) === 1;
  });
}

/** Stop/recovery clears by exact process identity, without owning the phase. */
export function confirmOrchestratorProcessStopped(ctx: StoreCtx, input: {
  runId: string; childPid: number; childStartId: string; childPgid: number; now: Date;
}): boolean {
  const changes = ctx.db
    .query(
      `UPDATE runs SET orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
         orchestrator_process_group = NULL, updated_at = ?
       WHERE run_id = ? AND orchestrator_worker_pid = ? AND orchestrator_worker_process_start_id = ?
         AND orchestrator_process_group = ?`,
    )
    .run(toIso(input.now), input.runId, input.childPid, input.childStartId, input.childPgid);
  return Number(changes.changes) === 1;
}

/** Bind the normalized durable result file while claiming owned → applying. */
export function claimApplying(ctx: StoreCtx, input: { runId: string; ownerToken: string; resultPath: string; now: Date }): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'applying', orchestrator_result_path = ?,
           orchestrator_last_heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?
           AND orchestrator_process_group IS NULL AND desired_state = 'running'`,
      )
      .run(input.resultPath, toIso(input.now), toIso(input.now), input.runId, input.ownerToken);
    return Number(changes.changes) === 1;
  });
}

/**
 * Apply one decision effect and return the phase to idle in the same
 * owner-guarded transaction: the effect either commits with the phase
 * closed, or nothing changes and recovery re-reads the result file.
 */
export function applyOrchestratorDecision(ctx: StoreCtx, input: {
  runId: string; ownerToken: string; decision: "retry" | "block" | "fail"; now: Date;
}): { effectNodeId: string | null; effectAttempt: number | null } {
  return ctx.tx(() => {
    const run = getRun(ctx, input.runId);
    if (!run || run.orchestrator_phase !== "applying" || run.orchestrator_owner_token !== input.ownerToken ||
        run.orchestrator_process_group !== null || run.desired_state !== "running") {
      throw new GuardRejected("stale orchestrator cannot apply decision");
    }
    let effectNodeId: string | null = null;
    let effectAttempt: number | null = null;
    if (input.decision === "retry") {
      const latest = ctx.db
        .query<AttemptRow, [string]>(
          "SELECT * FROM node_attempts WHERE run_id = ? AND status = 'failed' ORDER BY execution_seq DESC LIMIT 1",
        )
        .get(input.runId);
      const created = latest ? createRetryAttempt(ctx, {
        runId: input.runId, nodeId: latest.node_id, previousAttempt: latest.attempt,
        resolvedMaxAttempts: latest.resolved_max_attempts, resolvedTimeoutMs: latest.resolved_timeout_ms,
        chainPosition: latest.chain_position, now: input.now,
      }) : null;
      if (created) { effectNodeId = created.node_id; effectAttempt = created.attempt; }
      else ctx.db.query("UPDATE runs SET status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
        .run(toIso(input.now), toIso(input.now), input.runId);
    } else if (input.decision === "block") {
      ctx.db.query("UPDATE runs SET status = 'blocked', block_kind = 'orchestrator', updated_at = ? WHERE run_id = ?")
        .run(toIso(input.now), input.runId);
    } else {
      ctx.db.query("UPDATE runs SET status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
        .run(toIso(input.now), toIso(input.now), input.runId);
    }
    ctx.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'idle', orchestrator_owner_token = NULL,
           orchestrator_wrapper_pid = NULL, orchestrator_wrapper_process_start_id = NULL,
           orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
           orchestrator_process_group = NULL, orchestrator_result_path = NULL, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'applying' AND orchestrator_owner_token = ?`,
      )
      .run(toIso(input.now), input.runId, input.ownerToken);
    return { effectNodeId, effectAttempt };
  });
}

/** Owner-guarded owned → pending release; never legal with a live child group. */
export function releaseOrchestratorToPending(ctx: StoreCtx, runId: string, ownerToken: string, now: Date): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL,
           orchestrator_wrapper_pid = NULL, orchestrator_wrapper_process_start_id = NULL,
           orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
           orchestrator_process_group = NULL, orchestrator_result_path = NULL, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?
           AND orchestrator_process_group IS NULL`,
      )
      .run(toIso(now), runId, ownerToken);
    return Number(changes.changes) === 1;
  });
}

/** Operator repair: release an ownerless, processless phase back to pending. */
export function operatorResetOrchestrator(ctx: StoreCtx, runId: string, now: Date): boolean {
  const changes = ctx.db
    .query(
      `UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, updated_at = ?
       WHERE run_id = ? AND orchestrator_owner_token IS NULL AND orchestrator_process_group IS NULL`,
    )
    .run(toIso(now), runId);
  return Number(changes.changes) === 1;
}

function nextCursorAfter(cursor: string, now: Date, everyMs: number): string {
  const from = new Date(cursor).getTime();
  if (!Number.isFinite(from) || everyMs <= 0) throw new GuardRejected("invalid persisted schedule cadence");
  const intervals = Math.floor((now.getTime() - from) / everyMs) + 1;
  return toIso(new Date(from + Math.max(1, intervals) * everyMs));
}
