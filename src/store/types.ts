import type { Database } from "bun:sqlite";

/**
 * The store's persisted vocabulary: state unions, row shapes, and the
 * rejected-guard errors. Every store module imports this file, so it depends
 * on nothing but types itself — no store module and no SQL.
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

/** What a store query module needs from the Store that composes it. */
export interface StoreCtx {
  readonly db: Database;
  tx<T>(fn: () => T): T;
}
