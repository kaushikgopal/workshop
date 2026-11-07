import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { probeServiceHealth } from "../../../src/service/probe-service-health.js";
import { sendServiceRequest } from "../../../src/service/send-service-request.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../../../src/service/schema.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const sourceCommit = "70ba39324a8c2eac2c2c15a817ffb8547e603a42";
const rootPlaceholder = "/WORKSHOP_FIXTURE_ROOT";
const interruptedWorkflowId = "interrupted-migration";
const pendingWorkflowId = "pending-migration";
const root = mkdtempSync(join(tmpdir(), "workshop-real-interrupted-capture-"));
const workshopDirectory = join(root, ".workshop");
const workflowDirectory = join(workshopDirectory, "workflows");
const stateDirectory = join(workshopDirectory, ".state");
const requestLog = join(root, "provider-requests.txt");
const effectLog = join(root, "interrupted-effects.txt");
const pendingLog = join(root, "pending-effects.txt");
const processIdPath = join(root, "interrupted-process.pid");
const serviceHelper = join(fixtureDirectory, "capture-service.ts");

mkdirSync(workflowDirectory, { recursive: true });
mkdirSync(stateDirectory, { recursive: true });
copyFileSync(join(fixtureDirectory, "workshop.yaml"), join(workshopDirectory, "workshop.yaml"));
copyFileSync(join(fixtureDirectory, "interrupted-migration.yaml"), join(workflowDirectory, "interrupted-migration.yaml"));
copyFileSync(join(fixtureDirectory, "pending-migration.yaml"), join(workflowDirectory, "pending-migration.yaml"));

const server = spawn(process.execPath, [serviceHelper, root, requestLog], {
  cwd: process.cwd(),
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "";
server.stderr?.on("data", (chunk: Buffer) => {
  if (serverError.length < 16_384) serverError += chunk.toString("utf8").slice(0, 16_384 - serverError.length);
});
const serverExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
  server.once("exit", (code, signal) => resolve({ code, signal }));
});
let interruptedRun: ReturnType<typeof serviceStartResultV1Schema.parse> | undefined;
let pendingRun: ReturnType<typeof serviceStartResultV1Schema.parse> | undefined;
let servicePid: number | undefined;
let serviceBootId: string | undefined;
let workerIdentity: { pid: number; pgid: number; startIdentity: string; serviceBootId: string } | undefined;
let interruptionConfirmed = false;

try {
  const health = await waitForService(stateDirectory, serverExit, () => serverError);
  if (server.pid === undefined || health.metadata.pid !== server.pid || health.metadata.bootId === null) {
    throw new Error("the historical service metadata does not match its owner process");
  }
  servicePid = server.pid;
  serviceBootId = health.metadata.bootId;

  const pendingResponse = await sendServiceRequest(health.metadata.socketPath, {
    version: 1, method: "start", requestId: "capture-pending-run", workflowId: pendingWorkflowId,
  });
  if (!pendingResponse.ok) throw new Error(pendingResponse.error.message);
  pendingRun = serviceStartResultV1Schema.parse(pendingResponse.result);
  await waitForRunStatus(health.metadata.socketPath, pendingWorkflowId, pendingRun.runId, "completed");
  if (lineCount(pendingLog) !== 1) throw new Error("the first scheduled occurrence did not write exactly one marker");

  const firstResponse = await sendServiceRequest(health.metadata.socketPath, {
    version: 1, method: "start", requestId: "capture-interrupted-run", workflowId: interruptedWorkflowId,
  });
  if (!firstResponse.ok) throw new Error(firstResponse.error.message);
  interruptedRun = serviceStartResultV1Schema.parse(firstResponse.result);
  await waitForInterruptedProcess(health.metadata.socketPath, interruptedRun.runId, processIdPath, effectLog);

  const databasePath = join(stateDirectory, "durable.db");
  const pendingWakeup = await waitForCapacityWakeup(databasePath, pendingWorkflowId);
  const interruptedSummary = await readRunSummary(health.metadata.socketPath, interruptedWorkflowId, interruptedRun.runId);
  if (interruptedSummary.status !== "running" || interruptedSummary.currentNodeId !== "hold-process") {
    throw new Error("the main workflow is not in its interrupted process step");
  }
  if (lineCount(effectLog) !== 1 || lineCount(requestLog) !== 1 || lineCount(pendingLog) !== 1) {
    throw new Error("the live capture effects do not match the expected pre-interruption state");
  }

  const capturedProcessId = Number(readFileSync(processIdPath, "utf8").trim());
  if (!Number.isSafeInteger(capturedProcessId) || capturedProcessId < 1) throw new Error("the worker process ID is invalid");
  const database = await openNodeSqliteDatabase(databasePath);
  try {
    const processRecord = await findProcessTask(database, interruptedRun.runId);
    const checkpoint = processRecord.state.checkpoint as { phase?: unknown; process?: unknown } | undefined;
    const process = checkpoint?.process as { status?: unknown; identity?: unknown } | undefined;
    const identity = process?.identity as typeof workerIdentity;
    if (processRecord.state.status !== "running" || checkpoint?.phase !== "monitor"
      || process?.status !== "running" || identity === undefined || identity === null
      || identity.pid !== capturedProcessId || identity.pgid !== capturedProcessId
      || identity.serviceBootId !== serviceBootId) {
      throw new Error("the captured process task is not durably running with matching process evidence");
    }
    workerIdentity = identity;
    const schema = await database.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1");
    if (schema?.version !== 1) throw new Error("the historical capture is not schema version 1");
    const retainedWakeup = await findScheduleWakeupTask(database, pendingWorkflowId);
    if (retainedWakeup.id !== pendingWakeup.id || !isWaitingForCapacity(retainedWakeup)) {
      throw new Error("the unrelated scheduled occurrence is not durably waiting for run capacity");
    }
  } finally {
    await database.close();
  }

  server.kill("SIGKILL");
  const exit = await serverExit;
  if (exit.signal !== "SIGKILL") throw new Error("the historical service did not exit by SIGKILL");
  await killProcessGroup(workerIdentity.pid);
  interruptionConfirmed = true;

  const captureDatabase = await openNodeSqliteDatabase(databasePath);
  let normalizedRecords: NormalizedRecord[];
  let replacementCount: number;
  try {
    const version = await captureDatabase.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1");
    if (version?.version !== 1) throw new Error("the durable schema changed during capture shutdown");
    const normalization = await normalizeCapturePaths(captureDatabase, root, rootPlaceholder);
    normalizedRecords = normalization.records;
    replacementCount = normalization.replacements;
    await captureDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await captureDatabase.exec("VACUUM");
  } finally {
    await captureDatabase.close();
  }

  if (!interruptionConfirmed || lineCount(effectLog) !== 1 || lineCount(requestLog) !== 1 || lineCount(pendingLog) !== 1) {
    throw new Error("the post-interruption capture effects changed unexpectedly");
  }
  const outputDatabase = join(fixtureDirectory, "durable.db");
  copyFileSync(databasePath, outputDatabase);
  copyFileSync(effectLog, join(fixtureDirectory, "interrupted-effects.txt"));
  copyFileSync(requestLog, join(fixtureDirectory, "provider-requests.txt"));
  copyFileSync(pendingLog, join(fixtureDirectory, "pending-effects.txt"));
  const manifest = {
    sourceCommit,
    durableVersion: "1.0.2",
    rootPlaceholder,
    replacements: replacementCount,
    records: normalizedRecords,
    capture: {
      interruptedWorkflowId,
      interruptedRunId: interruptedRun.runId,
      pendingWorkflowId,
      pendingRunId: pendingRun.runId,
      pendingStatusBeforeInterruption: "completed",
      pendingWakeupTaskId: pendingWakeup.id,
      pendingWakeupWaitForCapacity: true,
      interruptedNodeId: "hold-process",
      servicePid,
      serviceBootId,
      workerIdentity,
      interruptionSignal: "SIGKILL",
      serviceProcessExitedBySignal: "SIGKILL",
      workerProcessGroupKilledAfterServiceExit: true,
      providerRequestCount: lineCount(requestLog),
      markerEffectCount: lineCount(effectLog),
      pendingEffectCount: lineCount(pendingLog),
    },
    transformation: "Replaced only the disposable capture workspace root in stored text fields after the historical service and worker process group were killed. Task state, evidence, IDs, and checkpoints were not edited.",
  };
  writeFileSync(join(fixtureDirectory, "path-normalization.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ database: outputDatabase, replacements: replacementCount, capture: manifest.capture }, null, 2) + "\n");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const stopped = await Promise.race([serverExit, delay(5_000).then(() => null)]);
    if (stopped === null) {
      server.kill("SIGKILL");
      await serverExit;
    }
  }
  if (workerIdentity !== undefined) await killProcessGroup(workerIdentity.pid);
  rmSync(root, { recursive: true, force: true });
}

async function waitForService(
  stateDirectory: string,
  serverExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  getError: () => string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const exit = await Promise.race([serverExit, delay(0).then(() => null)]);
    if (exit !== null) throw new Error("historical service exited before startup: " + getError());
    const health = await probeServiceHealth(stateDirectory);
    if (health.kind === "ready") return health;
    await delay(20);
  }
  throw new Error("historical service startup timed out: " + getError());
}

async function waitForInterruptedProcess(socketPath: string, runId: string, pidPath: string, markerPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const summary = await readRunSummary(socketPath, interruptedWorkflowId, runId);
    if (summary.status === "running" && summary.currentNodeId === "hold-process"
      && existsSync(pidPath) && existsSync(markerPath)) return;
    await delay(20);
  }
  throw new Error("the interrupted workflow did not reach its process marker");
}

async function waitForRunStatus(socketPath: string, workflowId: string, runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const summary = await readRunSummary(socketPath, workflowId, runId);
    if (summary.status === status) return;
    await delay(20);
  }
  throw new Error("the scheduled workflow did not reach its expected state: " + status);
}

async function waitForCapacityWakeup(databasePath: string, workflowId: string): Promise<{ id: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const database = await openNodeSqliteDatabase(databasePath);
    try {
      const task = await findScheduleWakeupTask(database, workflowId);
      if (isWaitingForCapacity(task)) return { id: task.id };
    } finally {
      await database.close();
    }
    await delay(20);
  }
  throw new Error("the unrelated scheduled occurrence did not wait for run capacity");
}

async function findScheduleWakeupTask(database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>, workflowId: string) {
  const rows = await database.all<{ id: number; record: string }>("SELECT id, record FROM tasks ORDER BY id");
  for (const row of rows) {
    const record = JSON.parse(row.record) as {
      kind?: unknown;
      input?: { workflowId?: unknown };
      state: { status: string; checkpoint?: unknown };
    };
    if (record.kind === "workshop.schedule-wakeup" && record.input?.workflowId === workflowId) {
      return { ...record, id: row.id };
    }
  }
  throw new Error("the scheduled wakeup task is missing");
}

function isWaitingForCapacity(task: { readonly state: { readonly checkpoint?: unknown } }): boolean {
  const checkpoint = task.state.checkpoint as { phase?: unknown; waitFor?: unknown } | undefined;
  return checkpoint?.phase === "wait" && checkpoint.waitFor === "capacity";
}

async function readRunSummary(socketPath: string, workflowId: string, runId: string) {
  const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId, limit: 100 });
  if (!response.ok) throw new Error(response.error.message);
  const page = serviceRunsPageV1Schema.parse(response.result);
  const summary = page.runs.find(run => run.runId === runId);
  if (summary === undefined) throw new Error("service did not return the requested run");
  return summary;
}

async function findProcessTask(database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>, runId: string) {
  const rows = await database.all<{ id: number; record: string }>("SELECT id, record FROM tasks ORDER BY id");
  for (const row of rows) {
    const record = JSON.parse(row.record) as { kind?: unknown; input?: { runId?: unknown }; state: { status: string; checkpoint?: unknown } };
    if (record.kind === "workshop.process-execution" && record.input?.runId === runId) return { ...record, id: row.id };
  }
  throw new Error("the interrupted process execution task is missing");
}

type NormalizedRecord = { table: string; key: string; column: string; kind: string | null; fields: string[]; occurrences: number };

async function normalizeCapturePaths(
  database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
  captureRoot: string,
  placeholder: string,
): Promise<{ records: NormalizedRecord[]; replacements: number }> {
  const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const records: NormalizedRecord[] = [];
  let replacements = 0;
  for (const { name: table } of tables) {
    const quotedTable = quoteIdentifier(table);
    const columns = await database.all<{ name: string; pk: number }>("PRAGMA table_info(" + quotedTable + ")");
    const primaryKey = columns.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk);
    const rows = await database.all<Record<string, unknown>>("SELECT rowid AS __capture_rowid, * FROM " + quotedTable);
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column.name];
        if (typeof value !== "string" || !value.includes(captureRoot)) continue;
        const paths = findPathFields(value, captureRoot);
        const count = countOccurrences(value, captureRoot);
        const where = primaryKey.length > 0 ? primaryKey.map(item => quoteIdentifier(item.name) + " = ?").join(" AND ") : "rowid = ?";
        const keyValues = (primaryKey.length > 0 ? primaryKey.map(item => row[item.name]) : [row.__capture_rowid]).map(value => {
          if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string" || value instanceof Uint8Array) return value;
          throw new Error("table contains an unsupported primary key value");
        });
        await database.run(
          "UPDATE " + quotedTable + " SET " + quoteIdentifier(column.name) + " = replace(" + quoteIdentifier(column.name) + ", ?, ?) WHERE " + where,
          captureRoot, placeholder, ...keyValues,
        );
        const recordObject = parseRecord(value);
        const kind = recordObject !== null && typeof recordObject.kind === "string" ? recordObject.kind : null;
        const key = primaryKey.length > 0
          ? primaryKey.map(item => item.name + "=" + String(row[item.name])).join(", ")
          : "rowid=" + String(row.__capture_rowid);
        records.push({ table, key, column: column.name, kind, fields: paths, occurrences: count });
        replacements += count;
      }
    }
  }
  const remaining = await countRootOccurrences(database, captureRoot);
  if (remaining !== 0) throw new Error("path normalization left capture-root text in the database");
  return { records, replacements };
}

async function countRootOccurrences(database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>, rootPath: string): Promise<number> {
  const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  let count = 0;
  for (const { name } of tables) {
    const quotedTable = quoteIdentifier(name);
    const columns = await database.all<{ name: string }>("PRAGMA table_info(" + quotedTable + ")");
    const rows = await database.all<Record<string, unknown>>("SELECT * FROM " + quotedTable);
    for (const row of rows) for (const column of columns) {
      const value = row[column.name];
      if (typeof value === "string") count += countOccurrences(value, rootPath);
    }
  }
  return count;
}

function findPathFields(value: string, rootPath: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return value.includes(rootPath) ? ["$"] : []; }
  const fields: string[] = [];
  const visit = (item: unknown, path: string) => {
    if (typeof item === "string") {
      if (item.includes(rootPath)) fields.push(path);
    } else if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, path + "[" + index + "]"));
    } else if (typeof item === "object" && item !== null) {
      for (const [key, child] of Object.entries(item)) visit(child, path + "." + key);
    }
  };
  visit(parsed, "$");
  return fields;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function killProcessGroup(processGroupId: number): Promise<void> {
  try { process.kill(-processGroupId, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(-processGroupId, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  throw new Error("the interrupted worker process group remains after SIGKILL");
}

function lineCount(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line.length > 0).length : 0;
}

function countOccurrences(value: string, searched: string): number {
  return value.split(searched).length - 1;
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
