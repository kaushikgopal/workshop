import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { processStartId } from "../src/process/identify-process.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { ServiceShutdownError } from "../src/service/serve-workshop-service.js";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/real-1.0.2-interrupted-workflow/", import.meta.url));
const rootPlaceholder = "/WORKSHOP_FIXTURE_ROOT";

type FixtureManifest = {
  readonly sourceCommit: string;
  readonly durableVersion: string;
  readonly rootPlaceholder: string;
  readonly replacements: number;
  readonly records: readonly { readonly table: string; readonly column: string; readonly occurrences: number }[];
  readonly capture: {
    readonly interruptedWorkflowId: string;
    readonly interruptedRunId: string;
    readonly pendingWorkflowId: string;
    readonly pendingRunId: string;
    readonly pendingStatusBeforeInterruption: string;
    readonly pendingWakeupTaskId: number;
    readonly pendingWakeupWaitForCapacity: boolean;
    readonly workerIdentity: { readonly pid: number; readonly pgid: number; readonly startIdentity: string; readonly serviceBootId: string };
    readonly providerRequestCount: number;
    readonly markerEffectCount: number;
    readonly pendingEffectCount: number;
  };
};

test("migrates interrupted 1.0.2 process evidence and fails closed without replay", async () => {
  const manifest = JSON.parse(readFileSync(join(fixtureDirectory, "path-normalization.json"), "utf8")) as FixtureManifest;
  expect(manifest.sourceCommit).toBe("70ba39324a8c2eac2c2c15a817ffb8547e603a42");
  expect(manifest.durableVersion).toBe("1.0.2");
  expect(manifest.rootPlaceholder).toBe(rootPlaceholder);
  expect(manifest.capture.pendingStatusBeforeInterruption).toBe("completed");
  expect(manifest.capture.pendingWakeupTaskId).toBeGreaterThan(0);
  expect(manifest.capture.pendingWakeupWaitForCapacity).toBe(true);
  expect(manifest.capture.pendingEffectCount).toBe(1);
  expect(manifest.capture.workerIdentity.pgid).toBe(manifest.capture.workerIdentity.pid);
  expect(manifest.capture.providerRequestCount).toBe(1);
  expect(manifest.capture.markerEffectCount).toBe(1);
  expect(manifest.replacements).toBeGreaterThan(0);

  // Do not let stale captured evidence terminate a process that now reuses its PID.
  expect(processStartId(manifest.capture.workerIdentity.pid)).not.toBe(manifest.capture.workerIdentity.startIdentity);

  const root = mkdtempSync(join(tmpdir(), "workshop-migrate-interrupted-workflow-"));
  const workshopDirectory = join(root, ".workshop");
  const workflowsDirectory = join(workshopDirectory, "workflows");
  const stateDirectory = join(workshopDirectory, ".state");
  mkdirSync(workflowsDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  copyFileSync(join(fixtureDirectory, "workshop.yaml"), join(workshopDirectory, "workshop.yaml"));
  copyFileSync(join(fixtureDirectory, "interrupted-migration.yaml"), join(workflowsDirectory, "interrupted-migration.yaml"));
  copyFileSync(join(fixtureDirectory, "pending-migration.yaml"), join(workflowsDirectory, "pending-migration.yaml"));
  const databasePath = join(stateDirectory, "durable.db");
  copyFileSync(join(fixtureDirectory, "durable.db"), databasePath);

  const effectPath = join(root, "interrupted-effects.txt");
  const requestPath = join(root, "provider-requests.txt");
  const pendingPath = join(root, "pending-effects.txt");
  copyFileSync(join(fixtureDirectory, "interrupted-effects.txt"), effectPath);
  copyFileSync(join(fixtureDirectory, "provider-requests.txt"), requestPath);
  copyFileSync(join(fixtureDirectory, "pending-effects.txt"), pendingPath);
  expect(nonemptyLineCount(effectPath)).toBe(manifest.capture.markerEffectCount);
  expect(nonemptyLineCount(requestPath)).toBe(manifest.capture.providerRequestCount);
  expect(nonemptyLineCount(pendingPath)).toBe(manifest.capture.pendingEffectCount);

  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    const database = await openNodeSqliteDatabase(databasePath);
    try {
      expect(await database.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))
        .toEqual({ version: 1 });
      expect(await database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      const observedReplacements = await restoreCapturePaths(database, manifest, root);
      expect(observedReplacements).toBe(manifest.replacements);
      expect(await countTextOccurrences(database, rootPlaceholder)).toBe(0);
      expect(await countTextOccurrences(database, root)).toBe(manifest.replacements);
    } finally {
      await database.close();
    }

    const provider = fauxProvider({ provider: "fixture", models: [{ id: "legacy-worker" }] });
    provider.setResponses(Array.from({ length: 100 }, () => () => {
      appendFileSync(requestPath, "request\n", "utf8");
      return fauxAssistantMessage("<status>succeeded</status>\n<reason>Unexpected recovery request.</reason>\n<output>UNEXPECTED_RECOVERY_RUN</output>");
    }));
    const models = createModels();
    models.setProvider(provider.provider);

    let startupError: unknown;
    try {
      owner = await startWorkshopService(loadInstallation(root), models);
    } catch (error) {
      startupError = error;
    }
    expect(nonemptyLineCount(effectPath)).toBe(manifest.capture.markerEffectCount);
    expect(nonemptyLineCount(requestPath)).toBe(manifest.capture.providerRequestCount);
    expect(nonemptyLineCount(pendingPath)).toBe(manifest.capture.pendingEffectCount);

    const migratedDatabase = await openNodeSqliteDatabase(databasePath);
    try {
      const schema = await migratedDatabase.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1");
      expect(schema?.version).toBe(2);
      expect(CURRENT_SQLITE_SCHEMA_VERSION).toBe(2);
      expect(await migratedDatabase.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

      const taskRows = await migratedDatabase.all<{ id: number; record: string }>("SELECT id, record FROM tasks ORDER BY id");
      const tasks = taskRows.map(row => ({ id: row.id, ...JSON.parse(row.record) as TaskRecord }));
      const interruptedTask = tasks.find(task => task.kind === "workshop.process-execution"
        && task.input?.runId === manifest.capture.interruptedRunId);
      expect(interruptedTask?.state.status).toBe("pending"); // Strict startup refuses before any handler can retire the task.
      const pendingTask = tasks.find(task => task.kind === "workshop.workflow-run"
        && task.input?.runId === manifest.capture.pendingRunId);
      expect(pendingTask).toBeDefined();
      expect(pendingTask?.state.status).toBe("terminal");
      const pendingWorkflowTasks = tasks.filter(task => task.kind === "workshop.workflow-run"
        && task.input?.workflowId === manifest.capture.pendingWorkflowId);
      expect(pendingWorkflowTasks).toHaveLength(1);
      const pendingWakeup = tasks.find(task => task.id === manifest.capture.pendingWakeupTaskId);
      expect(pendingWakeup?.kind).toBe("workshop.schedule-wakeup");
      expect(pendingWakeup?.state.status).not.toBe("terminal");
      expect(pendingWakeup?.state.checkpoint).toMatchObject({ phase: "wait", waitFor: "capacity" });
      expect(nonemptyLineCount(pendingPath)).toBe(manifest.capture.pendingEffectCount);
    } finally {
      await migratedDatabase.close();
    }

    expect(startupError).toBeInstanceOf(ServiceShutdownError);
    const startupCauses = (startupError as ServiceShutdownError).cause as AggregateError;
    expect(startupCauses).toBeInstanceOf(AggregateError);
    expect(startupCauses.errors.map(error => (error as Error).message).join("\n")).toContain("no confirmed-death receipt");
  } finally {
    if (owner !== undefined) await owner.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

type TaskRecord = {
  readonly kind?: string;
  readonly input?: { readonly runId?: string; readonly workflowId?: string };
  readonly state: { readonly status: string; readonly checkpoint?: unknown };
};

async function restoreCapturePaths(
  database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
  manifest: FixtureManifest,
  root: string,
): Promise<number> {
  const columns = new Map<string, number>();
  for (const record of manifest.records) {
    const key = record.table + "\0" + record.column;
    columns.set(key, (columns.get(key) ?? 0) + record.occurrences);
  }
  let replacements = 0;
  await database.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, expected] of columns) {
      const [table, column] = key.split("\0");
      if (table === undefined || column === undefined) throw new Error("invalid path-normalization manifest record");
      const quotedTable = quoteIdentifier(table);
      const quotedColumn = quoteIdentifier(column);
      const values = await database.all<Record<string, unknown>>(
        "SELECT " + quotedColumn + " AS value FROM " + quotedTable + " WHERE instr(" + quotedColumn + ", ?) > 0",
        rootPlaceholder,
      );
      const found = values.reduce((sum, row) => sum + countOccurrences(String(row.value), rootPlaceholder), 0);
      expect(found).toBe(expected);
      replacements += found;
      await database.run(
        "UPDATE " + quotedTable + " SET " + quotedColumn + " = replace(" + quotedColumn + ", ?, ?) WHERE instr(" + quotedColumn + ", ?) > 0",
        rootPlaceholder, root, rootPlaceholder,
      );
    }
    await database.exec("COMMIT");
  } catch (error) {
    await database.exec("ROLLBACK");
    throw error;
  }
  return replacements;
}

async function countTextOccurrences(
  database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
  searched: string,
): Promise<number> {
  const tables = await database.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  let count = 0;
  for (const { name: table } of tables) {
    const quotedTable = quoteIdentifier(table);
    const columns = await database.all<{ name: string; type: string }>("PRAGMA table_info(" + quotedTable + ")");
    for (const { name: column, type } of columns) {
      if (!/CHAR|CLOB|TEXT/i.test(type)) continue;
      const values = await database.all<Record<string, unknown>>(
        "SELECT " + quoteIdentifier(column) + " AS value FROM " + quotedTable
          + " WHERE instr(" + quoteIdentifier(column) + ", ?) > 0",
        searched,
      );
      count += values.reduce((sum, row) => sum + countOccurrences(String(row.value), searched), 0);
    }
  }
  return count;
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function countOccurrences(value: string, searched: string): number {
  return value.split(searched).length - 1;
}

function nonemptyLineCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter(line => line.length > 0).length;
}
