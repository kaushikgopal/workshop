import type { AttemptRow } from "../storage/db/store.js";

/**
 * One node-status derivation shared by the JSON DTO, the human tree, and the
 * diagram. The latest attempt by number decides: a live attempt projects as
 * pending/running, and a later successful retry makes the node completed —
 * earlier failed or blocked attempts stay visible in the attempt history.
 */
export function deriveNodeStatus(attempts: AttemptRow[]): string {
  if (attempts.length === 0) return "pending";
  const latest = attempts.reduce((a, b) => (a.attempt >= b.attempt ? a : b));
  if (latest.status === "finishing") return "running";
  return latest.status;
}
