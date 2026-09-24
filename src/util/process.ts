import { spawnSync } from "node:child_process";

/**
 * Process-start identity: a PID alone is not proof a process is the same one we
 * spawned (PIDs are reused). The start time reported by `ps` disambiguates.
 * Returns null when the process does not exist.
 */
export function processStartId(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out === "" ? null : out;
}

export function isProcessAlive(pid: number): boolean {
  return processStartId(pid) !== null;
}

/**
 * Claim identities must carry a start id, so an unreadable `ps` row is an
 * error rather than a null that would weaken the identity check.
 */
export function processStartIdOrThrow(pid: number): string {
  const id = processStartId(pid);
  if (id === null) throw new Error(`cannot capture process-start identity for pid ${pid}`);
  return id;
}

/**
 * Terminate a whole process group and confirm death before returning true.
 * Sends SIGTERM to the group, escalates to SIGKILL after the grace period,
 * then polls until no member of the group remains. Returns false only when
 * death could not be confirmed (the caller must block, never retry blindly).
 */
export async function terminateProcessGroup(
  pgid: number,
  graceMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  signalGroup(pgid, "SIGTERM");
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await sleep(50);
  }
  signalGroup(pgid, "SIGKILL");
  // SIGKILL is final; give the kernel a short moment to reap.
  for (let i = 0; i < 20; i++) {
    if (!groupAlive(pgid)) return true;
    await sleep(50);
  }
  return !groupAlive(pgid);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole group; ESRCH means it is already gone.
    process.kill(-pgid, signal);
  } catch {
    /* already dead */
  }
}

/**
 * True while at least one live process remains in the group. EPERM means the
 * group exists but holds a process we may not signal — treat it as alive so
 * death is never confirmed optimistically.
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists, not ours to signal
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
