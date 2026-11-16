import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { appendRecent, workshopStateDocument } from "../workflow/define-workshop-state.ts";
import { WORKFLOW_TASK_NAME } from "../workflow/define-workflow-task.ts";
import { runInputOf, statusOf, taskForRun } from "./read-workshop-status.ts";
import { receiptFor, saveReceipt } from "./record-service-receipt.ts";
import { ServiceFailure } from "./create-service-failure.ts";
import type { ServiceRequest, ServiceResponse } from "./types.ts";

type WorkflowTaskRecord = NonNullable<Awaited<ReturnType<typeof taskForRun>>>;

function liveStatus(record: WorkflowTaskRecord): boolean {
  return ["pending", "running", "waiting", "sleeping"].includes(record.state.status);
}

export async function cancelWorkflowRun(
  harness: Harness,
  request: Extract<ServiceRequest, { type: "cancel_run" }>,
): Promise<ServiceResponse> {
  const previous = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
  const prior = previous === undefined ? undefined : receiptFor(previous, request);
  if (prior) {
    if (prior.cancelled === true) {
      const priorTask = await taskForRun(harness, request.run_id);
      if (priorTask) await harness.abortTask(priorTask.id, BACKGROUND_CONTEXT);
    }
    return prior;
  }
  const record = await taskForRun(harness, request.run_id);
  if (!record) throw new ServiceFailure("run_not_found", `Workflow run ${request.run_id} was not found`);
  const run = runInputOf(record);
  if (!run) throw new Error("Durable workflow task has invalid run metadata");
  const cancellationWasRequested = liveStatus(record);
  const abortResult = cancellationWasRequested ? await harness.abortTask(record.id, BACKGROUND_CONTEXT) : undefined;
  return await harness.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    const prior = receiptFor(state, request);
    if (prior) return prior;
    const current = await tx.task(record.id);
    if (!current || current.kind !== WORKFLOW_TASK_NAME) {
      throw new ServiceFailure("run_not_found", `Workflow run ${request.run_id} was not found`);
    }
    const currentStatus = statusOf(current);
    const alreadyCancelled = currentStatus === "cancelled";
    const hasCancelAction = state.actions.some((action) => action.run_id === request.run_id && action.decision.action === "cancel");
    const recoveryAcknowledgement = alreadyCancelled && !hasCancelAction;
    const cancelled = recoveryAcknowledgement || (!alreadyCancelled && cancellationWasRequested && abortResult === "marked");
    const result: ServiceResponse = cancelled
      ? { request_id: request.request_id, ok: true, run_id: request.run_id, workflow: run.workflow, status: "cancellation-requested", cancelled: true }
      : { request_id: request.request_id, ok: true, run_id: request.run_id, workflow: run.workflow, status: currentStatus, cancelled: false };
    if (cancelled) appendRecent(state.actions, {
      at: new Date().toISOString(),
      workflow: run.workflow,
      run_id: request.run_id,
      step: null,
      source: "chat",
      decision: { action: "cancel" },
      note: recoveryAcknowledgement
        ? "Workflow run cancellation acknowledged during recovery."
        : "Workflow run cancellation requested from chat.",
    });
    saveReceipt(state, request, result);
    return result;
  }, BACKGROUND_CONTEXT);
}
