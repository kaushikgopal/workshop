import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { terminateProcessGroup } from "./kill-process-tree.js";
import { processStartId } from "./identify-process.js";

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
export interface TrackedCaptureStats {
  totalBytes: number;
  retainedBytes: number;
  truncatedBytes: number;
  limitExceeded: boolean;
  error: string | null;
}

/**
 * Spawn the harness command in its own process group so the runtime can
 * terminate the whole tree on timeout, stop, or cancel. The returned identity
 * is what callers must durably record immediately after spawn: the pid is the
 * group leader, the pgid equals it, and the startId disambiguates PID reuse.
 */
export interface SemanticStdoutCapture {
  bytes: Buffer;
  totalBytes: number;
  tooLarge: boolean;
  sha256: string | null;
}

export interface TrackedProcess {
  pid: number;
  pgid: number;
  startId: string;
  exit: Promise<ExitInfo>;
  streamsClosed: Promise<void>;
  captures: () => { stdout: Readonly<TrackedCaptureStats>; stderr: Readonly<TrackedCaptureStats> };
  semanticStdout: () => SemanticStdoutCapture | null;
  /**
   * Terminate the whole process group and confirm every member is gone.
   * Returns true only when the whole group was observed dead — a dead leader
   * alone never counts, because descendants can outlive it.
   */
  kill: (graceMs?: number) => Promise<boolean>;
}

export function spawnTracked(input: {
  shell: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  stdoutFile: string;
  stderrFile: string;
  stdoutLogCapBytes?: number;
  stderrLogCapBytes?: number;
  semanticStdoutLimitBytes?: number;
}): TrackedProcess {
  for (const [name, limit] of [
    ["stdout log", input.stdoutLogCapBytes],
    ["stderr log", input.stderrLogCapBytes],
    ["semantic stdout", input.semanticStdoutLimitBytes],
  ] as const) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error(`${name} limit must be a nonnegative safe integer`);
    }
  }
  const stdout = openSync(input.stdoutFile, "w");
  const stderr = openSync(input.stderrFile, "w");
  let closeAfterStreams = false;
  try {
    const child = spawn(input.shell, ["-lc", input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // child becomes its own process-group leader
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("could not capture spawned process ID");
    const semantic = input.semanticStdoutLimitBytes === undefined
      ? null
      : createSemanticStdoutCapture(input.semanticStdoutLimitBytes, () => { void terminateProcessGroup(pid, 0); });
    const stdoutStats = captureStream(child.stdout, stdout, input.stdoutLogCapBytes, semantic?.add);
    const stderrStats = captureStream(child.stderr, stderr, input.stderrLogCapBytes);
    const streamsClosed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    closeAfterStreams = true;
    void streamsClosed.then(() => {
      closeSync(stdout);
      closeSync(stderr);
    });
    let identity: { pid: number; pgid: number; startId: string };
    try {
      identity = captureIdentity(pid);
    } catch (e) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      throw e;
    }

    const exit = new Promise<ExitInfo>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
      child.on("error", () => resolve({ code: -1, signal: null }));
    });

    return {
      ...identity,
      exit,
      streamsClosed,
      captures: () => ({ stdout: { ...stdoutStats }, stderr: { ...stderrStats } }),
      semanticStdout: () => semantic?.result() ?? null,
      kill: async (graceMs?: number) => terminateProcessGroup(identity.pgid, graceMs ?? 2000),
    };
  } finally {
    if (!closeAfterStreams) {
      closeSync(stdout);
      closeSync(stderr);
    }
  }
}

/**
 * Capture the process-start identity right after spawn. `ps` metadata can lag
 * the fork by a few milliseconds; recording an empty identity would leave
 * recovery unable to verify (and therefore terminate) the recorded group.
 */
function captureIdentity(pid: number): { pid: number; pgid: number; startId: string } {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 40; i++) {
    const startId = processStartId(pid);
    if (startId !== null) return { pid, pgid: pid, startId };
    Atomics.wait(wait, 0, 0, 5);
  }
  throw new Error(`cannot capture process-start identity for pid ${pid}`);
}


function createSemanticStdoutCapture(limit: number, onTooLarge: () => void) {
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let totalBytes = 0;
  let retainedBytes = 0;
  let tooLarge = false;
  let result: SemanticStdoutCapture | undefined;
  return {
    add(bytes: Buffer) {
      if (result !== undefined) throw new Error("semantic stdout was already finalized");
      totalBytes += bytes.byteLength;
      hash.update(bytes);
      const retained = Math.min(bytes.byteLength, Math.max(0, limit - retainedBytes));
      if (retained > 0) chunks.push(Buffer.from(bytes.subarray(0, retained)));
      retainedBytes += retained;
      if (totalBytes > limit && !tooLarge) {
        tooLarge = true;
        onTooLarge();
      }
    },
    result() {
      if (result === undefined) {
        result = {
          bytes: Buffer.concat(chunks, retainedBytes),
          totalBytes,
          tooLarge,
          sha256: tooLarge ? null : `sha256:${hash.digest("hex")}`,
        };
      }
      return result;
    },
  };
}

function captureStream(
  stream: Readable | null,
  fd: number,
  limit: number | undefined,
  onChunk?: (bytes: Buffer) => void,
): TrackedCaptureStats {
  const stats: TrackedCaptureStats = { totalBytes: 0, retainedBytes: 0, truncatedBytes: 0, limitExceeded: false, error: null };
  stream?.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stats.totalBytes += bytes.byteLength;
    onChunk?.(bytes);
    const available = limit === undefined ? bytes.byteLength : Math.max(0, limit - stats.retainedBytes);
    const retained = Math.min(bytes.byteLength, available);
    let offset = 0;
    try {
      while (offset < retained) {
        const written = writeSync(fd, bytes, offset, retained - offset);
        if (written === 0) throw new Error("stream capture write made no progress");
        offset += written;
        stats.retainedBytes += written;
      }
    } catch (error) {
      stats.error = error instanceof Error ? error.message : "stream capture write failed";
    }
    stats.truncatedBytes = stats.totalBytes - stats.retainedBytes;
    if (limit !== undefined && stats.totalBytes > limit) stats.limitExceeded = true;
  });
  stream?.on("error", (error: Error) => {
    stats.error = error.message;
  });
  return stats;
}

/** Race a tracked process's exit against a deadline; null means wait forever. */
export async function raceDeadline(
  proc: TrackedProcess,
  timeoutMs: number | null,
): Promise<{ kind: "exit"; exit: { code: number | null; signal: NodeJS.Signals | null } } | { kind: "timeout" }> {
  if (timeoutMs === null) return { kind: "exit", exit: await proc.exit };
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const exit = await Promise.race([proc.exit.then((e) => ({ kind: "exit" as const, exit: e })), timer]);
    return exit === "timeout" ? { kind: "timeout" } : exit;
  } finally {
    clearTimeout(timerId);
  }
}
