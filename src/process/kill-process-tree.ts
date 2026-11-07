export type ProcessGroupProbeResult =
  | { state: "alive" }
  | { state: "absent" }
  | { state: "denied" }
  | { state: "error"; error: unknown };

/** Probe a process group without conflating access failures with absence. */
export function probeProcessGroup(pgid: number): ProcessGroupProbeResult {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    return { state: "error", error: new RangeError("process-group ID must be a positive safe integer") };
  }
  try {
    process.kill(-pgid, 0);
    return { state: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "absent" };
    if (code === "EPERM") return { state: "denied" };
    return { state: "error", error };
  }
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
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  const deadline = Date.now() + graceMs;
  signalGroup(pgid, "SIGTERM");
  while (Date.now() < deadline) {
    if (!groupMayExist(pgid)) return true;
    await sleep(50);
  }
  signalGroup(pgid, "SIGKILL");
  // SIGKILL is final; give the kernel a short moment to reap.
  for (let i = 0; i < 20; i++) {
    if (!groupMayExist(pgid)) return true;
    await sleep(50);
  }
  return !groupMayExist(pgid);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole group; ESRCH means it is already gone.
    process.kill(-pgid, signal);
  } catch {
    /* the caller confirms absence through a separate probe */
  }
}

/** Treat every result except ESRCH as possibly alive; unknown is not absent. */
function groupMayExist(pgid: number): boolean {
  return probeProcessGroup(pgid).state !== "absent";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
