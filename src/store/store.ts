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
  orchestrator_wrapper_pid: number | null;
  orchestrator_wrapper_process_start_id: string | null;
  orchestrator_worker_pid: number | null;
  orchestrator_worker_process_start_id: string | null;
  orchestrator_process_group: number | null;
  orchestrator_last_heartbeat_at: string | null;
  orchestrator_result_path: string | null;
  block_kind: BlockKind | null;
  run_dir: string;
  worklog_path: string;
  admission_state: "pending" | "ready" | "blocked";
  admission_definition_yaml: string | null;
  admission_error: string | null;
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
  validator_pid: number | null;
  validator_process_start_id: string | null;
  validator_process_group: number | null;
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

/** A claim rejected only because all top-level execution slots are occupied. */
export class CapacityRejected extends GuardRejected {
  constructor() {
    super("execution capacity is full");
    this.name = "CapacityRejected";
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
               schedule_started_runs = 0, schedule_every = ?, schedule_max_runs = ?, next_run_at = ?
             WHERE workflow_id = ?`,
          )
          .run(nowIso, input.every, input.maxRuns, input.every ? nowIso : null, input.workflowId);
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

  listPendingAdmissions(): RunRow[] {
    return this.db
      .query<RunRow, []>("SELECT * FROM runs WHERE admission_state = 'pending' ORDER BY started_at, run_id")
      .all();
  }

  /**
   * Reserve a run with final artifact paths and exact validated source bytes.
   * Scheduled overlap consumption and run creation are serialized here so
   * competing connections cannot duplicate a run or shift the cadence.
   */
  createRun(input: {
    workflowId: string;
    definitionHash: string;
    definitionYaml: string;
    runsDir: string;
    now: Date;
    mode: "manual" | "scheduled";
    isRecurring: boolean;
    everyMs: number | null;
  }): { runId: string; created: boolean } {
    return this.tx(() => {
      const wf = this.getWorkflow(input.workflowId);
      if (!wf) throw new GuardRejected(`no workflow "${input.workflowId}"`);

      if (input.isRecurring) {
        if (!wf.schedule_every || input.everyMs === null) throw new GuardRejected("workflow is not scheduled");
        if (wf.activation_state !== "active") {
          throw new GuardRejected(`activation is ${wf.activation_state} — no occurrence admitted`);
        }
        if (wf.schedule_max_runs != null && wf.schedule_max_runs > 0 && wf.schedule_started_runs >= wf.schedule_max_runs) {
          this.db.query("UPDATE workflows SET activation_state = 'exhausted', next_run_at = NULL WHERE workflow_id = ?").run(input.workflowId);
          throw new GuardRejected(`activation exhausted (${wf.schedule_max_runs} runs admitted)`);
        }
      }
      if (input.mode === "scheduled" && wf.next_run_at && new Date(wf.next_run_at) > input.now) {
        throw new GuardRejected(`not due until ${wf.next_run_at}`);
      }

      const unresolved = this.getUnresolvedRun(input.workflowId);
      if (unresolved) {
        if (input.mode === "scheduled" && input.everyMs !== null) {
          this.advanceScheduleCursor(input.workflowId, wf.next_run_at, input.now, input.everyMs);
        }
        return { runId: unresolved.run_id, created: false };
      }

      const seqRow = this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM runs WHERE workflow_id = ?")
        .get(input.workflowId);
      const seq = (seqRow?.m ?? 0) + 1;
      const runId = formatRunId(input.workflowId, input.now, seq);
      const runDir = join(input.runsDir, runId);
      const snapshotPath = join(runDir, "definition.yaml");
      const logPath = join(runDir, "WORKSHOP_LOG.md");
      const nowIso = toIso(input.now);

      this.db
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
        this.db
          .query("UPDATE workflows SET schedule_started_runs = schedule_started_runs + 1, next_run_at = ? WHERE workflow_id = ?")
          .run(next, input.workflowId);
      } else {
        this.db.query("UPDATE workflows SET schedule_started_runs = schedule_started_runs + 1 WHERE workflow_id = ?").run(input.workflowId);
      }

      return { runId, created: true };
    });
  }

  /** Consume a due slot without loading mutable workflow source. */
  consumeScheduledOverlap(workflowId: string, now: Date, everyMs: number): string | null {
    return this.tx(() => {
      const wf = this.getWorkflow(workflowId);
      if (!wf || wf.activation_state !== "active" || !wf.schedule_every) return null;
      if (wf.schedule_max_runs != null && wf.schedule_max_runs > 0 && wf.schedule_started_runs >= wf.schedule_max_runs) {
        this.db.query("UPDATE workflows SET activation_state = 'exhausted', next_run_at = NULL WHERE workflow_id = ?").run(workflowId);
        return null;
      }
      if (wf.next_run_at && new Date(wf.next_run_at) > now) return null;
      const unresolved = this.getUnresolvedRun(workflowId);
      if (!unresolved) return null;
      this.advanceScheduleCursor(workflowId, wf.next_run_at, now, everyMs);
      return unresolved.run_id;
    });
  }

  private advanceScheduleCursor(workflowId: string, cursor: string | null, now: Date, everyMs: number): void {
    const from = cursor ?? toIso(now);
    this.db.query("UPDATE workflows SET next_run_at = ? WHERE workflow_id = ?").run(nextCursorAfter(from, now, everyMs), workflowId);
  }

  markAdmissionReady(runId: string, now: Date): boolean {
    const changes = this.db
      .query("UPDATE runs SET admission_state = 'ready', admission_definition_yaml = NULL, admission_error = NULL, updated_at = ? WHERE run_id = ? AND admission_state = 'pending'")
      .run(toIso(now), runId);
    return Number(changes.changes) === 1;
  }

  failAdmission(runId: string, error: string, now: Date): void {
    this.tx(() => {
      this.db
        .query("UPDATE runs SET admission_state = 'blocked', admission_error = ?, status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ? AND admission_state != 'ready'")
        .run(error, toIso(now), toIso(now), runId);
    });
  }

  failRunIntegrity(runId: string, error: string, now: Date): void {
    this.tx(() => {
      this.db
        .query("UPDATE node_attempts SET status = 'failed', failure_kind = 'worklog_integrity', finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('pending','running','finishing')")
        .run(toIso(now), toIso(now), runId);
      this.db
        .query("UPDATE runs SET admission_state = 'blocked', admission_error = ?, status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
        .run(error, toIso(now), toIso(now), runId);
    });
  }

  /** Fail only the still-pending packet row that was actually inspected. */
  failPendingPacketIntegrity(input: { runId: string; nodeId: string; attempt: number; error: string; now: Date }): boolean {
    return this.tx(() => {
      const changes = this.db
        .query("UPDATE node_attempts SET status = 'failed', failure_kind = 'worklog_integrity', finished_at = ?, updated_at = ? WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'pending'")
        .run(toIso(input.now), toIso(input.now), input.runId, input.nodeId, input.attempt);
      if (Number(changes.changes) !== 1) return false;
      this.db
        .query("UPDATE runs SET admission_state = 'blocked', admission_error = ?, status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
        .run(input.error, toIso(input.now), toIso(input.now), input.runId);
      return true;
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
      return this.insertPendingAttempt({
        runId: input.runId, nodeId: input.nodeId, attempt: 1,
        resolvedMaxAttempts: input.resolvedMaxAttempts, resolvedTimeoutMs: input.resolvedTimeoutMs,
        chainPosition: input.chainPosition, now: input.now,
      });
    });
  }

  /** The next chronological execution number for a run. */
  private nextExecutionSeq(runId: string): number {
    const row = this.db.query<{ m: number | null }, [string]>("SELECT MAX(execution_seq) AS m FROM node_attempts WHERE run_id = ?").get(runId);
    return (row?.m ?? 0) + 1;
  }

  /** The packet path is minted once per row from the ordered-node layout. */
  private packetPathFor(runId: string, chainPosition: number, nodeId: string, attempt: number): string {
    const run = this.getRun(runId);
    if (!run) throw new GuardRejected(`no run "${runId}"`);
    return join(attemptDir(run.run_dir, chainPosition, nodeId, attempt), "packet.md");
  }

  /** One pending-attempt insert; the packet path comes from packetPathFor. */
  private insertPendingAttempt(input: {
    runId: string; nodeId: string; attempt: number; resolvedMaxAttempts: number;
    resolvedTimeoutMs: number | null; chainPosition: number; now: Date;
  }): AttemptRow {
    const seq = this.nextExecutionSeq(input.runId);
    const packetPath = this.packetPathFor(input.runId, input.chainPosition, input.nodeId, input.attempt);
    this.db
      .query(
        `INSERT INTO node_attempts (run_id, node_id, attempt, status, resolved_max_attempts, resolved_timeout_ms,
           chain_position, execution_seq, packet_path, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.runId, input.nodeId, input.attempt, input.resolvedMaxAttempts, input.resolvedTimeoutMs,
        input.chainPosition, seq, packetPath, toIso(input.now));
    const row = this.getAttempt(input.runId, input.nodeId, input.attempt);
    if (!row) throw new Error("attempt insert vanished");
    return row;
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
      return this.insertPendingAttempt({
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
  resumeBlockedRun(input: { runId: string; now: Date }): AttemptRow | null {
    return this.tx(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new GuardRejected(`no run "${input.runId}"`);
      if (run.desired_state === "stopped") throw new GuardRejected(`run ${input.runId} is stopped`);
      if (run.status !== "blocked") throw new GuardRejected(`run ${input.runId} is ${run.status}, not blocked`);
      const resumable = ["agent_requested", "orchestrator", "operator"];
      if (!resumable.includes(run.block_kind ?? "")) {
        throw new GuardRejected(`run ${input.runId} block_kind ${run.block_kind} is not operator-resumable`);
      }
      const blocked =
        this.db
          .query<AttemptRow, [string]>(
            "SELECT * FROM node_attempts WHERE run_id = ? AND status = 'blocked' ORDER BY execution_seq DESC LIMIT 1",
          )
          .get(input.runId) ?? null;
      if (!blocked) return null;
      const next = blocked.attempt + 1;
      const fresh = this.insertPendingAttempt({
        runId: input.runId, nodeId: blocked.node_id, attempt: next,
        resolvedMaxAttempts: blocked.resolved_max_attempts + 1, // one manual bound extension
        resolvedTimeoutMs: blocked.resolved_timeout_ms,
        chainPosition: blocked.chain_position,
        now: input.now,
      });
      this.db
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
  claimAttempt(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    now: Date;
    maxConcurrentRuns: number;
  }): { ownerToken: string; pgid: number; startId: string } {
    return this.tx(() => {
      this.assertRunnableForClaim(input.runId);
      this.assertCapacity(input.maxConcurrentRuns);
      const ownerToken = newOwnerToken();
      const startId = processStartIdOrThrow(process.pid);
      const changes = this.db
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
      this.db
        .query("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ? AND status = 'queued'")
        .run(toIso(input.now), input.runId);
      return { ownerToken, pgid: process.pid, startId };
    });
  }

  /** Persist the node-harness child identity immediately after spawn. */
  recordChildIdentity(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  recordValidatorIdentity(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  clearAttemptProcessIdentity(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    role: "worker" | "validator"; pid: number; startId: string; pgid: number; now: Date;
  }): boolean {
    return this.tx(() => {
      const prefix = input.role === "worker" ? "worker" : "validator";
      const changes = this.db
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
  confirmAttemptProcessStopped(input: {
    runId: string; nodeId: string; attempt: number; role: "worker" | "validator";
    pid: number; startId: string; pgid: number; now: Date;
  }): boolean {
    const prefix = input.role === "worker" ? "worker" : "validator";
    const changes = this.db
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
  recordResolvedExecution(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    harnessTemplate: string; harnessCommand: string; model: string | null; now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  heartbeat(input: { runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  setProgress(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string; progress: string; now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  claimFinishing(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date;
    nodeOutputPath: string; validatorStatus: "passed" | "failed" | null; validatorReason: string | null;
  }): void {
    this.tx(() => {
      const changes = this.db
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
  completeAttempt(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    now: Date;
    successor: { nodeId: string; resolvedMaxAttempts: number; resolvedTimeoutMs: number | null; chainPosition: number } | null;
  }): { completed: boolean; successorCreated: boolean } {
    return this.tx(() => {
      const changes = this.db
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
      const run = this.getRun(input.runId)!;
      if (input.successor && run.desired_state === "running") {
        this.createSuccessorAttempt({ runId: input.runId, nodeId: input.successor.nodeId,
          resolvedMaxAttempts: input.successor.resolvedMaxAttempts,
          resolvedTimeoutMs: input.successor.resolvedTimeoutMs,
          chainPosition: input.successor.chainPosition, now: input.now });
        successorCreated = true;
      }
      if (successorCreated) {
        this.db.query("UPDATE runs SET updated_at = ? WHERE run_id = ?").run(toIso(input.now), input.runId);
      } else if (input.successor === null) {
        this.db
          .query("UPDATE runs SET status = 'completed', block_kind = NULL, finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued','running')")
          .run(toIso(input.now), toIso(input.now), input.runId);
      } else if (run.desired_state === "paused") {
        this.db
          .query("UPDATE runs SET status = 'paused', updated_at = ? WHERE run_id = ? AND status IN ('queued','running')")
          .run(toIso(input.now), input.runId);
      }
      return { completed: true, successorCreated };
    });
  }

  /** Owner-guarded agent-requested block (running → blocked). */
  blockAttempt(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    blockKind: BlockKind; reason: string; now: Date;
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
        .query("UPDATE runs SET status = 'blocked', block_kind = ?, updated_at = ? WHERE run_id = ? AND desired_state != 'stopped'")
        .run(input.blockKind, toIso(input.now), input.runId);
      return true;
    });
  }

  /** Fail only after every recorded attempt group is confirmed dead. */
  failAttempt(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string | null;
    failureKind: FailureKind; validatorReason?: string | null; protectForOrchestration?: boolean; now: Date;
  }): { failed: boolean; orchestratorPending: boolean } {
    return this.tx(() => {
      const attempt = this.getAttempt(input.runId, input.nodeId, input.attempt);
      const effectiveOwner = input.ownerToken ?? attempt?.owner_token ?? null;
      if (!attempt || effectiveOwner === null || attempt.owner_token !== effectiveOwner) {
        throw new GuardRejected("stale owner cannot fail attempt");
      }
      const changes = this.db
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
      const phaseChanges = this.db
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

  /** Request stop durably; cancellation waits for process-group confirmation. */
  stopRun(input: { runId: string; now: Date }): void {
    this.tx(() => {
      const changes = this.db
        .query("UPDATE runs SET desired_state = 'stopped', updated_at = ? WHERE run_id = ?")
        .run(toIso(input.now), input.runId);
      if (Number(changes.changes) === 0) throw new GuardRejected(`no run "${input.runId}"`);
      // With no recorded groups, terminate-confirm is vacuous and the stop
      // can finalize immediately. Live groups keep ownership protected.
      this.finalizeStoppedRun({ runId: input.runId, now: input.now });
    });
  }

  /**
   * Final cancellation is legal only after every persisted worker, validator,
   * and orchestrator group has been cleared following confirmed death.
   */
  finalizeStoppedRun(input: { runId: string; now: Date }): boolean {
    return this.tx(() => {
      const run = this.getRun(input.runId);
      if (!run || run.desired_state !== "stopped") return false;
      const activeAttempt = this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM node_attempts WHERE run_id = ? AND (worker_process_group IS NOT NULL OR validator_process_group IS NOT NULL)",
        )
        .get(input.runId);
      if (Number(activeAttempt?.n ?? 0) > 0 || run.orchestrator_process_group !== null) return false;
      this.db
        .query(
          `UPDATE node_attempts SET status = 'cancelled', owner_token = NULL, finished_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('pending','running','finishing')`,
        )
        .run(toIso(input.now), toIso(input.now), input.runId);
      this.db
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

  /** Recovery owner transfer after every recorded group is confirmed dead. */
  transferFinishingOwner(input: {
    runId: string; nodeId: string; attempt: number; priorOwnerToken: string; now: Date;
  }): string | null {
    return this.tx(() => {
      const newToken = newOwnerToken();
      const changes = this.db
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

  // ---------- orchestrator phase machine ----------

  claimOrchestrator(runId: string, now: Date, maxConcurrentRuns: number): { ownerToken: string } | null {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.orchestrator_phase !== "pending" || run.orchestrator_owner_token !== null ||
          run.desired_state !== "running" || run.admission_state !== "ready" ||
          !["queued", "running"].includes(run.status)) return null;
      this.assertCapacity(maxConcurrentRuns);
      const ownerToken = newOwnerToken();
      const wrapperStart = processStartIdOrThrow(process.pid);
      const changes = this.db
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
  recordOrchestratorIdentity(input: {
    runId: string; ownerToken: string; childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  heartbeatOrchestrator(input: { runId: string; ownerToken: string; now: Date }): boolean {
    return this.tx(() => {
      const changes = this.db
        .query(
          "UPDATE runs SET orchestrator_last_heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?",
        )
        .run(toIso(input.now), toIso(input.now), input.runId, input.ownerToken);
      return Number(changes.changes) === 1;
    });
  }

  /** Clear a recorded child group only after the caller confirmed the whole PGID dead. */
  clearOrchestratorIdentity(input: {
    runId: string; ownerToken: string; childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  confirmOrchestratorProcessStopped(input: {
    runId: string; childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    const changes = this.db
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
  claimApplying(input: { runId: string; ownerToken: string; resultPath: string; now: Date }): boolean {
    return this.tx(() => {
      const changes = this.db
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
  applyOrchestratorDecision(input: {
    runId: string; ownerToken: string; decision: "retry" | "block" | "fail"; now: Date;
  }): { effectNodeId: string | null; effectAttempt: number | null } {
    return this.tx(() => {
      const run = this.getRun(input.runId);
      if (!run || run.orchestrator_phase !== "applying" || run.orchestrator_owner_token !== input.ownerToken ||
          run.orchestrator_process_group !== null || run.desired_state !== "running") {
        throw new GuardRejected("stale orchestrator cannot apply decision");
      }
      let effectNodeId: string | null = null;
      let effectAttempt: number | null = null;
      if (input.decision === "retry") {
        const latest = this.db
          .query<AttemptRow, [string]>(
            "SELECT * FROM node_attempts WHERE run_id = ? AND status = 'failed' ORDER BY execution_seq DESC LIMIT 1",
          )
          .get(input.runId);
        const created = latest ? this.createRetryAttempt({
          runId: input.runId, nodeId: latest.node_id, previousAttempt: latest.attempt,
          resolvedMaxAttempts: latest.resolved_max_attempts, resolvedTimeoutMs: latest.resolved_timeout_ms,
          chainPosition: latest.chain_position, now: input.now,
        }) : null;
        if (created) { effectNodeId = created.node_id; effectAttempt = created.attempt; }
        else this.db.query("UPDATE runs SET status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
          .run(toIso(input.now), toIso(input.now), input.runId);
      } else if (input.decision === "block") {
        this.db.query("UPDATE runs SET status = 'blocked', block_kind = 'orchestrator', updated_at = ? WHERE run_id = ?")
          .run(toIso(input.now), input.runId);
      } else {
        this.db.query("UPDATE runs SET status = 'failed', finished_at = ?, updated_at = ? WHERE run_id = ?")
          .run(toIso(input.now), toIso(input.now), input.runId);
      }
      this.db
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
  releaseOrchestratorToPending(runId: string, ownerToken: string, now: Date): boolean {
    return this.tx(() => {
      const changes = this.db
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
  operatorResetOrchestrator(runId: string, now: Date): boolean {
    const changes = this.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, updated_at = ?
         WHERE run_id = ? AND orchestrator_owner_token IS NULL AND orchestrator_process_group IS NULL`,
      )
      .run(toIso(now), runId);
    return Number(changes.changes) === 1;
  }

  // ---------- guards ----------

  /** True when a new attempt/orchestrator claim could take a top-level slot. */
  hasExecutionCapacity(maxConcurrentRuns: number): boolean {
    return this.occupiedRunSlots() < maxConcurrentRuns;
  }

  private assertCapacity(maxConcurrentRuns: number): void {
    if (this.occupiedRunSlots() >= maxConcurrentRuns) throw new CapacityRejected();
  }

  private occupiedRunSlots(): number {
    const row = this.db
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

  /** Run must be unresolved, prepared, desired running, orchestrator idle. */
  assertRunnableForClaim(runId: string): void {
    const run = this.getRun(runId);
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
  assertRunnable(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new GuardRejected(`no run "${runId}"`);
    if (isTerminal(run.status)) throw new GuardRejected(`run ${runId} is ${run.status}`);
    if (run.status === "blocked") throw new GuardRejected(`run ${runId} is blocked (${run.block_kind})`);
    if (run.desired_state === "stopped") throw new GuardRejected(`run ${runId} is stopped`);
    if (run.desired_state === "paused") throw new GuardRejected(`run ${runId} is paused`);
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

function nextCursorAfter(cursor: string, now: Date, everyMs: number): string {
  const from = new Date(cursor).getTime();
  if (!Number.isFinite(from) || everyMs <= 0) throw new GuardRejected("invalid persisted schedule cadence");
  const intervals = Math.floor((now.getTime() - from) / everyMs) + 1;
  return toIso(new Date(from + Math.max(1, intervals) * everyMs));
}
