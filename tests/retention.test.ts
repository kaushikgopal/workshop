import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerifiedRetentionWindow, retainStreamWindow } from "../src/storage/disk/cap-streams.js";
import { parseByteSize } from "../src/util/parse-units.js";

// ---------------------------------------------------------------------------
// Cap parsing
// ---------------------------------------------------------------------------

describe("retention — cap parsing", () => {
  test("bytes, kb, mb, and the explicit opt-out", () => {
    expect(parseByteSize("512")).toBe(512);
    expect(parseByteSize("1kb")).toBe(1024);
    expect(parseByteSize("2mb")).toBe(2 * 1024 * 1024);
    expect(parseByteSize("unlimited")).toBe("unlimited");
  });
});

describe("Durable retention windows", () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), "workshop-retained-window-"));

  test("retains head and tail metadata without splitting UTF-8", () => {
    const file = join(scratch(), "stdout");
    writeFileSync(file, "αbcδε", "utf8");
    expect(retainStreamWindow(file, 6)).toEqual({
      totalBytes: 8,
      retainedBytes: 6,
      truncatedBytes: 2,
      keptHeadBytes: 4,
      keptTailBytes: 2,
    });
    const retained = readFileSync(file);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(retained)).toBe("αbcε");
    expect(retained.byteLength).toBe(6);
    expect(retainStreamWindow(file, 6)).toEqual({
      totalBytes: 8,
      retainedBytes: 6,
      truncatedBytes: 2,
      keptHeadBytes: 4,
      keptTailBytes: 2,
    });
  });

  test("completes a receipt persisted before a crash left the raw stream in place", () => {
    const directory = scratch();
    const rawFile = join(directory, "raw");
    const receiptSource = join(directory, "receipt-source");
    const original = Buffer.from(`HEAD${"x".repeat(992)}TAIL`);
    writeFileSync(rawFile, original);
    writeFileSync(receiptSource, original);
    const expected = retainStreamWindow(receiptSource, 100);
    writeFileSync(`${rawFile}.retention.json`, readFileSync(`${receiptSource}.retention.json`));

    expect(retainStreamWindow(rawFile, 100)).toEqual(expected);
    expect(readFileSync(rawFile)).toEqual(readFileSync(receiptSource));
  });

  test("verifies a committed retained receipt without rewriting the capture", () => {
    const file = join(scratch(), "stdout");
    writeFileSync(file, Buffer.from(`HEAD${"x".repeat(992)}TAIL`));
    const window = retainStreamWindow(file, 100);
    const retained = readFileSync(file);
    const receipt = JSON.parse(readFileSync(`${file}.retention.json`, "utf8")) as { retainedSha256: string };

    expect(readVerifiedRetentionWindow(file, 100)).toEqual({ ...window, retainedSha256: receipt.retainedSha256 });
    expect(readFileSync(file)).toEqual(retained);
    expect(readVerifiedRetentionWindow(file, 101)).toBeNull();
    writeFileSync(file, "tampered");
    expect(readVerifiedRetentionWindow(file, 100)).toBeNull();
  });

  test("unlimited keeps the complete file as the head", () => {
    const file = join(scratch(), "stdout");
    const original = Buffer.from("complete diagnostic output");
    writeFileSync(file, original);
    expect(retainStreamWindow(file, "unlimited")).toEqual({
      totalBytes: original.byteLength,
      retainedBytes: original.byteLength,
      truncatedBytes: 0,
      keptHeadBytes: original.byteLength,
      keptTailBytes: 0,
    });
    expect(readFileSync(file)).toEqual(original);
  });
});
