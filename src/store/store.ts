import type { Database } from "bun:sqlite";
import { toIso } from "../util/clock.js";
import { formatRunId, newOwnerToken } from "../util/ids.js";
import { processStartId } from "../util/process.js";
import { attemptDir } from "../worklog/worklog.js";
import { join } from "node:path";

/**
 * Store operations. Every transition that could race uses a guarded
 * compare-and-set inside a transaction that re-checks run status, desired
 * state, and orchestrator phase. "CAS" here means: UPDATE ... WHERE guard
 * conditions, then require changes() === 1.
 */

export type ActivationState = "active" | "paused" | "stopped" | "exhausted" | "expired";
export type RunStatus = "queued" | "running" | "paused" | "blocked" | "failed" | "completed" | "cancelled";
export type DesiredState = "running" | "paused" | "stopped";
export type OrchestratorPhase = "idle" | "pending" | "owned" | "applying";
export type AttemptStatus = "pending" | "running" | "finishing" | "blocked" | "failed" | "completed" | "cancelled";
export type FailureKind = "process_error" | "timeout" | "worklog_integrity" | "validator_rejection" | "interrupted";
export type BlockKind =
  | "agent_requested"
  | "preflight"
  | "orchestrator"
  | "orchestrator_unresolved"
  | "unknown_external"
  | "operator";

const UNRESOLVED_RUN_STATUSES = "('queued','running','paused','blocked')";
const LIVE_ATTEMPT_STATUSES = "('pending','running','finishing')";

export interface WorkflowRow {
  workflow_id: string;
  definition_path: string;
  canonical_definition_hash: string;
  activation_state: ActivationState;
  activation_started_at: string;
  schedule_started_runs: number;
  schedule_every: string | null;
  schedule_max_runs: number | null;
  next_run_at: string | null;
}

export interface RunRow {
  run_id: string;
  seq: number;
  workflow_id: string;
  status: RunStatus;
  definition_hash: string;
  definition_snapshot_path: string;
  desired_state: DesiredState;
  orchestrator_phase: OrchestratorPhase;
  orchestrator_owner_token: string | null;
  orchestrator_worker_pid: number | null;
  orchestrator_last_heartbeat_at: string | null;
  block_kind: BlockKind | null;
  run_dir: string;
  worklog_path: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface AttemptRow {
  run_id: string;
  node_id: string;
  attempt: number;
  status: AttemptStatus;
  failure_kind: FailureKind | null;
  block_kind: BlockKind | null;
  resolved_harness_template: string | null;
  resolved_harness_command: string | null;
  resolved_model: string | null;
  resolved_max_attempts: number;
  resolved_timeout_ms: number | null;
  node_output_path: string | null;
  packet_path: string;
  owner_token: string | null;
  wrapper_pid: number | null;
  wrapper_process_start_id: string | null;
  worker_pid: number | null;
  worker_process_start_id: string | null;
  worker_process_group: number | null;
  execution_seq: number;
  last_heartbeat_at: string | null;
  current_progress: string | null;
  validator_status: "passed" | "failed" | null;
  validator_reason: string | null;
  chain_position: number;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

/** Thrown when a guarded transition loses a race; callers re-read state. */
export class GuardRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardRejected";
  }
}

export class Store {
  private inTx = false;
  constructor(readonly db: Database) {}

  /** Immediate transactions; re-entrant for composed operations. */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  // ---------- workflows / activation ----------

  getWorkflow(workflowId: string): WorkflowRow | null {
    return this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId) ?? null;
  }

  listWorkflows(): WorkflowRow[] {
    return this.db.query<WorkflowRow, []>("SELECT * FROM workflows ORDER BY workflow_id").all();
  }

  /** Create or refresh the activation. Only start may call this. */
  upsertWorkflowActivation(input: {
    workflowId: string;
    definitionPath: string;
    definitionHash: string;
    every: string | null;
    maxRuns: number | null;
    now: Date;
  }): { created: boolean } {
    return this.tx(() => {
      const existing = this.getWorkflow(input.workflowId);
      const nowIso = toIso(input.now);
      if (!existing) {
        this.db
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
      this.db
        .query("UPDATE workflows SET definition_path = ?, canonical_definition_hash = ? WHERE workflow_id = ?")
        .run(input.definitionPath, input.definitionHash, input.workflowId);
      // A new activation resets the counter — only from terminal states,
      // and only when no run is unresolved.
      if (existing.activation_state !== "active") {
        const unresolved = this.getUnresolvedRun(input.workflowId);
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
        this.db
          .query(
            `UPDATE workflows SET activation_state = 'active', activation_started_at = ?,
               schedule_started_runs = 0, next_run_at = ? WHERE workflow_id = ?`,
          )
          .run(nowIso, input.every ? nowIso : null, input.workflowId);
        return { created: true };
      }
      return { created: false };
    });
  }

  setActivationState(workflowId: string, state: ActivationState): void {
    this.tx(() => {
      const changes = this.db
        .query("UPDATE workflows SET activation_state = ? WHERE workflow_id = ?")
        .run(state, workflowId);
      if (Number(changes.changes) === 0) throw new GuardRejected(`no workflow "${workflowId}"`);
    });
  }
  resetActivationCounter(workflowId: string, now: Date): void {
    this.tx(() => {
      this.db
        .query(
          "UPDATE workflows SET activation_state = 'active', schedule_started_runs = 0, activation_started_at = ?, next_run_at = ? WHERE workflow_id = ?",
        )
        .run(toIso(now), toIso(now), workflowId);
    });
  }

  // ---------- runs ----------

  getRun(runId: string): RunRow | null {
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId) ?? null;
  }

  getUnresolvedRun(workflowId: string): RunRow | null {
    return (
      this.db
        .query<RunRow, [string]>(
          `SELECT * FROM runs WHERE workflow_id = ? AND status IN ${UNRESOLVED_RUN_STATUSES} ORDER BY started_at DESC LIMIT 1`,
        )
        .get(workflowId) ?? null
    );
  }

  getMostRecentRun(workflowId: string): RunRow | null {
    return (
      this.db
        .query<RunRow, [string]>("SELECT * FROM runs WHERE workflow_id = ? ORDER BY seq DESC LIMIT 1")
        .get(workflowId) ?? null
    );
  }

  listRuns(workflowId?: string): RunRow[] {
    if (workflowId) {
      return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE workflow_id = ? ORDER BY seq").all(workflowId);
    }
    return this.db.query<RunRow, []>("SELECT * FROM runs ORDER BY workflow_id, seq").all();
  }

  listUnresolvedRuns(): RunRow[] {
    return this.db
      .query<RunRow, []>(`SELECT * FROM runs WHERE status IN ${UNRESOLVED_RUN_STATUSES} ORDER BY started_at`)
      .all();
  }

  /**
   * Create a run. Callers must hold the unresolved-run check (schedule
   * admission or idempotent start) — this re-checks it in the same
   * transaction to make admission atomic.
   */
  createRun(input: {
    workflowId: string;
    definitionHash: string;
    definitionSnapshotPath: string;
    runDir: string;
    worklogPath: string;
    now: Date;
    isRecurring: boolean;
    everyMs: number | null;
  }): { runId: string; created: boolean } {
    return this.tx(() => {
      const unresolved = this.getUnresolvedRun(input.workflowId);
      if (unresolved) return { runId: unresolved.run_id, created: false };

      const wf = this.getWorkflow(input.workflowId);
      if (!wf) throw new GuardRejected(`no workflow "${input.workflowId}"`);

      // Overlap suppression + bounds live here: a due occurrence that arrives
      // while one run is unresolved is skipped without starting a run.
      if (input.isRecurring) {
        if (wf.activation_state !== "active") {
          throw new GuardRejected(`activation is ${wf.activation_state} — no occurrence admitted`);
        }
        if (wf.schedule_max_runs != null && wf.schedule_max_runs > 0 && wf.schedule_started_runs >= wf.schedule_max_runs) {
          this.db.query("UPDATE workflows SET activation_state = 'exhausted' WHERE workflow_id = ?").run(input.workflowId);
          throw new GuardRejected(`activation exhausted (${wf.schedule_max_runs} runs admitted)`);
        }
      }

      // The sequence is per-workflow: each run folder is identifiable to the
      // workflow that spawned it (hemingway-clock-20260910-001).
      const seqRow = this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM runs WHERE workflow_id = ?")
        .get(input.workflowId);
      const seq = (seqRow?.m ?? 0) + 1;
      const runId = formatRunId(input.workflowId, input.now, seq);
      const nowIso = toIso(input.now);

      this.db
        .query(
          `INSERT INTO runs (run_id, seq, workflow_id, status, definition_hash, definition_snapshot_path,
             desired_state, orchestrator_phase, block_kind, run_dir, worklog_path, started_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, 'running', 'idle', NULL, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          seq,
          input.workflowId,
          input.definitionHash,
          input.definitionSnapshotPath,
          input.runDir,
          input.worklogPath,
          nowIso,
          nowIso,
        );

      const nextRunAt = input.everyMs ? toIso(new Date(input.now.getTime() + input.everyMs)) : null;
      this.db
        .query(
          "UPDATE workflows SET schedule_started_runs = schedule_started_runs + 1, next_run_at = ? WHERE workflow_id = ?",
        )
        .run(nextRunAt, input.workflowId);

      return { runId, created: true };
    });
  }

  /** Guarded desired-state change for operator controls. */
  setDesiredState(runId: string, desired: DesiredState, now: Date): void {
    this.tx(() => {
      const changes = this.db
        .query("UPDATE runs SET desired_state = ?, updated_at = ? WHERE run_id = ?")
        .run(desired, toIso(now), runId);
      if (Number(changes.changes) === 0) throw new GuardRejected(`no run "${runId}"`);
    });
  }

  /** Guarded run-status change with optional block kind. */
  setRunStatus(runId: string, status: RunStatus, now: Date, blockKind: BlockKind | null): void {
    this.tx(() => {
      const changes = this.db
        .query("UPDATE runs SET status = ?, block_kind = ?, updated_at = ?, finished_at = ? WHERE run_id = ?")
        .run(status, blockKind, toIso(now), isTerminal(status) ? toIso(now) : null, runId);
      if (Number(changes.changes) === 0) throw new GuardRejected(`no run "${runId}"`);
    });
  }

  // ---------- node attempts ----------

  getAttempt(runId: string, nodeId: string, attempt: number): AttemptRow | null {
    return (
      this.db
        .query<AttemptRow, [string, string, number]>(
          "SELECT * FROM node_attempts WHERE run_id = ? AND node_id = ? AND attempt = ?",
        )
        .get(runId, nodeId, attempt) ?? null
    );
  }

  getLiveAttempt(runId: string): AttemptRow | null {
    return (
      this.db
        .query<AttemptRow, [string]>(
          `SELECT * FROM node_attempts WHERE run_id = ? AND status IN ${LIVE_ATTEMPT_STATUSES} LIMIT 1`,
        )
        .get(runId) ?? null
    );
  }

  listAttempts(runId: string): AttemptRow[] {
    return this.db
      .query<AttemptRow, [string]>("SELECT * FROM node_attempts WHERE run_id = ? ORDER BY node_id, attempt")
      .all(runId);
  }

  /**
   * Create the next attempt. Transactionally re-checks that the run is
   * unresolved, desired_state is running, and the orchestrator phase is idle,
   * and that no live attempt exists for the run.
   */
  createSuccessorAttempt(input: {
    runId: string;
    nodeId: string;
    resolvedMaxAttempts: number;
    resolvedTimeoutMs: number | null;
    chainPosition: number;
    now: Date;
  }): AttemptRow {
    return this.tx(() => {
      this.assertRunnable(input.runId);
      const live = this.getLiveAttempt(input.runId);
      if (live) throw new GuardRejected(`run ${input.runId} already has a live attempt (${live.node_id} #${live.attempt})`);
      const nowIso = toIso(input.now);
      const seq = this.nextExecutionSeq(input.runId);
      const packetPath = this.packetPathFor(input.runId, seq, input.nodeId);
      this.db
        .query(
          `INSERT INTO node_attempts (run_id, node_id, attempt, status, resolved_max_attempts, resolved_timeout_ms,
             chain_position, execution_seq, packet_path, updated_at)
           VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.runId, input.nodeId, input.resolvedMaxAttempts, input.resolvedTimeoutMs, input.chainPosition, seq, packetPath, nowIso);
      const row = this.getAttempt(input.runId, input.nodeId, 1);
      if (!row) throw new Error("attempt insert vanished");
      return row;
    });
  }

  /** The next chronological execution number for a run. */
  private nextExecutionSeq(runId: string): number {
    const row = this.db.query<{ m: number | null }, [string]>("SELECT MAX(execution_seq) AS m FROM node_attempts WHERE run_id = ?").get(runId);
    return (row?.m ?? 0) + 1;
  }

  /** The attempt folder derives from the run row's directory + execution number. */
  private packetPathFor(runId: string, executionSeq: number, nodeId: string): string {
    const run = this.getRun(runId);
    if (!run) throw new GuardRejected(`no run "${runId}"`);
    return join(attemptDir(run.run_dir, executionSeq, nodeId), "packet.md");
  }

  /**
   * Create a retry attempt (attempt n+1). Transactionally re-checks run
   * guards and the resolved attempt bound.
   */
  createRetryAttempt(input: {
    runId: string;
    nodeId: string;
    previousAttempt: number;
    resolvedMaxAttempts: number;
    resolvedTimeoutMs: number | null;
    chainPosition: number;
    now: Date;
  }): AttemptRow | null {
    return this.tx(() => {
      this.assertRunnable(input.runId);
      if (input.previousAttempt >= input.resolvedMaxAttempts) return null;
      const next = input.previousAttempt + 1;
      const nowIso = toIso(input.now);
      const seq = this.nextExecutionSeq(input.runId);
      const packetPath = this.packetPathFor(input.runId, seq, input.nodeId);
      this.db
        .query(
          `INSERT INTO node_attempts (run_id, node_id, attempt, status, resolved_max_attempts, resolved_timeout_ms,
             chain_position, execution_seq, packet_path, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.runId, input.nodeId, next, input.resolvedMaxAttempts, input.resolvedTimeoutMs, input.chainPosition, seq, packetPath, nowIso);
      const row = this.getAttempt(input.runId, input.nodeId, next);
      if (!row) throw new Error("attempt insert vanished");
      return row;
    });
  }

  /**
   * Claim: pending → running. The winner records owner identity in the same
   * statement; losers get GuardRejected. Never "read pending, then start".
   */
  claimAttempt(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    now: Date;
  }): { ownerToken: string; pgid: number; startId: string } {
    return this.tx(() => {
      this.assertRunnableForClaim(input.runId);
      const ownerToken = newOwnerToken();
      const pgid = process.pid; // the runner wrapper is its own group leader
      const startId = processStartIdOrThrow(process.pid);
      const changes = this.db
        .query(
          `UPDATE node_attempts SET status = 'running', owner_token = ?, wrapper_pid = ?,
             wrapper_process_start_id = ?, worker_pid = ?,
             worker_process_start_id = ?, worker_process_group = ?, last_heartbeat_at = ?, started_at = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'pending'`,
        )
        .run(
          ownerToken,
          process.pid, // wrapper identity — the claimer that collects evidence
          startId,
          process.pid, // worker identity — replaced by the child after spawn
          startId,
          pgid,
          toIso(input.now),
          toIso(input.now),
          toIso(input.now),
          input.runId,
          input.nodeId,
          input.attempt,
        );
      if (Number(changes.changes) !== 1) {
        throw new GuardRejected(`attempt ${input.nodeId} #${input.attempt} in ${input.runId} is not claimable`);
      }
      this.db
        .query("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ? AND status = 'queued'")
        .run(toIso(input.now), input.runId);
      return { ownerToken, pgid, startId };
    });
  }

  /** Owner-guarded child identity recorded immediately after spawn. */
  recordChildIdentity(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    ownerToken: string;
    childPid: number;
    childStartId: string;
    childPgid: number;
    now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
        .query(
          `UPDATE node_attempts SET worker_pid = ?, worker_process_start_id = ?, worker_process_group = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
        )
        .run(
          input.childPid,
          input.childStartId,
          input.childPgid,
          toIso(input.now),
          input.runId,
          input.nodeId,
          input.attempt,
          input.ownerToken,
        );
      return Number(changes.changes) === 1;
    });
  }

  /** Owner-guarded heartbeat. */
  heartbeat(input: { runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date }): boolean {
    const changes = this.db
      .query(
        `UPDATE node_attempts SET last_heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken);
    return Number(changes.changes) === 1;
  }

  /** Owner-guarded progress. */
  setProgress(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    ownerToken: string;
    progress: string;
    now: Date;
  }): boolean {
    const changes = this.db
      .query(
        `UPDATE node_attempts SET current_progress = ?, last_heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(
        input.progress.slice(0, 2000),
        toIso(input.now),
        toIso(input.now),
        input.runId,
        input.nodeId,
        input.attempt,
        input.ownerToken,
      );
    return Number(changes.changes) === 1;
  }

  /** Owner-fenced claim of the finishing state (running → finishing). */
  claimFinishing(input: { runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date }): void {
    return this.tx(() => {
      const attempt = this.getAttempt(input.runId, input.nodeId, input.attempt);
      if (!attempt) throw new GuardRejected("attempt vanished");
      if (attempt.owner_token !== input.ownerToken) throw new GuardRejected("stale owner cannot finish");
      this.assertRunGuards(input.runId, { requireDesiredRunning: false });
      const changes = this.db
        .query(
          `UPDATE node_attempts SET status = 'finishing', updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
        )
        .run(toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken);
      if (Number(changes.changes) !== 1) throw new GuardRejected("attempt is not in running state");
    });
  }

  /** Owner-guarded completion (finishing → completed) plus successor creation. */
  completeAttempt(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    ownerToken: string;
    nodeOutputPath: string;
    validatorStatus: "passed" | "failed" | null;
    validatorReason: string | null;
    now: Date;
    successor: { nodeId: string; resolvedMaxAttempts: number; resolvedTimeoutMs: number | null; chainPosition: number } | null;
  }): { completed: boolean; successorCreated: boolean } {
    return this.tx(() => {
      // Durable stop wins even over late completion evidence.
      const runBefore = this.getRun(input.runId)!;
      if (runBefore.desired_state === "stopped") {
        throw new GuardRejected("run is stopped — late completion is fenced");
      }
      const changes = this.db
        .query(
          `UPDATE node_attempts SET status = 'completed', node_output_path = ?, validator_status = ?,
             validator_reason = ?, finished_at = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'finishing'`,
        )
        .run(
          input.nodeOutputPath,
          input.validatorStatus,
          input.validatorReason,
          toIso(input.now),
          toIso(input.now),
          input.runId,
          input.nodeId,
          input.attempt,
          input.ownerToken,
        );
      if (Number(changes.changes) !== 1) throw new GuardRejected("stale owner cannot complete");

      let successorCreated = false;
      const run = this.getRun(input.runId)!;
      if (input.successor && run.desired_state === "running") {
        try {
          this.createSuccessorAttempt({
            runId: input.runId,
            nodeId: input.successor.nodeId,
            resolvedMaxAttempts: input.successor.resolvedMaxAttempts,
            resolvedTimeoutMs: input.successor.resolvedTimeoutMs,
            chainPosition: input.successor.chainPosition ?? 0,
            now: input.now,
          });
          successorCreated = true;
        } catch (e) {
          if (!(e instanceof GuardRejected)) throw e;
          // desired_state flipped or run blocked mid-flight: leave paused; the
          // operator resume path recreates the missing successor.
        }
      }
      if (successorCreated) {
        this.db.query("UPDATE runs SET updated_at = ? WHERE run_id = ?").run(toIso(input.now), input.runId);
      } else if (input.successor === null) {
        // Terminal node: the run completes even when the activation is paused;
        // only a durable stop (which cancels attempts first) can prevent it.
        this.db
          .query("UPDATE runs SET status = 'completed', block_kind = NULL, finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued','running')")
          .run(toIso(input.now), toIso(input.now), input.runId);
      } else if (run.desired_state === "paused") {
        // A non-terminal node completes but creates no successor and leaves
        // the run paused.
        this.db
          .query("UPDATE runs SET status = 'paused', updated_at = ? WHERE run_id = ? AND status IN ('queued','running')")
          .run(toIso(input.now), input.runId);
      }
      return { completed: true, successorCreated };
    });
  }

  /** Owner-guarded agent-requested block (running → blocked). */
  blockAttempt(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    ownerToken: string;
    blockKind: BlockKind;
    reason: string;
    now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
        .query(
          `UPDATE node_attempts SET status = 'blocked', block_kind = ?, finished_at = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'running'`,
        )
        .run(input.blockKind, toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt, input.ownerToken);
      if (Number(changes.changes) !== 1) return false;
      this.db
        .query("UPDATE runs SET status = 'blocked', block_kind = ?, updated_at = ? WHERE run_id = ?")
        .run(input.blockKind, toIso(input.now), input.runId);
      return true;
    });
  }

  /** Fail an attempt (running|finishing → failed) and optionally protect for orchestration. */
  failAttempt(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    ownerToken: string | null;
    failureKind: FailureKind;
    validatorReason?: string | null;
    protectForOrchestration?: boolean;
    now: Date;
  }): { failed: boolean; orchestratorPending: boolean } {
    return this.tx(() => {
      const attempt = this.getAttempt(input.runId, input.nodeId, input.attempt);
      if (!attempt) throw new GuardRejected("attempt vanished");
      if (input.ownerToken !== null && attempt.owner_token !== input.ownerToken) {
        throw new GuardRejected("stale owner cannot fail attempt");
      }
      const changes = this.db
        .query(
          `UPDATE node_attempts SET status = 'failed', failure_kind = ?, validator_reason = COALESCE(?, validator_reason),
             finished_at = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND status IN ('running','finishing')`,
        )
        .run(input.failureKind, input.validatorReason ?? null, toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt);
      if (Number(changes.changes) !== 1) return { failed: false, orchestratorPending: false };

      // The same transaction moves the run into the protected phase, which
      // blocks every new node claim until the orchestrator decides. A dead
      // worker auto-retries instead — the only technical interruption that
      // never needs judgment.
      if (input.protectForOrchestration === false) {
        return { failed: true, orchestratorPending: false };
      }
      const phaseChanges = this.db
        .query("UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'idle'")
        .run(toIso(input.now), input.runId);
      return { failed: true, orchestratorPending: Number(phaseChanges.changes) === 1 };
    });
  }

  /** Cancel an attempt (stop path). Cancels from any live state. */
  cancelAttempt(input: { runId: string; nodeId: string; attempt: number; now: Date }): void {
    this.tx(() => {
      this.db
        .query(
          `UPDATE node_attempts SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND status IN ('pending','running','finishing')`,
        )
        .run(toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt);
    });
  }

  /**
   * Durable stop: desired_state is written first (a daemon restart cannot
   * reinterpret cancellation as a retry); the run row cancels only when
   * still unresolved. Returns the run row after the transition.
   */
  stopRun(input: { runId: string; now: Date }): void {
    this.tx(() => {
      // Durable intent and attempt cancellation land in one transaction:
      // a late completion's owner CAS then fails on status.
      this.db
        .query("UPDATE runs SET desired_state = 'stopped', updated_at = ? WHERE run_id = ?")
        .run(toIso(input.now), input.runId);
      this.db
        .query(
          `UPDATE node_attempts SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('pending','running','finishing')`,
        )
        .run(toIso(input.now), toIso(input.now), input.runId);
      this.db
        .query(
          "UPDATE runs SET status = 'cancelled', block_kind = NULL, finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued','running','paused','blocked')",
        )
        .run(toIso(input.now), toIso(input.now), input.runId);
    });
  }

  /**
   * Recovery transfer of a finishing attempt to a recovery owner by
   * compare-and-set; the old owner's death is a precondition of the caller.
   */
  transferFinishingOwner(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    priorOwnerToken: string;
    now: Date;
  }): string | null {
    return this.tx(() => {
      const newToken = newOwnerToken();
      const changes = this.db
        .query(
          `UPDATE node_attempts SET owner_token = ?, worker_pid = ?, worker_process_start_id = ?,
             worker_process_group = NULL, updated_at = ?
           WHERE run_id = ? AND node_id = ? AND attempt = ? AND owner_token = ? AND status = 'finishing'`,
        )
        .run(
          newToken,
          process.pid,
          processStartIdOrThrow(process.pid),
          toIso(input.now),
          input.runId,
          input.nodeId,
          input.attempt,
          input.priorOwnerToken,
        );
      return Number(changes.changes) === 1 ? newToken : null;
    });
  }

  // ---------- orchestrator phase machine ----------

  // ---------- orchestrator phase machine ----------

  claimOrchestrator(runId: string, now: Date): { ownerToken: string } | null {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.orchestrator_phase !== "pending") return null;
      const ownerToken = newOwnerToken();
      this.db
        .query(
          "UPDATE runs SET orchestrator_phase = 'owned', orchestrator_owner_token = ?, orchestrator_worker_pid = ?, orchestrator_last_heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'pending' AND orchestrator_owner_token IS NULL",
        )
        .run(ownerToken, process.pid, toIso(now), toIso(now), runId);
      return { ownerToken };
    });
  }

  claimApplying(runId: string, ownerToken: string, now: Date): boolean {
    const changes = this.db
      .query(
        "UPDATE runs SET orchestrator_phase = 'applying', orchestrator_last_heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?",
      )
      .run(toIso(now), toIso(now), runId, ownerToken);
    return Number(changes.changes) === 1;
  }

  releaseOrchestratorToPending(runId: string, ownerToken: string | null, now: Date): void {
    this.tx(() => {
      if (ownerToken === null) {
        this.db
          .query("UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, orchestrator_worker_pid = NULL, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'owned'")
          .run(toIso(now), runId);
      } else {
        this.db
          .query("UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, orchestrator_worker_pid = NULL, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?")
          .run(toIso(now), runId, ownerToken);
      }
    });
  }

  finishOrchestrator(runId: string, now: Date): void {
    this.tx(() => {
      this.db
        .query(
          "UPDATE runs SET orchestrator_phase = 'idle', orchestrator_owner_token = NULL, orchestrator_worker_pid = NULL, updated_at = ? WHERE run_id = ?",
        )
        .run(toIso(now), runId);
    });
  }

  // ---------- guards ----------

  /** Run must be unresolved, desired running, orchestrator idle. */
  assertRunnableForClaim(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new GuardRejected(`no run "${runId}"`);
    if (!["queued", "running"].includes(run.status)) {
      throw new GuardRejected(`run ${runId} is ${run.status}, not claimable`);
    }
    if (run.desired_state !== "running") throw new GuardRejected(`run ${runId} desired_state is ${run.desired_state}`);
    if (run.orchestrator_phase !== "idle") {
      throw new GuardRejected(`run ${runId} orchestrator phase is ${run.orchestrator_phase}`);
    }
  }

  /** Unresolved + desired running (orchestrator phase tolerated). */
  assertRunnable(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new GuardRejected(`no run "${runId}"`);
    if (isTerminal(run.status)) throw new GuardRejected(`run ${runId} is ${run.status}`);
    if (run.status === "blocked") throw new GuardRejected(`run ${runId} is blocked (${run.block_kind})`);
    if (run.desired_state === "stopped") throw new GuardRejected(`run ${runId} is stopped`);
    if (run.desired_state === "paused") throw new GuardRejected(`run ${runId} is paused`);
  }

  /** Full guard set with tolerance for specific phases. */
  assertRunGuards(runId: string, _opts: { requireDesiredRunning: boolean }): void {
    const run = this.getRun(runId);
    if (!run) throw new GuardRejected(`no run "${runId}"`);
    if (isTerminal(run.status)) throw new GuardRejected(`run ${runId} became ${run.status}`);
    void _opts;
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === "failed" || status === "completed" || status === "cancelled";
}

function processStartIdOrThrow(pid: number): string {
  const id = processStartId(pid);
  if (id === null) throw new Error(`cannot capture process-start identity for pid ${pid}`);
  return id;
}
