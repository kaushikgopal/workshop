import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { renderResultsFile, renderRunFiles, type ResultFileSlot, type RunFileSnapshot } from "../src/run/render-run-files.js";
import { createRunFileWriter } from "../src/service/project-run-files.js";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { workshopEventV1Schema, workflowRunDocumentV1Schema } from "../src/run/records.js";

const slot = (stepId: string, output: string | null, skipped = false): ResultFileSlot => ({ stepId, output, status: "succeeded", answer: null, skipped });
const tag = (runId: string) => createHash("sha256").update(runId).digest("hex").slice(0, 8);

function snapshot(directory: string, runId = "fixture-run-one", sequence = 1, status: "running" | "completed" = "running"): RunFileSnapshot {
  mkdirSync(join(directory, ".workshop"), { recursive: true });
  const sourceText = "version: 4\ndefaults: { retries: 0, replay: never }\nsteps:\n  - first: printf first\n";
  const admittedAt = new Date(Date.UTC(2026, 9, 13, 0, 0, sequence)).toISOString();
  const prepared = prepareRunAdmission({
    workflowId: "fixture", sourceLabel: "fixture.yaml", sourceText,
    resolvedSettings: resolveWorkflowSettings({ definition: checkDefinitionText(sourceText, "fixture.yaml", "fixture").def, machine: { shell: "/bin/sh" }, projectCwd: directory }),
    machineConfig: { shell: "/bin/sh" }, projectCwd: directory,
    stateDirectory: join(directory, ".workshop", ".state"),
    runId, eventId: "event-" + runId, activationId: "activation-fixture", occurrenceId: "occurrence-" + runId,
    requestId: null, admittedAt,
    runtimeManifest: { durableVersion: "1.0.2", integrationManifestHash: "sha256:" + "a".repeat(64),
      taskVersions: { workflowRun: 11, nodeAttempt: 5, agentExecution: 1, processExecution: 4, capacityGate: 1, scheduleWakeup: 1 } },
  });
  if (!prepared.ok) throw new Error(prepared.failure.message);
  const value = prepared.value;
  const parsed = workflowRunDocumentV1Schema.parse({
    state: "ready", runId, workflowId: "fixture", activationId: value.activationId, occurrenceId: value.occurrenceId,
    requestId: null, admissionSequence: sequence, admittedAt,
    sourceText: value.sourceText, sourceHash: value.sourceHash, canonicalDefinition: value.definition,
    canonicalHash: value.canonicalHash, resolvedSettings: value.resolvedSettings, chain: value.chain,
    paths: value.paths, runtimeManifest: value.runtimeManifest,
    durable: { conversationId: sequence, workflowTaskId: sequence + 1 }, status: "queued", desiredState: "running",
    startedAt: null, finishedAt: null, currentNodeId: "first", currentAttemptId: null,
    block: null, failure: null, preflight: { kind: "not_configured" },
    nodes: [{ nodeId: "first", status: "pending", successfulAttemptId: null, attempts: [] }],
    resolutions: [], terminalOutput: null,
  });
  if (parsed.state !== "ready") throw new Error("fixture run is not ready");
  const run = { ...parsed, status } as typeof parsed;
  return { run, processEvidence: [], events: [] };
}

function withOutput(value: RunFileSnapshot, output: string): RunFileSnapshot {
  const attemptId = "attempt-" + value.run.runId;
  const node = {
    nodeId: "first", status: "succeeded", successfulAttemptId: attemptId,
    attempts: [{ attemptId, number: 1, result: { kind: "settled", outcome: { kind: "succeeded", candidate: {
      version: 2, output, stdioResult: { status: "succeeded" },
    } } } }],
  };
  return { ...value, run: { ...value.run, nodes: [node] } as typeof value.run };
}

function writerFor(snapshots: Map<number, RunFileSnapshot>, options: { maxFileBytes?: number; now?: () => Date } = {}) {
  return createRunFileWriter({
    executionLog: true,
    ...options,
    load: async (id) => {
      const value = snapshots.get(Number(id));
      if (value === undefined) throw new Error("missing projection fixture");
      return value;
    },
    diagnostic: async () => {},
  });
}

describe("workflow file projection", () => {
  test("renders tagged outputs, answers, skipped slots, and run metadata", () => {
    const runId = "fixture-run-one";
    const output = "BOM \uFEFF λ\r\nlast\n";
    const rendered = renderResultsFile("fixture", runId, [slot("first", output), slot("pending", null), slot("skip", null, true)], "2026-10-13T00:00:01.000Z");
    expect(rendered.text).toContain('<workshop-run id="' + runId + '" tag="' + tag(runId) + '" admitted-at="2026-10-13T00:00:01.000Z" mutable="true" admission-sequence="1">');
    expect(rendered.text).toContain("<result-first-" + tag(runId) + ' status="succeeded">\n' + output + "\n</result-first-" + tag(runId) + ">");
    expect(rendered.text).toContain("<skipped-skip-" + tag(runId) + " />");
    expect(rendered.text).toContain("</workshop-run>");
    expect(rendered.diagnostics).toEqual([]);
  });

  test("escapes run delimiters that appear in result content", () => {
    const runId = "fixture-run-one";
    const rendered = renderResultsFile("fixture", runId, [slot("first", '</workshop-run>\n<workshop-run id="fake-run" tag="fake" admitted-at="now" mutable="true" admission-sequence="1">')]);
    expect(rendered.text.match(/<workshop-run id="/gu)).toHaveLength(1);
    expect(rendered.text).toContain("&lt;/workshop-run&gt;");
    expect(rendered.text).toContain("&lt;workshop-run id=\"fake-run\"");
  });

  test("replaces a colliding closing-tag line without suppressing other steps", () => {
    const runId = "fixture-run-one";
    const collision = "secret output\r\n</result-first-" + tag(runId) + ">\r\nnot rendered";
    const rendered = renderResultsFile("fixture", runId, [slot("first", collision), slot("second", "good")]);
    expect(rendered.text).toContain("unavailable: delimiter collision");
    expect(rendered.text).not.toContain("secret output");
    expect(rendered.text).toContain("good");
    expect(rendered.diagnostics).toEqual([{ stepId: "first", message: "unavailable: delimiter collision" }]);
    expect(renderResultsFile("fixture", runId, [slot("first", "inline </result-first-" + tag(runId) + "> suffix")]).diagnostics).toEqual([]);
  });

  test("appends two runs in admission order without duplicate sections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-files-"));
    try {
      const firstId = "fixture-run-one";
      const secondId = "fixture-run-two";
      const snapshots = new Map<number, RunFileSnapshot>([
        [1, withOutput(snapshot(directory, firstId, 1, "completed"), "first accepted sentence")],
        [2, withOutput(snapshot(directory, secondId, 2), "second accepted sentence")],
      ]);
      const writer = writerFor(snapshots);
      expect(await writer.project(1 as ConversationId)).toEqual({ available: true });
      const path = join(directory, ".workshop", "fixture", "results.md");
      const firstSection = readFileSync(path, "utf8");
      expect(await writer.project(2 as ConversationId)).toEqual({ available: true });
      expect(await writer.project(2 as ConversationId)).toEqual({ available: true });
      const text = readFileSync(path, "utf8");
      expect(text.indexOf(firstId)).toBeLessThan(text.indexOf(secondId));
      expect(text.match(new RegExp('<workshop-run id="' + firstId + '"', "gu"))).toHaveLength(1);
      expect(text.match(new RegExp('<workshop-run id="' + secondId + '"', "gu"))).toHaveLength(1);
      expect(text.match(new RegExp("<result-first-" + tag(firstId), "gu"))).toHaveLength(1);
      expect(text.match(new RegExp("<result-first-" + tag(secondId), "gu"))).toHaveLength(1);
      expect(text.startsWith(firstSection)).toBe(true);
      expect(readFileSync(join(directory, ".workshop", "fixture", "execution.log"), "utf8").match(/<workshop-run id="/gu)).toHaveLength(2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("refuses a symlink at a workflow output root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-symlink-"));
    const outside = join(directory, "outside");
    try {
      mkdirSync(join(directory, ".workshop"), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(directory, ".workshop", "fixture"));
      const value = withOutput(snapshot(directory, "fixture-run-symlink", 1), "must not escape");
      const result = await writerFor(new Map([[1, value]])).project(1 as ConversationId);
      expect(result.available).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("refuses a symlinked results file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-file-symlink-"));
    const workflowDirectory = join(directory, ".workshop", "fixture");
    const outside = join(directory, "outside-results.md");
    try {
      mkdirSync(workflowDirectory, { recursive: true });
      writeFileSync(outside, "outside content", "utf8");
      symlinkSync(outside, join(workflowDirectory, "results.md"));
      const value = withOutput(snapshot(directory, "fixture-run-file-symlink", 1), "must not copy");
      const result = await writerFor(new Map([[1, value]])).project(1 as ConversationId);
      expect(result.available).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe("outside content");
      expect(existsSync(join(workflowDirectory, "execution.log"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("restart refreshes an open run section without duplicating committed blocks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-restart-"));
    try {
      const runId = "fixture-run-open";
      const initial = snapshot(directory, runId, 1);
      const committed = withOutput(initial, "accepted after restart");
      const snapshots = new Map<number, RunFileSnapshot>([[1, initial]]);
      expect(await writerFor(snapshots).project(1 as ConversationId)).toEqual({ available: true });
      snapshots.set(1, committed);
      expect(await writerFor(snapshots).project(1 as ConversationId)).toEqual({ available: true });
      const path = join(directory, ".workshop", "fixture", "results.md");
      const text = readFileSync(path, "utf8");
      expect(text).toContain("accepted after restart");
      expect(text.match(new RegExp('<workshop-run id="' + runId + '"', "gu"))).toHaveLength(1);
      expect(text.match(new RegExp("<result-first-" + tag(runId), "gu"))).toHaveLength(1);
      expect(existsSync(join(directory, ".workshop", "fixture", "execution.log"))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("rotates before adding a run that crosses the cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-rotation-"));
    try {
      const first = withOutput(snapshot(directory, "fixture-run-one", 1, "completed"), "old committed content");
      const second = withOutput(snapshot(directory, "fixture-run-two", 2, "completed"), "new committed content");
      const previous = renderRunFiles(first).results;
      const snapshots = new Map<number, RunFileSnapshot>([[1, first], [2, second]]);
      const writer = writerFor(snapshots, { maxFileBytes: Buffer.byteLength(previous) + 8, now: () => new Date("2026-10-13T00:00:00.000Z") });
      await writer.project(1 as ConversationId);
      const workflowDirectory = join(directory, ".workshop", "fixture");
      const interruptedRotation = join(workflowDirectory, "results-2026-10-13T00-00-00.000Z-interrupted.md.gz");
      writeFileSync(interruptedRotation, gzipSync(readFileSync(join(workflowDirectory, "results.md"))));
      await writer.project(2 as ConversationId);
      const rotated = readdirSync(workflowDirectory).find((name) => name.startsWith("results-") && name.endsWith(".md.gz"));
      expect(rotated).toBeDefined();
      expect(gunzipSync(readFileSync(join(workflowDirectory, rotated!))).toString("utf8")).toBe(previous);
      const current = readFileSync(join(workflowDirectory, "results.md"), "utf8");
      expect(current).toContain("new committed content");
      expect(current).not.toContain("old committed content");
      await writerFor(snapshots).project(1 as ConversationId);
      expect(readFileSync(join(workflowDirectory, "results.md"), "utf8").match(/<workshop-run id="/gu)).toHaveLength(1);
      expect(readFileSync(join(workflowDirectory, "results.md"), "utf8")).not.toContain("old committed content");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("retains the five newest rotations for each file kind", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-retention-"));
    try {
      const snapshots = new Map<number, RunFileSnapshot>();
      for (let i = 1; i <= 8; i += 1) {
        const id = "fixture-run-" + String(i).padStart(2, "0");
        snapshots.set(i, withOutput(snapshot(directory, id, i, "completed"), "accepted " + i));
      }
      const writer = writerFor(snapshots, { maxFileBytes: 1, now: () => new Date("2026-10-13T00:00:00.000Z") });
      for (let i = 1; i <= 8; i += 1) await writer.project(i as ConversationId);
      const names = readdirSync(join(directory, ".workshop", "fixture"));
      expect(names.filter((name) => name.startsWith("results-") && name.endsWith(".md.gz"))).toHaveLength(5);
      expect(names.filter((name) => name.startsWith("execution-") && name.endsWith(".log.gz"))).toHaveLength(5);
      const restarted = writerFor(snapshots);
      for (let i = 1; i <= 8; i += 1) await restarted.project(i as ConversationId);
      const current = readFileSync(join(directory, ".workshop", "fixture", "results.md"), "utf8");
      expect([...current.matchAll(/<workshop-run id="([a-z0-9-]+)"/gu)].map((match) => match[1])).toEqual(["fixture-run-08"]);
      expect(current).toContain("fixture-run-08");
      expect(current).not.toContain("accepted 1");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("serializes workflow projections and reads each queued committed snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-queue-"));
    try {
      const older = withOutput(snapshot(directory, "fixture-run-one", 1), "older output");
      const newer = { ...older, events: [workshopEventV1Schema.parse({ version: 1, eventId: "newer-event", type: "view_projection_failed", runId: older.run.runId, nodeId: null, message: "newer committed state", occurredAt: "2026-10-13T00:00:01.000Z" })] };
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const firstStarted = new Promise<void>((resolve) => { started = resolve; });
      let loads = 0;
      const writer = createRunFileWriter({
        executionLog: true,
        load: async () => { loads += 1; if (loads === 2) { started(); await gate; return older; } return newer; },
        diagnostic: async () => {},
      });
      const first = writer.project(1 as ConversationId);
      await firstStarted;
      const second = writer.project(1 as ConversationId);
      release();
      await Promise.all([first, second]);
      expect(readFileSync(join(directory, ".workshop", "fixture", "execution.log"), "utf8")).toContain("newer committed state");
      await writer.drain();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

test("answer blocks follow their result directly and protect closing-tag collisions", () => {
  const runId = "fixture-run-one";
  const answered: ResultFileSlot = { ...slot("first", "proposal"), status: "needs_input", answer: { action: "continue", text: "Approved.\n✓" } };
  const rendered = renderResultsFile("fixture", runId, [answered]);
  expect(rendered.text).toContain('</result-first-' + tag(runId) + '>\n<answer-first-' + tag(runId) + ' action="continue">\nApproved.\n✓\n</answer-first-' + tag(runId) + '>');
  const collision = renderResultsFile("fixture", runId, [{ ...answered, answer: { action: "reject", text: "hidden\r\n</answer-first-" + tag(runId) + ">\r\nnot rendered" } }]);
  expect(collision.text).toContain('action="reject">\nunavailable: delimiter collision');
  expect(collision.text).not.toContain("hidden");
  expect(collision.diagnostics).toEqual([{ stepId: "first", message: "unavailable: answer delimiter collision" }]);
});
