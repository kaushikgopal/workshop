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
import { appendRecent, workshopStateDocument, workflowRunReferenceDocument, type WorkshopAction, type WorkflowRunReference, type WorkshopState } from "./workshop-state.ts";

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


function slotWasIndexed(state: WorkshopState, workflow: string, slot: string): boolean {
  const lastSlot = Object.hasOwn(state.lastSlots, workflow) ? state.lastSlots[workflow] : undefined;
  return lastSlot !== undefined && lastSlot >= slot;
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

export function startWorkflow(input: Omit<StartWorkflowInput, "idempotency">): Promise<StartWorkflowOutcome>;
export function startWorkflow(input: StartWorkflowInput & { idempotency: NonNullable<StartWorkflowInput["idempotency"]> }): Promise<StartWorkflowResult>;
export async function startWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workflowName)) throw new Error(`Invalid workflow name: ${input.workflowName}`);
  const projectRoot = resolve(input.projectRoot);
  const { config, workflow } = configurationFor(projectRoot, input.workflowName);
  const slot = input.slot ?? null;
  const at = input.at ?? new Date();
  if (!Number.isFinite(at.getTime())) throw new Error("Workflow start time must be a valid date");
  if (slot === null && workflow.enabled === false) throw new Error(`Workflow "${input.workflowName}" is disabled and cannot be started manually.`);

  const stateDirectory = resolve(projectRoot, "state");
  const dataDirectory = resolve(projectRoot, "data", input.workflowName);
  mkdirSync(dataDirectory, { recursive: true });
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

  return await input.port.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    if (input.idempotency) {
      const receipt = state.receipts.find((item) => item.request_id === input.idempotency?.requestId);
      if (receipt) {
        if (receipt.fingerprint !== input.idempotency.fingerprint) throw new Error("Request ID was already used for a different request");
        return { kind: "replayed", response: receipt.response };
      }
    }
    const finish = (outcome: StartWorkflowOutcome): StartWorkflowOutcome => {
      if (input.idempotency) appendRecent(state.receipts, {
        request_id: input.idempotency.requestId,
        fingerprint: input.idempotency.fingerprint,
        response: input.idempotency.response(outcome),
      });
      return outcome;
    };
    if (slot !== null && slotWasIndexed(state, workflow.name, slot)) {
      return finish({ kind: "already-indexed", workflow: workflow.name, slot });
    }
    if (slot === null && state.paused.includes(workflow.name)) {
      throw new Error(`Workflow "${input.workflowName}" is paused; resume it before starting manually.`);
    }
    if (slot !== null && state.paused.includes(workflow.name)) {
      recordAdmission(state, workflow.name, slot, null, "skipped", at.toISOString(), "paused");
      return finish({ kind: "skipped", workflow: workflow.name, slot, reason: "paused" });
    }
    if (slot !== null && workflow.max_runs !== undefined && startedCountForWorkflow(state, workflow.name) >= workflow.max_runs) {
      recordAdmission(state, workflow.name, slot, null, "skipped", at.toISOString(), "max_runs reached");
      return finish({ kind: "skipped", workflow: workflow.name, slot, reason: "max_runs reached" });
    }

    const records = await liveTasksInTransaction(tx);
    if (records.some((record) => isLive(record) && workflowOf(record) === workflow.name)) {
      if (slot === null) return finish({ kind: "locked", workflow: workflow.name, reason: "workflow already has an open run" });
      recordAdmission(state, workflow.name, slot, null, "skipped", at.toISOString(), "workflow lock held");
      return finish({ kind: "skipped", workflow: workflow.name, slot, reason: "workflow lock held" });
    }

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
    return finish({ kind: "started", workflow: workflow.name, run_id: runId, slot, task_id: String(taskId) });
  });
}
