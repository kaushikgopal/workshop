import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  serviceRequestIdV1Schema,
  serviceRequestV1Schema,
  serviceResponseFrameV1Schema,
  serviceResponseV1Schema,
} from "./schema.js";
import type { ServiceRequestV1, ServiceResponseFrameV1, ServiceResponseV1 } from "./schema.js";

export const MAX_SERVICE_FRAME_BYTES = 1_048_576;
export const MAX_SERVICE_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES = 480 * 1024;

const serviceRequestEnvelopeSchema = z.record(z.string(), z.unknown());
const supportedMethods = new Set([
  "health",
  "start",
  "pause",
  "resume",
  "stop",
  "resolve",
  "status",
  "runs",
  "logs.page",
  "node.describe",
  "diagram",
  "watch",
]);

export type ServiceProtocolFailure = {
  readonly requestId: string | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

export type ParsedServiceRequest =
  | { readonly ok: true; readonly request: ServiceRequestV1 }
  | { readonly ok: false; readonly failure: ServiceProtocolFailure };

export type ParsedServiceResponse =
  | { readonly ok: true; readonly response: ServiceResponseFrameV1 }
  | { readonly ok: false; readonly failure: ServiceProtocolFailure };

export function parseServiceRequestLine(line: string | Uint8Array): ParsedServiceRequest {
  const bytes = typeof line === "string" ? Buffer.from(line, "utf8") : Buffer.from(line);
  if (bytes.byteLength + 1 > MAX_SERVICE_FRAME_BYTES) {
    return failure(null, "frame_too_large", `Request exceeds ${MAX_SERVICE_FRAME_BYTES} bytes`);
  }

  const decoded = decodeJson(bytes);
  if (!decoded.ok) return { ok: false, failure: decoded.failure };

  const envelope = serviceRequestEnvelopeSchema.safeParse(decoded.value);
  if (!envelope.success) return failure(null, "invalid_request", "Request must be a JSON object");

  const requestId = serviceRequestIdV1Schema.safeParse(envelope.data.requestId);
  const correlatedId = requestId.success ? requestId.data : null;
  if (envelope.data.version !== 1) {
    return failure(correlatedId, "unsupported_version", "Request version must be 1");
  }
  if (typeof envelope.data.method !== "string") {
    return failure(correlatedId, "invalid_request", "Request method must be a string");
  }
  if (!supportedMethods.has(envelope.data.method)) {
    return failure(correlatedId, "unknown_method", "Unknown service method");
  }

  const parsed = serviceRequestV1Schema.safeParse(decoded.value);
  if (!parsed.success) {
    return failure(correlatedId, "invalid_arguments", "Request arguments do not match the method schema", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return { ok: true, request: parsed.data };
}

export function parseServiceResponseLine(line: string | Uint8Array): ParsedServiceResponse {
  const bytes = typeof line === "string" ? Buffer.from(line, "utf8") : Buffer.from(line);
  if (bytes.byteLength + 1 > MAX_SERVICE_FRAME_BYTES) {
    return failure(null, "frame_too_large", `Response exceeds ${MAX_SERVICE_FRAME_BYTES} bytes`);
  }

  const decoded = decodeJson(bytes);
  if (!decoded.ok) return { ok: false, failure: decoded.failure };
  const envelope = serviceRequestEnvelopeSchema.safeParse(decoded.value);
  if (!envelope.success) return failure(null, "invalid_response", "Response must be a JSON object");

  const requestId = serviceRequestIdV1Schema.safeParse(envelope.data.requestId);
  const correlatedId = requestId.success ? requestId.data : null;
  if (envelope.data.version !== 1) {
    return failure(correlatedId, "unsupported_version", "Response version must be 1");
  }
  const parsed = serviceResponseFrameV1Schema.safeParse(decoded.value);
  if (!parsed.success) {
    return failure(correlatedId, "invalid_response", "Response does not match the version 1 schema", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return { ok: true, response: parsed.data };
}

export function encodeServiceRequestLine(request: ServiceRequestV1): string {
  const parsed = serviceRequestV1Schema.safeParse(request);
  if (!parsed.success) throw new TypeError("Cannot encode a service request that fails the version 1 schema");
  const line = `${JSON.stringify(parsed.data)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SERVICE_FRAME_BYTES) {
    throw new RangeError(`Request exceeds ${MAX_SERVICE_FRAME_BYTES} bytes`);
  }
  return line;
}

export function encodeServiceResponseLine(response: ServiceResponseV1): string {
  const parsed = serviceResponseV1Schema.safeParse(response);
  if (!parsed.success) {
    return minimalFailure(null, "invalid_handler_response", "Service handler returned an invalid response");
  }

  const line = `${JSON.stringify(parsed.data)}\n`;
  if (Buffer.byteLength(line, "utf8") <= MAX_SERVICE_FRAME_BYTES) return line;
  return minimalFailure(parsed.data.requestId, "response_too_large", `Response exceeds ${MAX_SERVICE_FRAME_BYTES} bytes`);
}

export function encodeServiceResponseFrames(response: ServiceResponseV1): string[] {
  const parsed = serviceResponseV1Schema.safeParse(response);
  if (!parsed.success) {
    return [minimalFailure(null, "invalid_handler_response", "Service handler returned an invalid response")];
  }
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (payload.byteLength + 1 <= MAX_SERVICE_FRAME_BYTES) return [`${payload.toString("utf8")}\n`];
  if (payload.byteLength > MAX_SERVICE_RESPONSE_BYTES) {
    return [minimalFailure(parsed.data.requestId, "response_too_large", `Response exceeds ${MAX_SERVICE_RESPONSE_BYTES} bytes`)];
  }

  const frames: string[] = [];
  for (let offset = 0, sequence = 0; offset < payload.byteLength; offset += MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES, sequence += 1) {
    const data = payload.subarray(offset, Math.min(payload.byteLength, offset + MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES)).toString("base64");
    const frame = JSON.stringify({
      version: 1,
      requestId: parsed.data.requestId,
      fragment: { sequence, final: offset + MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES >= payload.byteLength, data },
    });
    const line = `${frame}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_SERVICE_FRAME_BYTES) {
      throw new Error("service response fragment exceeds the frame limit");
    }
    frames.push(line);
  }
  return frames;
}

export function serviceSuccess(requestId: string | null, result: unknown): ServiceResponseV1 {
  return serviceResponseV1Schema.parse({ version: 1, requestId, ok: true, result });
}

export function serviceError(
  requestId: string | null,
  code: string,
  message: string,
  details?: unknown,
): ServiceResponseV1 {
  return serviceResponseV1Schema.parse({
    version: 1,
    requestId,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

function decodeJson(bytes: Buffer): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: ServiceProtocolFailure } {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return { ok: false, failure: { requestId: null, error: { code: "invalid_encoding", message: "Frame must use valid UTF-8" } } };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, failure: { requestId: null, error: { code: "malformed_json", message: "Frame is not valid JSON" } } };
  }
}

function failure(requestId: string | null, code: string, message: string, details?: unknown): { readonly ok: false; readonly failure: ServiceProtocolFailure } {
  return {
    ok: false,
    failure: { requestId, error: { code, message, ...(details === undefined ? {} : { details }) } },
  };
}

function minimalFailure(requestId: string | null, code: string, message: string): string {
  return `${JSON.stringify({ version: 1, requestId, ok: false, error: { code, message } })}\n`;
}
