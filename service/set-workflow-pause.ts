import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { appendRecent, workshopStateDocument } from "../workflow/define-workshop-state.ts";
import { receiptFor, saveReceipt } from "./record-service-receipt.ts";
import type { ServiceRequest, ServiceResponse } from "./types.ts";

export async function setWorkflowPause(
  harness: Harness,
  request: Extract<ServiceRequest, { type: "pause_workflow" | "resume_workflow" }>,
): Promise<ServiceResponse> {
  const paused = request.type === "pause_workflow";
  const previous = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
  const prior = previous === undefined ? undefined : receiptFor(previous, request);
  if (prior) return prior;
  return await harness.commit(async (tx) => {
    const state = await tx.doc(workshopStateDocument);
    const prior = receiptFor(state, request);
    if (prior) return prior;
    if (paused && !state.paused.includes(request.workflow)) state.paused.push(request.workflow);
    if (!paused) state.paused = state.paused.filter((workflow) => workflow !== request.workflow);
    state.paused.sort();
    const action = paused ? "pause" as const : "resume" as const;
    appendRecent(state.actions, {
      at: new Date().toISOString(),
      workflow: request.workflow,
      run_id: null,
      step: null,
      source: "chat",
      decision: { action },
      note: paused ? "Workflow paused from chat." : "Workflow resumed from chat.",
    });
    const response = { request_id: request.request_id, ok: true, workflow: request.workflow, paused, paused_workflows: [...state.paused] };
    saveReceipt(state, request, response);
    return response;
  }, BACKGROUND_CONTEXT);
}
