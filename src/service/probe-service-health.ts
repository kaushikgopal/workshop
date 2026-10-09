import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  type ServiceMetadataV1,
  serviceHealthResponseV1Schema,
  serviceMetadataV1Schema,
} from "./schema.js";
import { encodeServiceRequestLine, parseServiceResponseLine } from "./parse-service-protocol.js";
import { locateServiceSocket } from "./locate-service-socket.js";

const MAX_METADATA_BYTES = 4_096;
const MAX_HEALTH_FRAME_BYTES = 4_096;

export type ServiceHealthProbe =
  | { readonly kind: "ready"; readonly metadata: ServiceMetadataV1 }
  | { readonly kind: "not_ready"; readonly reason: string };

/** Require both checked metadata and a matching live socket response. */
export async function probeServiceHealth(stateDirectory: string, timeoutMs = 1_000): Promise<ServiceHealthProbe> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("health probe timeout must be a positive safe integer");
  }

  const location = locateServiceSocket(stateDirectory);
  const metadataPath = join(location.stateDirectory, "service.json");
  let rawMetadata: string;
  try {
    const stat = lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "not_ready", reason: "service metadata is not a regular file" };
    if (stat.size > MAX_METADATA_BYTES) return { kind: "not_ready", reason: "service metadata exceeds its size limit" };
    rawMetadata = readFileSync(metadataPath, "utf8");
  } catch (error) {
    return { kind: "not_ready", reason: isMissing(error) ? "service metadata is missing" : "service metadata cannot be read" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    return { kind: "not_ready", reason: "service metadata is malformed" };
  }
  const metadataResult = serviceMetadataV1Schema.safeParse(parsed);
  if (!metadataResult.success) return { kind: "not_ready", reason: "service metadata is invalid" };
  const metadata = metadataResult.data;
  if (metadata.socketPath !== location.socketPath) {
    return { kind: "not_ready", reason: "service metadata names an unexpected socket path" };
  }
  if (metadata.status !== "ready") {
    return { kind: "not_ready", reason: `service state is ${metadata.status}` };
  }

  const response = await readHealthResponse(metadata.socketPath, timeoutMs);
  if (response.kind !== "response") return { kind: "not_ready", reason: response.reason };
  const healthResult = serviceHealthResponseV1Schema.safeParse(response.value);
  if (!healthResult.success || healthResult.data.status !== "ready") {
    return { kind: "not_ready", reason: "service health response is invalid or not ready" };
  }
  if (healthResult.data.bootId !== metadata.bootId || healthResult.data.pid !== metadata.pid) {
    return { kind: "not_ready", reason: "service health identity does not match its metadata" };
  }
  return { kind: "ready", metadata };
}

async function readHealthResponse(
  socketPath: string,
  timeoutMs: number,
): Promise<{ readonly kind: "response"; readonly value: unknown } | { readonly kind: "error"; readonly reason: string }> {
  return await new Promise((resolveResponse) => {
    let settled = false;
    let data = "";
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish({ kind: "error", reason: "service health probe timed out" }), timeoutMs);
    const finish = (result: { readonly kind: "response"; readonly value: unknown } | { readonly kind: "error"; readonly reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResponse(result);
    };

    socket.once("connect", () => {
      socket.end(encodeServiceRequestLine({ version: 1, method: "health" }));
    });
    socket.on("data", (chunk: Buffer) => {
      if (chunk.byteLength > MAX_HEALTH_FRAME_BYTES - Buffer.byteLength(data)) {
        finish({ kind: "error", reason: "service health response exceeds its size limit" });
        return;
      }
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const parsed = parseServiceResponseLine(data.slice(0, newline));
      if (!parsed.ok || !("ok" in parsed.response) || !parsed.response.ok) {
        finish({ kind: "error", reason: "service health response envelope is invalid" });
        return;
      }
      finish({ kind: "response", value: parsed.response.result });
    });
    socket.on("error", () => finish({ kind: "error", reason: "service health socket is unavailable" }));
    socket.on("end", () => {
      if (!settled) finish({ kind: "error", reason: "service health socket closed without a response" });
    });
  });
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
