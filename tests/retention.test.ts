import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInstallation, readWorklog, runCli } from "./helpers.js";
import { findInstallation } from "../src/load-installation.js";
import { advanceChain } from "../src/run/advance-chain.js";
import { startWorkflow } from "../src/run/start-run.js";
import { loadAndValidateDefinition } from "../src/definition/load-definition.js";
import { openDb } from "../src/storage/db/open-and-migrate.js";
import { Store } from "../src/storage/db/store.js";
import { runtimeCliInvocation } from "../src/attempt/build-attempt-env.js";
import { capStream, readTruncationRecord, readVerifiedRetentionWindow, retainStreamWindow } from "../src/storage/disk/cap-streams.js";
import { parseByteSize } from "../src/util/parse-units.js";

// ---------------------------------------------------------------------------
// Cap parsing and one-stream truncation
// ---------------------------------------------------------------------------

describe("retention — cap parsing", () => {
  test("bytes, kb, mb, and the explicit opt-out", () => {
    expect(parseByteSize("512")).toBe(512);
    expect(parseByteSize("1kb")).toBe(1024);
    expect(parseByteSize("2mb")).toBe(2 * 1024 * 1024);
    expect(parseByteSize("unlimited")).toBe("unlimited");
  });
});

describe("retention — one stream", () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), "workshop-retention-"));

  test("a stream within its cap is left untouched, with no truncation record", () => {
    const file = join(scratch(), "stdout");
    writeFileSync(file, "small output\n", "utf8");
    expect(capStream(file, 4096, new Date())).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("small output\n");
    expect(readTruncationRecord(file)).toBeNull();
  });

  test("an oversized stream keeps head and tail and records what it dropped", () => {
    const file = join(scratch(), "stdout");
    const head = "H".repeat(3000);
    const middle = "M".repeat(20000);
    const tail = "T".repeat(3000);
    writeFileSync(file, `${head}${middle}${tail}`, "utf8");

    const record = capStream(file, 4096, new Date());
    expect(record).not.toBeNull();
    expect(record!.capBytes).toBe(4096);
    expect(record!.totalBytes).toBe(26000);

    const capped = readFileSync(file, "utf8");
    expect(statSync(file).size).toBeLessThan(26000);
    expect(capped.startsWith("H".repeat(1000))).toBe(true); // the beginning survived
    expect(capped.endsWith("T".repeat(1000))).toBe(true); // so did the end
    expect(capped).not.toContain("MMM"); // the middle is what got dropped
    expect(capped).toContain("truncated 26000 bytes");

    // The record sits beside the stream and agrees with it.
    expect(readTruncationRecord(file)).toEqual(record);
  });

  test("capping never cuts a UTF-8 sequence in half", () => {
    const file = join(scratch(), "stdout");
    writeFileSync(file, "€".repeat(5000), "utf8"); // 3 bytes per character
    capStream(file, 1000, new Date());
    const capped = readFileSync(file, "utf8");
    expect(capped).not.toContain("\uFFFD");
    expect(capped).toContain("truncated 15000 bytes");
  });

  test("unlimited opts out entirely", () => {
    const file = join(scratch(), "stdout");
    writeFileSync(file, "x".repeat(10000), "utf8");
    expect(capStream(file, "unlimited", new Date())).toBeNull();
    expect(statSync(file).size).toBe(10000);
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


// ---------------------------------------------------------------------------
// Through a real run: the cap bounds the capture, never the node's output
// ---------------------------------------------------------------------------

/** A terminal command node that writes exactly `bytes` bytes to stdout. */
const bigNode = (id: string, bytes: number, extra = ""): string => `version: 1
id: ${id}
description: Emits more bytes than the default cap.
${extra}nodes:
  node-a:
    run:
      command: "yes a | head -c ${bytes}"
    next: null
`;

describe("retention — through a run", () => {
  test("the raw capture is capped while the extracted output keeps every byte", async () => {
    const inst = makeInstallation({ "big": bigNode("big", 300_000) });
    const real = findInstallation(inst.root);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "big.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    await advanceChain({ store, inst: real, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });

    const run = store.getRun(started.runId)!;
    const attempt = store.listAttempts(run.run_id)[0]!;
    const folder = join(run.run_dir, "nodes", "001-node-a", "attempt-001");

    // The capture is bounded…
    const record = readTruncationRecord(join(folder, "stdout"));
    expect(record).not.toBeNull();
    expect(record!.totalBytes).toBe(300_000);
    expect(record!.capBytes).toBe(256 * 1024);
    expect(statSync(join(folder, "stdout")).size).toBeLessThan(300_000);

    // …but the node's output and the worklog keep the whole thing. Capping the
    // raw stream must never change what the successor or the log sees.
    const outputText = readFileSync(join(folder, "output"), "utf8");
    expect(outputText.length).toBe(300_000);
    expect(readWorklog(inst, run.run_id).includes(outputText)).toBe(true);
    expect(attempt.status).toBe("completed");

    // The operator can see that a stream was capped, and by how much.
    const logs = runCli(inst, `logs big`);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("── nodes/001-node-a/attempt-001/stdout ── (truncated: 300000 bytes →");
  }, 60_000);

  test("a node-level stream_cap overrides the machine default", async () => {
    const inst = makeInstallation({ "big": bigNode("big", 300_000, "defaults:\n  max_attempts: 2\n") });
    const yamlPath = join(inst.workflowsDir, "big.yaml");
    writeFileSync(
      yamlPath,
      bigNode("big", 300_000).replace("    next: null", "    stream_cap: 1mb\n    next: null"),
      "utf8",
    );
    const real = findInstallation(inst.root);
    const loaded = loadAndValidateDefinition(yamlPath);
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    await advanceChain({ store, inst: real, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });

    const run = store.getRun(started.runId)!;
    const folder = join(run.run_dir, "nodes", "001-node-a", "attempt-001");
    expect(readTruncationRecord(join(folder, "stdout"))).toBeNull();
    expect(statSync(join(folder, "stdout")).size).toBe(300_000);
  }, 60_000);

  test("machine configuration sets the default cap", async () => {
    const inst = makeInstallation({
      "big": `version: 1
id: big
description: Emits more than the machine cap.
nodes:
  node-a:
    run:
      command: "yes a | head -c 20000"
    next: null
`,
    });
    writeFileSync(join(inst.root, ".workshop/config/workshop.yaml"), "stream_cap: 1kb\n", "utf8");

    const real = findInstallation(inst.root);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "big.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    await advanceChain({ store, inst: real, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });

    const run = store.getRun(started.runId)!;
    const folder = join(run.run_dir, "nodes", "001-node-a", "attempt-001");
    const record = readTruncationRecord(join(folder, "stdout"));
    expect(record).not.toBeNull();
    expect(record!.capBytes).toBe(1024);
    expect(record!.totalBytes).toBe(20_000);
    expect(statSync(join(folder, "output")).size).toBe(20_000);
  }, 60_000);
});
