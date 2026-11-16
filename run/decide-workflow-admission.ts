import type { JsonValue } from "@earendil-works/chord/json";
import type { MutationReceipt } from "../workflow/define-workshop-state.ts";

export type WorkflowAdmissionCommand =
  | { kind: "manual"; workflow: string }
  | { kind: "scheduled"; workflow: string; slot: string; dueSlot: string };

type AdmissionFacts = {
  phase: "admit";
  command: WorkflowAdmissionCommand;
  availability: { kind: "loaded"; enabled: boolean } | { kind: "failed" };
  paused: boolean;
  startedCount: number;
  maxRuns?: number;
  lastSlot?: string;
  hasOpenRun: boolean;
};

export type WorkflowAdmissionInput =
  | { phase: "receipt-lookup"; requestId: string; fingerprint: string; receipt?: MutationReceipt }
  | AdmissionFacts;

export type WorkflowAdmissionDecision =
  | { kind: "unseen-receipt" }
  | { kind: "replayed-receipt"; response: JsonValue }
  | { kind: "receipt-conflict"; reason: string }
  | { kind: "admitted" }
  | { kind: "skipped"; reason: string }
  | { kind: "already-indexed" }
  | { kind: "locked"; reason: string }
  | { kind: "rejected"; reason: string };

export function decideWorkflowAdmission(input: WorkflowAdmissionInput): WorkflowAdmissionDecision {
  if (input.phase === "receipt-lookup") {
    const receipt = input.receipt;
    if (receipt === undefined || receipt.request_id !== input.requestId) return { kind: "unseen-receipt" };
    return receipt.fingerprint === input.fingerprint
      ? { kind: "replayed-receipt", response: receipt.response }
      : { kind: "receipt-conflict", reason: "Request ID was already used for a different request" };
  }

  const { command } = input;
  if (command.kind === "scheduled" && input.lastSlot !== undefined && input.lastSlot >= command.slot) {
    return { kind: "already-indexed" };
  }
  if (input.availability.kind === "failed") {
    return command.kind === "scheduled"
      ? { kind: "skipped", reason: "admission failed" }
      : { kind: "rejected", reason: `Workflow not found: ${command.workflow}` };
  }
  if (command.kind === "scheduled") {
    if (command.slot !== command.dueSlot) return { kind: "skipped", reason: "schedule slot is no longer due" };
    if (!input.availability.enabled) return { kind: "skipped", reason: "workflow is disabled" };
    if (input.paused) return { kind: "skipped", reason: "paused" };
    if (input.maxRuns !== undefined && input.startedCount >= input.maxRuns) {
      return { kind: "skipped", reason: "max_runs reached" };
    }
    if (input.hasOpenRun) return { kind: "skipped", reason: "workflow lock held" };
    return { kind: "admitted" };
  }

  if (!input.availability.enabled) {
    return { kind: "rejected", reason: `Workflow "${command.workflow}" is disabled and cannot be started manually.` };
  }
  if (input.paused) {
    return { kind: "rejected", reason: `Workflow "${command.workflow}" is paused; resume it before starting manually.` };
  }
  if (input.hasOpenRun) return { kind: "locked", reason: "workflow already has an open run" };
  return { kind: "admitted" };
}
