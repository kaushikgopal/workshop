import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { StreamCap } from "../../util/parse-units.js";

/** Head : tail split of the retained window. */
const HEAD_SHARE = 2 / 3;

export interface TruncationRecord {
  version: 1;
  capBytes: number;
  keptHeadBytes: number;
  keptTailBytes: number;
  totalBytes: number;
  truncatedAt: string;
}

/**
 * Cap one stream in place. Callers must have finished reading the file — the
 * command runner consumes stdout to build its packet and output, so capping
 * happens only once every reader is done. Returns null when the stream is
 * absent or already within the cap.
 */
export function capStream(file: string, cap: StreamCap, now: Date): TruncationRecord | null {
  if (cap === "unlimited" || !existsSync(file)) return null;
  const totalBytes = statSync(file).size;
  if (totalBytes <= cap) return null;

  const headTarget = Math.ceil(cap * HEAD_SHARE);
  const tailTarget = cap - headTarget;
  const body = readFileSync(file);
  const head = safeSlice(body, 0, headTarget);
  const tail = safeSlice(body, body.length - tailTarget, body.length);
  const notice = Buffer.from(
    `\n── [workshop: truncated ${totalBytes} bytes to ${head.length} head + ${tail.length} tail; the full stream was not retained] ──\n`,
    "utf8",
  );
  writeDurable(file, Buffer.concat([head, notice, tail]));

  const record: TruncationRecord = {
    version: 1,
    capBytes: cap,
    keptHeadBytes: head.length,
    keptTailBytes: tail.length,
    totalBytes,
    truncatedAt: now.toISOString(),
  };
  writeDurable(`${file}.truncation.json`, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  return record;
}
/** Metadata for a head/tail stream window; `retainedBytes` excludes presentation text. */
export interface RetainedStreamWindow {
  readonly totalBytes: number;
  readonly retainedBytes: number;
  readonly truncatedBytes: number;
  readonly keptHeadBytes: number;
  readonly keptTailBytes: number;
}

const safeByteCount = z.number().int().nonnegative().refine((value) => Number.isSafeInteger(value));
const retentionReceiptV1Schema = z.strictObject({
  version: z.literal(1),
  capBytes: safeByteCount.refine((value) => value > 0),
  totalBytes: safeByteCount,
  retainedBytes: safeByteCount,
  truncatedBytes: safeByteCount,
  keptHeadBytes: safeByteCount,
  keptTailBytes: safeByteCount,
  retainedSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).superRefine((receipt, context) => {
  if (receipt.totalBytes <= receipt.retainedBytes
    || receipt.retainedBytes > receipt.capBytes
    || receipt.truncatedBytes !== receipt.totalBytes - receipt.retainedBytes
    || receipt.keptHeadBytes + receipt.keptTailBytes !== receipt.retainedBytes) {
    context.addIssue({ code: "custom", message: "retention receipt byte counts are inconsistent" });
  }
});
type RetentionReceiptV1 = z.infer<typeof retentionReceiptV1Schema>;

export type VerifiedRetentionWindow = RetainedStreamWindow & { readonly retainedSha256: string };

/** Read-only recovery for a completed receipt; it never caps or rewrites the capture file. */
export function readVerifiedRetentionWindow(file: string, cap: StreamCap): VerifiedRetentionWindow | null {
  try {
    const receipt = readRetentionReceipt(file);
    if (receipt === null || cap === "unlimited" || cap !== receipt.capBytes) return null;
    const before = lstatSync(file);
    if (!before.isFile() || before.size !== receipt.retainedBytes) return null;
    const retainedSha256 = hashFileSync(file);
    const after = lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || retainedSha256 !== receipt.retainedSha256) return null;
    return { ...windowFromReceipt(receipt), retainedSha256 };
  } catch {
    return null;
  }
}

/**
 * Retain a bounded head/tail window after the writer has exited and semantic
 * output has been extracted. A durable receipt lets monitor, abort, and reopen
 * recover the original byte layout after the capture file has been replaced.
 */
export function retainStreamWindow(file: string, cap: StreamCap): RetainedStreamWindow {
  if (cap !== "unlimited" && (!Number.isSafeInteger(cap) || cap <= 0)) {
    throw new Error("stream cap must be a positive safe integer or unlimited");
  }

  const receipt = readRetentionReceipt(file);
  if (receipt !== null) {
    if (cap !== receipt.capBytes) throw new Error("stream cap differs from the persisted retention receipt");
    const currentBytes = statSync(file).size;
    if (currentBytes === receipt.retainedBytes && hashFileSync(file) === receipt.retainedSha256) {
      return windowFromReceipt(receipt);
    }
    if (currentBytes !== receipt.totalBytes) {
      throw new Error("stream file does not match its pending or retained retention receipt");
    }
    return retainRawStream(file, receipt.capBytes, receipt);
  }

  const totalBytes = statSync(file).size;
  if (cap === "unlimited" || totalBytes <= cap) {
    return { totalBytes, retainedBytes: totalBytes, truncatedBytes: 0, keptHeadBytes: totalBytes, keptTailBytes: 0 };
  }
  return retainRawStream(file, cap, null);
}

function retainRawStream(file: string, cap: number, pending: RetentionReceiptV1 | null): RetainedStreamWindow {
  const totalBytes = statSync(file).size;
  if (pending !== null && totalBytes !== pending.totalBytes) {
    throw new Error("raw stream size differs from its pending retention receipt");
  }
  const headTarget = Math.ceil(cap * HEAD_SHARE);
  const tailTarget = cap - headTarget;
  const headWindow = readRange(file, 0, Math.min(totalBytes, headTarget + 3));
  const head = safeSlice(headWindow, 0, headTarget);
  const tailStart = Math.max(0, totalBytes - tailTarget - 3);
  const tailWindow = readRange(file, tailStart, totalBytes - tailStart);
  const tailOffset = totalBytes - tailTarget - tailStart;
  const tail = safeSlice(tailWindow, tailOffset, tailWindow.length);
  const retained = Buffer.concat([head, tail]);
  const window: RetainedStreamWindow = {
    totalBytes,
    retainedBytes: retained.byteLength,
    truncatedBytes: totalBytes - retained.byteLength,
    keptHeadBytes: head.byteLength,
    keptTailBytes: tail.byteLength,
  };
  const newReceipt = retentionReceiptV1Schema.parse({
    version: 1,
    capBytes: cap,
    ...window,
    retainedSha256: hashBytes(retained),
  });
  if (pending === null) {
    writeDurable(`${file}.retention.json`, Buffer.from(`${JSON.stringify(newReceipt)}\n`, "utf8"));
    syncDirectory(dirname(file));
  } else if (newReceipt.retainedSha256 !== pending.retainedSha256
    || newReceipt.totalBytes !== pending.totalBytes
    || newReceipt.retainedBytes !== pending.retainedBytes
    || newReceipt.truncatedBytes !== pending.truncatedBytes
    || newReceipt.keptHeadBytes !== pending.keptHeadBytes
    || newReceipt.keptTailBytes !== pending.keptTailBytes) {
    throw new Error("raw stream does not reproduce its pending retention receipt");
  }
  writeDurable(file, retained);
  syncDirectory(dirname(file));
  return window;
}

function readRetentionReceipt(file: string): RetentionReceiptV1 | null {
  const receiptPath = `${file}.retention.json`;
  if (!existsSync(receiptPath)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    throw new Error("stream retention receipt is unreadable");
  }
  const parsed = retentionReceiptV1Schema.safeParse(value);
  if (!parsed.success) throw new Error("stream retention receipt is invalid");
  return parsed.data;
}

function windowFromReceipt(receipt: RetentionReceiptV1): RetainedStreamWindow {
  return {
    totalBytes: receipt.totalBytes,
    retainedBytes: receipt.retainedBytes,
    truncatedBytes: receipt.truncatedBytes,
    keptHeadBytes: receipt.keptHeadBytes,
    keptTailBytes: receipt.keptTailBytes,
  };
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashFileSync(file: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  const fd = openSync(file, "r");
  try {
    let position = 0;
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}



/** Cap several streams at once; absent streams are ignored. */
export function capStreams(files: readonly string[], cap: StreamCap, now: Date): TruncationRecord | null {
  let last: TruncationRecord | null = null;
  for (const file of files) last = capStream(file, cap, now) ?? last;
  return last;
}

/** Read a stream's truncation sidecar. Absent or unreadable means uncapped. */
export function readTruncationRecord(file: string): TruncationRecord | null {
  const sidecar = `${file}.truncation.json`;
  if (!existsSync(sidecar)) return null;
  try {
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as TruncationRecord;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Slice bytes without splitting a UTF-8 sequence, so a capped stream never
 * gains a replacement character at either seam.
 */
function readRange(file: string, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset);
      if (read === 0) throw new Error("stream changed while retaining its head/tail window");
      offset += read;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function safeSlice(body: Buffer, start: number, end: number): Buffer {
  let from = start;
  let to = end;
  while (from < to && (body[from]! & 0xc0) === 0x80) from++;
  while (to > from && to < body.length && (body[to]! & 0xc0) === 0x80) to--;
  return body.subarray(from, to);
}

/** Temp file + rename + fsync: a crash never leaves a half-written stream. */
function writeDurable(file: string, bytes: Buffer): void {
  const temp = `${file}.retention-tmp`;
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}
