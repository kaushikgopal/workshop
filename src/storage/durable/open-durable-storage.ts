import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

type DurableStorageFailureKind =
  | "sqlite_open_failed"
  | "full_synchronization_failed"
  | "durable_storage_open_failed";

export type DurableStorageOpenFailure = {
  kind: DurableStorageFailureKind;
  message: string;
  cause: unknown;
};

export type DurableStorageOpenResult =
  | { ok: true; storage: SqliteStorage }
  | { ok: false; failure: DurableStorageOpenFailure };

const failureMessages: Record<DurableStorageFailureKind, string> = {
  sqlite_open_failed: "could not open the Durable SQLite database",
  full_synchronization_failed: "SQLite did not retain FULL synchronous mode",
  durable_storage_open_failed: "could not initialize Durable storage",
};

/** Open the production SQLite composition and verify its durability setting before use. */
export async function openDurableStorage(path: string): Promise<DurableStorageOpenResult> {
  let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
  let failureKind: DurableStorageFailureKind = "sqlite_open_failed";

  try {
    database = await openNodeSqliteDatabase(path);
    failureKind = "full_synchronization_failed";
    await database.exec("PRAGMA synchronous = FULL");
    const mode = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    if (mode?.synchronous !== 2) throw new Error("SQLite FULL synchronization was not applied");

    failureKind = "durable_storage_open_failed";
    const storage = await SqliteStorage.open(database);
    database = undefined;
    return { ok: true, storage };
  } catch (cause) {
    let reportedCause = cause;
    if (database !== undefined) {
      try {
        await database.close();
      } catch (closeCause) {
        reportedCause = new AggregateError([cause, closeCause], "Durable storage initialization and cleanup failed");
      }
    }
    return {
      ok: false,
      failure: {
        kind: failureKind,
        message: failureMessages[failureKind],
        cause: reportedCause,
      },
    };
  }
}
