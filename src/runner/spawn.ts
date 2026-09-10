import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { isProcessAlive, processStartId, terminateProcessGroup } from "../util/process.js";

/**
 * Spawn the harness command in its own process group so the runtime can
 * terminate the whole tree on timeout, stop, or cancel.
 */
export interface TrackedProcess {
  pid: number;
  pgid: number;
  startId: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
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
    const pgid = pid; // detached group leader
    const startId = processStartId(pid) ?? "";

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
      child.on("error", () => resolve({ code: -1, signal: null }));
    });

    return {
      pid,
      pgid,
      startId,
      exit,
      kill: async (graceMs?: number) => {
        const confirmed = await terminateProcessGroup(pgid, graceMs ?? 2000);
        return confirmed || !isProcessAlive(pid);
      },
    };
  } finally {
    // The child holds its own dup of each fd; closing ours now is safe.
    closeSync(stdout);
    closeSync(stderr);
  }
}
