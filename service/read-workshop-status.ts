import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { type Harness, type TaskRecord } from "@earendil-works/pi-durable";
import { checkProfileCommands, readConfig } from "../config/read-workshop-config.ts";
import { WORKFLOW_TASK_NAME, type WorkflowTaskCheckpoint } from "../workflow/define-workflow-task.ts";
import { listWorkflowStatus } from "../workflow/list-workflow-status.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";
import { workshopStateDocument, workflowRunReferenceDocument } from "../workflow/define-workshop-state.ts";
import type { ServiceRequest, ServiceResponse } from "./types.ts";

type WorkflowTaskRecord = TaskRecord<JsonValue, JsonValue, unknown>;
export type RunInput = { runId: string; workflow: string; slot: string | null; startedAt: string };
type WorkflowTaskState = WorkflowTaskCheckpoint;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkflowTaskCheckpoint(value: unknown): value is WorkflowTaskCheckpoint {
  if (!isRecord(value) || !["step", "attempt", "blocked", "decision"].includes(String(value.phase))) return false;
  if (!Number.isSafeInteger(value.stepIndex) || typeof value.pipeInput !== "string" || !Array.isArray(value.results) || !Array.isArray(value.attemptHistory)) return false;
  if (typeof value.localRetriesLeft !== "number" || typeof value.feedback !== "string" || typeof value.decisionNumber !== "number" || typeof value.automaticRoundUsed !== "boolean") return false;
  if (value.profile !== undefined && typeof value.profile !== "string") return false;
  if (value.waitUntil !== undefined && typeof value.waitUntil !== "number") return false;
  if (value.roundStatus !== undefined && value.roundStatus !== "pending" && value.roundStatus !== "settled") return false;
  if (value.decisionSource !== undefined && value.decisionSource !== "chat" && value.decisionSource !== "round") return false;
  if (value.phase === "attempt" && (!isRecord(value.activeAttempt) || (typeof value.activeAttempt.taskId !== "string" && typeof value.activeAttempt.taskId !== "number") || !isRecord(value.activeAttempt.request))) return false;
  if (value.phase === "blocked" || value.phase === "decision") {
    if (!isRecord(value.failure) || typeof value.failure.step !== "string" || typeof value.failure.lastError !== "string" || typeof value.failure.lastOutput !== "string" || !Array.isArray(value.failure.retryProfiles) || !Array.isArray(value.failure.attemptHistory)) return false;
  }
  if (value.phase === "decision" && (!isRecord(value.decision) || !["retry", "skip", "accept", "fail"].includes(String(value.decision.action)))) return false;
  return true;
}

export function runInputOf(record: WorkflowTaskRecord): RunInput | undefined {
  if (!isRecord(record.input)) return undefined;
  const { runId, workflowName, slot, startedAt } = record.input;
  if (typeof runId !== "string" || typeof workflowName !== "string" || typeof startedAt !== "string") return undefined;
  return { runId, workflow: workflowName, slot: typeof slot === "string" ? slot : null, startedAt };
}

export function checkpointOf(record: WorkflowTaskRecord): WorkflowTaskState | undefined {
  const state = record.state;
  if (state.status !== "pending" && state.status !== "running" && state.status !== "waiting" && state.status !== "sleeping") return undefined;
  return isWorkflowTaskCheckpoint(state.checkpoint) ? state.checkpoint : undefined;
}

export function checkpointPhase(record: WorkflowTaskRecord): string | undefined {
  return checkpointOf(record)?.phase;
}

export function statusOf(record: WorkflowTaskRecord): string {
  const phase = checkpointPhase(record);
  const state = record.state;
  if (state.status === "pending" || state.status === "running" || state.status === "waiting" || state.status === "sleeping") {
    return phase === "blocked" || phase === "decision" ? "blocked" : state.status;
  }
  if (state.status === "completing" || state.status === "terminal") {
    if (state.outcome.status === "completed") {
      const result = state.outcome.result;
      return isRecord(result) && result.status === "nothing-to-do" ? "nothing-to-do" : "completed";
    }
    if (state.outcome.status === "aborted") return "cancelled";
    return state.outcome.status;
  }
  return "unavailable";
}

function outputTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[truncated; showing last ${limit} characters]\n${value.slice(-limit)}`;
}

function readConfiguration(projectRoot: string) {
  const configFile = process.env.WORKSHOP_CONFIG ?? resolve(projectRoot, "workshop.yaml");
  const config = readConfig(configFile);
  const issues = checkProfileCommands(config, process.env.PATH, configFile);
  if (issues.length > 0) throw new Error(issues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
  return config;
}

export async function scanLiveWorkflowTasks(harness: Harness): Promise<WorkflowTaskRecord[]> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return inspection.tasks
    .map(({ record }) => record)
    .filter((record) => record.kind === WORKFLOW_TASK_NAME);
}

export async function taskForRun(harness: Harness, runId: string): Promise<WorkflowTaskRecord | undefined> {
  const reference = await harness.snapshot(workflowRunReferenceDocument, runId, BACKGROUND_CONTEXT);
  if (!reference || reference.run_id !== runId) return undefined;
  const record = await harness.getTask(reference.task_id, BACKGROUND_CONTEXT);
  if (!record || record.kind !== WORKFLOW_TASK_NAME || runInputOf(record)?.runId !== runId) return undefined;
  return record;
}

function statusResult(record: WorkflowTaskRecord): { returnValue?: Record<string, unknown>; error?: string } {
  const state = record.state;
  if (state.status !== "completing" && state.status !== "terminal") return {};
  if (state.outcome.status === "completed") return { returnValue: isRecord(state.outcome.result) ? state.outcome.result : undefined };
  if (state.outcome.status === "failed") return { error: state.outcome.error.message };
  if (state.outcome.status === "aborted") return { error: state.outcome.reason ?? "cancelled" };
  return { error: state.outcome.reason };
}

function resultSteps(record: WorkflowTaskRecord): unknown[] | undefined {
  const result = statusResult(record).returnValue;
  if (Array.isArray(result?.steps)) return result.steps;
  const checkpoint = checkpointOf(record);
  if (checkpoint && Array.isArray(checkpoint.results)) return checkpoint.results;
  return undefined;
}

function blockedStep(record: WorkflowTaskRecord): Record<string, unknown> | undefined {
  const checkpoint = checkpointOf(record);
  if (!checkpoint || (checkpoint.phase !== "blocked" && checkpoint.phase !== "decision")) return undefined;
  const failure = checkpoint.failure;
  return {
    step: failure.step,
    decision_number: failure.decisionNumber,
    last_error: failure.lastError,
    last_output: outputTail(failure.lastOutput, 4_000),
    attempt_history: failure.attemptHistory.map((attempt) => ({
      ...attempt,
      output: outputTail(attempt.output, 2_000),
      ...(attempt.error === undefined ? {} : { error: outputTail(attempt.error, 2_000) }),
    })),
  };
}

function runDetails(record: WorkflowTaskRecord) {
  const input = runInputOf(record);
  if (!input) throw new Error("Durable workflow task has invalid run metadata");
  const outcome = statusResult(record);
  const checkpoint = checkpointOf(record);
  const current = checkpoint && isRecord(checkpoint) && typeof checkpoint.pipeInput === "string" ? checkpoint.pipeInput : undefined;
  return {
    run_id: input.runId,
    workflow: input.workflow,
    slot: input.slot,
    started_at: input.startedAt,
    status: statusOf(record),
    ...(resultSteps(record) === undefined ? {} : { steps: resultSteps(record) }),
    ...(outcome.returnValue && Object.hasOwn(outcome.returnValue, "output") ? { output: outcome.returnValue.output } : current === undefined ? {} : { output: current }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(blockedStep(record) === undefined ? {} : { blocked_step: blockedStep(record) }),
  };
}

function runSummary(record: WorkflowTaskRecord) {
  const input = runInputOf(record);
  if (!input) return undefined;
  const blocked = blockedStep(record);
  return {
    run_id: input.runId,
    workflow: input.workflow,
    slot: input.slot,
    started_at: input.startedAt,
    status: statusOf(record),
    ...(blocked === undefined ? {} : { blocked_step: blocked.step, last_error: blocked.last_error }),
  };
}

export async function readWorkshopStatus(
  request: Extract<ServiceRequest, { type: "list_workflows" | "list_runs" | "read_run" }>,
  input: { projectRoot: string; workflowDirectory: string; harness: Harness },
): Promise<ServiceResponse> {
  switch (request.type) {
    case "list_workflows": {
      const config = readConfiguration(input.projectRoot);
      const loaded = loadWorkflows(input.workflowDirectory, new Set(Object.keys(config.agent_profiles)));
      const state = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
      return { request_id: request.request_id, ok: true, ...listWorkflowStatus(loaded, new Set(state?.paused ?? [])) };
    }
    case "list_runs": {
      const limit = request.limit ?? 20;
      if (limit === 0) return { request_id: request.request_id, ok: true, runs: [] };
      const [tasks, state] = await Promise.all([
        scanLiveWorkflowTasks(input.harness),
        input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT),
      ]);
      const live = tasks.flatMap((task) => {
        const run = runSummary(task);
        return run !== undefined && (request.workflow === undefined || run.workflow === request.workflow) ? [run] : [];
      });
      const liveById = new Map(live.map((run) => [run.run_id, run]));
      const admissions = (state?.admissions ?? []).filter((admission) => request.workflow === undefined || admission.workflow === request.workflow).slice(-limit);
      const recent = await Promise.all(admissions.map(async (admission) => {
        if (admission.outcome === "skipped") return {
          run_id: null,
          workflow: admission.workflow,
          slot: admission.slot,
          started_at: admission.at,
          status: "skipped",
          reason: admission.reason,
        };
        if (admission.run_id === null) return undefined;
        const current = liveById.get(admission.run_id);
        if (current) return current;
        const task = await taskForRun(input.harness, admission.run_id);
        const run = task === undefined ? undefined : runSummary(task);
        return run ?? {
          run_id: admission.run_id,
          workflow: admission.workflow,
          slot: admission.slot,
          started_at: admission.at,
          status: "unavailable",
          reason: "Durable workflow task was not found",
        };
      }));
      const rows = [...live, ...recent.filter((row): row is NonNullable<typeof row> => row !== undefined)];
      const seen = new Set<string>();
      const unique = rows.filter((row) => {
        const key = row.run_id === null ? `${row.workflow}:${row.slot}:${row.status}` : row.run_id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      unique.sort((left, right) => Number(right.status === "blocked") - Number(left.status === "blocked") || right.started_at.localeCompare(left.started_at));
      return { request_id: request.request_id, ok: true, runs: unique.slice(0, limit) };
    }
    case "read_run": {
      const record = await taskForRun(input.harness, request.run_id);
      if (!record) throw new Error(`Workflow run ${request.run_id} was not found`);
      return { request_id: request.request_id, ok: true, run: runDetails(record) };
    }
  }
}
