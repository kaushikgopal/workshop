import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { renderResultsFile, renderRunFiles, type ResultFileSlot, type RunFileSnapshot } from "../src/run/render-run-files.js";
import { createRunFileWriter } from "../src/service/project-run-files.js";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { workshopEventV1Schema, workflowRunDocumentV1Schema } from "../src/run/records.js";

const slot = (stepId: string, output: string | null, skipped = false): ResultFileSlot => ({ stepId, output, status: "succeeded", answer: null, skipped });
const runId = "fixture-run";
const runTag = createHash("sha256").update(runId).digest("hex").slice(0, 8);

function snapshot(directory: string): RunFileSnapshot {
  const sourceText = "version: 4\ndefaults: { retries: 0, replay: never }\nsteps:\n  - first: printf first\n";
  const prepared = prepareRunAdmission({
    workflowId: "fixture", sourceLabel: "fixture.yaml",
    sourceText,
    resolvedSettings: resolveWorkflowSettings({ definition: checkDefinitionText(sourceText, "fixture.yaml", "fixture").def, machine: { shell: "/bin/sh" }, projectCwd: directory }),
    machineConfig: { shell: "/bin/sh" }, projectCwd: directory,
    runsDirectory: directory, archiveDirectory: join(directory, "archive"),
    runId, eventId: "event-fixture", activationId: "activation-fixture", occurrenceId: "occurrence-fixture",
    requestId: null, admittedAt: "2026-10-13T00:00:00.000Z",
    runtimeManifest: { durableVersion: "1.0.2", integrationManifestHash: "sha256:" + "a".repeat(64),
      taskVersions: { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, failureJudgment: 1 } },
  });
  if (!prepared.ok) throw new Error(prepared.failure.message);
  const value = prepared.value;
  const run = workflowRunDocumentV1Schema.parse({
    state: "ready", runId, workflowId: "fixture", activationId: value.activationId, occurrenceId: value.occurrenceId,
    requestId: null, admissionSequence: 1, admittedAt: value.admittedAt,
    sourceText: value.sourceText, sourceHash: value.sourceHash, canonicalDefinition: value.definition,
    canonicalHash: value.canonicalHash, resolvedSettings: value.resolvedSettings, chain: value.chain,
    paths: value.paths, runtimeManifest: value.runtimeManifest,
    durable: { conversationId: 1, workflowTaskId: 2 }, status: "queued", desiredState: "running",
    startedAt: null, finishedAt: null, currentNodeId: "first", currentAttemptId: null,
    block: null, failure: null, preflight: { kind: "not_configured" },
    nodes: [{ nodeId: "first", status: "pending", successfulAttemptId: null, attempts: [] }],
    resolutions: [], terminalOutput: null,
  });
  if (run.state !== "ready") throw new Error("fixture run is not ready");
  return { run, processEvidence: [], events: [] };
}

describe("run file projection", () => {
  test("uses run-specific tags, exact output, empty answers, and skipped slots in chain order", () => {
    const output = "BOM \uFEFF λ\r\nlast\n";
    const rendered = renderResultsFile("fixture", runId, [slot("first", output), slot("pending", null), slot("skip", null, true)]);
    expect(rendered.text).toBe("# Results: fixture run " + runId + "\n\n<result-first-" + runTag
      + ' status="succeeded">\n' + output + "\n</result-first-" + runTag + ">\n\n<skipped-skip-" + runTag + " />\n");
    expect(rendered.text).not.toContain("answer-");
    expect(rendered.text).not.toContain("pending");
    expect(rendered.diagnostics).toEqual([]);
  });

  test("replaces a colliding closing-tag line without suppressing other steps", () => {
    const collision = "secret output\r\n</result-first-" + runTag + ">\r\nnot rendered";
    const rendered = renderResultsFile("fixture", runId, [slot("first", collision), slot("second", "good")]);
    expect(rendered.text).toContain("unavailable: delimiter collision");
    expect(rendered.text).not.toContain("secret output");
    expect(rendered.text).toContain("good");
    expect(rendered.diagnostics).toEqual([{ stepId: "first", message: "unavailable: delimiter collision" }]);
    expect(renderResultsFile("fixture", runId, [slot("first", "inline </result-first-" + runTag + "> suffix")]).diagnostics).toEqual([]);
  });

  test("regenerates edited or deleted files without changing state or duplicating blocks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-files-"));
    try {
      const committed = snapshot(directory);
      const original = JSON.stringify(committed);
      const writer = createRunFileWriter({ load: async () => committed, diagnostic: async () => {} });
      expect(await writer.project(1 as ConversationId)).toEqual({ available: true });
      const path = join(committed.run.paths.runDirectory, "results.md");
      writeFileSync(path, "human edits are not state");
      rmSync(join(committed.run.paths.runDirectory, "execution.log"));
      await writer.project(1 as ConversationId);
      expect(readFileSync(path, "utf8")).toBe(renderRunFiles(committed).results);
      expect(readFileSync(path, "utf8").match(/# Results:/gu)).toHaveLength(1);
      expect(existsSync(join(committed.run.paths.runDirectory, "execution.log"))).toBe(true);
      expect(JSON.stringify(committed)).toBe(original);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("loads the next committed snapshot only after the earlier replacement finishes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-project-queue-"));
    try {
      const older = snapshot(directory);
      const newer: RunFileSnapshot = { ...older, events: [workshopEventV1Schema.parse({ version: 1, eventId: "newer-event", type: "view_projection_failed", runId, nodeId: null, message: "newer committed state", occurredAt: "2026-10-13T00:00:01.000Z" })] };
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const firstStarted = new Promise<void>((resolve) => { started = resolve; });
      let loads = 0;
      const writer = createRunFileWriter({
        load: async () => { loads += 1; if (loads === 1) { started(); await gate; return older; } return newer; },
        diagnostic: async () => {},
      });
      const first = writer.project(1 as ConversationId);
      await firstStarted;
      const second = writer.project(1 as ConversationId);
      expect(loads).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(loads).toBe(2);
      expect(readFileSync(join(older.run.paths.runDirectory, "execution.log"), "utf8")).toBe(renderRunFiles(newer).executionLog);
      expect(readFileSync(join(older.run.paths.runDirectory, "execution.log"), "utf8")).toContain("newer committed state");
      await writer.drain();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
