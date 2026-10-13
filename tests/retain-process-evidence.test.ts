import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { processCaptureSchema, processIncarnationSchema } from "../src/process/schema.js";
import { readRetainedCapture } from "../src/process/read-retained-capture.js";
import { captureProcessRecords } from "../src/storage/durable/define-process-execution-task.js";
import { removeProcessCaptures } from "../src/storage/disk/remove-process-captures.js";
import { locateProcessFiles } from "../src/run/locate-run-files.js";

const hash = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const stats = (totalBytes: number) => ({ totalBytes, retainedBytes: totalBytes, truncatedBytes: 0, limitExceeded: false, error: null });

describe("retained process evidence", () => {
  test("retains the stdout envelope independently of stderr head and tail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-retain-evidence-"));
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      const stdout = Buffer.from("preamble\n<status>succeeded</status>\n<output>exact λ\n</output>\ntrailer");
      const stderr = Buffer.from("HEAD" + "x".repeat(80) + "TAIL");
      writeFileSync(stdoutPath, stdout);
      writeFileSync(stderrPath, stderr);
      const captures = await captureProcessRecords({ stdoutPath, stderrPath, streamCapBytes: 12 }, { stdout: stats(stdout.length), stderr: stats(stderr.length) });
      const output = captures[0]!;
      const diagnostic = captures[1]!;
      expect(Buffer.from(output.retained!.bytes, "base64")).toEqual(stdout);
      expect(output).toMatchObject({ complete: true, sha256: hash(stdout), truncatedBytes: 0, keptTailBytes: 0 });
      expect(readRetainedCapture(diagnostic)).toBe("HEADxxxxTAIL");
      expect(diagnostic).toMatchObject({ complete: false, retainedBytes: 12, truncatedBytes: stderr.length - 12, keptHeadBytes: 8, keptTailBytes: 4 });
      expect(diagnostic.sha256).toBe(hash(readFileSync(stderrPath)));
      expect(captures.map((capture) => capture.stream)).toEqual(["stdout", "stderr"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("retains only the first 1 MiB on overflow with a checked prefix digest and incomplete marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-retain-overflow-"));
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      const bytes = Buffer.alloc(1024 * 1024 + 50, 0xff);
      writeFileSync(stdoutPath, bytes);
      writeFileSync(stderrPath, Buffer.alloc(0));
      const [capture] = await captureProcessRecords({ stdoutPath, stderrPath, streamCapBytes: 12 }, { stdout: stats(bytes.length), stderr: stats(0) });
      expect(capture).toMatchObject({ totalBytes: bytes.length, retainedBytes: 1024 * 1024, truncatedBytes: 50, complete: false, keptTailBytes: 0 });
      expect(Buffer.from(capture!.retained!.bytes, "base64")).toEqual(bytes.subarray(0, 1024 * 1024));
      expect(capture!.sha256).toBe(hash(bytes.subarray(0, 1024 * 1024)));
      expect(readRetainedCapture(capture!)).toStartWith("[invalid UTF-8; base64 bytes]\n");
      expect(processCaptureSchema.parse(JSON.parse(JSON.stringify(capture)))).toEqual(capture!);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("checks base64 length and digest while historical records remain honest", () => {
    const bytes = Buffer.from([0xff, 0x00, 0xfe]);
    const capture = { stream: "stdout", path: "/tmp/historical.stdout", totalBytes: 3, retainedBytes: 3, truncatedBytes: 0,
      sha256: hash(bytes), complete: true, retained: { version: 1, encoding: "base64", bytes: bytes.toString("base64") } };
    const checked = processCaptureSchema.parse(capture);
    expect(readRetainedCapture(checked)).toBe("[invalid UTF-8; base64 bytes]\n/wD+");
    expect(() => processCaptureSchema.parse({ ...capture, retained: { ...capture.retained, bytes: "!not-base64" } })).toThrow();
    expect(() => processCaptureSchema.parse({ ...capture, retained: { ...capture.retained, bytes: Buffer.from("bad").toString("base64") } })).toThrow();
    const { retained: _retained, ...historical } = capture;
    expect(readRetainedCapture(processCaptureSchema.parse(historical))).toBeNull();
  });

  test("requires durable import, confirmed death, and replay-safe settlement before cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-capture-cleanup-"));
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      writeFileSync(stdoutPath, "retained");
      writeFileSync(stderrPath, "diagnostic");
      const captures = await captureProcessRecords({ stdoutPath, stderrPath, streamCapBytes: 256 }, { stdout: stats(8), stderr: stats(10) });
      const at = "2026-10-13T00:00:00.000Z";
      const process = processIncarnationSchema.parse({
        executionId: "execution", incarnationId: "incarnation", incarnationNumber: 1, role: "worker", status: "exited",
        replay: "never", commandHash: hash(Buffer.from("command")), launchIntentAt: at, startedAt: at, finishedAt: at,
        deadlineAt: null, identity: { pid: 123, pgid: 123, startIdentity: "identity", serviceBootId: "boot" },
        exit: { kind: "code", code: 0 }, cleanupState: "confirmed_dead", captures,
      });
      removeProcessCaptures(process, false);
      expect(existsSync(stdoutPath)).toBe(true);
      removeProcessCaptures({ ...process, status: "blocked", cleanupState: "unconfirmed" }, true);
      expect(existsSync(stdoutPath)).toBe(true);
      removeProcessCaptures({ ...process, captures: captures.map(({ retained: _retained, ...capture }) => capture) }, true);
      expect(existsSync(stdoutPath)).toBe(true);
      removeProcessCaptures(process, true);
      expect(existsSync(stdoutPath)).toBe(false);
      expect(existsSync(stderrPath)).toBe(false);
      expect(readRetainedCapture(captures[0]!)).toBe("retained");
      removeProcessCaptures(process, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("keeps temporary captures outside the readable folder and separates preflight executions", () => {
    const identity = { role: "preflight" as const, nodeId: null, attemptNumber: null, incarnationNumber: 1, executionId: "one" };
    const one = locateProcessFiles("/project/.workshop/runs/run-id", identity);
    const two = locateProcessFiles("/project/.workshop/runs/run-id", { ...identity, executionId: "two" });
    expect(one.stdoutPath).toBe("/project/.workshop/state/captures/run-id/preflight/one/preflight.stdout");
    expect(one.stdoutPath).not.toBe(two.stdoutPath);
    expect(one.resultsPath).toBe("/project/.workshop/runs/run-id/results.md");
  });
});

test("old verifier cleanup cannot delete a replacement verifier capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-verifier-captures-"));
  try {
    const runDirectory = join(directory, "runs", "run-id");
    const identity = { role: "validator" as const, nodeId: "work", attemptNumber: 1, incarnationNumber: 1, executionId: "old" };
    const old = locateProcessFiles(runDirectory, identity);
    const replacement = locateProcessFiles(runDirectory, { ...identity, executionId: "new" });
    mkdirSync(old.directory, { recursive: true });
    mkdirSync(replacement.directory, { recursive: true });
    writeFileSync(old.stdoutPath, "old");
    writeFileSync(old.stderrPath, "diagnostic");
    const captures = await captureProcessRecords({ ...old, streamCapBytes: 256 }, { stdout: stats(3), stderr: stats(10) });
    writeFileSync(replacement.stdoutPath, "replacement evidence");
    const at = "2026-10-13T00:00:00.000Z";
    const process = processIncarnationSchema.parse({
      executionId: "old", incarnationId: "incarnation", incarnationNumber: 1, role: "validator", status: "exited",
      replay: "safe", commandHash: hash(Buffer.from("command")), launchIntentAt: at, startedAt: at, finishedAt: at,
      deadlineAt: null, identity: { pid: 123, pgid: 123, startIdentity: "identity", serviceBootId: "boot" },
      exit: { kind: "code", code: 127 }, cleanupState: "confirmed_dead", captures,
    });
    removeProcessCaptures(process, true);
    expect(existsSync(old.stdoutPath)).toBe(false);
    expect(readFileSync(replacement.stdoutPath, "utf8")).toBe("replacement evidence");
    expect(old.stdoutPath).not.toBe(replacement.stdoutPath);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
