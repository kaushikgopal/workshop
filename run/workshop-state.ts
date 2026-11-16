import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, defineDocFamily, type TaskId } from "@earendil-works/pi-durable";
import type { OrchestratorDecision, WorkflowDecision } from "../workflow/types.ts";
import { parseOrchestratorDecision } from "../workflow/parse-orchestrator-decision.ts";
import { parseWorkflowDecision } from "../workflow/parse-workflow-decision.ts";

export type WorkflowAdmission = {
  workflow: string;
  slot: string | null;
  run_id: string | null;
  outcome: "started" | "skipped";
  at: string;
  reason?: string;
};

export type WorkshopAction = {
  at: string;
  workflow: string;
  run_id: string | null;
  step: string | null;
  source: "chat" | "round-1";
  decision: WorkflowDecision | OrchestratorDecision | { action: "start" | "cancel" | "pause" | "resume" };
  note: string;
};

export type MutationReceipt = {
  request_id: string;
  fingerprint: string;
  response: JsonValue;
};

export type WorkshopState = {
  admissions: WorkflowAdmission[];
  actions: WorkshopAction[];
  paused: string[];
  receipts: MutationReceipt[];
  startedCounts: Record<string, number>;
  lastSlots: Record<string, string>;
};

export const maxWorkshopHistoryRecords = 1_000;

export function appendRecent<T>(records: T[], record: T): void {
  records.push(record);
  const excess = records.length - maxWorkshopHistoryRecords;
  if (excess > 0) records.splice(0, excess);
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAdmissions(value: JsonValue | undefined): WorkflowAdmission[] {
  if (!Array.isArray(value)) throw new Error("Stored workshop admission history is invalid");
  return value.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.workflow !== "string" || (entry.slot !== null && typeof entry.slot !== "string") ||
      (entry.run_id !== null && typeof entry.run_id !== "string") || (entry.outcome !== "started" && entry.outcome !== "skipped") ||
      typeof entry.at !== "string" || (entry.reason !== undefined && typeof entry.reason !== "string")) {
      throw new Error("Stored workshop admission is invalid");
    }
    return {
      workflow: entry.workflow,
      slot: entry.slot,
      run_id: entry.run_id,
      outcome: entry.outcome,
      at: entry.at,
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    };
  });
}

function parseActionDecision(value: JsonValue | undefined): WorkshopAction["decision"] {
  if (!isJsonObject(value) || typeof value.action !== "string") throw new Error("Stored workshop action decision is invalid");
  if (value.action === "start") return { action: "start" };
  if (value.action === "cancel") return { action: "cancel" };
  if (value.action === "pause") return { action: "pause" };
  if (value.action === "resume") return { action: "resume" };
  if (typeof value.note === "string") {
    const raw = JSON.stringify(value);
    if (raw === undefined) throw new Error("Stored orchestrator decision could not be read");
    const decision = parseOrchestratorDecision(raw, {
      allowedRetryProfiles: typeof value.profile === "string" ? [value.profile] : [],
      lastOutput: "migrated action history",
    });
    if (decision.action !== value.action || decision.note !== value.note) throw new Error("Stored orchestrator decision is invalid");
    return decision;
  }
  return parseWorkflowDecision(value);
}

function parseActions(value: JsonValue | undefined): WorkshopAction[] {
  if (!Array.isArray(value)) throw new Error("Stored workshop action history is invalid");
  return value.slice(-maxWorkshopHistoryRecords).map((entry) => {
    if (!isJsonObject(entry) || typeof entry.at !== "string" || typeof entry.workflow !== "string" ||
      (entry.run_id !== null && typeof entry.run_id !== "string") || (entry.step !== null && typeof entry.step !== "string") ||
      (entry.source !== "chat" && entry.source !== "round-1") || typeof entry.note !== "string") {
      throw new Error("Stored workshop action is invalid");
    }
    return {
      at: entry.at,
      workflow: entry.workflow,
      run_id: entry.run_id,
      step: entry.step,
      source: entry.source,
      decision: parseActionDecision(entry.decision),
      note: entry.note,
    };
  });
}

function parseReceipts(value: JsonValue | undefined): MutationReceipt[] {
  if (!Array.isArray(value)) throw new Error("Stored workshop request receipt history is invalid");
  return value.slice(-maxWorkshopHistoryRecords).map((entry) => {
    if (!isJsonObject(entry) || typeof entry.request_id !== "string" || typeof entry.fingerprint !== "string" || entry.response === undefined) {
      throw new Error("Stored workshop request receipt is invalid");
    }
    return { request_id: entry.request_id, fingerprint: entry.fingerprint, response: entry.response };
  });
}

function progressFromAdmissions(admissions: readonly WorkflowAdmission[]): { startedCounts: Record<string, number>; lastSlots: Record<string, string> } {
  const runIds = new Map<string, Set<string>>();
  const lastSlots: Record<string, string> = {};
  for (const admission of admissions) {
    if (admission.outcome === "started" && admission.run_id !== null) {
      const ids = runIds.get(admission.workflow) ?? new Set<string>();
      ids.add(admission.run_id);
      runIds.set(admission.workflow, ids);
    }
    const previousSlot = Object.hasOwn(lastSlots, admission.workflow) ? lastSlots[admission.workflow] : undefined;
    if (admission.slot !== null && (previousSlot === undefined || admission.slot > previousSlot)) {
      lastSlots[admission.workflow] = admission.slot;
    }
  }
  return { startedCounts: Object.fromEntries([...runIds].map(([workflow, ids]) => [workflow, ids.size])), lastSlots };
}

export type WorkflowRunReference = {
  run_id: string;
  task_id: TaskId;
  workflow: string;
  slot: string | null;
  started_at: string;
};

export const workflowRunReferenceDocument = defineDocFamily<WorkflowRunReference, WorkflowRunReference>({
  kind: "workshop.run-reference",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

export const workshopStateDocument = defineDoc<WorkshopState>({
  kind: "workshop.state",
  version: 2,
  scope: "session",
  initial: () => ({ admissions: [], actions: [], paused: [], receipts: [], startedCounts: {}, lastSlots: {} }),
  migrate(value, fromVersion) {
    if (fromVersion !== 1) throw new Error(`Cannot migrate workshop state from version ${fromVersion}`);
    if (!Array.isArray(value.paused) || !value.paused.every((entry) => typeof entry === "string")) {
      throw new Error("Stored workshop pause state is invalid");
    }
    const allAdmissions = parseAdmissions(value.admissions);
    return {
      ...value,
      admissions: allAdmissions.slice(-maxWorkshopHistoryRecords),
      actions: parseActions(value.actions),
      paused: value.paused,
      receipts: parseReceipts(value.receipts),
      ...progressFromAdmissions(allAdmissions),
    };
  },
  checkpointWhen: () => true,
});
