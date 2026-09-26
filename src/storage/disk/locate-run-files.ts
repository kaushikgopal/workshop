import { dirname, join } from "node:path";

/**
 * Pure path arithmetic for a run directory: nothing here touches disk.
 * SQLite stores each run's paths when the run is created, so an existing run
 * keeps whatever names these functions produced at that time.
 */

export const WORKLOG_FILENAME = "WORKLOG.md";

export function locateWorklog(runDir: string): string {
  return join(runDir, WORKLOG_FILENAME);
}
/** Three-digit zero-padding is the layout's only width (001, 002, …). */
export function pad3(value: number): string {
  return String(value).padStart(3, "0");
}
/**
 * Attempt-scoped layout: node evidence grouped under nodes/, one folder per
 * chain node — nodes/001-node-timestamp/attempt-001/. The node folder prefix
 * is the one-based zero-padded chain position (chain_position + 1); the child
 * folder is the one-based zero-padded node attempt, so chain position and a
 * node's retry count have distinct visible meanings. The global execution
 * order stays in SQLite (execution_seq) — never in a path. Everything about
 * one attempt lives in its folder: packet, streams, output, prompt,
 * validation/, and its merge receipt.
 */
export function locateAttemptDir(
  runDir: string,
  chainPosition: number,
  nodeId: string,
  attempt: number
): string {
  return join(runDir, "nodes", `${pad3(chainPosition + 1)}-${nodeId}`, `attempt-${pad3(attempt)}`);
}
/**
 * An existing attempt's folder is wherever its persisted packet_path puts it.
 * The stored path is authoritative: pre-layout evidence under attempts/ is
 * read, repaired, and logged in place — never re-derived from this layout.
 */
export function attemptDirOfPacket(packetFile: string): string {
  return dirname(packetFile);
}
export function locatePacket(attemptFolder: string): string {
  return join(attemptFolder, "packet.md");
}
/** Run-scoped orchestrator invocation artifacts, bound to the owner token. */
export function locateOrchestratorDir(runDir: string, ownerToken: string): string {
  return join(runDir, "orchestrator", ownerToken);
}
