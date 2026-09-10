import { randomBytes } from "node:crypto";

/** Run ids look like run-20260904-001 — date plus per-day sequence. */
export function formatRunId(date: Date, seq: number): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `run-${y}${m}${d}-${String(seq).padStart(3, "0")}`;
}

/** Unguessable owner tokens: one accepted owner per attempt or orchestrator phase. */
export function newOwnerToken(): string {
  return randomBytes(16).toString("hex");
}
