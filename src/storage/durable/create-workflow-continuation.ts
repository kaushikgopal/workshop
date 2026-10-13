import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { WorkflowRunDocumentV1 } from "../../run/records.js";
import { createCapacityGateTaskInput, type CapacityGateTaskDefinition } from "./define-capacity-gate-task.js";
import { workflowRunTaskInputSchema, type WorkflowRunTaskDefinition } from "./define-workshop-tasks.js";

type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;

/** Create the successor task and capacity gate within the caller's transition commit. */
export async function createWorkflowContinuation(
  tx: Tx,
  tasks: { WorkflowRunTask: WorkflowRunTaskDefinition; CapacityGateTask: CapacityGateTaskDefinition },
  run: ReadyRun,
  conversationId: ConversationId,
): Promise<ReadyRun["durable"]> {
  const nodeIndex = run.chain.order.findIndex((nodeId) => nodeId === run.currentNodeId);
  if (nodeIndex < 1 || run.currentAttemptId !== null || run.nodes[nodeIndex]?.status !== "pending") {
    throw new Error("human continuation requires a saved pending successor");
  }
  const taskId = await tx.createTask(tasks.WorkflowRunTask, workflowRunTaskInputSchema.parse({
    runId: run.runId, workflowId: run.workflowId, activationId: run.activationId,
    occurrenceId: run.occurrenceId, successorNodeIndex: nodeIndex,
  }), { ownership: { kind: "conversation" }, conversationId });
  const gateId = await tx.createTask(tasks.CapacityGateTask, createCapacityGateTaskInput({
    runId: run.runId, workflowId: run.workflowId, activationId: run.activationId,
    occurrenceId: run.occurrenceId, workflowTaskId: Number(taskId),
  }), { ownership: { kind: "task", taskId }, conversationId });
  return { ...run.durable, workflowTaskId: Number(taskId), capacityGateTaskId: Number(gateId), continuationPending: false };
}
