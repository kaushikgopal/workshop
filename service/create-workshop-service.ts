import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { WorkshopServiceInvocation } from "./create-workshop-extension.ts";
import { createWorkflowStartPort, startWorkflow, type StartWorkflowOutcome } from "../run/start-workflow.ts";
import { workshopStateDocument } from "../workflow/define-workshop-state.ts";
import { parseServiceRequest, type ServiceResponse } from "./types.ts";
import { readWorkshopStatus } from "./read-workshop-status.ts";
import { decideBlockedRun } from "./decide-blocked-run.ts";
import { resolveFailureRound } from "./resolve-failure-round.ts";
import { cancelWorkflowRun } from "./cancel-workflow-run.ts";
import { setWorkflowPause } from "./set-workflow-pause.ts";
import { createWorkshopChat } from "./create-workshop-chat.ts";
import { fingerprint, responseFromReceipt, startResponse } from "./record-service-receipt.ts";

export type WorkshopService = {
  handleRequest(value: unknown, invocation?: WorkshopServiceInvocation): Promise<ServiceResponse>;
  watchChat(requestId: string, send: (event: ServiceResponse) => void): Promise<{ close(): Promise<void> }>;
};

export function createWorkshopService(input: { projectRoot: string; harness: Harness }): WorkshopService {
  const projectRoot = resolve(input.projectRoot);
  const workflowDirectory = resolve(projectRoot, "workflows");
  const chat = createWorkshopChat({ harness: input.harness });

  async function handleRequest(value: unknown, invocation?: WorkshopServiceInvocation): Promise<ServiceResponse> {
    const request = parseServiceRequest(value);
    switch (request.type) {
      case "list_workflows":
      case "list_runs":
      case "read_run":
        return await readWorkshopStatus(request, { projectRoot, workflowDirectory, harness: input.harness });
      case "watch_chat":
        return { request_id: request.request_id, ok: false, error: "watch_chat requires a persistent socket" };
      case "submit_chat":
        return await chat.submitChat(request);
      case "start_workflow": {
        const port = await createWorkflowStartPort(input.harness);
        const result = await startWorkflow({
          workflowName: request.workflow,
          projectRoot,
          port,
          source: "chat",
          idempotency: {
            requestId: request.request_id,
            fingerprint: fingerprint(request),
            response: (outcome: StartWorkflowOutcome) => {
              const response = startResponse(request.request_id, outcome);
              const serialized = JSON.stringify(response);
              if (serialized === undefined) throw new Error("Start response could not be saved");
              return JSON.parse(serialized);
            },
          },
        });
        return result.kind === "replayed" ? responseFromReceipt(result.response) : startResponse(request.request_id, result);
      }
      case "decide_blocked_run": {
        const round = invocation === undefined ? undefined : await resolveFailureRound(input.harness, invocation.taskId);
        if (round) return await decideBlockedRun(input.harness, {
          ...request,
          run_id: round.runId,
          decision_number: round.decisionNumber,
        }, "round");
        return await decideBlockedRun(input.harness, request, "chat");
      }
      case "cancel_run":
        return await cancelWorkflowRun(input.harness, request);
      case "pause_workflow":
      case "resume_workflow":
        return await setWorkflowPause(input.harness, request);
      case "list_actions": {
        const state = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
        const all = [...(state?.actions ?? [])].reverse().filter((action) => request.workflow === undefined || action.workflow === request.workflow);
        return { request_id: request.request_id, ok: true, actions: all.slice(0, request.limit ?? 20) };
      }
    }
  }

  return { handleRequest, watchChat: chat.watchChat };
}
