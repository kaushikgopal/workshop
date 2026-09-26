import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
