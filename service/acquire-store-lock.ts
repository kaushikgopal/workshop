import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

const lockTable = "workshop_service_lock";

type LockOwner = { pid: number; processStartedAt: string; token: string; acquiredAt: string };

type StoreLock = {
  release(): Promise<void>;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function processStartedAt(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 });
  if (result.error || result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

function processIsSameInstance(pid: number, startedAt: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code !== "EPERM") throw error;
  }
  const currentStartedAt = processStartedAt(pid);
  return currentStartedAt === undefined || startedAt.length === 0 || currentStartedAt === startedAt;
}

async function claim(database: NodeSqliteDatabase, owner: LockOwner): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.exec(`CREATE TABLE IF NOT EXISTS ${lockTable} (lock_key TEXT PRIMARY KEY, pid INTEGER NOT NULL, process_started_at TEXT NOT NULL DEFAULT '', token TEXT NOT NULL, acquired_at TEXT NOT NULL)`);
    const columns = await tx.all<{ name: string }>(`PRAGMA table_info(${lockTable})`);
    if (!columns.some((column) => column.name === "process_started_at")) {
      await tx.exec(`ALTER TABLE ${lockTable} ADD COLUMN process_started_at TEXT NOT NULL DEFAULT ''`);
    }
    const current = await tx.get<{ pid: number; process_started_at: string }>(`SELECT pid, process_started_at FROM ${lockTable} WHERE lock_key = ?`, "service");
    if (current && processIsSameInstance(current.pid, current.process_started_at)) {
      throw new Error(`Workshop service is already running (durable store is held by PID ${current.pid})`);
    }
    await tx.run(
      `INSERT INTO ${lockTable} (lock_key, pid, process_started_at, token, acquired_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(lock_key) DO UPDATE SET pid = excluded.pid, process_started_at = excluded.process_started_at, token = excluded.token, acquired_at = excluded.acquired_at`,
      "service",
      owner.pid,
      owner.processStartedAt,
      owner.token,
      owner.acquiredAt,
    );
  });
}

async function releaseStoreLock(database: NodeSqliteDatabase, token: string): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.run(`DELETE FROM ${lockTable} WHERE lock_key = ? AND token = ?`, "service", token);
  });
}

export async function acquireStoreLock(databasePath: string): Promise<StoreLock> {
  const startedAt = processStartedAt(process.pid);
  if (startedAt === undefined) throw new Error("Workshop cannot verify its process identity with the ps command");
  const database = await openNodeSqliteDatabase(databasePath);
  const owner: LockOwner = {
    pid: process.pid,
    processStartedAt: startedAt,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  try {
    await claim(database, owner);
  } catch (error) {
    await database.close();
    throw error;
  }

  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      if (releasePromise) return releasePromise;
      // Every caller must observe the completed cleanup, including any failure.
      releasePromise = (async () => {
        try {
          await releaseStoreLock(database, owner.token);
        } finally {
          await database.close();
        }
      })();
      return releasePromise;
    },
  };
}
