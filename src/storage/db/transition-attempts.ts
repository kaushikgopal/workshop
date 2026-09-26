import { join } from "node:path";
import { toIso } from "../../util/clock.js";
import { newOwnerToken } from "../../util/generate-ids.js";
import { processStartIdOrThrow } from "../../process/identify-process.js";
import { locateAttemptDir } from "../disk/locate-run-files.js";
import { GuardRejected, type AttemptRow, type BlockKind, type FailureKind, type StoreCtx } from "./types.js";
import { getRun, isTerminal } from "./query-runs.js";
import { assertCapacity } from "./transition-workflows.js";

const LIVE_ATTEMPT_STATUSES = "('pending','running','finishing')";

export function getAttempt(ctx: StoreCtx, runId: string, nodeId: string, attempt: number): AttemptRow | null {
  return (
    ctx.db
      .query<AttemptRow, [string, string, number]>(
        "SELECT * FROM node_attempts WHERE run_id = ? AND node_id = ? AND attempt = ?",
      )
      .get(runId, nodeId, attempt) ?? null
  );
}

export function getLiveAttempt(ctx: StoreCtx, runId: string): AttemptRow | null {
  return (
    ctx.db
      .query<AttemptRow, [string]>(
        `SELECT * FROM node_attempts WHERE run_id = ? AND status IN ${LIVE_ATTEMPT_STATUSES} LIMIT 1`,
      )
      .get(runId) ?? null
  );
}

export function listAttempts(ctx: StoreCtx, runId: string): AttemptRow[] {
  return ctx.db
    .query<AttemptRow, [string]>("SELECT * FROM node_attempts WHERE run_id = ? ORDER BY node_id, attempt")
    .all(runId);
}

/**
 * Create the next attempt. Transactionally re-checks that the run is
 * unresolved, desired_state is running, and the orchestrator phase is idle,
 * and that no live attempt exists for the run.
 */
export function createSuccessorAttempt(ctx: StoreCtx, input: {
  runId: string;
  nodeId: string;
  resolvedMaxAttempts: number;
  resolvedTimeoutMs: number | null;
  chainPosition: number;
  now: Date;
}): AttemptRow {
  return ctx.tx(() => {
    assertRunnable(ctx, input.runId);
    const live = getLiveAttempt(ctx, input.runId);
    if (live) throw new GuardRejected(`run ${input.runId} already has a live attempt (${live.node_id} #${live.attempt})`);
    return insertPendingAttempt(ctx, {
      runId: input.runId, nodeId: input.nodeId, attempt: 1,
      resolvedMaxAttempts: input.resolvedMaxAttempts, resolvedTimeoutMs: input.resolvedTimeoutMs,
      chainPosition: input.chainPosition, now: input.now,
    });
  });
}

/** The next chronological execution number for a run. */
function nextExecutionSeq(ctx: StoreCtx, runId: string): number {
  const row = ctx.db.query<{ m: number | null }, [string]>("SELECT MAX(execution_seq) AS m FROM node_attempts WHERE run_id = ?").get(runId);
  return (row?.m ?? 0) + 1;
}

/** The packet path is minted once per row from the ordered-node layout. */
function packetPathFor(ctx: StoreCtx, runId: string, chainPosition: number, nodeId: string, attempt: number): string {
  const run = getRun(ctx, runId);
  if (!run) throw new GuardRejected(`no run "${runId}"`);
  return join(locateAttemptDir(run.run_dir, chainPosition, nodeId, attempt), "packet.md");
}

/** One pending-attempt insert; the packet path comes from packetPathFor. */
function insertPendingAttempt(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; resolvedMaxAttempts: number;
  resolvedTimeoutMs: number | null; chainPosition: number; now: Date;
}): AttemptRow {
  const seq = nextExecutionSeq(ctx, input.runId);
  const packetPath = packetPathFor(ctx, input.runId, input.chainPosition, input.nodeId, input.attempt);
  ctx.db
    .query(
      `INSERT INTO node_attempts (run_id, node_id, attempt, status, resolved_max_attempts, resolved_timeout_ms,
         chain_position, execution_seq, packet_path, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.runId, input.nodeId, input.attempt, input.resolvedMaxAttempts, input.resolvedTimeoutMs,
      input.chainPosition, seq, packetPath, toIso(input.now));
  const row = getAttempt(ctx, input.runId, input.nodeId, input.attempt);
  if (!row) throw new Error("attempt insert vanished");
  return row;
}

/**
 * Create a retry attempt (attempt n+1). Transactionally re-checks run
 * guards and the resolved attempt bound.
 */
export function createRetryAttempt(ctx: StoreCtx, input: {
  runId: string;
  nodeId: string;
  previousAttempt: number;
  resolvedMaxAttempts: number;
  resolvedTimeoutMs: number | null;
  chainPosition: number;
  now: Date;
}): AttemptRow | null {
  return ctx.tx(() => {
    assertRunnable(ctx, input.runId);
    if (input.previousAttempt >= input.resolvedMaxAttempts) return null;
    const next = input.previousAttempt + 1;
    return insertPendingAttempt(ctx, {
      runId: input.runId, nodeId: input.nodeId, attempt: next,
      resolvedMaxAttempts: input.resolvedMaxAttempts, resolvedTimeoutMs: input.resolvedTimeoutMs,
      chainPosition: input.chainPosition, now: input.now,
    });
  });
}

/**
 * Atomic resume of an operator-resumable blocked run (agent_requested,
 * orchestrator, operator): one transaction clears the blocker, returns the
 * run to running, and creates the fresh retry attempt. The latest blocked
 * attempt is selected by execution sequence — the run's chronological
 * spine — not by node id or attempt number. The retry carries one manual
 * bound extension. Returns the fresh attempt, or null when the run has no
 * blocked attempt to retry.
 */
export function resumeBlockedRun(ctx: StoreCtx, input: { runId: string; now: Date }): AttemptRow | null {
  return ctx.tx(() => {
    const run = getRun(ctx, input.runId);
    if (!run) throw new GuardRejected(`no run "${input.runId}"`);
    if (run.desired_state === "stopped") throw new GuardRejected(`run ${input.runId} is stopped`);
    if (run.status !== "blocked") throw new GuardRejected(`run ${input.runId} is ${run.status}, not blocked`);
    const resumable = ["agent_requested", "orchestrator", "operator"];
    if (!resumable.includes(run.block_kind ?? "")) {
      throw new GuardRejected(`run ${input.runId} block_kind ${run.block_kind} is not operator-resumable`);
    }
    const blocked =
      ctx.db
        .query<AttemptRow, [string]>(
          "SELECT * FROM node_attempts WHERE run_id = ? AND status = 'blocked' ORDER BY execution_seq DESC LIMIT 1",
        )
        .get(input.runId) ?? null;
    if (!blocked) return null;
    const next = blocked.attempt + 1;
    const fresh = insertPendingAttempt(ctx, {
      runId: input.runId, nodeId: blocked.node_id, attempt: next,
      resolvedMaxAttempts: blocked.resolved_max_attempts + 1, // one manual bound extension
      resolvedTimeoutMs: blocked.resolved_timeout_ms,
      chainPosition: blocked.chain_position,
      now: input.now,
    });
    ctx.db
      .query("UPDATE runs SET status = 'running', block_kind = NULL, updated_at = ? WHERE run_id = ? AND status = 'blocked'")
      .run(toIso(input.now), input.runId);
    return fresh;
  });
}

/**
 * Claim pending → running. The claim records the runtime's own (wrapper)
 * identity; the harness child's PID/start-id/PGID is recorded separately in
 * recordChildIdentity immediately after spawn.
 */
export function claimAttempt(ctx: StoreCtx, input: {
  runId: string;
  nodeId: string;
  attempt: number;
  now: Date;
  maxConcurrentRuns: number;
}): { ownerToken: string; pgid: number; startId: string } {
  return ctx.tx(() => {
    assertRunnableForClaim(ctx, input.runId);
    assertCapacity(ctx, input.maxConcurrentRuns);
    const ownerToken = newOwnerToken();
    const startId = processStartIdOrThrow(process.pid);
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET status = 'running', owner_token = ?, wrapper_pid = ?,
           wrapper_process_start_id = ?, worker_pid = ?, worker_process_start_id = ?,
           worker_process_group = NULL, validator_pid = NULL, validator_process_start_id = NULL,
           validator_process_group = NULL, last_heartbeat_at = ?, started_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'pending'`,
      )
      .run(
        ownerToken, process.pid, startId, process.pid, startId,
        toIso(input.now), toIso(input.now), toIso(input.now),
        input.runId, input.nodeId, input.attempt,
      );
    if (Number(changes.changes) !== 1) {
      throw new GuardRejected(`attempt ${input.nodeId} #${input.attempt} in ${input.runId} is not claimable`);
    }
    ctx.db
      .query("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ? AND status = 'queued'")
      .run(toIso(input.now), input.runId);
    return { ownerToken, pgid: process.pid, startId };
  });
}

/** Persist the node-harness child identity immediately after spawn. */
export function recordChildIdentity(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string;
  childPid: number; childStartId: string; childPgid: number; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET worker_pid = ?, worker_process_start_id = ?, worker_process_group = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'
           AND worker_process_group IS NULL`,
      )
      .run(input.childPid, input.childStartId, input.childPgid, toIso(input.now),
        input.runId, input.nodeId, input.attempt, input.ownerToken);
    if (Number(changes.changes) === 1) return true;
    return false;
  });
}

/** Persist the active validator's child identity immediately after spawn. */
export function recordValidatorIdentity(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string;
  childPid: number; childStartId: string; childPgid: number; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET validator_pid = ?, validator_process_start_id = ?, validator_process_group = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'
           AND validator_process_group IS NULL`,
      )
      .run(input.childPid, input.childStartId, input.childPgid, toIso(input.now),
        input.runId, input.nodeId, input.attempt, input.ownerToken);
    if (Number(changes.changes) === 1) return true;
    return false;
  });
}

/** Clear a recorded group only after the caller confirmed the whole PGID dead. */
export function clearAttemptProcessIdentity(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string;
  role: "worker" | "validator"; pid: number; startId: string; pgid: number; now: Date;
}): boolean {
  return ctx.tx(() => {
    const prefix = input.role === "worker" ? "worker" : "validator";
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET ${prefix}_pid = NULL, ${prefix}_process_start_id = NULL,
           ${prefix}_process_group = NULL, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ?
           AND ${prefix}_pid = ? AND ${prefix}_process_start_id = ? AND ${prefix}_process_group = ?
           AND status IN ('running','finishing','blocked')`
      )
      .run(toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken,
        input.pid, input.startId, input.pgid);
    if (Number(changes.changes) === 1) return true;
    return false;
  });
}

/** Stop/recovery clear by exact process identity, without possessing its owner token. */
export function confirmAttemptProcessStopped(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; role: "worker" | "validator";
  pid: number; startId: string; pgid: number; now: Date;
}): boolean {
  const prefix = input.role === "worker" ? "worker" : "validator";
  const changes = ctx.db
    .query(
      `UPDATE node_attempts SET ${prefix}_pid = NULL, ${prefix}_process_start_id = NULL,
         ${prefix}_process_group = NULL, updated_at = ?
       WHERE run_id = ? AND node_id = ? AND attempt = ?
         AND ${prefix}_pid = ? AND ${prefix}_process_start_id = ? AND ${prefix}_process_group = ?`,
    )
    .run(toIso(input.now), input.runId, input.nodeId, input.attempt, input.pid, input.startId, input.pgid);
  return Number(changes.changes) === 1;
}

/** Owner-fenced provenance recorded before execution. */
export function recordResolvedExecution(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string;
  harnessTemplate: string; harnessCommand: string; model: string | null; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET resolved_harness_template = ?, resolved_harness_command = ?, resolved_model = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(input.harnessTemplate, input.harnessCommand, input.model, toIso(input.now),
        input.runId, input.nodeId, input.attempt, input.ownerToken);
    if (Number(changes.changes) === 1) return true;
    return false;
  });
}

/** Owner-guarded heartbeat. */
export function heartbeat(ctx: StoreCtx, input: { runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date }): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET last_heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken);
    if (Number(changes.changes) === 1) return true;
    return false;
  });
}

/** Owner-guarded progress. */
export function setProgress(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string; progress: string; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET current_progress = ?, last_heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(input.progress.slice(0, 2000), toIso(input.now), toIso(input.now),
        input.runId, input.nodeId, input.attempt, input.ownerToken);
    if (Number(changes.changes) === 1) return true;
    return false;
  });
}

/**
 * Owner-fenced evidence barrier (running → finishing). Packet, output, and
 * normalized validator evidence are already durable and flushed; this
 * transition binds the output path and validator verdict atomically, so
 * recovery reads them from the row instead of mutable prose.
 */
export function claimFinishing(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date;
  nodeOutputPath: string; validatorStatus: "passed" | "failed" | null; validatorReason: string | null;
}): void {
  ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET status = 'finishing', node_output_path = ?, validator_status = ?,
           validator_reason = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'
           AND worker_process_group IS NULL AND validator_process_group IS NULL
           AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND desired_state != 'stopped'
                       AND status IN ('queued','running'))`,
      )
      .run(input.nodeOutputPath, input.validatorStatus, input.validatorReason, toIso(input.now),
        input.runId, input.nodeId, input.attempt, input.ownerToken, input.runId);
    if (Number(changes.changes) === 1) return;
    throw new GuardRejected("stale owner or active process group cannot finish");
  });
}

/** Owner-guarded completion plus successor creation in one transaction.
 * Evidence fields were bound at claimFinishing; only the finishing owner
 * can complete. */
export function completeAttempt(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string;
  now: Date;
  successor: { nodeId: string; resolvedMaxAttempts: number; resolvedTimeoutMs: number | null; chainPosition: number } | null;
}): { completed: boolean; successorCreated: boolean } {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET status = 'completed', finished_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'finishing'
           AND worker_process_group IS NULL AND validator_process_group IS NULL
           AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND desired_state != 'stopped'
                       AND status IN ('queued','running'))`,
      )
      .run(toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken, input.runId);
    if (Number(changes.changes) !== 1) {
      throw new GuardRejected("stale owner cannot complete");
    }

    let successorCreated = false;
    const run = getRun(ctx, input.runId)!;
    if (input.successor && run.desired_state === "running") {
      createSuccessorAttempt(ctx, { runId: input.runId, nodeId: input.successor.nodeId,
        resolvedMaxAttempts: input.successor.resolvedMaxAttempts,
        resolvedTimeoutMs: input.successor.resolvedTimeoutMs,
        chainPosition: input.successor.chainPosition, now: input.now });
      successorCreated = true;
    }
    if (successorCreated) {
      ctx.db.query("UPDATE runs SET updated_at = ? WHERE run_id = ?").run(toIso(input.now), input.runId);
    } else if (input.successor === null) {
      ctx.db
        .query("UPDATE runs SET status = 'completed', block_kind = NULL, finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued','running')")
        .run(toIso(input.now), toIso(input.now), input.runId);
    } else if (run.desired_state === "paused") {
      ctx.db
        .query("UPDATE runs SET status = 'paused', updated_at = ? WHERE run_id = ? AND status IN ('queued','running')")
        .run(toIso(input.now), input.runId);
    }
    return { completed: true, successorCreated };
  });
}

/** Owner-guarded agent-requested block (running → blocked). */
export function blockAttempt(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string;
  blockKind: BlockKind; reason: string; now: Date;
}): boolean {
  return ctx.tx(() => {
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET status = 'blocked', block_kind = ?, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(input.blockKind, toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken);
    if (Number(changes.changes) !== 1) return false;
    ctx.db
      .query("UPDATE runs SET status = 'blocked', block_kind = ?, updated_at = ? WHERE run_id = ? AND desired_state != 'stopped'")
      .run(input.blockKind, toIso(input.now), input.runId);
    return true;
  });
}

/** Fail only after every recorded attempt group is confirmed dead. */
export function failAttempt(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; ownerToken: string | null;
  failureKind: FailureKind; validatorReason?: string | null; protectForOrchestration?: boolean; now: Date;
}): { failed: boolean; orchestratorPending: boolean } {
  return ctx.tx(() => {
    const attempt = getAttempt(ctx, input.runId, input.nodeId, input.attempt);
    const effectiveOwner = input.ownerToken ?? attempt?.owner_token ?? null;
    if (!attempt || effectiveOwner === null || attempt.owner_token !== effectiveOwner) {
      throw new GuardRejected("stale owner cannot fail attempt");
    }
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET status = 'failed', failure_kind = ?,
           validator_status = CASE WHEN ? = 'validator_rejection' THEN 'failed' ELSE validator_status END,
           validator_reason = COALESCE(?, validator_reason), finished_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ?
           AND status IN ('running','finishing')
           AND worker_process_group IS NULL AND validator_process_group IS NULL
           AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND desired_state != 'stopped')`,
      )
      .run(input.failureKind, input.failureKind, input.validatorReason ?? null, toIso(input.now), toIso(input.now),
        input.runId, input.nodeId, input.attempt, effectiveOwner, input.runId);
    if (Number(changes.changes) !== 1) {
      return { failed: false, orchestratorPending: false };
    }
    if (input.protectForOrchestration === false) return { failed: true, orchestratorPending: false };
    const phaseChanges = ctx.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL,
           orchestrator_wrapper_pid = NULL, orchestrator_wrapper_process_start_id = NULL,
           orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
           orchestrator_process_group = NULL, orchestrator_result_path = NULL, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'idle' AND desired_state != 'stopped'`,
      )
      .run(toIso(input.now), input.runId);
    return { failed: true, orchestratorPending: Number(phaseChanges.changes) === 1 };
  });
}

/** Recovery owner transfer after every recorded group is confirmed dead. */
export function transferFinishingOwner(ctx: StoreCtx, input: {
  runId: string; nodeId: string; attempt: number; priorOwnerToken: string; now: Date;
}): string | null {
  return ctx.tx(() => {
    const newToken = newOwnerToken();
    const changes = ctx.db
      .query(
        `UPDATE node_attempts SET owner_token = ?, wrapper_pid = ?, wrapper_process_start_id = ?,
           worker_pid = ?, worker_process_start_id = ?, worker_process_group = NULL, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'finishing'
           AND worker_process_group IS NULL AND validator_process_group IS NULL
           AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND desired_state != 'stopped')`,
      )
      .run(newToken, process.pid, processStartIdOrThrow(process.pid), process.pid,
        processStartIdOrThrow(process.pid), toIso(input.now), input.runId, input.nodeId, input.attempt,
        input.priorOwnerToken, input.runId);
    if (Number(changes.changes) === 1) return newToken;
    return null;
  });
}

/** Run must be unresolved, prepared, desired running, orchestrator idle. */
export function assertRunnableForClaim(ctx: StoreCtx, runId: string): void {
  const run = getRun(ctx, runId);
  if (!run) throw new GuardRejected(`no run "${runId}"`);
  if (run.admission_state !== "ready") throw new GuardRejected(`run ${runId} admission is ${run.admission_state}`);
  if (!["queued", "running"].includes(run.status)) {
    throw new GuardRejected(`run ${runId} is ${run.status}, not claimable`);
  }
  if (run.desired_state !== "running") throw new GuardRejected(`run ${runId} desired_state is ${run.desired_state}`);
  if (run.orchestrator_phase !== "idle") {
    throw new GuardRejected(`run ${runId} orchestrator phase is ${run.orchestrator_phase}`);
  }
}

/** Unresolved + desired running (orchestrator phase tolerated). */
export function assertRunnable(ctx: StoreCtx, runId: string): void {
  const run = getRun(ctx, runId);
  if (!run) throw new GuardRejected(`no run "${runId}"`);
  if (isTerminal(run.status)) throw new GuardRejected(`run ${runId} is ${run.status}`);
  if (run.status === "blocked") throw new GuardRejected(`run ${runId} is blocked (${run.block_kind})`);
  if (run.desired_state === "stopped") throw new GuardRejected(`run ${runId} is stopped`);
  if (run.desired_state === "paused") throw new GuardRejected(`run ${runId} is paused`);
}
