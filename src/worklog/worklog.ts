import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** Scaffold one attempt, creating missing pristine evidence without overwrite. */
export function scaffoldPacket(
  attemptFolder: string,
  attempt: number,
  successorId: string | null,
): string {
  const marker = authorizedMarker(successorId);
  const path = packetPath(attemptFolder);
  const content = packetTemplate(attempt, marker);
  ensurePristineFile(path, content);
  return content;
}

export interface PacketCheck {
  ok: true;
}

/**
 * The live structural marker pair. Only lines whose trimmed content is
 * exactly the authorized marker are structural delimiters — a packet may
 * quote the literal marker text inside ordinary prose (the first real
 * Hemingway packet did), and quoted prose must never count as structure.
 * A live pair is exactly one standalone opening line strictly before
 * exactly one standalone closing line; anything else fails closed.
 */
function markerPair(
  content: string,
  marker: { opening: string; closing: string },
): { live: true; openingLine: number; closingLine: number } | { live: false; openings: number; closings: number } {
  const openings: number[] = [];
  const closings: number[] = [];
  for (const [line, text] of content.split("\n").entries()) {
    const trimmed = text.trim();
    if (trimmed === marker.opening) openings.push(line);
    else if (trimmed === marker.closing) closings.push(line);
  }
  if (openings.length === 1 && closings.length === 1 && openings[0]! < closings[0]!) {
    return { live: true, openingLine: openings[0]!, closingLine: closings[0]! };
  }
  return { live: false, openings: openings.length, closings: closings.length };
}

/**
 * Validate a finished packet before merge. Ownership is the gate:
 * - exactly one standalone authorized opening line whose closing line
 *   follows it (spec §8); marker text quoted in prose never counts;
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

  const pair = markerPair(content, marker);
  if (!pair.live) {
    throw new WorklogIntegrityError(
      `packet for ${nodeId} #${attempt} must contain exactly one standalone ${marker.opening} marker ` +
        `followed by its ${marker.closing} closing line ` +
        `(found ${pair.openings} standalone openings, ${pair.closings} standalone closings)`,
    );
  }
}

/**
 * Escape every reserved marker occurrence except the one live standalone
 * authorized pair, whose lines survive verbatim: prose may quote markers,
 * unauthorized marker lines may exist, but only the structural pair may
 * stay live after a merge.
 */
export function escapeReservedMarkers(content: string, keep: { opening: string; closing: string }): string {
  const pair = markerPair(content, keep);
  const liveLines = pair.live ? new Set([pair.openingLine, pair.closingLine]) : new Set<number>();
  return content
    .split("\n")
    .map((line, i) => (liveLines.has(i) ? line : escapeReservedMarkerLine(line)))
    .join("\n");
}

/** Escape every reserved marker occurrence on one non-structural line. */
function escapeReservedMarkerLine(line: string): string {
  return line
    .replaceAll("<workflow-output>", "\\<workflow-output>")
    .replaceAll("</workflow-output>", "\\</workflow-output>")
    .replace(/<next-node-output id="[^"]*">/g, (m) => `\\${m}`)
    .replaceAll("</next-node-output>", "\\</next-node-output>")
    // Runtime merge and decision markers: packet prose must never mint a live
    // one, or a quoted marker would corrupt the merged log's marker counts.
    .replace(/<!-- workshop:(?:merge|decision) (?:begin|end)/g, (m) => `\\${m}`);
}

/** Pull the text between the live standalone marker pair, trimmed. */
export function extractMarker(content: string, opening: string, closing: string): string {
  const pair = markerPair(content, { opening, closing });
  if (!pair.live) return "";
  const lines = content.split("\n");
  return lines.slice(pair.openingLine + 1, pair.closingLine).join("\n").trim();
}

export function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Content digest of an in-memory string, same format as sha256File. */
export function sha256String(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Merge receipts are versioned. V1 carried the owning owner token and a
 * whole-node section digest. V2 drops the token — ownership is SQLite's CAS
 * concern, never filesystem evidence — and instead hashes the exact marked
 * block the runtime published. V1 receipts still parse for compatibility,
 * but only a v2 receipt is safe new finishing evidence.
 */
export interface MergeReceiptV1 {
  runId: string;
  nodeId: string;
  attempt: number;
  ownerToken: string;
  packetSha256: string;
  sectionSha256: string;
  mergedAt: string;
}

export interface MergeReceiptV2 {
  version: 2;
  runId: string;
  nodeId: string;
  attempt: number;
  packetSha256: string;
  blockSha256: string;
  /** Optional v1-era provenance; never used as a completion gate. */
  sectionSha256?: string;
  mergedAt: string;
}

export type MergeReceipt = MergeReceiptV1 | MergeReceiptV2;

export function isV2MergeReceipt(receipt: MergeReceipt): receipt is MergeReceiptV2 {
  return "version" in receipt && receipt.version === 2;
}

/** The merge key the runtime's begin/end markers are deterministic in. */
export interface MergeMarkerKey {
  runId: string;
  nodeId: string;
  attempt: number;
  packetSha256: string;
}

/**
 * The runtime's publication markers: HTML comments (invisible in rendered
 * markdown) keyed by run/node/attempt and the exact packet digest at merge
 * time. Identical inputs always produce identical marker text.
 */
export function mergeMarkers(key: MergeMarkerKey): { begin: string; end: string } {
  const attrs = `run=${key.runId} node=${key.nodeId} attempt=${key.attempt} packet=${key.packetSha256}`;
  return {
    begin: `<!-- workshop:merge begin ${attrs} -->`,
    end: `<!-- workshop:merge end ${attrs} -->`,
  };
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
  const logPath = worklogPath(input.runDir);
  const packetFile = packetPath(input.attemptFolder);
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

/** Render the exact immutable marker-to-marker attempt publication block. */
function renderMarkedPacketBlock(input: {
  runId: string; nodeId: string; attempt: number; attemptFolder: string; successorId: string | null;
}, packetSha: string): string {
  const packetFile = packetPath(input.attemptFolder);
  validatePacket(packetFile, input.nodeId, input.attempt, input.successorId);
  const packet = readFileSync(packetFile, "utf8");
  const attemptHeading = `#### Attempt ${input.attempt}`;
  const normalized = packet.trimStart().startsWith(attemptHeading)
    ? packet
    : `${attemptHeading}\n\n${packet.trimStart()}`;
  const escaped = escapeReservedMarkers(normalized, authorizedMarker(input.successorId));
  const marker = mergeMarkers({
    runId: input.runId, nodeId: input.nodeId, attempt: input.attempt, packetSha256: packetSha,
  });
  const body = escaped.endsWith("\n") ? escaped : `${escaped}\n`;
  return `${marker.begin}\n${body}${marker.end}`;
}

/** One published marked block located in the worklog text. */
interface MarkedBlock {
  key: MergeMarkerKey;
  beginIdx: number;
  endIdx: number;
  endLength: number;
  block: string;
}

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

/** Reconcile one existing marked block with its receipt, or lack thereof. */
function reconcileMarkedBlock(
  input: {
    runId: string; nodeId: string; attempt: number; attemptFolder: string;
    successorId: string | null; now: Date;
  },
  block: MarkedBlock,
  packetSha: string,
): MergeReceiptV2 {
  if (block.key.packetSha256 !== packetSha) {
    throw new WorklogIntegrityError(
      `marked merge block for ${input.nodeId} #${input.attempt} records packet ${block.key.packetSha256}, ` +
        `but the packet now hashes ${packetSha} — earlier attempts are immutable evidence`,
    );
  }
  const expectedBlock = renderMarkedPacketBlock(input, packetSha);
  if (block.block !== expectedBlock) {
    throw new WorklogIntegrityError(
      `marked merge block for ${input.nodeId} #${input.attempt} does not match the exact current packet publication`,
    );
  }
  const blockSha = sha256String(block.block);
  const existing = verifyMergeReceipt(input.attemptFolder, {
    runId: input.runId, nodeId: input.nodeId, attempt: input.attempt,
  });
  if (existing && isV2MergeReceipt(existing)) {
    if (existing.packetSha256 !== packetSha || existing.blockSha256 !== blockSha) {
      throw new WorklogIntegrityError(
        `merge receipt for ${input.nodeId} #${input.attempt} does not match the worklog's marked block — ` +
          `recorded evidence is inconsistent`,
      );
    }
    return existing;
  }
  const synthesized: MergeReceiptV2 = {
    version: 2, runId: input.runId, nodeId: input.nodeId, attempt: input.attempt,
    packetSha256: packetSha, blockSha256: blockSha, mergedAt: input.now.toISOString(),
  };
  atomicWriteFileSync(receiptPath(input.attemptFolder), JSON.stringify(synthesized, null, 2) + "\n");
  return synthesized;
}

function isSha256(v: unknown): v is string {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
}

function isIsoTimestamp(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/**
 * Read one merge receipt, strictly validating its runtime shape and its
 * identity against the (run, node, attempt) merge key. A malformed or
 * foreign receipt is an integrity violation — never a trusted no-op.
 * Returns null when no receipt exists.
 *
 * V1 receipts parse for compatibility with pre-marker runs; they carry
 * owner tokens and a provenance-only whole-node digest, so callers must not
 * treat them as safe new finishing evidence (see isV2MergeReceipt).
 */
export function verifyMergeReceipt(
  attemptFolder: string,
  identity: { runId: string; nodeId: string; attempt: number },
): MergeReceipt | null {
  const path = receiptPath(attemptFolder);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new WorklogIntegrityError(`merge receipt at ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WorklogIntegrityError(`merge receipt at ${path} does not match the runtime receipt shape`);
  }
  const r = parsed as Record<string, unknown>;
  const receipt = r.version === 2 ? parseV2Receipt(r, path) : parseV1Receipt(r, path);
  if (receipt.runId !== identity.runId || receipt.nodeId !== identity.nodeId || receipt.attempt !== identity.attempt) {
    throw new WorklogIntegrityError(
      `merge receipt at ${path} identifies ${receipt.runId}/${receipt.nodeId} #${receipt.attempt}, ` +
        `expected ${identity.runId}/${identity.nodeId} #${identity.attempt}`,
    );
  }
  return receipt;
}

function parseV1Receipt(r: Record<string, unknown>, path: string): MergeReceiptV1 {
  if (!hasExactKeys(r, ["attempt", "mergedAt", "nodeId", "ownerToken", "packetSha256", "runId", "sectionSha256"]) ||
    typeof r.runId !== "string" ||
    r.runId === "" ||
    typeof r.nodeId !== "string" ||
    r.nodeId === "" ||
    typeof r.attempt !== "number" ||
    !Number.isInteger(r.attempt) ||
    typeof r.ownerToken !== "string" ||
    r.ownerToken === "" ||
    !isSha256(r.packetSha256) ||
    !isSha256(r.sectionSha256) ||
    !isIsoTimestamp(r.mergedAt)
  ) {
    throw new WorklogIntegrityError(`merge receipt at ${path} does not match the runtime receipt shape`);
  }
  return {
    runId: r.runId,
    nodeId: r.nodeId,
    attempt: r.attempt,
    ownerToken: r.ownerToken,
    packetSha256: r.packetSha256,
    sectionSha256: r.sectionSha256,
    mergedAt: r.mergedAt,
  };
}

function parseV2Receipt(r: Record<string, unknown>, path: string): MergeReceiptV2 {
  const baseKeys = ["attempt", "blockSha256", "mergedAt", "nodeId", "packetSha256", "runId", "version"];
  const knownShape = hasExactKeys(r, baseKeys) || hasExactKeys(r, [...baseKeys, "sectionSha256"]);
  if (!knownShape ||
    typeof r.runId !== "string" ||
    r.runId === "" ||
    typeof r.nodeId !== "string" ||
    r.nodeId === "" ||
    typeof r.attempt !== "number" ||
    !Number.isInteger(r.attempt) ||
    !isSha256(r.packetSha256) ||
    !isSha256(r.blockSha256) ||
    (r.sectionSha256 !== undefined && !isSha256(r.sectionSha256)) ||
    !isIsoTimestamp(r.mergedAt)
  ) {
    throw new WorklogIntegrityError(`merge receipt at ${path} does not match the runtime receipt shape`);
  }
  return {
    version: 2, runId: r.runId, nodeId: r.nodeId, attempt: r.attempt,
    packetSha256: r.packetSha256, blockSha256: r.blockSha256,
    ...(r.sectionSha256 === undefined ? {} : { sectionSha256: r.sectionSha256 }),
    mergedAt: r.mergedAt,
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
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
  // next.index is relative to the text after the heading line: make the
  // section end absolute before slicing, or early headings yield "".
  const end = nextHeading
    ? nodeIdx + nodeHeading.length + 1 + (nextHeading.index ?? 0)
    : log.length;
  return log.slice(nodeIdx, end);
}

/** Create missing pristine evidence; refuse any existing byte mismatch. */
export function ensurePristineFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.prepare-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path); // hard-link installation is atomic and never replaces
    fsyncDirectory(dirname(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    try { rmSync(tmp); } catch { /* crash debris is harmless */ }
  }
  if (readFileSync(path, "utf8") !== content) {
    throw new WorklogIntegrityError(`existing evidence at ${path} does not match its pristine scaffold`);
  }
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

/** Flush an externally written file without changing its bytes or inode. */
export function fsyncFileSync(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
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

  acquireSync(timeoutMs = 5000): void {
    const deadline = Date.now() + timeoutMs;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        const fd = openSync(this.path, "wx");
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        this.takeoverIfStale();
        if (Date.now() > deadline) {
          throw new WorklogIntegrityError(`run lock at ${this.path} is held by another process`);
        }
        Atomics.wait(wait, 0, 0, 10);
      }
    }
  }


  async acquire(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.path, "wx");
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
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
