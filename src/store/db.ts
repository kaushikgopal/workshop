import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Schema v1 — SQLite is canonical lifecycle state. Current state and attempts
 * only; there is no event stream. WAL mode and foreign keys are required.
 */

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  definition_path TEXT NOT NULL,
  canonical_definition_hash TEXT NOT NULL,
  activation_state TEXT NOT NULL CHECK (activation_state IN ('active','paused','stopped','exhausted','expired')),
  activation_started_at TEXT NOT NULL,
  schedule_started_runs INTEGER NOT NULL DEFAULT 0,
  schedule_every TEXT,
  schedule_max_runs INTEGER,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','blocked','failed','completed','cancelled')),
  definition_hash TEXT NOT NULL,
  definition_snapshot_path TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running','paused','stopped')),
  orchestrator_phase TEXT NOT NULL DEFAULT 'idle' CHECK (orchestrator_phase IN ('idle','pending','owned','applying')),
  orchestrator_owner_token TEXT,
  orchestrator_worker_pid INTEGER,
  orchestrator_last_heartbeat_at TEXT,
  block_kind TEXT,
  run_dir TEXT NOT NULL,
  worklog_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

-- At most one unresolved run per workflow.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_unresolved_per_workflow
  ON runs(workflow_id) WHERE status IN ('queued','running','paused','blocked');

CREATE TABLE IF NOT EXISTS node_attempts (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','finishing','blocked','failed','completed','cancelled')),
  failure_kind TEXT CHECK (failure_kind IN ('process_error','timeout','worklog_integrity','validator_rejection','interrupted')),
  block_kind TEXT CHECK (block_kind IN ('agent_requested','preflight','orchestrator','orchestrator_unresolved','unknown_external','operator')),
  resolved_harness_template TEXT,
  resolved_harness_command TEXT,
  resolved_model TEXT,
  resolved_max_attempts INTEGER NOT NULL,
  resolved_timeout_ms INTEGER,
  node_output_path TEXT,
  packet_path TEXT NOT NULL,
  owner_token TEXT,
  wrapper_pid INTEGER,
  wrapper_process_start_id TEXT,
  worker_pid INTEGER,
  worker_process_start_id TEXT,
  worker_process_group INTEGER,
  last_heartbeat_at TEXT,
  current_progress TEXT,
  validator_status TEXT CHECK (validator_status IN ('passed','failed')),
  validator_reason TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  chain_position INTEGER NOT NULL DEFAULT 0,
  execution_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, node_id, attempt)
);

-- At most one live attempt per node and per run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_live_per_node
  ON node_attempts(run_id, node_id) WHERE status IN ('pending','running','finishing');
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_live_per_run
  ON node_attempts(run_id) WHERE status IN ('pending','running','finishing');
`;

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.query<{ v: number | null }, []>("SELECT (SELECT value FROM meta WHERE key='schema_version') AS v").get();
  const current = row?.v == null ? 0 : Number(row.v);
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema version ${current} is newer than this Workshop build (${SCHEMA_VERSION})`);
  }
  if (current === SCHEMA_VERSION) return;
  if (current === 0) {
    db.transaction(() => {
      db.exec(DDL);
      db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
    })();
    return;
  }
  // v1 → v2: execution_seq — the chronological per-run counter that names
  // attempt folders (attempts/001-node-timestamp/).
  if (current < 2) {
    db.transaction(() => {
      db.exec("ALTER TABLE node_attempts ADD COLUMN execution_seq INTEGER NOT NULL DEFAULT 0");
      db.exec(
        `UPDATE node_attempts SET execution_seq = (
           SELECT COUNT(*) FROM node_attempts AS earlier
           WHERE earlier.run_id = node_attempts.run_id
             AND (earlier.started_at < node_attempts.started_at
                  OR (earlier.started_at = node_attempts.started_at AND earlier.ROWID <= node_attempts.ROWID))
         )`,
      );
      db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    })();
  }
  // Future migrations step from `current` to SCHEMA_VERSION here.
}
