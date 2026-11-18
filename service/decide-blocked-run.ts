import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness } from "@earendil-works/pi-durable";
import { acceptBlockedDecision, type BlockedDecisionCommand } from "../workflow/accept-blocked-decision.ts";
import { appendRecent, workshopStateDocument, type WorkshopAction } from "../workflow/define-workshop-state.ts";
import { WORKFLOW_TASK_NAME, workflowDecisionDocument } from "../workflow/define-workflow-task.ts";
import { parseWorkflowDecision } from "../workflow/parse-workflow-decision.ts";
import type { WorkflowDecision } from "../workflow/types.ts";
import { checkpointOf, taskForRun } from "./read-workshop-status.ts";
import { receiptFor, recordServiceReceipt } from "./record-service-receipt.ts";
import { ServiceFailure } from "./create-service-failure.ts";
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

export type FailureRoundBinding = { runId: string; step: string; attempt: number; decisionNumber: number };

function rejectionMessage(
  code: string,
  input: {
    decisionNumber: number;
    currentDecisionNumber: number;
    action: WorkflowDecision;
    step: string;
    stepKind: string;
    round: boolean;
  },
): string {
  switch (code) {
    case "cancellation_in_progress":
      return "Cancellation is in progress; blocked-run decisions are no longer accepted";
    case "stale_decision":
      return input.round
        ? "This failure round no longer matches its blocked step"
        : `Blocked decision ${input.decisionNumber} is stale; current decision is ${input.currentDecisionNumber}`;
    case "choice_already_recorded":
      return "A decision was already accepted for this blocked step";
    case "empty_output":
      return "Cannot accept a blocked step with empty output";
    case "incompatible_profile":
      return input.action.action === "retry"
        ? `Profile \"${input.action.profile ?? ""}\" cannot retry ${input.stepKind} step ${input.step}`
        : "Retry profile is not allowed for this blocked step";
    default:
      return "Blocked-run decision was rejected";
  }
}

export async function decideBlockedRun(
  harness: Harness,
  request: Extract<ServiceRequest, { type: "decide_blocked_run" }>,
  source: "chat" | "round",
  round?: FailureRoundBinding,
): Promise<ServiceResponse> {
  const decision = parseWorkflowDecision(request.decision);
  const previousState = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
  const prior = previousState === undefined ? undefined : receiptFor(previousState, request);
  if (prior) return prior;
  const record = await taskForRun(harness, request.run_id);
  if (!record) throw new ServiceFailure("run_not_found", `Workflow run ${request.run_id} was not found`);

  return await harness.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    const prior = receiptFor(state, request);
    if (prior) return prior;
    const current = await tx.task(record.id);
    if (!current || current.kind !== WORKFLOW_TASK_NAME) {
      throw new ServiceFailure("run_not_found", `Workflow run ${request.run_id} was not found`);
    }
    const checkpoint = checkpointOf(current);
    const failure = checkpoint && (checkpoint.phase === "blocked" || checkpoint.phase === "decision")
      ? checkpoint.failure
      : undefined;
    const mailbox = checkpoint === undefined ? undefined : await tx.doc(workflowDecisionDocument, record.id);
    const currentDecisionNumber = failure?.decisionNumber ?? -1;
    const observation = {
      phase: checkpoint?.phase ?? "other",
      decisionNumber: currentDecisionNumber,
      mailboxOccupied: mailbox !== undefined && mailbox.choice !== null,
      abortRequested: current.abortRequested,
      failure: {
        runId: failure?.runId ?? "",
        step: failure?.step ?? "",
        attempt: failure?.attemptHistory.at(-1)?.attempt ?? 0,
        lastOutput: failure?.lastOutput ?? "",
        retryProfiles: failure?.retryProfiles ?? [],
      },
    };
    const command: BlockedDecisionCommand = source === "round"
      ? {
        source,
        decisionNumber: request.decision_number,
        decision,
        round: round ?? { runId: "", step: "", attempt: 0 },
      }
      : { source, decisionNumber: request.decision_number, decision };
    const acceptance = acceptBlockedDecision(observation, command);
    if (acceptance.kind === "rejected") {
      throw new ServiceFailure(acceptance.code, rejectionMessage(acceptance.code, {
        decisionNumber: request.decision_number,
        currentDecisionNumber,
        action: decision,
        step: failure?.step ?? "unknown",
        stepKind: failure?.stepKind ?? "unknown",
        round: source === "round",
      }));
    }
    if (!failure || !mailbox) throw new Error("Accepted blocked decision has no failure context");
    mailbox.choice = { requestId: request.request_id, decisionNumber: request.decision_number, decision, source };
    const response: ServiceResponse = { request_id: request.request_id, ok: true, run_id: request.run_id, decision };
    appendRecent(state.actions, actionForDecision(failure.workflow, request.run_id, failure.step, decision, source, request.note, new Date().toISOString()));
    recordServiceReceipt(state, request, response);
    return response;
  }, BACKGROUND_CONTEXT);
}
