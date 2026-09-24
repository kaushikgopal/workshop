import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The worklog is runtime-owned. The runtime scaffolds every heading before
 * work starts (no model call creates structure), agents write packet files
 * only, and the runtime validates and merges packets under the run lock.
 * Each merge publishes the packet inside deterministic begin/end markers
 * keyed by (run_id, node_id, attempt, packet digest) and records a receipt
 * that hashes the exact marked block — together they make every merge
 * idempotent and every crash window reconcilable.
 */

export class WorklogIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorklogIntegrityError";
  }
}

export function worklogPath(runDir: string): string {
  return join(runDir, "WORKSHOP_LOG.md");
}

/** Three-digit zero-padding is the layout's only width (001, 002, …). */
function pad3(value: number): string {
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
export function attemptDir(
  runDir: string,
  chainPosition: number,
  nodeId: string,
  attempt: number,
): string {
  return join(runDir, "nodes", `${pad3(chainPosition + 1)}-${nodeId}`, `attempt-${pad3(attempt)}`);
}

/**
 * An existing attempt's folder is wherever its persisted packet_path puts it.
 * The stored path is authoritative: pre-layout evidence under attempts/ is
 * read, repaired, and logged in place — never re-derived from this layout.
 */
export function attemptFolderOfPacket(packetFile: string): string {
  return dirname(packetFile);
}

export function packetPath(attemptFolder: string): string {
  return join(attemptFolder, "packet.md");
}

/** Run-scoped orchestrator invocation artifacts, bound to the owner token. */
export function orchestratorDir(runDir: string, ownerToken: string): string {
  return join(runDir, "orchestrator", ownerToken);
}


export function worklogTemplate(
  workflowId: string,
  description: string,
  nodeIds: string[],
): string {
  const nodeSections = nodeIds.map((id) => `### Node: ${id}\n`).join("\n");
  return `# Workflow run: ${workflowId}

## Goal

${description}

## Environment

## Global decision log

## Work packets

${nodeSections}## Run outcome
`;
}

/**
 * Append the attempt block under `### Node: <id>`, creating the node section
 * when the first attempt of that node merges.
 */
export function insertAttemptSection(log: string, nodeHeading: string, attemptBlock: string): string {
  if (!log.includes(nodeHeading + "\n")) {
    // Create the node section before "## Run outcome".
    const outcomeHeading = "## Run outcome";
    const idx = log.indexOf(outcomeHeading);
    if (idx === -1) {
      throw new WorklogIntegrityError(`worklog is missing both "${nodeHeading}" and "${outcomeHeading}"`);
    }
    return `${log.slice(0, idx)}${nodeHeading}\n\n${attemptBlock}\n${log.slice(idx)}`;
  }

  // Insert before the next heading that ends the node's section.
  const nodeIdx = log.indexOf(nodeHeading + "\n") + nodeHeading.length + 1;
  const rest = log.slice(nodeIdx);
  const nextHeading = /^#{2,3} /m.exec(rest);
  const insertAt = nextHeading ? nodeIdx + (nextHeading.index ?? 0) : log.length;
  return `${log.slice(0, insertAt)}\n${attemptBlock}${log.slice(insertAt)}`;
}

/** The heading-delimited section of one node, or "" when absent. */
export function sectionFor(log: string, nodeHeading: string): string {
  const nodeIdx = log.indexOf(nodeHeading + "\n");
  if (nodeIdx === -1) return "";
  const rest = log.slice(nodeIdx);
  const nextHeading = /^#{2,3} /m.exec(rest.slice(nodeHeading.length + 1));
  // next.index is relative to the text after the heading line: make the
  // section end absolute before slicing, or early headings yield "".
  const end = nextHeading
    ? nodeIdx + nodeHeading.length + 1 + (nextHeading.index ?? 0)
    : log.length;
  return log.slice(nodeIdx, end);
}

export function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Content digest of an in-memory string, same format as sha256File. */
export function sha256String(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Used to detect agent tampering with the worklog mid-attempt. */
export function worklogFingerprint(runDir: string): string {
  const p = worklogPath(runDir);
  const s = statSync(p);
  return sha256File(p) + `:${s.size}`;
}
