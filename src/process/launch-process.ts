import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { terminateProcessGroup } from "./kill-process-tree.js";
import { processStartId } from "./identify-process.js";

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Spawn the harness command in its own process group so the runtime can
 * terminate the whole tree on timeout, stop, or cancel. The returned identity
 * is what callers must durably record immediately after spawn: the pid is the
 * group leader, the pgid equals it, and the startId disambiguates PID reuse.
 */
export interface TrackedProcess {
  pid: number;
  pgid: number;
  startId: string;
  exit: Promise<ExitInfo>;
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
}): TrackedProcess {
  const stdout = openSync(input.stdoutFile, "w");
  const stderr = openSync(input.stderrFile, "w");
  try {
    const child = spawn(input.shell, ["-lc", input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", stdout, stderr],
      detached: true, // child becomes its own process-group leader
    });
    const pid = child.pid!;
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
      kill: async (graceMs?: number) => terminateProcessGroup(identity.pgid, graceMs ?? 2000),
    };
  } finally {
    // The child holds its own dup of each fd; closing ours now is safe.
    closeSync(stdout);
    closeSync(stderr);
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
