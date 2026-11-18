import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { type Cursor, type Harness, type TaskRecord } from "@earendil-works/pi-durable";
import { checkProfileCommands } from "../config/check-profile-commands.ts";
import { loadWorkshopConfig } from "../config/load-workshop-config.ts";
import { STEP_ATTEMPT_TASK_NAME } from "../workflow/define-step-attempt-task.ts";
import { WORKFLOW_TASK_NAME, workflowDecisionDocument, type WorkflowTaskCheckpoint } from "../workflow/define-workflow-task.ts";
import { listWorkflowStatus } from "../workflow/list-workflow-status.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";
import { workshopStateDocument, workflowRunReferenceDocument } from "../workflow/define-workshop-state.ts";
import type { AttemptHistoryEntry, WorkflowStepResult } from "../workflow/types.ts";
import { projectWorkflowRunStatus, type WorkflowSchedulerAvailability } from "./project-workshop-status.ts";
import { DEFAULT_SERVICE_LIST_LIMIT, type ServiceRequest, type ServiceResponse } from "./parse-service-request.ts";

type WorkflowTaskRecord = TaskRecord<JsonValue, JsonValue, unknown>;
type WorkflowTaskState = WorkflowTaskCheckpoint;
type InspectedWorkflowTask = { record: WorkflowTaskRecord; availability: WorkflowSchedulerAvailability };
export type RunInput = { runId: string; workflow: string; slot: string | null; startedAt: string };

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
  return projectWorkflowRunStatus({
    record,
    checkpoint: checkpointOf(record),
    mailboxOccupied: false,
  }).status;
}

function outputTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[truncated; showing last ${limit} characters]\n${value.slice(-limit)}`;
}

function readConfiguration(projectRoot: string) {
  const configFile = process.env.WORKSHOP_CONFIG ?? resolve(projectRoot, "workshop.yaml");
  const config = loadWorkshopConfig(configFile);
  const issues = checkProfileCommands(config, process.env.PATH, configFile);
  if (issues.length > 0) throw new Error(issues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
  return config;
}

export async function scanLiveWorkflowTasks(harness: Harness): Promise<InspectedWorkflowTask[]> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return inspection.tasks.flatMap(({ record, state }) => record.kind === WORKFLOW_TASK_NAME
    ? [{ record, availability: state }]
    : []);
}

export async function taskForRun(harness: Harness, runId: string): Promise<WorkflowTaskRecord | undefined> {
  const reference = await harness.snapshot(workflowRunReferenceDocument, runId, BACKGROUND_CONTEXT);
  if (!reference || reference.run_id !== runId) return undefined;
  const record = await harness.getTask(reference.task_id, BACKGROUND_CONTEXT);
  if (!record || record.kind !== WORKFLOW_TASK_NAME || runInputOf(record)?.runId !== runId) return undefined;
  return record;
}

async function taskAvailability(harness: Harness, record: WorkflowTaskRecord): Promise<WorkflowSchedulerAvailability | undefined> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return inspection.tasks.find(({ record: candidate }) => candidate.id === record.id)?.state;
}

async function mailboxOccupied(harness: Harness, record: WorkflowTaskRecord): Promise<boolean> {
  const document = await harness.snapshot(workflowDecisionDocument, record.id, BACKGROUND_CONTEXT);
  return document !== undefined && document.choice !== null;
}

function statusResult(record: WorkflowTaskRecord): { returnValue?: Record<string, unknown>; error?: string } {
  const state = record.state;
  if (state.status !== "completing" && state.status !== "terminal") return {};
  if (state.outcome.status === "completed") return { returnValue: isRecord(state.outcome.result) ? state.outcome.result : undefined };
  if (state.outcome.status === "failed" || state.outcome.status === "faulted") {
    return { error: state.outcome.error.message };
  }
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

function blockedStep(checkpoint: WorkflowTaskCheckpoint | undefined, projection: ReturnType<typeof projectWorkflowRunStatus>): Record<string, unknown> | undefined {
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
    allowed_actions: projection.blocked_step?.allowed_actions ?? [],
    retry_profiles: projection.blocked_step?.retry_profiles ?? [...failure.retryProfiles],
  };
}

type StepAttemptReceipt = {
  step: string;
  attempt: number;
  profile?: string;
  kind: "accepted" | "failed" | "nothing-to-do";
  output: string;
  error?: string;
};

function stepAttemptReceipt(child: TaskRecord<JsonValue, JsonValue, JsonValue>, parent: WorkflowTaskRecord): StepAttemptReceipt | undefined {
  if (String(child.owner) !== String(parent.id) || !isRecord(child.input)) return undefined;
  const runId = child.input.runId;
  const step = child.input.step;
  const request = child.input.request;
  if (typeof runId !== "string" || runId !== runInputOf(parent)?.runId || !isRecord(step) || !isRecord(request)) return undefined;
  const attempt = request.attempt;
  if (typeof step.number !== "number" || typeof step.name !== "string" || typeof attempt !== "number" || !Number.isSafeInteger(attempt)) return undefined;
  if (child.state.status !== "completing" && child.state.status !== "terminal") return undefined;
  const outcome = child.state.outcome;
  if (outcome.status !== "completed" || !isRecord(outcome.result)) return undefined;
  const result = outcome.result;
  if ((result.kind !== "accepted" && result.kind !== "failed" && result.kind !== "nothing-to-do") || typeof result.output !== "string") return undefined;
  const error = result.kind === "failed" && typeof result.reason === "string" ? result.reason : undefined;
  if (result.kind === "failed" && error === undefined) return undefined;
  return {
    step: `${step.number}-${step.name}`,
    attempt,
    ...(typeof request.profile === "string" ? { profile: request.profile } : {}),
    kind: result.kind,
    output: result.output,
    ...(error === undefined ? {} : { error }),
  };
}

function savedStepIds(record: WorkflowTaskRecord): string[] {
  if (!isRecord(record.input) || !isRecord(record.input.workflow) || !Array.isArray(record.input.workflow.steps)) return [];
  return record.input.workflow.steps.flatMap((step) => isRecord(step)
    && Number.isSafeInteger(step.number)
    && typeof step.name === "string"
    ? [`${step.number}-${step.name}`]
    : []);
}

function attemptHistory(receipts: readonly StepAttemptReceipt[]): AttemptHistoryEntry[] {
  return receipts.map((receipt) => ({
    attempt: receipt.attempt,
    ...(receipt.profile === undefined ? {} : { profile: receipt.profile }),
    output: receipt.output,
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  }));
}

async function reconstructTerminalProgress(
  harness: Harness,
  record: WorkflowTaskRecord,
): Promise<{ steps: WorkflowStepResult[]; output?: string } | undefined> {
  if (record.state.status !== "completing" && record.state.status !== "terminal") return undefined;
  if (record.state.outcome.status === "completed") return undefined;
  const stepIds = savedStepIds(record);
  if (stepIds.length === 0) return undefined;

  const childRecords = await harness.commit(async (tx) => {
    const records: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ kind: STEP_ATTEMPT_TASK_NAME }, 1_000, cursor);
      records.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return records;
  }, BACKGROUND_CONTEXT);
  const byStep = new Map<string, StepAttemptReceipt[]>();
  for (const child of childRecords) {
    const receipt = stepAttemptReceipt(child, record);
    if (!receipt) continue;
    const attempts = byStep.get(receipt.step) ?? [];
    attempts.push(receipt);
    byStep.set(receipt.step, attempts);
  }
  const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
  const runId = runInputOf(record)?.runId;
  const decisions = (state?.actions ?? []).filter((action) => action.run_id === runId && action.step !== null);
  const steps: WorkflowStepResult[] = [];
  for (const step of stepIds) {
    const receipts = (byStep.get(step) ?? []).sort((left, right) => left.attempt - right.attempt);
    const action = [...decisions].reverse().find((entry) => entry.step === step)?.decision.action;
    const accepted = receipts.find((entry) => entry.kind === "accepted");
    const nothingToDo = receipts.find((entry) => entry.kind === "nothing-to-do");
    if (accepted) {
      steps.push({ step, status: "completed", output: accepted.output, attempts: attemptHistory(receipts.filter((entry) => entry.attempt <= accepted.attempt)) });
      continue;
    }
    if (nothingToDo) {
      steps.push({ step, status: "nothing-to-do", output: nothingToDo.output, attempts: attemptHistory(receipts.filter((entry) => entry.attempt <= nothingToDo.attempt)) });
      break;
    }
    if (action === "skip") {
      steps.push({ step, status: "skipped", output: "", attempts: attemptHistory(receipts) });
      continue;
    }
    if (action === "accept" && receipts.length > 0) {
      const last = receipts.at(-1);
      if (last) steps.push({ step, status: "completed", output: last.output, attempts: attemptHistory(receipts) });
      continue;
    }
    break;
  }
  if (steps.length === 0) return undefined;
  let output = "";
  for (const step of steps) {
    if (step.status !== "skipped") output = step.output;
  }
  return { steps, output };
}

async function runDetails(
  harness: Harness,
  record: WorkflowTaskRecord,
  availability: WorkflowSchedulerAvailability | undefined,
  occupied: boolean,
) {
  const input = runInputOf(record);
  if (!input) throw new Error("Durable workflow task has invalid run metadata");
  const outcome = statusResult(record);
  const checkpoint = checkpointOf(record);
  const projection = projectWorkflowRunStatus({ record, availability, checkpoint, mailboxOccupied: occupied });
  const reconstructed = await reconstructTerminalProgress(harness, record);
  const priorSteps = resultSteps(record) ?? reconstructed?.steps;
  const current = checkpoint?.pipeInput;
  const resultOutput = outcome.returnValue && Object.hasOwn(outcome.returnValue, "output")
    ? outcome.returnValue.output
    : current ?? reconstructed?.output;
  return {
    run_id: input.runId,
    workflow: input.workflow,
    slot: input.slot,
    started_at: input.startedAt,
    status: projection.status,
    phase: projection.phase,
    status_message: projection.status_message,
    allowed_actions: projection.allowed_actions,
    ...(priorSteps === undefined ? {} : { steps: priorSteps }),
    ...(resultOutput === undefined ? {} : { output: resultOutput }),
    ...(projection.error === undefined ? (outcome.error === undefined ? {} : { error: outcome.error }) : { error: projection.error }),
    ...(blockedStep(checkpoint, projection) === undefined ? {} : { blocked_step: blockedStep(checkpoint, projection) }),
  };
}

async function runSummary(
  record: WorkflowTaskRecord,
  availability: WorkflowSchedulerAvailability | undefined,
  occupied: boolean,
) {
  const input = runInputOf(record);
  if (!input) return undefined;
  const checkpoint = checkpointOf(record);
  const projection = projectWorkflowRunStatus({ record, availability, checkpoint, mailboxOccupied: occupied });
  const blocked = blockedStep(checkpoint, projection);
  return {
    run_id: input.runId,
    workflow: input.workflow,
    slot: input.slot,
    started_at: input.startedAt,
    status: projection.status,
    phase: projection.phase,
    status_message: projection.status_message,
    allowed_actions: projection.allowed_actions,
    ...(blocked === undefined ? {} : {
      blocked_step: blocked.step,
      last_error: blocked.last_error,
      blocked_step_allowed_actions: blocked.allowed_actions,
      blocked_step_retry_profiles: blocked.retry_profiles,
    }),
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
      const limit = request.limit ?? DEFAULT_SERVICE_LIST_LIMIT;
      if (limit === 0) return { request_id: request.request_id, ok: true, runs: [] };
      const [tasks, state] = await Promise.all([
        scanLiveWorkflowTasks(input.harness),
        input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT),
      ]);
      const liveRows = await Promise.all(tasks.map(async ({ record, availability }) =>
        await runSummary(record, availability, await mailboxOccupied(input.harness, record))));
      const live = liveRows.flatMap((run) => run !== undefined && (request.workflow === undefined || run.workflow === request.workflow) ? [run] : []);
      const liveById = new Map(live.map((run) => [run.run_id, run]));
      const admissions = (state?.admissions ?? []).filter((admission) => request.workflow === undefined || admission.workflow === request.workflow).slice(-limit);
      const recent = await Promise.all(admissions.map(async (admission) => {
        if (admission.outcome === "skipped") return {
          run_id: null,
          workflow: admission.workflow,
          slot: admission.slot,
          started_at: admission.at,
          status: "skipped",
          phase: "skipped",
          status_message: admission.reason ?? "Workflow slot was skipped.",
          allowed_actions: [],
          reason: admission.reason,
        };
        if (admission.run_id === null) return undefined;
        const current = liveById.get(admission.run_id);
        if (current) return current;
        const task = await taskForRun(input.harness, admission.run_id);
        if (!task) return {
          run_id: admission.run_id,
          workflow: admission.workflow,
          slot: admission.slot,
          started_at: admission.at,
          status: "unavailable",
          phase: "definition-unavailable",
          status_message: "Durable workflow task was not found.",
          allowed_actions: [],
          reason: "Durable workflow task was not found",
        };
        return await runSummary(task, await taskAvailability(input.harness, task), await mailboxOccupied(input.harness, task));
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
      const [availability, occupied] = await Promise.all([
        taskAvailability(input.harness, record),
        mailboxOccupied(input.harness, record),
      ]);
      return { request_id: request.request_id, ok: true, run: await runDetails(input.harness, record, availability, occupied) };
    }
  }
}
