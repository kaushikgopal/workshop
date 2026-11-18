import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { requestService, type ServiceRequestInput } from "../service/request-service.ts";
import type { ServiceResponse } from "../service/parse-service-request.ts";

const activityWindowMs = 24 * 60 * 60 * 1_000;

type ActivityRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ActivityRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestWorkshopService(
  request: ServiceRequestInput,
  stateDirectory: string,
  socketPath: string,
): Promise<ServiceResponse> {
  let response: ServiceResponse;
  try {
    response = await requestService(request, stateDirectory);
  } catch (error) {
    throw new Error(`Cannot reach Workshop service at ${socketPath}: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    const detail = typeof response.error === "string" ? response.error : "the request was rejected";
    throw new Error(`Workshop service API request ${request.type} failed: ${detail}`);
  }
  return response;
}

function readRecords(response: ServiceResponse, field: string): ActivityRecord[] {
  const value = response[field];
  if (!Array.isArray(value)) throw new Error(`Workshop service returned an invalid ${field} list`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Workshop service returned an invalid ${field} entry at index ${index}`);
    return entry;
  });
}

function readTimestamp(record: ActivityRecord, field: string, label: string): number {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Workshop service returned ${label} without a timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Workshop service returned an invalid ${label} timestamp`);
  return timestamp;
}

function isRecent(record: ActivityRecord, field: string, label: string, start: number, end: number): boolean {
  const timestamp = readTimestamp(record, field, label);
  return timestamp >= start && timestamp <= end;
}

async function readRunDetails(
  run: ActivityRecord,
  stateDirectory: string,
  socketPath: string,
): Promise<ActivityRecord> {
  const runId = run["run_id"];
  if (runId === null) return run;
  if (typeof runId !== "string") throw new Error("Workshop service returned a run without a valid run_id");

  const response = await requestWorkshopService({
    request_id: randomUUID(),
    type: "read_run",
    run_id: runId,
  }, stateDirectory, socketPath);
  const details = response["run"];
  if (!isRecord(details)) throw new Error(`Workshop service returned invalid details for run ${runId}`);
  return { ...run, ...details };
}

async function main(): Promise<void> {
  const projectRoot = process.env.WORKSHOP_PROJECT_ROOT;
  if (!projectRoot) throw new Error("WORKSHOP_PROJECT_ROOT is required");

  const stateDirectory = resolve(projectRoot, "state");
  const socketPath = resolve(stateDirectory, "service.sock");
  const end = Date.now();
  const start = end - activityWindowMs;
  const [runsResponse, actionsResponse] = await Promise.all([
    requestWorkshopService({ request_id: randomUUID(), type: "list_runs", limit: 1_000 }, stateDirectory, socketPath),
    requestWorkshopService({ request_id: randomUUID(), type: "list_actions", limit: 1_000 }, stateDirectory, socketPath),
  ]);

  const recentRuns = readRecords(runsResponse, "runs")
    .filter((run) => isRecent(run, "started_at", "run", start, end));
  const actions = readRecords(actionsResponse, "actions")
    .filter((action) => isRecent(action, "at", "action", start, end));
  const runs: ActivityRecord[] = [];
  for (const run of recentRuns) runs.push(await readRunDetails(run, stateDirectory, socketPath));

  const report = {
    window_start: new Date(start).toISOString(),
    window_end: new Date(end).toISOString(),
    runs,
    actions,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(`Could not read Workshop activity: ${errorMessage(error)}`);
  process.exitCode = 1;
}
