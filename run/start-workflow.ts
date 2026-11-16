import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, Harness, TaskRecord, Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { checkProfileCommands, readConfig } from "../config/read-workshop-config.ts";
import type { WorkshopConfig } from "../config/read-workshop-config.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";
import type { Workflow } from "../workflow/types.ts";
import { WorkflowTask, WORKFLOW_TASK_NAME, type WorkflowTaskInput, workflowDecisionDocument } from "../workflow/define-workflow-task.ts";
import { appendRecent, workshopStateDocument, workflowRunReferenceDocument, type WorkshopAction, type WorkflowRunReference, type WorkshopState } from "../workflow/define-workshop-state.ts";
import { decideWorkflowAdmission, type WorkflowAdmissionCommand, type WorkflowAdmissionDecision } from "./decide-workflow-admission.ts";
import { latestCronSlot } from "../schedule/decide-workflow-slot.ts";

export type StartWorkflowOutcome =
  | { kind: "started"; workflow: string; run_id: string; slot: string | null; task_id: string }
  | { kind: "skipped"; workflow: string; slot: string; reason: string }
  | { kind: "already-indexed"; workflow: string; slot: string }
  | { kind: "locked"; workflow: string; reason: string };

export type StartWorkflowResult = StartWorkflowOutcome | { kind: "replayed"; response: JsonValue };

export type WorkflowStartPort = {
  conversationId: ConversationId;
  commit<T extends object>(change: (tx: Tx) => Promise<T>): Promise<T>;
  readState(): Promise<WorkshopState | undefined>;
};

type WorkflowTaskRecord = TaskRecord<JsonValue, JsonValue, unknown>;

class WorkflowAdmissionConflict extends Error {
  readonly code = "request_id_conflict";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLive(record: WorkflowTaskRecord): boolean {
  return ["pending", "running", "waiting", "sleeping", "completing"].includes(record.state.status);
}

function workflowOf(record: WorkflowTaskRecord): string | undefined {
  return isRecord(record.input) && typeof record.input.workflowName === "string" ? record.input.workflowName : undefined;
}

async function liveTasksInTransaction(tx: Tx): Promise<WorkflowTaskRecord[]> {
  const records: WorkflowTaskRecord[] = [];
  for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ kind: WORKFLOW_TASK_NAME, status }, 1_000, cursor);
      records.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return records;
}

function configurationFor(projectRoot: string, workflowName: string): { config: WorkshopConfig; workflow: Workflow } {
  const configFile = process.env.WORKSHOP_CONFIG ?? resolve(projectRoot, "workshop.yaml");
  const config = readConfig(configFile);
  const issues = checkProfileCommands(config, process.env.PATH, configFile);
  if (issues.length > 0) throw new Error(issues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
  const workflows = loadWorkflows(resolve(projectRoot, "workflows"), new Set(Object.keys(config.agent_profiles)));
  const workflow = workflows.workflows.find((candidate) => candidate.name === workflowName);
  if (workflow) return { config, workflow };
  const details = workflows.errors
    .filter(({ file }) => file === workflowName || file.startsWith(`${workflowName}/`))
    .map(({ file, reason }) => `${file}: ${reason}`)
    .join("\n");
  throw new Error(details || `Workflow not found: ${workflowName}`);
}

export function createWorkflowStartPort(harness: Harness): Promise<WorkflowStartPort> {
  return harness.root(BACKGROUND_CONTEXT).then((root) => ({
    conversationId: root.id,
    commit: async <T extends object>(change: (tx: Tx) => Promise<T>) => await root.commit(change, BACKGROUND_CONTEXT),
    readState: async () => await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT),
  }));
}

function runReferenceFor(record: WorkflowTaskRecord): WorkflowRunReference | undefined {
  if (record.kind !== WORKFLOW_TASK_NAME || !isRecord(record.input)) return undefined;
  const { runId, workflowName, startedAt, slot } = record.input;
  if (typeof runId !== "string" || typeof workflowName !== "string" || typeof startedAt !== "string" || (slot !== null && typeof slot !== "string")) return undefined;
  return { run_id: runId, task_id: record.id, workflow: workflowName, slot, started_at: startedAt };
}



function startedCountForWorkflow(state: WorkshopState, workflow: string): number {
  return Object.hasOwn(state.startedCounts, workflow) ? state.startedCounts[workflow] ?? 0 : 0;
}

function recordAdmission(state: WorkshopState, workflow: string, slot: string | null, runId: string | null, outcome: "started" | "skipped", at: string, reason?: string): void {
  appendRecent(state.admissions, {
    workflow,
    slot,
    run_id: runId,
    outcome,
    at,
    ...(reason === undefined ? {} : { reason }),
  });
  const lastSlot = Object.hasOwn(state.lastSlots, workflow) ? state.lastSlots[workflow] : undefined;
  if (slot !== null && (lastSlot === undefined || slot > lastSlot)) {
    state.lastSlots[workflow] = slot;
  }
  if (outcome === "started" && runId !== null) {
    state.startedCounts[workflow] = startedCountForWorkflow(state, workflow) + 1;
  }
}

function recordStartAction(state: WorkshopState, workflow: string, runId: string, at: string): void {
  const action: WorkshopAction = {
    at,
    workflow,
    run_id: runId,
    step: null,
    source: "chat",
    decision: { action: "start" },
    note: "Workflow run started from chat.",
  };
  appendRecent(state.actions, action);
}

type StartWorkflowInput = {
  workflowName: string;
  projectRoot: string;
  port: WorkflowStartPort;
  slot?: string;
  at?: Date;
  source?: "chat";
  idempotency?: {
    requestId: string;
    fingerprint: string;
    response(outcome: StartWorkflowOutcome): JsonValue;
  };
};

type StartIdempotency = NonNullable<StartWorkflowInput["idempotency"]>;

function receiptResult(state: WorkshopState | undefined, idempotency?: StartIdempotency): StartWorkflowResult | undefined {
  if (!idempotency) return undefined;
  const receipt = state?.receipts.find((item) => item.request_id === idempotency.requestId);
  const decision = decideWorkflowAdmission({
    phase: "receipt-lookup",
    requestId: idempotency.requestId,
    fingerprint: idempotency.fingerprint,
    ...(receipt === undefined ? {} : { receipt }),
  });
  if (decision.kind === "unseen-receipt") return undefined;
  if (decision.kind === "replayed-receipt") return { kind: "replayed", response: decision.response };
  if (decision.kind === "receipt-conflict") throw new WorkflowAdmissionConflict(decision.reason);
  throw new Error(`Unexpected receipt decision: ${decision.kind}`);
}

function finishStart(
  state: WorkshopState,
  idempotency: StartIdempotency | undefined,
  outcome: StartWorkflowOutcome,
): StartWorkflowOutcome {
  if (idempotency) appendRecent(state.receipts, {
    request_id: idempotency.requestId,
    fingerprint: idempotency.fingerprint,
    response: idempotency.response(outcome),
  });
  return outcome;
}

function decideLoadedAdmission(
  state: WorkshopState,
  workflow: Workflow,
  command: WorkflowAdmissionCommand,
  dueSlot: string | undefined,
  hasOpenRun: boolean,
): WorkflowAdmissionDecision {
  const lastSlot = command.kind === "scheduled" && Object.hasOwn(state.lastSlots, workflow.name)
    ? state.lastSlots[workflow.name]
    : undefined;
  return decideWorkflowAdmission({
    phase: "admit",
    command: command.kind === "scheduled"
      ? { ...command, dueSlot: dueSlot ?? command.slot }
      : command,
    availability: { kind: "loaded", enabled: workflow.enabled !== false },
    paused: state.paused.includes(workflow.name),
    startedCount: startedCountForWorkflow(state, workflow.name),
    ...(workflow.max_runs === undefined ? {} : { maxRuns: workflow.max_runs }),
    ...(lastSlot === undefined ? {} : { lastSlot }),
    hasOpenRun,
  });
}

function outcomeFromAdmission(
  decision: WorkflowAdmissionDecision,
  workflow: string,
  slot: string | null,
): StartWorkflowOutcome | undefined {
  switch (decision.kind) {
    case "admitted":
      return undefined;
    case "skipped":
      if (slot === null) throw new Error("Manual workflow admission cannot be skipped");
      return { kind: "skipped", workflow, slot, reason: decision.reason };
    case "already-indexed":
      if (slot === null) throw new Error("Manual workflow admission cannot be already indexed");
      return { kind: "already-indexed", workflow, slot };
    case "locked":
      return { kind: "locked", workflow, reason: decision.reason };
    case "rejected":
      throw new Error(decision.reason);
    case "unseen-receipt":
    case "replayed-receipt":
    case "receipt-conflict":
      throw new Error(`Unexpected admission decision: ${decision.kind}`);
  }
}

async function recordScheduledAdmissionFailure(
  input: StartWorkflowInput,
  workflowName: string,
  slot: string,
  at: Date,
  error: unknown,
): Promise<StartWorkflowResult> {
  console.error(`[workshop] scheduled admission failed (${workflowName} at ${slot}): ${errorMessage(error)}`);
  return await input.port.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    const replay = receiptResult(state, input.idempotency);
    if (replay) return replay;
    const lastSlot = Object.hasOwn(state.lastSlots, workflowName) ? state.lastSlots[workflowName] : undefined;
    const decision = decideWorkflowAdmission({
      phase: "admit",
      command: { kind: "scheduled", workflow: workflowName, slot, dueSlot: slot },
      availability: { kind: "failed" },
      paused: state.paused.includes(workflowName),
      startedCount: startedCountForWorkflow(state, workflowName),
      ...(lastSlot === undefined ? {} : { lastSlot }),
      hasOpenRun: false,
    });
    if (decision.kind === "already-indexed") {
      return finishStart(state, input.idempotency, { kind: "already-indexed", workflow: workflowName, slot });
    }
    if (decision.kind !== "skipped") throw new Error(`Unexpected admission failure decision: ${decision.kind}`);
    const outcome: StartWorkflowOutcome = { kind: "skipped", workflow: workflowName, slot, reason: decision.reason };
    recordAdmission(state, workflowName, slot, null, "skipped", at.toISOString(), decision.reason);
    return finishStart(state, input.idempotency, outcome);
  });
}

export function startWorkflow(input: Omit<StartWorkflowInput, "idempotency">): Promise<StartWorkflowOutcome>;
export function startWorkflow(input: StartWorkflowInput & { idempotency: NonNullable<StartWorkflowInput["idempotency"]> }): Promise<StartWorkflowResult>;
export async function startWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workflowName)) throw new Error(`Invalid workflow name: ${input.workflowName}`);
  const projectRoot = resolve(input.projectRoot);
  const slot = input.slot ?? null;
  const at = input.at ?? new Date();
  if (!Number.isFinite(at.getTime())) throw new Error("Workflow start time must be a valid date");

  const replay = receiptResult(input.idempotency ? await input.port.readState() : undefined, input.idempotency);
  if (replay) return replay;

  let config: WorkshopConfig;
  let workflow: Workflow;
  let dueSlot: string | undefined;
  try {
    ({ config, workflow } = configurationFor(projectRoot, input.workflowName));
    if (slot !== null) dueSlot = latestCronSlot(workflow.cron, at);
  } catch (error) {
    if (slot === null) throw error;
    return await recordScheduledAdmissionFailure(input, input.workflowName, slot, at, error);
  }

  const stateDirectory = resolve(projectRoot, "state");
  const dataDirectory = resolve(projectRoot, "data", input.workflowName);
  try {
    mkdirSync(dataDirectory, { recursive: true });
  } catch (error) {
    if (slot === null) throw error;
    return await recordScheduledAdmissionFailure(input, workflow.name, slot, at, error);
  }
  const runId = randomUUID();
  const taskInput: WorkflowTaskInput = {
    runId,
    workflowName: workflow.name,
    startedAt: at.toISOString(),
    slot,
    projectRoot,
    dataDirectory,
    stateDirectory,
    workflow,
    profileCommands: Object.fromEntries(Object.entries(config.agent_profiles).map(([name, profile]) => [name, profile.command])),
  };
  const command: WorkflowAdmissionCommand = slot === null
    ? { kind: "manual", workflow: workflow.name }
    : { kind: "scheduled", workflow: workflow.name, slot, dueSlot: dueSlot ?? slot };

  return await input.port.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    const receiptReplay = receiptResult(state, input.idempotency);
    if (receiptReplay) return receiptReplay;

    const finishDecision = (decision: WorkflowAdmissionDecision): StartWorkflowOutcome | undefined => {
      const outcome = outcomeFromAdmission(decision, workflow.name, slot);
      if (outcome?.kind === "skipped" && slot !== null) {
        recordAdmission(state, workflow.name, slot, null, "skipped", at.toISOString(), outcome.reason);
      }
      return outcome;
    };

    const initialDecision = decideLoadedAdmission(state, workflow, command, dueSlot, false);
    const initialOutcome = finishDecision(initialDecision);
    if (initialOutcome) return finishStart(state, input.idempotency, initialOutcome);

    const records = await liveTasksInTransaction(tx);
    const isLocked = records.some((record) => isLive(record) && workflowOf(record) === workflow.name);
    const decision = decideLoadedAdmission(state, workflow, command, dueSlot, isLocked);
    const outcome = finishDecision(decision);
    if (outcome) return finishStart(state, input.idempotency, outcome);

    const taskId = await tx.createTask(WorkflowTask, taskInput, {
      ownership: { kind: "conversation" },
      conversationId: input.port.conversationId,
    });
    await tx.doc(workflowDecisionDocument, taskId);
    await tx.doc(workflowRunReferenceDocument, runId, {
      run_id: runId,
      task_id: taskId,
      workflow: workflow.name,
      slot,
      started_at: at.toISOString(),
    });
    recordAdmission(state, workflow.name, slot, runId, "started", at.toISOString());
    if (input.source === "chat") recordStartAction(state, workflow.name, runId, at.toISOString());
    return finishStart(state, input.idempotency, { kind: "started", workflow: workflow.name, run_id: runId, slot, task_id: String(taskId) });
  });
}
