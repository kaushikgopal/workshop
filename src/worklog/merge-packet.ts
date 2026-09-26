import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../storage/disk/write-crash-safe.js";
import { mergeMarkers, renderMarkedPacketBlock, type MarkedBlock, type MergeMarkerKey } from "./apply-marker-rules.js";
import {
  insertAttemptSection,
  sectionFor,
} from "./edit-sections.js";
import { WorklogIntegrityError } from "./detect-tampering.js";
import { sha256String } from "../util/hash-content.js";
import { sha256File } from "../util/hash-content.js";
import { locatePacket } from "../storage/disk/locate-run-files.js";
import { locateWorklog } from "../storage/disk/locate-run-files.js";
import { receiptPath, reconcileMarkedBlock, verifyMergeReceipt, type MergeReceipt, type MergeReceiptV2 } from "./verify-merge-receipt.js";

/**
 * Parse every runtime merge marker pair in the worklog. Any live marker
 * occurrence that is not a well-formed pair is an integrity violation:
 * packets cannot mint markers (they are escaped), so only the runtime or
 * tampering can put them there.
 */
function scanMarkedBlocks(log: string): MarkedBlock[] {
  const blocks: MarkedBlock[] = [];
  const beginRe = /(?<!\\)<!-- workshop:merge begin run=(\S+) node=(\S+) attempt=(\d+) packet=(sha256:[0-9a-f]{64}) -->/g;
  let match: RegExpExecArray | null;
  while ((match = beginRe.exec(log)) !== null) {
    const key: MergeMarkerKey = {
      runId: match[1]!,
      nodeId: match[2]!,
      attempt: Number(match[3]!),
      packetSha256: match[4]!,
    };
    const { end } = mergeMarkers(key);
    const endIdx = indexOfUnescaped(log, end, match.index + match[0].length);
    if (endIdx === -1) {
      throw new WorklogIntegrityError(
        `worklog has a runtime merge marker for ${key.runId}/${key.nodeId} #${key.attempt} without its closing marker`,
      );
    }
    blocks.push({
      key,
      beginIdx: match.index,
      endIdx,
      endLength: end.length,
      block: log.slice(match.index, endIdx + end.length),
    });
  }
  const paired = new Set(blocks.flatMap((b) => [b.beginIdx, b.endIdx]));
  let idx = log.indexOf("<!-- workshop:merge");
  while (idx !== -1) {
    if (!paired.has(idx) && log[idx - 1] !== "\\") {
      throw new WorklogIntegrityError(`worklog contains a malformed runtime merge marker at offset ${idx}`);
    }
    idx = log.indexOf("<!-- workshop:merge", idx + 1);
  }
  return blocks;
}

function indexOfUnescaped(content: string, needle: string, from: number): number {
  let at = content.indexOf(needle, from);
  while (at !== -1 && content[at - 1] === "\\") at = content.indexOf(needle, at + 1);
  return at;
}

/**
 * A pre-marker merge (or its crash window) left an attempt block without
 * runtime markers or a usable receipt. That evidence is unresolved: fail
 * closed instead of publishing a duplicate.
 */
function assertNoUnmarkedLegacyAttemptBlock(
  log: string,
  blocks: MarkedBlock[],
  nodeId: string,
  attempt: number,
): void {
  const excised = exciseMarkedBlocks(log, blocks);
  const section = sectionFor(excised, `### Node: ${nodeId}`);
  if (section === "") return;
  if (new RegExp(`^#### Attempt ${attempt}[ \t]*$`, "m").test(section)) {
    throw new WorklogIntegrityError(
      `worklog already holds an unmarked attempt block for ${nodeId} #${attempt} — a pre-marker merge never ` +
        `finalized its receipt, so the evidence is unresolved and must not be duplicated`,
    );
  }
}

function exciseMarkedBlocks(log: string, blocks: MarkedBlock[]): string {
  let out = log;
  for (const b of [...blocks].sort((x, y) => y.beginIdx - x.beginIdx)) {
    out = out.slice(0, b.beginIdx) + out.slice(b.endIdx + b.endLength);
  }
  return out;
}

/**
 * Merge a validated packet into its worklog node section. Idempotent by
 * (run_id, node_id, attempt). The runtime publishes the packet inside
 * deterministic begin/end markers keyed by the merge key and the current
 * packet digest, then records a v2 receipt that hashes the exact marked
 * block. The caller must hold the run lock.
 *
 * Reconciliation treats crash windows as first-class:
 * - marked block present, no receipt → verify the block, synthesize the receipt;
 * - marked block + matching v2 receipt → strict shape/identity/digest
 *   verification plus marked-block verification, then a no-op;
 * - marked block + legacy v1 receipt → v1 is never safe new finishing
 *   evidence; synthesize v2 from the verified block;
 * - same merge key with a different packet digest, duplicate blocks,
 *   malformed markers, or a receipt whose block is missing → worklog_integrity;
 * - no marker and no receipt → insert once.
 * An unmarked legacy attempt block (a pre-marker merge that never finalized)
 * fails closed instead of being duplicated.
 */
export function mergePacket(input: {
  runDir: string;
  runId: string;
  nodeId: string;
  attempt: number;
  attemptFolder: string;
  successorId: string | null;
  now: Date;
}): MergeReceipt {
  const logPath = locateWorklog(input.runDir);
  const packetFile = locatePacket(input.attemptFolder);
  const receiptFile = receiptPath(input.attemptFolder);
  const identity = { runId: input.runId, nodeId: input.nodeId, attempt: input.attempt };

  const packetSha = sha256File(packetFile);
  const log = readFileSync(logPath, "utf8");
  const blocks = scanMarkedBlocks(log);
  const mine = blocks.filter(
    (b) => b.key.runId === identity.runId && b.key.nodeId === identity.nodeId && b.key.attempt === identity.attempt,
  );
  assertNoUnmarkedLegacyAttemptBlock(log, blocks, input.nodeId, input.attempt);

  if (mine.length > 1) {
    throw new WorklogIntegrityError(
      `worklog holds ${mine.length} marked merge blocks for ${input.nodeId} #${input.attempt} — ` +
        `duplicate merges are an integrity violation`,
    );
  }

  if (mine.length === 1) {
    return reconcileMarkedBlock(input, mine[0]!, packetSha);
  }

  const existingReceipt = verifyMergeReceipt(input.attemptFolder, identity);
  if (existingReceipt) {
    throw new WorklogIntegrityError(
      `merge receipt for ${input.nodeId} #${input.attempt} exists but its marked block is missing from ` +
        `the worklog — published evidence was lost`,
    );
  }
  const blockSpan = renderMarkedPacketBlock(input, packetSha);
  const merged = insertAttemptSection(log, `### Node: ${input.nodeId}`, `${blockSpan}\n`);

  atomicWriteFileSync(logPath, merged);

  const receipt: MergeReceiptV2 = {
    version: 2,
    ...identity,
    packetSha256: packetSha,
    blockSha256: sha256String(blockSpan),
    mergedAt: input.now.toISOString(),
  };
  atomicWriteFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
