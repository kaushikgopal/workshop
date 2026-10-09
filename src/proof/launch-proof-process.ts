import { spawnTracked } from "../process/launch-process.js";
import type { ProcessExit, ProcessIdentity } from "./types.js";

/**
 * The one process adapter of the proof: every node command and every validator
 * is spawned through here, so identity capture and kill semantics are shared.
 */
export interface ProofProcess {
  identity: ProcessIdentity;
  exit: Promise<ProcessExit>;
  kill(graceMs?: number): Promise<boolean>;
}

export function launchProofProcess(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  stdoutFile: string;
  stderrFile: string;
}): ProofProcess {
  const tracked = spawnTracked({
    shell: "/bin/bash",
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    stdoutFile: input.stdoutFile,
    stderrFile: input.stderrFile,
  });
  return {
    identity: { pid: tracked.pid, pgid: tracked.pgid, startId: tracked.startId },
    exit: tracked.exit,
    kill: tracked.kill,
  };
}

export type ProofProcessOutcome =
  | { kind: "exit"; code: number | null; signal: string | null }
  | { kind: "timeout"; cleanupConfirmed: boolean }
  | { kind: "aborted" };

/**
 * Race a launched process against its timeout and the task's abort signal.
 * A timeout kills the group and reports whether death was confirmed. An abort
 * hands the process to the caller: the abort handler owns the kill and must
 * confirm cleanup before the task can settle.
 */
export async function awaitProofProcess(
  process: ProofProcess,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<ProofProcessOutcome> {
  if (options.signal.aborted) return { kind: "aborted" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const exitPromise = process.exit.then((exit) => ({ kind: "exit" as const, code: exit.code, signal: exit.signal }));
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs);
    });
    const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
      onAbort = () => resolve({ kind: "aborted" });
      options.signal.addEventListener("abort", onAbort, { once: true });
    });

    const outcome = await Promise.race([exitPromise, timeoutPromise, abortPromise]);
    if (outcome.kind === "timeout") {
      const cleanupConfirmed = await process.kill();
      return { kind: "timeout", cleanupConfirmed };
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) options.signal.removeEventListener("abort", onAbort);
  }
}
