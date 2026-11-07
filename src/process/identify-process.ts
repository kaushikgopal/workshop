import { spawnSync } from "node:child_process";

/**
 * Process-start identity: a PID alone is not proof a process is the same one we
 * spawned (PIDs are reused). The start time reported by `ps` disambiguates.
 * Returns null when the process does not exist.
 */
export function processStartId(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return processStartIdFromOutput(r.stdout);
}

/** Read a process-start identity while preserving failures from the `ps` invocation. */
export function processStartIdForVerification(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) return null;
  return processStartIdFromOutput(r.stdout);
}

function processStartIdFromOutput(stdout: string): string | null {
  const out = stdout.trim();
  return out === "" ? null : out;
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

/** Return the current process-group ID reported for a process, or null when no row exists. */
export function processGroupId(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (out === "") return null;
  const pgid = Number(out);
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`cannot capture process-group identity for pid ${pid}`);
  }
  return pgid;
}
