import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness } from "@earendil-works/pi-durable";
import { appendRecent, workshopStateDocument, type WorkshopAction } from "../workflow/define-workshop-state.ts";
import { WORKFLOW_TASK_NAME, workflowDecisionDocument } from "../workflow/define-workflow-task.ts";
import { parseWorkflowDecision } from "../workflow/parse-workflow-decision.ts";
import type { WorkflowDecision } from "../workflow/types.ts";
import { checkpointOf, checkpointPhase, taskForRun } from "./read-workshop-status.ts";
import { receiptFor, saveReceipt } from "./record-service-receipt.ts";
import type { ServiceRequest, ServiceResponse } from "./types.ts";

function actionNote(decision: WorkflowDecision, source: "chat" | "round"): string {
  const by = source === "round" ? "automatic failure round" : "chat";
  if (decision.action === "retry") return [decision.hint, decision.after === undefined ? undefined : `retry after ${decision.after}`].filter(Boolean).join("; ") || `Step retried by ${by}.`;
  if (decision.action === "skip") return `Step skipped by ${by}.`;
  if (decision.action === "accept") return `Last output accepted by ${by}.`;
  return `Run failed by ${by}.`;
}

function actionForDecision(workflow: string, runId: string, step: string, decision: WorkflowDecision, source: "chat" | "round", note: string | undefined, at: string): WorkshopAction {
  const noteText = source === "round" && note?.trim() ? note.trim() : actionNote(decision, source);
  const actionDecision: WorkshopAction["decision"] = source === "round" ? { ...decision, note: noteText } : decision;
  return { at, workflow, run_id: runId, step, source, decision: actionDecision, note: noteText };
}

export async function decideBlockedRun(
  harness: Harness,
  request: Extract<ServiceRequest, { type: "decide_blocked_run" }>,
  source: "chat" | "round",
): Promise<ServiceResponse> {
  const decision = parseWorkflowDecision(request.decision);
  const previousState = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
  const prior = previousState === undefined ? undefined : receiptFor(previousState, request);
  if (prior) return prior;
  const record = await taskForRun(harness, request.run_id);
  if (!record || checkpointPhase(record) !== "blocked") throw new Error(`Workflow run ${request.run_id} is not waiting on a decision`);

  return await harness.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    const prior = receiptFor(state, request);
    if (prior) return prior;
    const current = await tx.task(record.id);
    if (!current || current.kind !== WORKFLOW_TASK_NAME || checkpointPhase(current) !== "blocked") {
      throw new Error(`Workflow run ${request.run_id} is no longer waiting on a decision`);
    }
    const currentCheckpoint = checkpointOf(current);
    if (!currentCheckpoint || (currentCheckpoint.phase !== "blocked" && currentCheckpoint.phase !== "decision")) {
      throw new Error(`Workflow run ${request.run_id} is no longer waiting on a decision`);
    }
    const failure = currentCheckpoint.failure;
    if (failure.decisionNumber !== request.decision_number) {
      throw new Error(`Blocked decision ${request.decision_number} is stale; current decision is ${failure.decisionNumber}`);
    }
    if (decision.action === "accept" && failure.lastOutput.trim().length === 0) {
      throw new Error("Cannot accept a blocked step with empty output");
    }
    if (decision.action === "retry" && decision.profile !== undefined && !failure.retryProfiles.includes(decision.profile)) {
      throw new Error(`Profile "${decision.profile}" cannot retry ${failure.stepKind} step ${failure.step}`);
    }
    const document = await tx.doc(workflowDecisionDocument, record.id);
    if (document.choice !== null) throw new Error("A decision was already accepted for this blocked step");
    document.choice = { requestId: request.request_id, decisionNumber: request.decision_number, decision, source };
    const response: ServiceResponse = { request_id: request.request_id, ok: true, run_id: request.run_id, decision };
    appendRecent(state.actions, actionForDecision(failure.workflow, request.run_id, failure.step, decision, source, request.note, new Date().toISOString()));
    saveReceipt(state, request, response);
    return response;
  }, BACKGROUND_CONTEXT);
}
