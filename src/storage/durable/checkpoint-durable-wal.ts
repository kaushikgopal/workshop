import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

/** Checkpoint committed WAL pages without exposing Durable's private SQLite handle. */
export async function checkpointDurableWal(databasePath: string): Promise<boolean> {
  const database = await openNodeSqliteDatabase(databasePath, { walAutoCheckpointPages: 0, busyTimeoutMs: 1_000 });
  try {
    await database.exec("PRAGMA synchronous = FULL");
    const mode = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    if (mode?.synchronous !== 2) throw new Error("SQLite FULL synchronization was not applied for WAL checkpoint");

    const checkpoint = await database.get<{ busy: number; log: number; checkpointed: number }>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );
    if (checkpoint === undefined || !Number.isSafeInteger(checkpoint.busy)
      || !Number.isSafeInteger(checkpoint.log) || !Number.isSafeInteger(checkpoint.checkpointed)) {
      throw new Error("SQLite returned an invalid WAL checkpoint result");
    }
    return checkpoint.busy === 0
      && (checkpoint.log < 0 || checkpoint.checkpointed >= checkpoint.log);
  } finally {
    // SqliteDatabase.close() also attempts TRUNCATE; a busy checkpoint leaves committed data in the WAL for recovery.
    await database.close();
  }
}
