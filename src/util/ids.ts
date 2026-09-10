import { randomBytes } from "node:crypto";

/**
 * Run ids look like hemingway-clock-20260910-001 — workflow, date, and the
 * workflow's own run sequence, so the run directory is identifiable to the
 * workflow that spawned it.
 */
export function formatRunId(workflowId: string, date: Date, seq: number): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${workflowId}-${y}${m}${d}-${String(seq).padStart(3, "0")}`;
}

/** Unguessable owner tokens: one accepted owner per attempt or orchestrator phase. */
export function newOwnerToken(): string {
  return randomBytes(16).toString("hex");
}
