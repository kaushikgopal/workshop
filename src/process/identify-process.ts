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
/**
 * Claim identities must carry a start id, so an unreadable `ps` row is an
 * error rather than a null that would weaken the identity check.
 */
export function processStartIdOrThrow(pid: number): string {
  const id = processStartId(pid);
  if (id === null) throw new Error(`cannot capture process-start identity for pid ${pid}`);
  return id;
}
