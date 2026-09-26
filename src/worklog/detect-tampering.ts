
/**
 * The worklog is runtime-owned. The runtime scaffolds every heading before
 * work starts (no model call creates structure), agents write packet files
 * only, and the runtime validates and merges packets under the run lock.
 * Each merge publishes the packet inside deterministic begin/end markers
 * keyed by (run_id, node_id, attempt, packet digest) and records a receipt
 * that hashes the exact marked block — together they make every merge
 * idempotent and every crash window reconcilable.
 */

import { statSync } from "node:fs";
import { locateWorklog } from "../storage/disk/locate-run-files.js";
import { sha256File } from "../util/hash-content.js";

export class WorklogIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorklogIntegrityError";
  }
}

/** Used to detect agent tampering with the worklog mid-attempt. */
export function worklogFingerprint(runDir: string): string {
  const p = locateWorklog(runDir);
  const s = statSync(p);
  return sha256File(p) + `:${s.size}`;
}
