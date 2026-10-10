import { Buffer } from "node:buffer";
import { createConnection } from "node:net";
import {
  encodeServiceRequestLine,
  MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES,
  MAX_SERVICE_FRAME_BYTES,
  MAX_SERVICE_RESPONSE_BYTES,
  parseServiceResponseLine,
} from "./parse-service-protocol.js";
import { serviceLogSectionPageV1Schema, serviceResponseV1Schema, type ServiceLogSectionPageV1, type ServiceRequestV1, type ServiceResponseV1 } from "./schema.js";

export class ServiceConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions, readonly retryable = false) {
    super(message, options);
    this.name = "ServiceConnectionError";
  }
}

/** Exchange one request and reassemble a bounded, correlated response stream. */
export function sendServiceRequest(
  socketPath: string,
  request: ServiceRequestV1,
  timeoutMs = 10_000,
): Promise<ServiceResponseV1> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("service request timeout must be a positive safe integer");
  const requestLine = encodeServiceRequestLine(request);
  const expectedRequestId = "requestId" in request ? request.requestId : null;

  return sendAttempt(socketPath, requestLine, expectedRequestId, timeoutMs).catch((error: unknown) => {
    if (error instanceof ServiceConnectionError && error.retryable) {
      return sendAttempt(socketPath, requestLine, expectedRequestId, timeoutMs);
    }
    throw error;
  });
}

export async function streamServiceLogChunks(
  socketPath: string,
  workflowId: string,
  runId: ServiceLogSectionPageV1["runId"] | undefined,
  onChunk: (section: ServiceLogSectionPageV1["section"], runId: string, chunk: ServiceLogSectionPageV1["chunk"]) => void | Promise<void>,
  timeoutMs = 10_000,
  verbose = false,
): Promise<{ readonly runId: string }> {
  let cursor: string | undefined;
  let selectedRunId = runId;
  let expectedIndex = 0;
  let totalSections: number | undefined;
  let sectionId: string | undefined;
  let sectionMetadata: string | undefined;
  let sectionOffsetBytes = 0;
  let sectionTotalBytes: number | undefined;
  const sectionIds = new Set<string>();
  do {
    const response = await sendServiceRequest(socketPath, {
      version: 1, method: "logs.page", workflowId,
      ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(cursor === undefined && verbose ? { verbose: true } : {}),
    }, timeoutMs);
    if (!response.ok) throw new ServiceConnectionError(`${response.error.code}: ${response.error.message}`);
    const page = serviceLogSectionPageV1Schema.parse(response.result);
    if (selectedRunId !== undefined && page.runId !== selectedRunId) throw new ServiceConnectionError("service changed the selected log run between chunks");
    if ((totalSections !== undefined && page.totalSections !== totalSections)
      || page.sectionIndex !== expectedIndex) throw new ServiceConnectionError("service returned an out-of-order log section chunk");
    const metadata = JSON.stringify({ ...page.section, content: null });
    if (sectionId === undefined) {
      if (sectionIds.has(page.section.sectionId)) throw new ServiceConnectionError("service repeated a log section ID");
      sectionId = page.section.sectionId;
      sectionMetadata = metadata;
      sectionOffsetBytes = 0;
      sectionTotalBytes = page.chunk.totalBytes;
    } else if (page.section.sectionId !== sectionId || metadata !== sectionMetadata) {
      throw new ServiceConnectionError("service changed log section metadata within a chunked snapshot");
    }
    if (page.chunk.offsetBytes !== sectionOffsetBytes || page.chunk.totalBytes !== sectionTotalBytes) {
      throw new ServiceConnectionError("service returned a discontinuous log section byte range");
    }
    const contentBytes = page.section.content === null ? 0 : Buffer.byteLength(page.section.content, "utf8");
    if (!page.chunk.complete && contentBytes === 0) throw new ServiceConnectionError("service returned an empty non-final log chunk");
    await onChunk(page.section, page.runId, page.chunk);
    selectedRunId = page.runId;
    totalSections = page.totalSections;
    if (page.chunk.complete) {
      sectionIds.add(page.section.sectionId);
      expectedIndex += 1;
      sectionId = undefined;
      sectionMetadata = undefined;
      sectionOffsetBytes = 0;
      sectionTotalBytes = undefined;
    } else {
      sectionOffsetBytes += contentBytes;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  if (selectedRunId === undefined || totalSections === undefined || expectedIndex !== totalSections) {
    throw new ServiceConnectionError("service ended the log section stream before its snapshot was complete");
  }
  return { runId: selectedRunId };
}

export async function readServiceWorklog(
  socketPath: string, workflowId: string, runId: ServiceLogSectionPageV1["runId"], timeoutMs = 10_000, verbose = false,
): Promise<string> {
  let cursor: string | undefined;
  let offsetBytes = 0;
  let totalBytes: number | undefined;
  let sectionMetadata: string | undefined;
  let totalSections: number | undefined;
  const chunks: string[] = [];
  for (;;) {
    const response = await sendServiceRequest(socketPath, {
      version: 1, method: "logs.page", workflowId, runId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(cursor === undefined && verbose ? { verbose: true } : {}),
    }, timeoutMs);
    if (!response.ok) throw new ServiceConnectionError(`${response.error.code}: ${response.error.message}`);
    const page = serviceLogSectionPageV1Schema.parse(response.result);
    if (page.runId !== runId || page.sectionIndex !== 0 || page.section.kind !== "worklog") {
      throw new ServiceConnectionError("service returned no worklog section");
    }
    const currentMetadata = JSON.stringify({ ...page.section, content: null });
    if ((sectionMetadata !== undefined && sectionMetadata !== currentMetadata)
      || (totalSections !== undefined && totalSections !== page.totalSections)) {
      throw new ServiceConnectionError("service changed worklog snapshot metadata between chunks");
    }
    sectionMetadata = currentMetadata;
    totalSections = page.totalSections;
    if (page.chunk.offsetBytes !== offsetBytes || (totalBytes !== undefined && page.chunk.totalBytes !== totalBytes)) {
      throw new ServiceConnectionError("service returned a discontinuous worklog byte range");
    }
    if (page.section.content === null) throw new ServiceConnectionError("service returned an unavailable worklog section");
    const contentBytes = Buffer.byteLength(page.section.content, "utf8");
    if (!page.chunk.complete && contentBytes === 0) throw new ServiceConnectionError("service returned an empty non-final worklog chunk");
    chunks.push(page.section.content);
    offsetBytes += contentBytes;
    totalBytes = page.chunk.totalBytes;
    if (page.chunk.complete) {
      if (offsetBytes !== totalBytes) throw new ServiceConnectionError("service ended the worklog before its declared byte length");
      return chunks.join("");
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) throw new ServiceConnectionError("service ended the worklog before its final chunk");
  }
}

function sendAttempt(
  socketPath: string,
  requestLine: string,
  expectedRequestId: string | null,
  timeoutMs: number,
): Promise<ServiceResponseV1> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let chunkBytes = 0;
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let expectedSequence = 0;
    let sawFragment = false;
    let sawFinalFragment = false;
    let completeResponse: ServiceResponseV1 | undefined;
    let settled = false;
    const timeout = setTimeout(() => fail(new ServiceConnectionError("service request timed out", undefined, true)), timeoutMs);

    socket.once("connect", () => socket.write(requestLine));
    socket.on("data", (data: Buffer) => {
      if (settled) return;
      buffer = buffer.byteLength === 0 ? data : Buffer.concat([buffer, data]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        if (newline + 1 > MAX_SERVICE_FRAME_BYTES) {
          fail(new ServiceConnectionError("service response frame exceeds its size limit"));
          return;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (!acceptFrame(line)) return;
      }
      if (buffer.byteLength > MAX_SERVICE_FRAME_BYTES) {
        fail(new ServiceConnectionError("service response frame exceeds its size limit"));
      }
    });
    socket.once("end", () => {
      if (settled) return;
      if (buffer.byteLength !== 0) {
        fail(new ServiceConnectionError("service closed with an incomplete response frame", undefined, true));
      } else if (sawFragment) {
        if (!sawFinalFragment) fail(new ServiceConnectionError("service closed before the final response fragment", undefined, true));
        else finishReassembled();
      } else if (completeResponse !== undefined) {
        succeed(completeResponse);
      } else {
        fail(new ServiceConnectionError("service closed without a response", undefined, true));
      }
    });
    socket.once("error", (error) => fail(new ServiceConnectionError("service socket connection failed", { cause: error }, true)));

    function acceptFrame(line: Buffer): boolean {
      const parsed = parseServiceResponseLine(line);
      if (!parsed.ok) {
        fail(new ServiceConnectionError(`invalid service response: ${parsed.failure.error.code}`));
        return false;
      }
      const frame = parsed.response;
      if (frame.requestId !== expectedRequestId) {
        fail(new ServiceConnectionError("service response request ID does not match the request"));
        return false;
      }
      if ("fragment" in frame) {
        if (completeResponse !== undefined || sawFinalFragment || frame.fragment.sequence !== expectedSequence) {
          fail(new ServiceConnectionError("service response fragments are out of order or duplicated"));
          return false;
        }
        const decoded = Buffer.from(frame.fragment.data, "base64");
        if (decoded.toString("base64") !== frame.fragment.data || decoded.byteLength > MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES) {
          fail(new ServiceConnectionError("service response fragment encoding is invalid"));
          return false;
        }
        if (chunkBytes + decoded.byteLength > MAX_SERVICE_RESPONSE_BYTES) {
          fail(new ServiceConnectionError("reassembled service response exceeds its size limit"));
          return false;
        }
        sawFragment = true;
        sawFinalFragment = frame.fragment.final;
        expectedSequence += 1;
        chunkBytes += decoded.byteLength;
        chunks.push(decoded);
        return true;
      }
      if (sawFragment || completeResponse !== undefined) {
        fail(new ServiceConnectionError("service mixed single and fragmented responses"));
        return false;
      }
      completeResponse = frame;
      return true;
    }

    function finishReassembled(): void {
      let response: ServiceResponseV1;
      try {
        const bytes = Buffer.concat(chunks, chunkBytes);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        response = serviceResponseV1Schema.parse(JSON.parse(text));
      } catch (error) {
        fail(new ServiceConnectionError("reassembled service response is invalid", { cause: error }));
        return;
      }
      if (response.requestId !== expectedRequestId) {
        fail(new ServiceConnectionError("reassembled service response request ID does not match its fragments"));
        return;
      }
      succeed(response);
    }

    function succeed(response: ServiceResponseV1): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveResponse(response);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      rejectResponse(error);
    }
  });
}
