import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The worklog is runtime-owned. The runtime scaffolds every heading before
 * work starts (no model call creates structure), agents write packet files
 * only, and the runtime validates and merges packets under the run lock.
 * Receipts make each merge idempotent and key it by (run_id, node_id, attempt).
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

/**
 * Attempt-scoped layout: chronological per-run execution folders under
 * attempts/ — attempts/001-node-timestamp/, attempts/002-node-generate-line/.
 * Everything about one execution lives there: packet, streams, output,
 * prompt, validation/, and its merge receipt. The sequence is per run, not
 * per node; a node's own attempt number stays in the DB and packet content.
 */
export function attemptFolderName(executionSeq: number, nodeId: string): string {
  return `${String(executionSeq).padStart(3, "0")}-${nodeId}`;
}

export function attemptDir(runDir: string, executionSeq: number, nodeId: string): string {
  return join(runDir, "attempts", attemptFolderName(executionSeq, nodeId));
}

export function packetPath(attemptFolder: string): string {
  return join(attemptFolder, "packet.md");
}

export function receiptPath(attemptFolder: string): string {
  return join(attemptFolder, "merge-receipt.json");
}

/** Run-scoped orchestrator invocation artifacts, bound to the owner token. */
export function orchestratorDir(runDir: string, ownerToken: string): string {
  return join(runDir, "orchestrator", ownerToken);
}

/** The marker a node's attempt is authorized to carry. */
export function authorizedMarker(successorId: string | null): { opening: string; closing: string } {
  if (successorId === null) {
    return { opening: "<workflow-output>", closing: "</workflow-output>" };
  }
  return {
    opening: `<next-node-output id="${successorId}">`,
    closing: "</next-node-output>",
  };
}


export function scaffoldWorklog(
  runDir: string,
  workflowId: string,
  description: string,
  nodeIds: string[],
): string {
  const nodeSections = nodeIds.map((id) => `### Node: ${id}\n`).join("\n");
  const content = `# Workflow run: ${workflowId}

## Goal

${description}

## Environment

## Global decision log

## Work packets

${nodeSections}
## Run outcome
`;
  return atomicWriteFileSync(worklogPath(runDir), content);
}

/** The scaffold content for one attempt's packet file. */
export function packetTemplate(attempt: number, marker: { opening: string; closing: string }): string {
  return `#### Attempt ${attempt}

##### Progress

##### Decisions

##### Validation

##### Blockers

${marker.opening}
${marker.closing}
`;
}

/** Scaffold one attempt's packet file: attempt headings + one authorized marker. */
export function scaffoldPacket(
  attemptFolder: string,
  attempt: number,
  successorId: string | null,
): string {
  const marker = authorizedMarker(successorId);
  const path = packetPath(attemptFolder);
  mkdirSync(dirname(path), { recursive: true });
  return atomicWriteFileSync(path, packetTemplate(attempt, marker));
}

export interface PacketCheck {
  ok: true;
}

/**
 * Validate a finished packet before merge. Ownership is the gate:
 * - exactly one authorized marker with its closing tag (spec §8);
 * - no headings that own runtime sections (#, ##, ###).
 * Formatting drift inside the attempt block — dropped or extra ####/#####
 * headings — is tolerated; the merge normalizes the attempt heading.
 */
export function validatePacket(packetFile: string, nodeId: string, attempt: number, successorId: string | null): void {
  const content = readFileSync(packetFile, "utf8");
  const marker = authorizedMarker(successorId);

  for (const line of content.split("\n")) {
    if (/^#{1,3} /.test(line.trim())) {
      throw new WorklogIntegrityError(
        `packet for ${nodeId} #${attempt} contains a heading it does not own: "${line.trim()}" — "#", "##", and "###" sections belong to the runtime`,
      );
    }
  }

  const openingCount = countOccurrences(content, marker.opening);
  const closingCount = countOccurrences(content, marker.closing);
  if (openingCount !== 1 || closingCount !== 1) {
    throw new WorklogIntegrityError(
      `packet for ${nodeId} #${attempt} must contain exactly its scaffolded ${marker.opening} marker ` +
        `(found ${openingCount} openings, ${closingCount} closings)`,
    );
  }
}

/** Escape extra reserved marker openings/closings so only the authorized pair is live. */
export function escapeReservedMarkers(content: string, keep: { opening: string; closing: string }): string {
  // Pull the authorized pair out of the escaping pass with placeholders,
  // then escape every other reserved marker occurrence.
  const OPEN = "\u0000workshop-keep-open\u0000";
  const CLOSE = "\u0000workshop-keep-close\u0000";
  let out = content.replace(keep.opening, OPEN).replace(keep.closing, CLOSE);
  out = out
    .replaceAll("<workflow-output>", "\\<workflow-output>")
    .replaceAll("</workflow-output>", "\\</workflow-output>")
    .replace(/<next-node-output id="[^"]*">/g, (m) => `\\${m}`)
    .replaceAll("</next-node-output>", "\\</next-node-output>");
  return out.replaceAll(OPEN, keep.opening).replaceAll(CLOSE, keep.closing);
}

/** Pull the text inside a marker pair, trimmed. */
export function extractMarker(content: string, opening: string, closing: string): string {
  const start = content.indexOf(opening);
  if (start === -1) return "";
  const from = start + opening.length;
  const end = content.indexOf(closing, from);
  if (end === -1) return "";
  return content.slice(from, end).trim();
}

export function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export interface MergeReceipt {
  runId: string;
  nodeId: string;
  attempt: number;
  ownerToken: string;
  packetSha256: string;
  sectionSha256: string;
  mergedAt: string;
}

/**
 * Merge a validated packet into its worklog node section. Idempotent by
 * (run_id, node_id, attempt): an identical repeat is a no-op; the same key
 * with different digests is a worklog_integrity block. The caller must hold
 * the run lock and the finishing owner fence.
 */
export function mergePacket(input: {
  runDir: string;
  runId: string;
  nodeId: string;
  attempt: number;
  attemptFolder: string;
  successorId: string | null;
  ownerToken: string;
  now: Date;
}): MergeReceipt {
  const logPath = worklogPath(input.runDir);
  const packetFile = packetPath(input.attemptFolder);
  const receiptFile = receiptPath(input.attemptFolder);

  const packetSha = sha256File(packetFile);
  const existingReceipt = readReceipt(receiptFile);
  if (existingReceipt) {
    if (existingReceipt.packetSha256 === packetSha) {
      return existingReceipt; // idempotent repeat
    }
    throw new WorklogIntegrityError(
      `merge receipt for ${input.nodeId} #${input.attempt} exists with a different packet digest — ` +
        `earlier attempts are immutable evidence`,
    );
  }

  validatePacket(packetFile, input.nodeId, input.attempt, input.successorId);
  const packet = readFileSync(packetFile, "utf8");
  // Formatting drift tolerance: the merged attempt block always begins with
  // its attempt heading, even when the agent dropped it.
  const attemptHeading = `#### Attempt ${input.attempt}`;
  const normalized = packet.trimStart().startsWith(attemptHeading)
    ? packet
    : `${attemptHeading}\n\n${packet.trimStart()}`;
  const escaped = escapeReservedMarkers(normalized, authorizedMarker(input.successorId));

  const log = readFileSync(logPath, "utf8");
  const nodeHeading = `### Node: ${input.nodeId}`;
  const merged = insertAttemptSection(log, nodeHeading, escaped);

  atomicWriteFileSync(logPath, merged);

  const receipt: MergeReceipt = {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ownerToken: input.ownerToken,
    packetSha256: packetSha,
    sectionSha256: `sha256:${createHash("sha256").update(sectionFor(merged, nodeHeading)).digest("hex")}`,
    mergedAt: input.now.toISOString(),
  };
  mkdirSync(dirname(receiptFile), { recursive: true });
  atomicWriteFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

/** Verify (or idempotently create) the receipt during recovery. */
export function verifyMergeReceipt(attemptFolder: string): MergeReceipt | null {
  return readReceipt(receiptPath(attemptFolder));
}

function readReceipt(path: string): MergeReceipt | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MergeReceipt;
  } catch {
    throw new WorklogIntegrityError(`merge receipt at ${path} is not valid JSON`);
  }
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

function sectionFor(log: string, nodeHeading: string): string {
  const nodeIdx = log.indexOf(nodeHeading + "\n");
  if (nodeIdx === -1) return "";
  const rest = log.slice(nodeIdx);
  const nextHeading = /^#{2,3} /m.exec(rest.slice(nodeHeading.length + 1));
  const end = nextHeading ? nodeHeading.length + 1 + (nextHeading.index ?? 0) : log.length;
  return log.slice(nodeIdx, end);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Write + fsync + rename, so readers never see a partial file. */
export function atomicWriteFileSync(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
  return content;
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort on platforms that disallow it.
  }
}

/** The run-scoped write lock. O_EXCL create; stale takeover by pid liveness. */
export class RunLock {
  private path: string;
  constructor(runDir: string) {
    this.path = join(runDir, "lock");
  }

  async acquire(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.path, "wx");
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        this.takeoverIfStale();
        if (Date.now() > deadline) {
          throw new WorklogIntegrityError(`run lock at ${this.path} is held by another process`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  release(): void {
    try {
      // Only remove if we still own it.
      const content = readFileSync(this.path, "utf8");
      const holder = JSON.parse(content) as { pid: number };
      if (holder.pid === process.pid) rmSync(this.path);
    } catch {
      /* already gone */
    }
  }

  private takeoverIfStale(): void {
    try {
      const content = readFileSync(this.path, "utf8");
      const holder = JSON.parse(content) as { pid: number };
      try {
        process.kill(holder.pid, 0);
        return; // alive
      } catch {
        // Dead holder: take over.
        rmSync(this.path);
      }
    } catch {
      /* lock vanished */
    }
  }
}

/** Used to detect agent tampering with the worklog mid-attempt. */
export function worklogFingerprint(runDir: string): string {
  const p = worklogPath(runDir);
  const s = statSync(p);
  return sha256File(p) + `:${s.size}`;
}
