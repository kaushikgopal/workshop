import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { resolve, join } from "node:path";
import type { ServiceRequest, ServiceResponse } from "./parse-service-request.ts";

type RequestWithoutId<T> = T extends ServiceRequest ? Omit<T, "request_id"> & { request_id?: string } : never;
export type ServiceRequestInput = RequestWithoutId<ServiceRequest>;
function isServiceResponse(value: unknown): value is ServiceResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "ok" in value && typeof value.ok === "boolean" &&
    (!("request_id" in value) || typeof value.request_id === "string");
}


export async function requestService(
  request: ServiceRequestInput,
  stateDirectory = resolve(process.cwd(), "state"),
  timeoutMs = 10_000,
): Promise<ServiceResponse> {
  const requestId = request.request_id ?? randomUUID();
  const message = JSON.stringify({ ...request, request_id: requestId });
  const socket = connect(join(stateDirectory, "service.sock"));
  socket.setEncoding("utf8");

  return await new Promise((resolveResponse, reject) => {
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: ServiceResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolveResponse(value);
    };
    const timer = setTimeout(() => finish(new Error(`Workshop service request timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.once("connect", () => socket.write(`${message}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      const end = response.indexOf("\n");
      if (end < 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.slice(0, end));
      } catch (error) {
        finish(new Error(`Workshop service returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!isServiceResponse(parsed)) {
        finish(new Error("Workshop service returned an invalid response"));
        return;
      }
      if (parsed.request_id !== undefined && parsed.request_id !== requestId) {
        finish(new Error("Workshop service response does not match the request"));
        return;
      }
      finish(undefined, parsed);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("Workshop service closed the socket before responding"));
    });
  });
}
