import type { JsonValue } from "@earendil-works/chord/json";
import { appendRecent, type WorkshopState } from "../workflow/define-workshop-state.ts";
import type { StartWorkflowOutcome } from "../run/start-workflow.ts";
import type { ServiceRequest, ServiceResponse } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fingerprint(request: ServiceRequest): string {
  const { request_id: _requestId, ...payload } = request;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  };
  return JSON.stringify(normalize(payload));
}

export function responseFromReceipt(value: JsonValue): ServiceResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("Stored service receipt is invalid");
  if (value.request_id !== undefined && typeof value.request_id !== "string") throw new Error("Stored service receipt has an invalid request ID");
  return {
    ...value,
    ok: value.ok,
    ...(typeof value.request_id === "string" ? { request_id: value.request_id } : {}),
  };
}

export function receiptFor(state: WorkshopState, request: ServiceRequest): ServiceResponse | undefined {
  const receipt = state.receipts.find((entry) => entry.request_id === request.request_id);
  if (!receipt) return undefined;
  if (receipt.fingerprint !== fingerprint(request)) throw new Error("Request ID was already used for a different request");
  return responseFromReceipt(receipt.response);
}

export function saveReceipt(state: WorkshopState, request: ServiceRequest, response: ServiceResponse): void {
  const serialized = JSON.stringify(response);
  if (serialized === undefined) throw new Error("Service response could not be saved");
  const responseValue = JSON.parse(serialized);
  appendRecent(state.receipts, { request_id: request.request_id, fingerprint: fingerprint(request), response: responseValue });
}

export function startResponse(requestId: string, outcome: StartWorkflowOutcome): ServiceResponse {
  if (outcome.kind === "skipped" || outcome.kind === "locked") return { request_id: requestId, ok: false, error: outcome.reason };
  if (outcome.kind === "already-indexed") return { request_id: requestId, ok: false, error: `Workflow slot ${outcome.slot} was already indexed` };
  return { request_id: requestId, ok: true, workflow: outcome.workflow, run_id: outcome.run_id };
}
