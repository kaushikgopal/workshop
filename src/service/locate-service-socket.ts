import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ServiceSocketLocation {
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly runtimeDirectory: string | null;
}

/** Use a short private runtime path when sockaddr_un cannot hold the state path. */
export function locateServiceSocket(stateDirectory: string): ServiceSocketLocation {
  const absoluteStateDirectory = resolve(stateDirectory);
  let canonicalStateDirectory = absoluteStateDirectory;
  try {
    canonicalStateDirectory = realpathSync(absoluteStateDirectory);
  } catch {
    // Health probes must not create state directories just to discover their path.
  }

  const directPath = join(canonicalStateDirectory, "service.sock");
  if (Buffer.byteLength(directPath) <= unixSocketPathLimit()) {
    return { stateDirectory: canonicalStateDirectory, socketPath: directPath, runtimeDirectory: null };
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const identity = createHash("sha256").update(canonicalStateDirectory).digest("hex").slice(0, 24);
  const runtimeDirectory = join("/tmp", `workshop-${uid}-${identity}`);
  const socketPath = join(runtimeDirectory, "service.sock");
  if (Buffer.byteLength(socketPath) > unixSocketPathLimit()) {
    throw new Error(`cannot fit a private Workshop service socket path on ${process.platform}`);
  }
  return { stateDirectory: canonicalStateDirectory, socketPath, runtimeDirectory };
}

function unixSocketPathLimit(): number {
  if (process.platform === "darwin") return 103;
  if (process.platform === "linux") return 107;
  throw new Error(`Workshop service sockets are unsupported on ${process.platform}`);
}
