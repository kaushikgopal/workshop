import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createViewerSource } from "../src/cli/watch.js";
import { runIdSchema } from "../src/run/schema.js";
import { runsDtoSchema, statusDtoSchema } from "../src/views/schema.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");

const workflowId = "hemingway-clock";

type ActivityRecord = {
  readonly event: string;
  readonly role: string;
  readonly runId: string;
  readonly executionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly promptBytes?: number;
  readonly output?: string;
  readonly priorCount?: number;
  readonly passed?: boolean;
  readonly resultsPath?: string;
  readonly logPath?: string;
  readonly archivePresent?: boolean;
};

describe("recurring Hemingway acceptance", () => {
  test("admits six runs and compares accepted sentences through results.md", async () => {
    const fixture = await createFixture({ id: workflowId, schedule: true, generatorSleepMs: 120, validatorSleepMs: 120 });
    try {
      expect(runCli(fixture.root, ["validate", `.workshop/workflows/${workflowId}.yaml`]).status).toBe(0);
      const started = runCli(fixture.root, ["start", workflowId, "--detach"], 30_000);
      expect(started.status).toBe(0);
      const firstRunId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const history = await waitForCompletedRuns(fixture.root, workflowId, 6);
      expect(history.runs).toHaveLength(6);
      expect(history.runs.every((run) => run.status === "completed")).toBe(true);
      expect(history.runs.some((run) => run.runId === firstRunId)).toBe(true);

      const statusResult = runCli(fixture.root, ["status", workflowId, "--json"]);
      expect(statusResult.status).toBe(0);
      const status = statusDtoSchema.parse(JSON.parse(statusResult.stdout));
      const workflow = status.workflows.find((entry) => entry.workflowId === workflowId);
      const activation = workflow?.activation;
      expect(activation).toMatchObject({ state: "exhausted", admittedCount: 6, maxRuns: 6, nextDueAt: null });
      expect(activation?.skippedSlots).toBeGreaterThan(0);

      const runIds = history.runs.map((run) => run.runId);
      const activationIds = new Set(history.runs.map((run) => run.activationId));
      expect(new Set(runIds).size).toBe(6);
      expect(activationIds.size).toBe(1);
      if (activation === null || activation === undefined) throw new Error("scheduled activation is missing");
      expect([...activationIds]).toEqual([activation.activationId]);

      const activity = readActivity(fixture.activityLog);
      const results = readFileSync(fixture.resultsPath, "utf8");
      expect(results.match(/<workshop-run id="/gu)).toHaveLength(6);
      const accepted = activityOutputs(activity);
      expect(accepted).toHaveLength(6);
      const starts = activity.filter((record) => record.event === "start");
      expect(starts.map((record) => record.resultsPath)).toEqual(Array(12).fill(fixture.resultsPath));
      expect(starts.map((record) => record.logPath)).toEqual(Array(12).fill(fixture.resultsPath.replace(/results\.md$/u, "execution.log")));
      expect(starts.every((record) => record.archivePresent === false)).toBe(true);
      expect(new Set(accepted).size).toBe(6);
      for (const sentence of accepted) expect(results).toContain(sentence);

      const runActivity = new Map<string, ActivityRecord[]>();
      for (const record of activity) {
        const records = runActivity.get(record.runId) ?? [];
        records.push(record);
        runActivity.set(record.runId, records);
      }
      for (const runId of runIds) {
        const records = runActivity.get(runId) ?? [];
        for (const role of ["generator", "validator"]) {
          expect(records.filter((record) => record.role === role && record.event === "start")).toHaveLength(1);
          expect(records.filter((record) => record.role === role && record.event === "finish")).toHaveLength(1);
        }
        const generator = records.find((record) => record.role === "generator" && record.event === "start");
        const validator = records.find((record) => record.role === "validator" && record.event === "start");
        expect(generator?.provider).toBe("fixture-generator");
        expect(generator?.thinking).toBe("medium");
        expect(validator?.provider).toBe("fixture-validator");
        expect(validator?.thinking).toBe("low");
        expect(generator?.executionId).not.toBe(validator?.executionId);
        expect(generator?.promptBytes).toBeGreaterThan(0);
        expect(validator?.promptBytes).toBeGreaterThan(0);
      }
      const verdicts = activity.filter((record) => record.role === "validator" && record.event === "verdict");
      expect(verdicts).toHaveLength(6);
      expect(verdicts.every((record) => record.passed === true)).toBe(true);
      expect(verdicts.map((record) => record.priorCount).sort()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(activity.some((record) => record.role === "publisher")).toBe(false);

      let activeRuns = new Set<string>();
      let maxActiveRuns = 0;
      for (const record of activity) {
        if (record.event === "start") {
          expect(activeRuns.has(record.runId)).toBe(false);
          activeRuns.add(record.runId);
          maxActiveRuns = Math.max(maxActiveRuns, activeRuns.size);
        } else if (record.event === "finish") {
          expect(activeRuns.has(record.runId)).toBe(true);
          activeRuns.delete(record.runId);
        }
      }
      expect(activeRuns.size).toBe(0);
      expect(maxActiveRuns).toBe(1);

      const cliLogs = runCli(fixture.root, ["logs", workflowId, "--all", "--json"]);
      expect(cliLogs.status).toBe(0);
      const logHistory = JSON.parse(cliLogs.stdout) as { runs: { runId: string }[] };
      expect(logHistory.runs.map((run) => run.runId).sort()).toEqual([...runIds].sort());
      const service = JSON.parse(readFileSync(join(fixture.stateDirectory, "service.json"), "utf8")) as { socketPath: string };
      const viewer = createViewerSource(service.socketPath);
      const snapshot = await viewer.snapshot(workflowId);
      expect(snapshot.detail?.diagram.runId).toBe(snapshot.status.workflows[0]?.latestRun?.runId ?? null);
      expect(snapshot.detail?.nodes.map(node => node.nodeId)).toEqual(["generate"]);
      expect(snapshot.status.workflows[0]?.activation?.admittedCount).toBe(6);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  test("rejects a paraphrase against an earlier accepted sentence in results.md", async () => {
    const paraphrase = "The old man rowed as night fell beyond the shore.";
    const reference = "The old man rowed until the sea forgot the shore.";
    const fixture = await createFixture({ id: "hemingway-reject", schedule: false, fixedOutput: paraphrase });
    mkdirSync(join(fixture.root, ".workshop", "hemingway-reject"), { recursive: true });
    writeFileSync(fixture.resultsPath, '<workshop-run id="prior-run" tag="abcdef01" admitted-at="2026-10-13T00:00:00.000Z">\n'
      + '<result-generate-abcdef01 status="succeeded">\n' + reference + '\n</result-generate-abcdef01>\n</workshop-run>\n', "utf8");
    try {
      const runId = await startSingleRun(fixture.root, "hemingway-reject");
      const failed = await waitForRunStatus(fixture.root, "hemingway-reject", runId, "failed");
      expect(failed.failure?.kind).toBe("validator_rejection");
      expect(readFileSync(fixture.resultsPath, "utf8")).toContain(reference);
      const verdict = readActivity(fixture.activityLog).find((record) => record.role === "validator" && record.event === "verdict");
      expect(verdict).toMatchObject({ passed: false, priorCount: 1 });
      expect(readActivity(fixture.activityLog).some((record) => record.role === "publisher")).toBe(false);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not validate an invalid generator result", async () => {
    const fixture = await createFixture({ id: "hemingway-invalid", schedule: false, malformedGenerator: true });
    try {
      const runId = await startSingleRun(fixture.root, "hemingway-invalid");
      const failed = await waitForRunStatus(fixture.root, "hemingway-invalid", runId, "failed");
      expect(failed.failure?.kind).toBe("result_invalid");
      const activity = readActivity(fixture.activityLog);
      expect(activity.filter((record) => record.role === "generator" && record.event === "start")).toHaveLength(1);
      expect(activity.some((record) => record.role === "validator")).toBe(false);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("Continue completes the approval example and stores the answer block", async () => {
    const fixture = await createFixture({ id: "hemingway-clock-human-approval", schedule: false, needsInput: true, useApprovalExample: true });
    try {
      expect(runCli(fixture.root, ["validate", ".workshop/workflows/hemingway-clock-human-approval.yaml"]).status).toBe(0);
      const runId = await startSingleRun(fixture.root, "hemingway-clock-human-approval");
      await waitForRunStatus(fixture.root, "hemingway-clock-human-approval", runId, "waiting");
      const reply = runCli(fixture.root, ["reply", "hemingway-clock-human-approval", "--continue", "--answer", "Approved."]);
      expect(reply.status).toBe(0);
      await waitForRunStatus(fixture.root, "hemingway-clock-human-approval", runId, "completed");
      const results = readFileSync(fixture.resultsPath, "utf8");
      const runTag = createHash("sha256").update(runId).digest("hex").slice(0, 8);
      expect(results).toContain("<answer-draft-" + runTag + ' action="continue">\nApproved.\n</answer-draft-' + runTag + ">");
      expect(readActivity(fixture.activityLog).some((record) => record.role === "publisher")).toBe(false);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

});

async function createFixture(options: {
  readonly id: string;
  readonly schedule: boolean;
  readonly generatorSleepMs?: number;
  readonly validatorSleepMs?: number;
  readonly fixedOutput?: string;
  readonly malformedGenerator?: boolean;
  readonly needsInput?: boolean;
  readonly useApprovalExample?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "workshop-" + options.id + "-"));
  const workshopDirectory = join(root, ".workshop");
  const workflowsDirectory = join(workshopDirectory, "workflows");
  const stateDirectory = join(workshopDirectory, ".state");
  const resultsPath = join(workshopDirectory, options.id, "results.md");
  const activityLog = join(workshopDirectory, options.id, "mock-activity.jsonl");
  mkdirSync(workflowsDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });

  writeFileSync(join(workshopDirectory, "workshop.yaml"), [
    "project_dir: " + JSON.stringify(root),
    "shell: /bin/bash",
    "max_concurrent_runs: 1",
    "agent:",
    "  model: fixture-generator/generator:medium",
    "",
  ].join("\n"), "utf8");

  const source = options.useApprovalExample === true
    ? readFileSync(join(REPO_ROOT, "examples/workflows/hemingway-clock-human-approval.yaml"), "utf8")
    : [
      "version: 4",
      "description: Exercise scheduled Hemingway generation and independent validation.",
      ...(options.schedule ? ["schedule:", "  every: 50ms", "  max_runs: 6"] : []),
      "defaults:",
      "  retries: 0",
      "  replay: safe",
      "steps:",
      "  - generate:",
      "      result: tagged",
      "      agent:",
      "        instructions: Read earlier accepted sentences from WORKSHOP_RESULTS_PATH and write one distinct original sentence.",
      "      verify:",
      "        agent:",
      "          model: fixture-validator/validator:low",
      "          instructions: Compare the candidate with earlier accepted sentences in WORKSHOP_RESULTS_PATH.",
      "",
    ].join("\n");
  writeFileSync(join(workflowsDirectory, options.id + ".yaml"), source, "utf8");
  await startFauxService(root, {
    id: options.id,
    activityPath: activityLog,
    fixedOutput: options.fixedOutput,
    malformedGenerator: options.malformedGenerator,
    needsInput: options.needsInput,
    generatorSleepMs: options.generatorSleepMs,
    validatorSleepMs: options.validatorSleepMs,
  });
  return { root, stateDirectory, resultsPath, activityLog };
}

async function startFauxService(root: string, options: Record<string, unknown>): Promise<void> {
  const fixturePath = join(REPO_ROOT, "tests/fixtures/serve-faux-workshop.ts");
  const child = spawn(process.execPath, [fixturePath, root, "hemingway-acceptance", JSON.stringify(options)], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("test-owned faux service did not start");
  child.unref();
  const metadataPath = join(root, ".workshop", ".state", "service.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("test-owned faux service exited during startup");
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { status?: unknown };
      if (metadata.status === "ready") return;
      if (metadata.status === "failed") throw new Error("test-owned faux service failed during startup");
    }
    await delay(20);
  }
  try { process.kill(child.pid, "SIGKILL"); } catch { /* service already exited */ }
  throw new Error("test-owned faux service did not become ready");
}

async function startSingleRun(root: string, id: string): Promise<string> {
  const started = runCli(root, ["start", id, "--detach"], 30_000);
  if (started.status !== 0) throw new Error(started.stderr);
  return runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
}

async function waitForCompletedRuns(root: string, id: string, count: number) {
  const deadline = Date.now() + 45_000;
  let history = runsDtoSchema.parse({ version: 2, workflowId: id, total: 0, truncated: false, runs: [] });
  while (Date.now() < deadline) {
    const result = runCli(root, ["runs", id, "--json", "--all"]);
    if (result.status !== 0) throw new Error(result.stderr);
    history = runsDtoSchema.parse(JSON.parse(result.stdout));
    const failed = history.runs.find((run) => run.status === "blocked" || run.status === "failed");
    if (failed !== undefined) {
      const logs = runCli(root, ["logs", id, "--run", failed.runId, "--json"]).stdout;
      const activityPath = join(root, ".workshop", id, "mock-activity.jsonl");
      const activity = existsSync(activityPath) ? readFileSync(activityPath, "utf8") : "";
      throw new Error("run ended before expected completion: " + JSON.stringify({ run: failed, logs, activity }));
    }
    if (history.runs.length === count && history.runs.every((run) => run.status === "completed")) return history;
    await delay(40);
  }
  throw new Error(`expected ${count} completed runs; observed ${history.runs.length}`);
}

async function waitForRunStatus(root: string, id: string, runId: string, expected: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = runCli(root, ["runs", id, "--json"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const history = runsDtoSchema.parse(JSON.parse(result.stdout));
    const run = history.runs.find((entry) => entry.runId === runId);
    if (run?.status === expected) return run;
    if (run?.status === "failed" || run?.status === "blocked") {
      const logs = runCli(root, ["logs", id, "--run", runId, "--json"]).stdout;
      const activityPath = join(root, ".workshop", id, "mock-activity.jsonl");
      const activity = existsSync(activityPath) ? readFileSync(activityPath, "utf8") : "";
      throw new Error("run ended before expected status: " + JSON.stringify({ run, logs, activity }));
    }
    await delay(40);
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

function activityOutputs(activity: readonly ActivityRecord[]): string[] {
  return activity.filter((record) => record.role === "generator" && record.event === "result")
    .map((record) => record.output ?? "");
}

function readActivity(path: string): ActivityRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ActivityRecord);
}

function runCli(root: string, args: readonly string[], timeoutMs = 10_000) {
  const result = spawnSync("bun", [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: [result.stderr, result.error instanceof Error ? result.error.message : ""].filter(Boolean).join("\n"),
  };
}

async function stopService(root: string): Promise<void> {
  const metadataPath = join(root, ".workshop", ".state", "service.json");
  if (!existsSync(metadataPath)) return;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: unknown };
  if (typeof metadata.pid !== "number") return;
  try { process.kill(metadata.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = JSON.parse(readFileSync(metadataPath, "utf8")) as { status?: unknown };
    if (current.status === "stopped") return;
    await delay(20);
  }
  throw new Error("service did not stop during test cleanup");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
