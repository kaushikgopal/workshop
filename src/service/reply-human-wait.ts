import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { installationDocumentV1Schema } from "../installation/schema.js";
import { workflowRunDocumentV1Schema, workshopEventV1Schema } from "../run/records.js";
import { humanReplyResultSchema } from "../run/schema.js";
import { commitServiceMutation } from "../storage/durable/commit-service-mutation.js";
import { WorkshopEventEntry, WorkshopInstallationDoc, WorkshopRunDoc } from "../storage/durable/define-workshop-records.js";
import type { ServiceRequestV1 } from "./schema.js";
import { ServiceRequestError } from "./serve-workshop-service.js";

/** Only the socket caller can commit human provenance. Replies never re-admit a run. */
export async function replyHumanWait(
  harness: Harness,
  request: Extract<ServiceRequestV1, { method: "human.reply" }>,
): Promise<unknown> {
  const result = await commitServiceMutation({
    harness, context: BACKGROUND_CONTEXT,
    request: { requestId: request.requestId, method: "human.reply", arguments: {
      workflowId: request.workflowId, runId: request.runId, waitId: request.waitId,
      action: request.action, answer: request.answer,
    } },
    retain: () => ({ kind: "run", runId: request.runId }),
    apply: async (tx) => {
      const installationDraft = await tx.doc(WorkshopInstallationDoc);
      const installation = installationDocumentV1Schema.parse(installationDraft);
      if (installation.state !== "ready") throw new Error("installation is uninitialized");
      const workflow = installation.workflows[request.workflowId];
      const reference = workflow?.runs.find((run) => run.runId === request.runId);
      if (workflow === undefined || reference === undefined) {
        throw new ServiceRequestError("wait_not_found", "reply target does not belong to this workflow");
      }
      // SAFETY: the installation reference binds the checked run to its conversation.
      const conversationId = reference.conversationId as ConversationId;
      const draft = await tx.doc(WorkshopRunDoc, conversationId);
      const run = workflowRunDocumentV1Schema.parse(draft);
      if (run.state !== "ready" || run.runId !== request.runId || run.workflowId !== request.workflowId
        || reference.status !== run.status) throw new Error("reply run differs from the installation reference");
      const wait = run.waits?.find((value) => value.waitId === request.waitId);
      // Receipt replay precedes lifecycle checks. New request IDs cannot revive Stop intent.
      const rejected = wait?.settlement.kind === "replied" && wait.settlement.action === "reject";
      if ((run.desiredState === "stopped" && !rejected) || wait?.settlement.kind === "stopped"
        || workflow.activations.find((value) => value.activationId === run.activationId)?.state === "stopped") {
        throw new ServiceRequestError("run_stopped", "run_stopped: stopped or rejected runs cannot receive replies");
      }
      if (wait?.settlement.kind === "replied") {
        if (wait.settlement.action !== request.action || wait.settlement.answer !== request.answer) {
          throw new ServiceRequestError("reply_conflict", "reply_conflict: this wait already has a different reply");
        }
        return wait.settlement.response;
      }
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw new ServiceRequestError("run_stopped", "run_stopped: terminal runs cannot receive replies");
      }
      if (wait === undefined || wait.settlement.kind !== "pending" || run.status !== "waiting"
        || workflow.openRunId !== run.runId || run.currentNodeId !== wait.nodeId || run.currentAttemptId !== wait.attemptId) {
        throw new ServiceRequestError("wait_not_found", "reply does not target the unresolved wait");
      }
      const nodeIndex = run.chain.order.indexOf(wait.nodeId);
      const final = nodeIndex === run.chain.order.length - 1;
      const reject = request.action === "reject";
      const status = reject ? "cancelled" : final ? "completed" : run.desiredState === "paused" ? "paused" : "queued";
      const at = new Date().toISOString();
      const response = humanReplyResultSchema.parse({
        workflowId: run.workflowId, runId: run.runId, waitId: wait.waitId, status,
        desiredState: reject ? "stopped" : run.desiredState, resolvedAt: at,
      });
      const next: Extract<typeof run, { state: "ready" }> = {
        ...run, status, desiredState: response.desiredState,
        finishedAt: reject || final ? at : null,
        terminalOutput: !reject && final ? wait.output : null,
        currentNodeId: reject ? wait.nodeId : final ? null : run.chain.order[nodeIndex + 1] ?? null,
        currentAttemptId: null,
        durable: { ...run.durable, capacityGateTaskId: null },
        nodes: run.nodes.map((node) => node.nodeId === wait.nodeId
          ? { ...node, status: reject ? "cancelled" : "succeeded", successfulAttemptId: reject ? null : wait.attemptId }
          : node),
        waits: (run.waits ?? []).map((value) => value.waitId === wait.waitId
          ? { ...value, settlement: { kind: "replied", provenance: "human", action: request.action, answer: request.answer, response } }
          : value),
      };
      Object.assign(draft, workflowRunDocumentV1Schema.parse(next));
      reference.status = status;
      reference.workflowTaskId = next.durable.workflowTaskId;
      workflow.capacityReservations = workflow.capacityReservations.filter((id) => id !== run.runId);
      if (reject || final) workflow.openRunId = null;
      Object.assign(installationDraft, installationDocumentV1Schema.parse(installation));
      await tx.appendEntry(WorkshopEventEntry, conversationId, { data: workshopEventV1Schema.parse({
        version: 1, eventId: randomUUID(), type: "run_state_changed", runId: run.runId,
        from: run.status, to: status, occurredAt: at,
      }) });
      if (reject || final) await tx.appendEntry(WorkshopEventEntry, conversationId, { data: workshopEventV1Schema.parse({
        version: 1, eventId: randomUUID(), type: "run_settled", runId: run.runId,
        outcome: reject ? { kind: "cancelled" } : { kind: "completed", terminalOutput: wait.output }, occurredAt: at,
      }) });
      return response;
    },
  });
  if (result.kind === "idempotency_conflict") {
    throw new ServiceRequestError("idempotency_conflict", "request ID was used with different reply contents");
  }
  return result.response;
}
