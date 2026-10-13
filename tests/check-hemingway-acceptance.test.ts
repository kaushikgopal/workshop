import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createViewerSource } from "../src/cli/watch.js";
import { runIdSchema } from "../src/run/schema.js";
import { runsDtoSchema, statusDtoSchema } from "../src/views/schema.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");
const agentPath = join(REPO_ROOT, "tests/mock/write-recurring-hemingway-agent.ts");
const workflowId = "hemingway-clock";

type ActivityRecord = {
  readonly event: string;
  readonly role: string;
  readonly runId: string;
  readonly pid: number;
  readonly executionId?: string;
  readonly resultPath?: string;
  readonly output?: string;
  readonly archiveCount?: number;
  readonly passed?: boolean;
};

describe("recurring Hemingway acceptance", () => {
  test("admits six distinct runs on one activation and publishes each after independent validation", async () => {
    const fixture = createFixture({ id: workflowId, schedule: true, generatorSleepMs: 120, validatorSleepMs: 120 });
    try {
      const validation = runCli(fixture.root, ["validate", workflowId]);
      expect(validation.status).toBe(0);

      const started = runCli(fixture.root, ["start", workflowId, "--detach"], 30_000);
      expect(started.status).toBe(0);
      expect(started.stdout).toContain("Started run ");
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
      const occurrenceIds = history.runs.map((run) => run.occurrenceId);
      const activationIds = new Set(history.runs.map((run) => run.activationId));
      expect(new Set(runIds).size).toBe(6);
      expect(new Set(occurrenceIds).size).toBe(6);
      expect(activationIds.size).toBe(1);
      if (activation === null || activation === undefined) throw new Error("scheduled activation is missing");
      expect([...activationIds]).toEqual([activation.activationId]);

      const archiveFiles = readdirSync(fixture.archiveDirectory).filter((name) => name.endsWith(".md")).sort();
      expect(archiveFiles).toEqual(runIds.map((runId) => `${runId}.md`).sort());
      const quotes = archiveFiles.map((name) => readFileSync(join(fixture.archiveDirectory, name), "utf8").trim());
      expect(new Set(quotes).size).toBe(6);

      const activity = readActivity(fixture.activityLog);
      const runActivity = new Map<string, ActivityRecord[]>();
      for (const record of activity) {
        const records = runActivity.get(record.runId) ?? [];
        records.push(record);
        runActivity.set(record.runId, records);
      }
      for (const runId of runIds) {
        const records = runActivity.get(runId) ?? [];
        for (const role of ["generator", "validator", "publisher"]) {
          expect(records.filter((record) => record.role === role && record.event === "start")).toHaveLength(1);
          expect(records.filter((record) => record.role === role && record.event === "finish")).toHaveLength(1);
        }
        const generator = records.find((record) => record.role === "generator" && record.event === "start");
        const validator = records.find((record) => record.role === "validator" && record.event === "start");
        expect(generator).toBeDefined();
        expect(validator).toBeDefined();
        expect(generator?.pid).not.toBe(validator?.pid);
        expect(generator?.executionId).not.toBe(validator?.executionId);
        expect(generator?.resultPath).not.toBe(validator?.resultPath);
      }
      const resultPaths = activity
        .filter((record) => record.event === "start" && (record.role === "generator" || record.role === "validator"))
        .map((record) => record.resultPath);
      expect(new Set(resultPaths).size).toBe(12);
      const verdicts = activity.filter((record) => record.role === "validator" && record.event === "verdict");
      expect(verdicts).toHaveLength(6);
      expect(verdicts.every((record) => record.passed === true)).toBe(true);
      expect(verdicts.map((record) => record.archiveCount)).toEqual([0, 1, 2, 3, 4, 5]);

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
      const snapshot = await viewer.snapshot(workflowId, firstRunId);
      expect(snapshot.runs.total).toBe(6);
      expect(snapshot.runs.runs.map((run) => run.id).sort()).toEqual([...runIds].sort());
      const viewerWorkflow = snapshot.status.workflows.find((entry) => entry.id === workflowId);
      expect(viewerWorkflow?.activation?.startedRuns).toBe(6);
      const viewerLog = await viewer.log(workflowId, null);
      for (const runId of runIds) expect(viewerLog).toContain(runId);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  test("does not publish a paraphrase rejected by the independent validator", async () => {
    const paraphrase = "The old man rowed as night fell beyond the shore.";
    const reference = "The old man rowed until the sea forgot the shore.";
    const fixture = createFixture({ id: "hemingway-reject", schedule: false, fixedOutput: paraphrase });
    mkdirSync(fixture.archiveDirectory, { recursive: true });
    writeFileSync(join(fixture.archiveDirectory, "prior-run.md"), `${reference}\n`, "utf8");
    try {
      const runId = await startSingleRun(fixture.root, "hemingway-reject");
      const blocked = await waitForRunStatus(fixture.root, "hemingway-reject", runId, "blocked");
      expect(blocked.block).not.toBeNull();
      const archiveFiles = readdirSync(fixture.archiveDirectory).filter((name) => name.endsWith(".md")).sort();
      expect(archiveFiles).toEqual(["prior-run.md"]);
      expect(readFileSync(join(fixture.archiveDirectory, "prior-run.md"), "utf8").trim()).toBe(reference);
      const activity = readActivity(fixture.activityLog);
      expect(activity.filter((record) => record.role === "validator" && record.event === "verdict")).toMatchObject([
        { passed: false, archiveCount: 1 },
      ]);
      expect(activity.some((record) => record.role === "publisher" && record.event === "start")).toBe(false);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not publish an invalid generator result", async () => {
    const fixture = createFixture({ id: "hemingway-invalid", schedule: false, malformedGenerator: true });
    try {
      const runId = await startSingleRun(fixture.root, "hemingway-invalid");
      const blocked = await waitForRunStatus(fixture.root, "hemingway-invalid", runId, "blocked");
      expect(blocked.block).not.toBeNull();
      expect(readdirSync(fixture.archiveDirectory)).toEqual([]);
      const activity = readActivity(fixture.activityLog);
      expect(activity.filter((record) => record.role === "generator" && record.event === "start")).toHaveLength(1);
      expect(activity.some((record) => record.role === "validator" || record.role === "publisher")).toBe(false);
    } finally {
      await stopService(fixture.root);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});

function createFixture(options: {
  readonly id: string;
  readonly schedule: boolean;
  readonly generatorSleepMs?: number;
  readonly validatorSleepMs?: number;
  readonly fixedOutput?: string;
  readonly malformedGenerator?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), `workshop-${options.id}-`));
  const workshopDirectory = join(root, ".workshop");
  const workflowDirectory = join(workshopDirectory, "workflows");
  const stateDirectory = join(workshopDirectory, "state");
  const archiveDirectory = join(workshopDirectory, "archive", options.id);
  const activityLog = join(stateDirectory, "mock-activity.jsonl");
  mkdirSync(workflowDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });

  const generatorCommand = agentCommand("generator", activityLog, {
    sleepMs: options.generatorSleepMs ?? 0,
    ...(options.fixedOutput === undefined ? {} : { fixedOutput: options.fixedOutput }),
    ...(options.malformedGenerator === true ? { malformed: true } : {}),
  });
  const validatorCommand = agentCommand("validator", activityLog, { sleepMs: options.validatorSleepMs ?? 0 });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), [
    `project_dir: ${JSON.stringify(root)}`,
    "shell: /bin/bash",
    "max_concurrent_runs: 1",
    "agent:",
    "  harness:",
    `    command: ${JSON.stringify(generatorCommand)}`,
    "  model: fixture/mock-model:medium",
    "orchestrator:",
    "  model: fixture/mock-model:low",
    "",
  ].join("\n"), "utf8");

  const publication = publicationCommand(activityLog);
  const workflowLines = [
    "version: 4",
    "description: Exercise scheduled Hemingway generation, independent validation, and per-run publication.",
    ...(options.schedule ? ["schedule:", "  every: 50ms", "  max_runs: 6"] : []),
    "defaults:",
    "  retries: 0",
    "  replay: safe",
    "steps:",
    "  - generate:",
    "      agent:",
    "        instructions: Write one distinct original sentence to the supplied result path.",
    "      verify:",
    "        agent:",
    `          harness:\n            command: ${JSON.stringify(validatorCommand)}`,
    "          instructions: Compare the candidate with archived quotes and write a checked verdict.",
    "  - publish:",
    "      run: |",
    ...publication.split("\n").map((line) => `        ${line}`),
    "      replay: safe",
    "",
  ];
  writeFileSync(join(workflowDirectory, `${options.id}.yaml`), workflowLines.join("\n"), "utf8");
  return { root, stateDirectory, archiveDirectory, activityLog };
}

function agentCommand(
  role: "generator" | "validator",
  activityLog: string,
  options: { readonly sleepMs: number; readonly fixedOutput?: string; readonly malformed?: boolean },
): string {
  return [
    `WORKSHOP_MOCK_ROLE=${role}`,
    `WORKSHOP_MOCK_LAUNCH_LOG=${shellDoubleQuote(activityLog)}`,
    `WORKSHOP_MOCK_ARCHIVE_DIR="$WORKSHOP_ARCHIVE"`,
    `WORKSHOP_MOCK_SLEEP_MS=${options.sleepMs}`,
    ...(options.fixedOutput === undefined ? [] : [`WORKSHOP_MOCK_OUTPUT=${shellDoubleQuote(options.fixedOutput)}`]),
    ...(options.malformed === true ? ["WORKSHOP_MOCK_GENERATOR_RESULT=malformed"] : []),
    `bun ${shellDoubleQuote(agentPath)}`,
  ].join(" ");
}

function publicationCommand(activityLog: string): string {
  return [
    `activity_log=${shellDoubleQuote(activityLog)}`,
    `archive_directory="$WORKSHOP_ARCHIVE"`,
    `printf '{"event":"start","role":"publisher","runId":"%s","pid":%s}\\n' "$WORKSHOP_RUN_ID" "$$" >> "$activity_log"`,
    `mkdir -p "$archive_directory"`,
    `target="$archive_directory/$WORKSHOP_RUN_ID.md"`,
    `if [ -f "$target" ]; then`,
    `  cmp -s "$target" "$WORKSHOP_PREVIOUS_OUTPUT_FILE" || exit 1`,
    `else`,
    `  cp "$WORKSHOP_PREVIOUS_OUTPUT_FILE" "$target"`,
    `fi`,
    `printf '{"event":"finish","role":"publisher","runId":"%s","pid":%s}\\n' "$WORKSHOP_RUN_ID" "$$" >> "$activity_log"`,
    `printf '%s\\n' "$target"`,
  ].join("\n");
}

function shellDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
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
    if (failed !== undefined) throw new Error(`run ${failed.runId} ended ${failed.status}: ${failed.block?.kind ?? failed.failure?.kind ?? "unknown"}`);
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
    await delay(40);
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
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
  const metadataPath = join(root, ".workshop", "state", "service.json");
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
