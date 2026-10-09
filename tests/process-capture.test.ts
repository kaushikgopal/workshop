import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { raceDeadline, spawnTracked, type TrackedProcess } from "../src/process/launch-process.js";
import { captureProcessRecords, recoverProcessCaptureRecords } from "../src/storage/durable/define-process-execution-task.js";
import { retainStreamWindow } from "../src/storage/disk/cap-streams.js";

async function settle(process: TrackedProcess) {
  const raced = await raceDeadline(process, 5_000);
  if (raced.kind === "timeout") {
    await process.kill();
    throw new Error("subprocess exceeded its test deadline");
  }
  const groupDead = await process.kill();
  await process.streamsClosed;
  return { exit: raced.exit, groupDead, captures: process.captures() };
}

describe("bounded subprocess capture", () => {
  test("retains the stdout prefix, records overflow, and retires the process group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdout-"));
    let child: TrackedProcess | undefined;
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      child = spawnTracked({
        shell: "/bin/bash",
        command: "printf '0123456789%.0s' {1..100000}",
        cwd: directory,
        env: { BASH_ENV: "/dev/null", HOME: directory },
        stdoutFile: stdoutPath,
        stderrFile: stderrPath,
        stdoutLogCapBytes: 32,
        stderrLogCapBytes: 32,
        semanticStdoutLimitBytes: 32,
      });
      const result = await settle(child);
      expect(result.groupDead).toBe(true);
      expect(result.exit.code === null || result.exit.code !== 0).toBe(true);
      expect(result.captures.stdout.limitExceeded).toBe(true);
      expect(result.captures.stdout.retainedBytes).toBe(32);
      expect(result.captures.stdout.truncatedBytes).toBe(result.captures.stdout.totalBytes - 32);
      expect(readFileSync(stdoutPath, "utf8")).toHaveLength(32);
      const semantic = child.semanticStdout();
      expect(semantic?.tooLarge).toBe(true);
      expect(semantic?.sha256).toBeNull();
      expect(semantic?.totalBytes).toBeGreaterThan(32);
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds stderr independently while keeping stdout exact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stderr-"));
    let child: TrackedProcess | undefined;
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      child = spawnTracked({
        shell: "/bin/bash",
        command: "printf 'exact stdout'; printf '0123456789' >&2",
        cwd: directory,
        env: { BASH_ENV: "/dev/null", HOME: directory },
        stdoutFile: stdoutPath,
        stderrFile: stderrPath,
        stdoutLogCapBytes: 4,
        stderrLogCapBytes: 4,
        semanticStdoutLimitBytes: 64,
      });
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(result.groupDead).toBe(true);
      expect(readFileSync(stdoutPath, "utf8")).toBe("exac");
      expect(result.captures.stdout.retainedBytes).toBe(4);
      expect(result.captures.stdout.truncatedBytes).toBe(8);
      expect(result.captures.stdout.limitExceeded).toBe(true);
      expect(result.captures.stderr.retainedBytes).toBe(4);
      expect(result.captures.stderr.limitExceeded).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("0123");
      const semantic = child.semanticStdout();
      if (semantic === null) throw new Error("semantic stdout capture is missing");
      expect(semantic.tooLarge).toBe(false);
      expect(semantic.bytes.toString("utf8")).toBe("exact stdout");
      expect(semantic.totalBytes).toBe(Buffer.byteLength("exact stdout"));
      expect(semantic.sha256).toBe(`sha256:${createHash("sha256").update("exact stdout").digest("hex")}`);
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps the live file complete and caps it after semantic capture and group retirement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-window-"));
    let child: TrackedProcess | undefined;
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      const expected = `HEAD${"x".repeat(4096)}TAIL`;
      child = spawnTracked({
        shell: "/bin/bash",
        command: "printf HEAD; head -c 4096 /dev/zero | tr '\\000' x; printf TAIL; sleep 5",
        cwd: directory,
        env: { BASH_ENV: "/dev/null", HOME: directory },
        stdoutFile: stdoutPath,
        stderrFile: stderrPath,
        semanticStdoutLimitBytes: 8192,
      });
      const deadline = Date.now() + 5_000;
      while (child.captures().stdout.totalBytes < Buffer.byteLength(expected) && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(child.captures().stdout.totalBytes).toBe(Buffer.byteLength(expected));
      expect(statSync(stdoutPath).size).toBe(Buffer.byteLength(expected));
      expect(await child.kill()).toBe(true);
      await child.streamsClosed;
      const semantic = child.semanticStdout();
      if (semantic === null) throw new Error("semantic stdout capture is missing");
      expect(semantic.tooLarge).toBe(false);
      expect(semantic.bytes.toString("utf8")).toBe(expected);
      expect(retainStreamWindow(stdoutPath, 12)).toEqual({
        totalBytes: Buffer.byteLength(expected),
        retainedBytes: 12,
        truncatedBytes: Buffer.byteLength(expected) - 12,
        keptHeadBytes: 8,
        keptTailBytes: 4,
      });
      expect(readFileSync(stdoutPath, "utf8")).toBe("HEADxxxxTAIL");
    } finally {
      if (child !== undefined) {
        await child.kill();
        await child.streamsClosed;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves original retention evidence across monitor/abort overlap and recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-retention-reentry-"));
    let child: TrackedProcess | undefined;
    let resumeHash: () => void = () => {};
    let markHashStarted: () => void = () => {};
    const hashGate = new Promise<void>((resolve) => { resumeHash = resolve; });
    const hashStarted = new Promise<void>((resolve) => { markHashStarted = resolve; });
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      child = spawnTracked({
        shell: "/bin/bash",
        command: "printf 'HEAD'; head -c 992 /dev/zero | tr '\\000' x; printf 'TAIL'",
        cwd: directory,
        env: { BASH_ENV: "/dev/null", HOME: directory },
        stdoutFile: stdoutPath,
        stderrFile: stderrPath,
        semanticStdoutLimitBytes: 2048,
      });
      const finished = await settle(child);
      const input = { stdoutPath, stderrPath, streamCapBytes: 100 };
      let firstHash = true;
      const monitorCapture = captureProcessRecords(input, finished.captures, {
        hashFile: async (path) => {
          if (firstHash) {
            firstHash = false;
            markHashStarted();
            await hashGate;
          }
          return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
        },
      });
      await hashStarted;
      expect(statSync(stdoutPath).size).toBe(100);
      const abortCaptures = await captureProcessRecords(input, finished.captures, { bestEffort: true });
      resumeHash();
      const monitorCaptures = await monitorCapture;

      const expected = {
        stream: "stdout",
        totalBytes: 1000,
        retainedBytes: 100,
        truncatedBytes: 900,
        keptHeadBytes: 67,
        keptTailBytes: 33,
        complete: false,
      };
      expect(abortCaptures[0]).toMatchObject(expected);
      expect(monitorCaptures[0]).toMatchObject(expected);

      const reopenedCaptures = await recoverProcessCaptureRecords(input);
      expect(reopenedCaptures[0]).toMatchObject(expected);
      expect(readFileSync(stdoutPath, "utf8")).toBe(`HEAD${"x".repeat(92)}TAIL`);
      expect(reopenedCaptures[0]?.sha256).toBe(`sha256:${createHash("sha256").update(readFileSync(stdoutPath)).digest("hex")}`);
    } finally {
      resumeHash();
      if (child !== undefined) {
        await child.kill();
        await child.streamsClosed;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps direct-to-file capture when no byte limit is supplied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-direct-"));
    let child: TrackedProcess | undefined;
    try {
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      child = spawnTracked({
        shell: "/bin/bash",
        command: "printf 'stdout'; printf 'stderr' >&2",
        cwd: directory,
        env: { BASH_ENV: "/dev/null", HOME: directory },
        stdoutFile: stdoutPath,
        stderrFile: stderrPath,
      });
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(result.groupDead).toBe(true);
      expect(readFileSync(stdoutPath, "utf8")).toBe("stdout");
      expect(readFileSync(stderrPath, "utf8")).toBe("stderr");
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
