import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { raceDeadline, spawnTracked, type TrackedProcess } from "../src/process/launch-process.js";
import { captureProcessRecords, recoverProcessCaptureRecords } from "../src/storage/durable/define-process-execution-task.js";
import { retainStreamWindow } from "../src/storage/disk/cap-streams.js";
import { processStdioWriteSchema } from "../src/process/schema.js";

function spawnInputProcess(
  directory: string,
  command: string,
  inputBytes: Uint8Array,
  signal?: AbortSignal,
): TrackedProcess {
  return spawnTracked({
    shell: "/bin/bash",
    command,
    cwd: directory,
    env: { BASH_ENV: "/dev/null", HOME: directory },
    stdoutFile: join(directory, "stdout"),
    stderrFile: join(directory, "stderr"),
    inputBytes,
    ...(signal === undefined ? {} : { signal }),
  });
}

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
  test("does not source login dotfiles and resolves commands from its configured PATH", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-shell-startup-"));
    let child: TrackedProcess | undefined;
    try {
      const home = join(directory, "home");
      const bin = join(directory, "bin");
      const profileBin = join(directory, "profile-bin");
      const marker = join(directory, "profile-sourced");
      const stdoutPath = join(directory, "stdout");
      const stderrPath = join(directory, "stderr");
      mkdirSync(home);
      mkdirSync(bin);
      mkdirSync(profileBin);
      writeFileSync(join(home, ".bash_profile"), "printf sourced > '" + marker + "'; printf 'profile stderr\n' >&2; export PATH='" + profileBin + "'\n");
      writeFileSync(join(home, ".profile"), "printf sourced > '" + marker + "'\n");
      writeFileSync(join(bin, "path-probe"), "#!/bin/sh\nprintf path-ok\n");
      chmodSync(join(bin, "path-probe"), 0o755);

      child = spawnTracked({
        shell: "/bin/bash",
        command: "path-probe",
        cwd: directory,
        env: { HOME: home, PATH: bin, BASH_ENV: "" },
        stdoutFile: stdoutPath,
        stderrFile: stderrPath,
      });
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(readFileSync(stdoutPath, "utf8")).toBe("path-ok");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
        command: "{ printf 'HEAD'; head -c 992 /dev/zero | tr '\\000' x; printf 'TAIL'; } >&2",
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
      expect(statSync(stderrPath).size).toBe(100);
      const abortCaptures = await captureProcessRecords(input, finished.captures, { bestEffort: true });
      resumeHash();
      const monitorCaptures = await monitorCapture;

      const expected = {
        stream: "stderr",
        totalBytes: 1000,
        retainedBytes: 100,
        truncatedBytes: 900,
        keptHeadBytes: 67,
        keptTailBytes: 33,
        complete: false,
      };
      expect(abortCaptures[1]).toMatchObject(expected);
      expect(monitorCaptures[1]).toMatchObject(expected);

      const reopenedCaptures = await recoverProcessCaptureRecords(input);
      expect(reopenedCaptures[1]).toMatchObject(expected);
      expect(readFileSync(stderrPath, "utf8")).toBe(`HEAD${"x".repeat(92)}TAIL`);
      expect(reopenedCaptures[1]?.sha256).toBe(`sha256:${createHash("sha256").update(readFileSync(stderrPath)).digest("hex")}`);
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

describe("subprocess stdin transport", () => {
  test("delivers input through EOF and reports a schema-valid outcome", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-eof-"));
    let child: TrackedProcess | undefined;
    try {
      const inputBytes = Buffer.from("input through eof");
      child = spawnInputProcess(directory, "data=$(cat); printf '<%s>' \"$data\"", inputBytes);
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(readFileSync(join(directory, "stdout"), "utf8")).toBe("<input through eof>");
      expect(processStdioWriteSchema.parse(child.writeOutcome())).toEqual({ kind: "finished", queuedBytes: inputBytes.byteLength });
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("exits promptly when the command ignores a large input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-ignored-"));
    let child: TrackedProcess | undefined;
    try {
      child = spawnInputProcess(directory, "printf ignored", Buffer.alloc(8 * 1024 * 1024));
      const startedAt = Date.now();
      const result = await settle(child);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.exit.code).toBe(0);
      expect(readFileSync(join(directory, "stdout"), "utf8")).toBe("ignored");
      expect(child.writeOutcome().kind).toBe("early_closed");
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("records an early stdin close while the process stays alive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-close-"));
    let child: TrackedProcess | undefined;
    try {
      child = spawnInputProcess(directory, "exec 0<&-; sleep 0.15; printf alive", Buffer.alloc(1024 * 1024));
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(readFileSync(join(directory, "stdout"), "utf8")).toBe("alive");
      expect(child.writeOutcome()).toMatchObject({ kind: "early_closed" });
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("treats EPIPE as evidence without an unhandled rejection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-epipe-"));
    let child: TrackedProcess | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      child = spawnInputProcess(directory, "exec 0<&-; sleep 0.15; printf alive", Buffer.alloc(1024 * 1024));
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      const outcome = child.writeOutcome();
      expect(outcome.kind).toBe("early_closed");
      if (outcome.kind === "early_closed") {
        expect(outcome.queuedBytes).toBeGreaterThan(0);
        expect(outcome.diagnosticCode).toBe("EPIPE");
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for a slow reader under backpressure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-slow-"));
    let child: TrackedProcess | undefined;
    try {
      const inputBytes = Buffer.alloc(512 * 1024, 0x61);
      child = spawnInputProcess(directory, "sleep 0.1; wc -c", inputBytes);
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(Number(readFileSync(join(directory, "stdout"), "utf8").trim())).toBe(inputBytes.byteLength);
      expect(child.writeOutcome()).toEqual({ kind: "finished", queuedBytes: inputBytes.byteLength });
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("streams input larger than pipe capacity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-large-"));
    let child: TrackedProcess | undefined;
    try {
      const inputBytes = Buffer.alloc(8 * 1024 * 1024, 0x62);
      child = spawnInputProcess(directory, "wc -c", inputBytes);
      const result = await settle(child);
      expect(result.exit.code).toBe(0);
      expect(Number(readFileSync(join(directory, "stdout"), "utf8").trim())).toBe(inputBytes.byteLength);
      expect(child.writeOutcome()).toEqual({ kind: "finished", queuedBytes: inputBytes.byteLength });
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancels a blocked writer when its deadline expires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-timeout-"));
    let child: TrackedProcess | undefined;
    try {
      child = spawnInputProcess(directory, "sleep 10", Buffer.alloc(8 * 1024 * 1024));
      expect(await raceDeadline(child, 50)).toEqual({ kind: "timeout" });
      expect(child.writeOutcome().kind).toBe("cancelled");
      expect(await child.kill()).toBe(true);
      await child.streamsClosed;
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancels a blocked writer when its abort signal fires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-process-stdin-abort-"));
    let child: TrackedProcess | undefined;
    const controller = new AbortController();
    try {
      child = spawnInputProcess(directory, "sleep 10", Buffer.alloc(8 * 1024 * 1024), controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const outcome = child.writeOutcome();
      expect(outcome.kind).toBe("cancelled");
      if (outcome.kind === "cancelled") {
        expect(outcome.queuedBytes).toBeGreaterThan(0);
        expect(outcome.diagnosticCode).toBe("ABORTED");
      }
      expect(await child.kill()).toBe(true);
      await child.streamsClosed;
    } finally {
      if (child !== undefined) await child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
