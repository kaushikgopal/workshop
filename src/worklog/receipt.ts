import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./fs.js";
import { renderMarkedPacketBlock, type MarkedBlock } from "./markers.js";
import { WorklogIntegrityError, sha256String } from "./worklog.js";

export function receiptPath(attemptFolder: string): string {
  return join(attemptFolder, "merge-receipt.json");
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

/** Reconcile one existing marked block with its receipt, or lack thereof. */
export function reconcileMarkedBlock(
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
