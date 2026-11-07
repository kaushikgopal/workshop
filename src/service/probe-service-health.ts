import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  type ServiceMetadataV1,
  type StartupParkDiagnosticV1,
  MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1,
  serviceHealthResponseV1Schema,
  serviceMetadataV1Schema,
  startupParkDiagnosticV1Schema,
} from "./schema.js";
import { encodeServiceRequestLine, parseServiceResponseLine } from "./parse-service-protocol.js";
import { locateServiceSocket } from "./locate-service-socket.js";
import { STARTUP_PARK_DIAGNOSTIC_FILE } from "./write-startup-park-diagnostic.js";

const MAX_METADATA_BYTES = 4_096;
const MAX_HEALTH_FRAME_BYTES = 4_096;

type PrivateFileRead =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "error"; readonly reason: string };

export type ServiceHealthProbe =
  | { readonly kind: "ready"; readonly metadata: ServiceMetadataV1 }
  | { readonly kind: "not_ready"; readonly reason: string; readonly startupFailure?: StartupParkDiagnosticV1 };

/** Require checked metadata and a matching live socket response. */
export async function probeServiceHealth(stateDirectory: string, timeoutMs = 1_000): Promise<ServiceHealthProbe> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("health probe timeout must be a positive safe integer");
  }

  const location = locateServiceSocket(stateDirectory);
  const stateDirectoryResult = checkPrivateStateDirectory(location.stateDirectory);
  if (stateDirectoryResult !== undefined) return { kind: "not_ready", reason: stateDirectoryResult };
  const metadataPath = join(location.stateDirectory, "service.json");
  const metadataFile = readPrivateBoundedFile(metadataPath, MAX_METADATA_BYTES);
  if (metadataFile.kind === "error") return { kind: "not_ready", reason: metadataFile.reason };

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataFile.content);
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
    const startupFailure = readStartupFailure(location.stateDirectory, metadata.bootId);
    return {
      kind: "not_ready",
      reason: "service state is " + metadata.status,
      ...(startupFailure === undefined ? {} : { startupFailure }),
    };
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

function readStartupFailure(stateDirectory: string, bootId: string): StartupParkDiagnosticV1 | undefined {
  const read = readPrivateBoundedFile(join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE), MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1);
  if (read.kind !== "ok") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch {
    return undefined;
  }
  const checked = startupParkDiagnosticV1Schema.safeParse(parsed);
  if (!checked.success || checked.data.bootId !== bootId) return undefined;
  return checked.data;
}

function checkPrivateStateDirectory(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0) {
      return "service state directory is not private and owner-controlled";
    }
    return undefined;
  } catch (error) {
    return isMissing(error) ? "service metadata is missing" : "service state directory cannot be read";
  }
}

function readPrivateBoundedFile(path: string, maxBytes: number): PrivateFileRead {
  let descriptor: number | undefined;
  try {
    if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) {
      return { kind: "error", reason: "service metadata cannot be read safely on this platform" };
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { kind: "error", reason: "service metadata is not a regular file" };
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return { kind: "error", reason: "service metadata is not owned by this user" };
    }
    if ((stat.mode & 0o077) !== 0) return { kind: "error", reason: "service metadata is not private" };
    if (stat.size > maxBytes) return { kind: "error", reason: "service metadata exceeds its size limit" };

    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(descriptor, bytes, length, bytes.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) return { kind: "error", reason: "service metadata exceeds its size limit" };
    return { kind: "ok", content: bytes.subarray(0, length).toString("utf8") };
  } catch (error) {
    return { kind: "error", reason: isMissing(error) ? "service metadata is missing" : "service metadata cannot be read" };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Keep the bounded read result. */ }
    }
  }
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
