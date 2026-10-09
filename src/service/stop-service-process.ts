import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processStartId } from "../process/identify-process.js";
import { locateServiceSocket } from "./locate-service-socket.js";
import { probeServiceHealth } from "./probe-service-health.js";
import { serviceMetadataV1Schema, type ServiceMetadataV1 } from "./schema.js";

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const MAX_METADATA_BYTES = 4_096;

export type StopServiceResult =
  | { readonly _tag: "not_running"; readonly reason: string }
  | { readonly _tag: "stopped"; readonly metadata: ServiceMetadataV1 }
  | { readonly _tag: "unverified"; readonly reason: string }
  | { readonly _tag: "shutdown_failed"; readonly metadata: ServiceMetadataV1 }
  | { readonly _tag: "timed_out"; readonly metadata: ServiceMetadataV1 };

/**
 * Ask the installation's service to shut down gracefully. The protocol has no
 * shutdown method, so the owner is signalled; a SIGTERM goes only to a PID
 * whose live socket answered with the recorded boot ID and whose process-start
 * identity still matches, so a reused PID is never signalled.
 */
export async function stopServiceProcess(stateDirectory: string, timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<StopServiceResult> {
  const probe = await probeServiceHealth(stateDirectory);
  if (probe.kind !== "ready") {
    const recorded = readServiceMetadata(stateDirectory);
    if (recorded !== null && processStartId(recorded.pid) === recorded.startIdentity) {
      return {
        _tag: "unverified",
        reason: `service pid ${recorded.pid} is still alive but not healthy (${probe.reason}; recorded state ${recorded.status}); refusing to signal an unverified process`,
      };
    }
    return { _tag: "not_running", reason: probe.reason };
  }

  const metadata = probe.metadata;
  if (processStartId(metadata.pid) !== metadata.startIdentity) {
    return { _tag: "unverified", reason: `service pid ${metadata.pid} no longer matches its recorded start identity; refusing to signal it` };
  }
  try {
    process.kill(metadata.pid, "SIGTERM");
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return { _tag: "stopped", metadata };
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processStartId(metadata.pid) !== metadata.startIdentity) return { _tag: "stopped", metadata };
    const current = readServiceMetadata(stateDirectory);
    if (current?.bootId === metadata.bootId && current.status === "shutdown_failed") return { _tag: "shutdown_failed", metadata };
    if (Date.now() >= deadline) return { _tag: "timed_out", metadata };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

function readServiceMetadata(stateDirectory: string): ServiceMetadataV1 | null {
  const path = join(locateServiceSocket(stateDirectory).stateDirectory, "service.json");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) return null;
    const parsed = serviceMetadataV1Schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
