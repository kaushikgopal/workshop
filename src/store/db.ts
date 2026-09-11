import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Schema v1 — SQLite is canonical lifecycle state. Current state and attempts
 * only; there is no event stream. WAL mode and foreign keys are required.
 */

export const SCHEMA_VERSION = 4;

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
  definition_snapshot_path TEXT NOT NULL CHECK (length(definition_snapshot_path) > 0),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running','paused','stopped')),
  orchestrator_phase TEXT NOT NULL DEFAULT 'idle' CHECK (orchestrator_phase IN ('idle','pending','owned','applying')),
  orchestrator_owner_token TEXT,
  orchestrator_wrapper_pid INTEGER,
  orchestrator_wrapper_process_start_id TEXT,
  orchestrator_worker_pid INTEGER,
  orchestrator_worker_process_start_id TEXT,
  orchestrator_process_group INTEGER,
  orchestrator_last_heartbeat_at TEXT,
  orchestrator_result_path TEXT,
  block_kind TEXT,
  run_dir TEXT NOT NULL CHECK (length(run_dir) > 0),
  worklog_path TEXT NOT NULL CHECK (length(worklog_path) > 0),
  admission_state TEXT NOT NULL DEFAULT 'pending' CHECK (admission_state IN ('pending','ready','blocked')),
  admission_definition_yaml TEXT,
  admission_error TEXT,
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
  validator_pid INTEGER,
  validator_process_start_id TEXT,
  validator_process_group INTEGER,
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
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db, dbPath);
  return db;
}

function migrate(db: Database, dbPath: string): void {
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
  if (current < 3) {
    db.transaction(() => {
      db.exec("ALTER TABLE runs ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'ready' CHECK (admission_state IN ('pending','ready','blocked'))");
      db.exec("ALTER TABLE runs ADD COLUMN admission_definition_yaml TEXT");
      db.exec("ALTER TABLE runs ADD COLUMN admission_error TEXT");
      // Give every legacy row deterministic non-empty paths. Unresolved rows
      // from the old DB→filesystem crash gap lack replay bytes and fail closed;
      // terminal history keeps its original lifecycle result.
      const legacy = db
        .query<{ run_id: string; run_dir: string; definition_snapshot_path: string; worklog_path: string; status: string }, []>(
          "SELECT run_id, run_dir, definition_snapshot_path, worklog_path, status FROM runs WHERE definition_snapshot_path = '' OR run_dir = '' OR worklog_path = ''",
        )
        .all();
      for (const run of legacy) {
        const runDir = run.run_dir || join(dirname(dbPath), "runs", run.run_id);
        const snapshot = run.definition_snapshot_path || join(runDir, "definition.yaml");
        const worklog = run.worklog_path || join(runDir, "WORKSHOP_LOG.md");
        const unresolved = ["queued", "running", "paused", "blocked"].includes(run.status);
        db.query(
          `UPDATE runs SET run_dir = ?, definition_snapshot_path = ?, worklog_path = ?,
             admission_state = ?, admission_error = ?,
             status = CASE WHEN ? THEN 'failed' ELSE status END,
             finished_at = CASE WHEN ? THEN COALESCE(finished_at, updated_at) ELSE finished_at END
           WHERE run_id = ?`,
        ).run(
          runDir, snapshot, worklog, unresolved ? "blocked" : "ready",
          unresolved ? "legacy admission has empty artifact paths and no replayable definition" : null,
          unresolved ? 1 : 0, unresolved ? 1 : 0, run.run_id,
        );
      }
      db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    })();
  }
  // v3 → v4 is a no-op marker. The aborted schema-4 draft added decision,
  // digest, manifest, and audit columns that the corrected design never
  // reads; databases already opened at v4 simply keep those ignored
  // columns, and no v3 database ever shipped outside that draft.
  if (current < 4) {
    db.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
  }
  // Future migrations step from `current` to SCHEMA_VERSION here.
}
