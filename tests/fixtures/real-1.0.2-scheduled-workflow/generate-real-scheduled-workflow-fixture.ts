import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createRegistry, Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadInstallation } from "../../../src/installation/load-installation.js";
import { probeServiceHealth } from "../../../src/service/probe-service-health.js";
import { sendServiceRequest } from "../../../src/service/send-service-request.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../../../src/service/schema.js";
import { startWorkshopService } from "../../../src/service/open-service-runtime.js";
import { canonicalHash } from "../../../src/definition/hash-canonical-json.js";
import { defineAgentExecutionTask } from "../../../src/storage/durable/define-agent-execution-task.js";
import { defineScheduleWakeupTask } from "../../../src/storage/durable/define-scheduler-wakeup-task.js";
import { defineWorkshopTasks } from "../../../src/storage/durable/define-workshop-tasks.js";
import { openDurableStorage } from "../../../src/storage/durable/open-durable-storage.js";

const FIXTURE_ROOT = "/WORKSHOP_FIXTURE_ROOT";
const outputDirectory = fileURLToPath(new URL("./", import.meta.url));
const captureRoot = mkdtempSync(join(tmpdir(), "workshop-real-scheduled-capture-"));
const workshopDirectory = join(captureRoot, ".workshop");
const workflowsDirectory = join(workshopDirectory, "workflows");
mkdirSync(workflowsDirectory, { recursive: true });
copyFileSync(join(outputDirectory, "workshop.yaml"), join(workshopDirectory, "workshop.yaml"));
copyFileSync(join(outputDirectory, "scheduled-migration.yaml"), join(workflowsDirectory, "scheduled-migration.yaml"));

const provider = fauxProvider({ provider: "fixture", models: [{ id: "legacy-worker" }] });
let modelRequests = 0;
provider.setResponses([() => {
  modelRequests += 1;
  return fauxAssistantMessage("<status>succeeded</status>\n<reason>Legacy faux worker completed the capture.</reason>\n<output>HISTORICAL_SCHEDULED_CAPTURE</output>");
}]);
const models = createModels();
models.setProvider(provider.provider);
const installation = loadInstallation(captureRoot);
let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
let inspectionHarness: HarnessType | undefined;
try {
  owner = await startWorkshopService(installation, models);
  const health = await probeServiceHealth(installation.stateDirectory);
  if (health.kind !== "ready") throw new Error(health.reason);
  const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
    version: 1, method: "start", requestId: "real-1.0.2-scheduled-capture", workflowId: "scheduled-migration",
  });
  if (!startedResponse.ok) throw new Error(startedResponse.error.message);
  const started = serviceStartResultV1Schema.parse(startedResponse.result);
  await waitForCompletedRun(health.metadata.socketPath, started.runId);
  if (modelRequests !== 1) throw new Error("the historical faux worker did not make exactly one model request");

  await owner.shutdown();
  owner = undefined;
  const opened = await openDurableStorage(installation.databasePath);
  if (!opened.ok) throw new Error(opened.failure.message + ": " + String(opened.failure.cause));
  let activeHarness: HarnessType | undefined;
  const agentExecution = defineAgentExecutionTask({ getHarness: () => {
    if (activeHarness === undefined) throw new Error("inspection Harness is unavailable");
    return activeHarness;
  } });
  const tasks = defineWorkshopTasks("real-1.0.2-scheduled-capture", { agentExecutionTask: agentExecution.task });
  const taskVersions = { workflowRun: 11, nodeAttempt: 5, agentExecution: 1, processExecution: 4, capacityGate: 1, scheduleWakeup: 1 } as const;
  const scheduleWakeupTask = defineScheduleWakeupTask({
    installation,
    workflowRunTask: tasks.WorkflowRunTask,
    runtimeManifest: { durableVersion: "1.0.2", integrationManifestHash: canonicalHash({ taskVersions }), taskVersions },
  });
  const registry = createRegistry();
  registry.install({
    name: "workshop-service-runtime",
    tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, agentExecution.task, scheduleWakeupTask],
  });
  registry.install(agentExecution.guard.extension);
  registry.install(CodingTools);
  activeHarness = await Harness.open(opened.storage, { models, registry }, BACKGROUND_CONTEXT);
  inspectionHarness = activeHarness;
  const inspection = await inspectionHarness.inspect(BACKGROUND_CONTEXT);
  const scheduler = inspection.tasks.find(task => task.record.kind === "workshop.schedule-wakeup");
  if (scheduler === undefined) throw new Error("the historical Workshop scheduler task is missing");
  const checkpoint = (scheduler.record.state as { checkpoint?: { phase?: unknown; waitFor?: unknown; wakeAt?: unknown } }).checkpoint;
  if (checkpoint?.phase !== "wait" || checkpoint.waitFor !== "deadline" || typeof checkpoint.wakeAt !== "string") {
    throw new Error("the historical scheduler did not persist a deadline wait: " + JSON.stringify(checkpoint));
  }
  await inspectionHarness.close(BACKGROUND_CONTEXT);
  inspectionHarness = undefined;

  const normalization = await normalizeCaptureRoot(installation.databasePath, captureRoot);
  copyFileSync(installation.databasePath, join(outputDirectory, "durable.db"));
  writeFileSync(join(outputDirectory, "path-normalization.json"), JSON.stringify(normalization, null, 2) + "\n");
  console.log("Wrote a path-normalized 1.0.2 capture with the original completed run and waiting scheduler state.");
} finally {
  if (inspectionHarness !== undefined) await inspectionHarness.close(BACKGROUND_CONTEXT);
  if (owner !== undefined) await owner.shutdown().catch(() => undefined);
  rmSync(captureRoot, { recursive: true, force: true });
}

async function normalizeCaptureRoot(databasePath: string, captureRoot: string) {
  const database = await openNodeSqliteDatabase(databasePath);
  try {
    const documentRevisions = await database.all<{ document_id: number; seq: number; content: string }>(
      "SELECT document_id, seq, content FROM document_revisions WHERE instr(content, ?) > 0 ORDER BY document_id, seq",
      captureRoot,
    );
    const tasks = await database.all<{ id: number; kind: string; record: string }>(
      "SELECT id, kind, record FROM tasks WHERE instr(record, ?) > 0 ORDER BY id", captureRoot,
    );
    const entries = await database.all<{ id: number; record: string }>(
      "SELECT id, record FROM entries WHERE instr(record, ?) > 0 ORDER BY id", captureRoot,
    );
    requireIds(documentRevisions.map(row => row.document_id + ":" + row.seq), ["12:2", "23:10", "24:10"], "document revision");
    requireIds(tasks.map(row => row.id + ":" + row.kind), ["17:" + JSON.stringify("workshop.agent-execution")], "task");
    requireIds(entries.map(row => row.id), [27], "entry");
    const replacementCount = documentRevisions.reduce((sum, row) => sum + countOccurrences(row.content, captureRoot), 0)
      + tasks.reduce((sum, row) => sum + countOccurrences(row.record, captureRoot), 0)
      + entries.reduce((sum, row) => sum + countOccurrences(row.record, captureRoot), 0);
    if (replacementCount !== 13 || await countTextOccurrences(database, captureRoot) !== 13) {
      throw new Error("capture root appears outside the expected 13 legacy path strings");
    }

    await database.exec("BEGIN IMMEDIATE");
    try {
      await database.run("UPDATE document_revisions SET content = replace(content, ?, ?) WHERE instr(content, ?) > 0", captureRoot, FIXTURE_ROOT, captureRoot);
      await database.run("UPDATE tasks SET record = replace(record, ?, ?) WHERE instr(record, ?) > 0", captureRoot, FIXTURE_ROOT, captureRoot);
      await database.run("UPDATE entries SET record = replace(record, ?, ?) WHERE instr(record, ?) > 0", captureRoot, FIXTURE_ROOT, captureRoot);
      await database.exec("COMMIT");
    } catch (error) {
      await database.exec("ROLLBACK");
      throw error;
    }
    await database.exec("VACUUM");
    if (await countTextOccurrences(database, captureRoot) !== 0 || await countTextOccurrences(database, "/var/") !== 0) {
      throw new Error("machine-specific paths remain in the normalized SQLite capture");
    }
    if (await countTextOccurrences(database, FIXTURE_ROOT) !== 13) {
      throw new Error("the normalized fixture does not contain exactly 13 path placeholders");
    }
    return {
      sourceCommit: "70ba39324a8c2eac2c2c15a817ffb8547e603a42",
      durableVersion: "1.0.2",
      rootPlaceholder: FIXTURE_ROOT,
      replacements: replacementCount,
      records: [
        { table: "document_revisions", key: "document_id=12, seq=2", documentKind: "workshop.run", fields: ["resolvedSettings.nodes.write.run.cwd", "paths.projectCwd", "paths.workflowDirectory"], occurrences: 3 },
        { table: "document_revisions", key: "document_id=23, seq=10", documentKind: "pi.agent", fields: ["cwd"], occurrences: 1 },
        { table: "document_revisions", key: "document_id=24, seq=10", documentKind: "workshop.agent-execution-environment", fields: ["values.WORKSHOP_RESULTS_PATH", "values.WORKSHOP_LOG_PATH"], occurrences: 2 },
        { table: "tasks", key: "id=17", taskKind: "workshop.agent-execution", fields: ["input.cwd", "input.promptText (results and log paths)", "input.env.WORKSHOP_RESULTS_PATH", "input.env.WORKSHOP_LOG_PATH"], occurrences: 5 },
        { table: "entries", key: "id=27", entryKind: "pi.user", fields: ["model[0].content (results and log paths)"], occurrences: 2 },
      ],
      transformation: "Replaced only the disposable capture workspace root in stored text payloads after the historical Harness closed. Task state, evidence, IDs, and checkpoints were not edited.",
    };
  } finally {
    await database.close();
  }
}

function requireIds(actual: readonly (string | number)[], expected: readonly (string | number)[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("unexpected " + label + " records during fixture path normalization: " + JSON.stringify(actual));
  }
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

async function countTextOccurrences(database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>, value: string): Promise<number> {
  const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  let occurrences = 0;
  for (const table of tables) {
    const tableName = quoteIdentifier(table.name);
    const columns = await database.all<{ name: string }>("PRAGMA table_info(" + tableName + ")");
    for (const column of columns) {
      const columnName = quoteIdentifier(column.name);
      const values = await database.all<{ value: string }>(
        "SELECT " + columnName + " AS value FROM " + tableName + " WHERE typeof(" + columnName + ") = 'text'",
      );
      occurrences += values.reduce((sum, row) => sum + countOccurrences(row.value, value), 0);
    }
  }
  return occurrences;
}

function quoteIdentifier(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}

async function waitForCompletedRun(socketPath: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "scheduled-migration", limit: 100 });
    if (!response.ok) throw new Error(response.error.message);
    const page = serviceRunsPageV1Schema.parse(response.result);
    const run = page.runs.find(candidate => candidate.runId === runId);
    if (run?.status === "completed") return;
    if (run !== undefined && ["failed", "blocked", "cancelled"].includes(run.status)) {
      throw new Error("historical faux run settled as " + run.status);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("historical faux run did not complete before the capture deadline");
}
