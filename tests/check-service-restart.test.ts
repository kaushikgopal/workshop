import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { loadCheckedWorkflow, loadInstallation } from "../src/installation/load-installation.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { admitPreparedRun } from "../src/storage/durable/admit-run.js";
import { defineWorkshopTasks, createWorkflowRunTaskInput, parseWorkflowRunTaskInput } from "../src/storage/durable/define-workshop-tasks.js";
import { WorkshopInstallationDoc } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { encodeServiceRequestLine } from "../src/service/parse-service-protocol.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import type { ServiceRequestV1 } from "../src/service/schema.js";
import { serviceLogSectionPageV1Schema, serviceResolveResultV1Schema } from "../src/service/schema.js";
import { runIdSchema } from "../src/run/schema.js";
import { logsDtoSchema, nodeDescriptionDtoSchema, runsDtoSchema, statusDtoSchema } from "../src/views/schema.js";
import { createViewerSource } from "../src/cli/watch.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");
const mockAgentPath = join(REPO_ROOT, "tests/mock/hemingway-node.ts");
const sentence = "The old man rowed until the sea forgot the shore.";

describe("public service restart", () => {
  test("runs the deterministic Hemingway mock and reconnects across a service restart without replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-hemingway-cli-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const state = join(root, ".workshop", "state");
    const launches = join(state, "mock-launches.jsonl");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), [
      "shell: /bin/sh",
      "keep_files: always",
      "agent:",
      "  harness:",
      `    command: 'WORKSHOP_MOCK_SLEEP_MS=800 WORKSHOP_LAUNCH_LOG=${launches} bun ${mockAgentPath}'`,
      "  model: fixture/mock-model:medium",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "hemingway.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "description: Run the deterministic Hemingway worker mock.",
      "steps:",
      "  - generate:",
      "      agent:",
      "        instructions: Write one original sentence in the tagged stdout format.",
      "      verify:",
      "        run: 'printf mock-validator-passed >&2; test -n \"$(cat)\"'",
      "",
    ].join("\n"), "utf8");

    try {
      const validated = runCli(root, ["validate", "hemingway"]);
      expect(validated.status).toBe(0);
      const started = runCli(root, ["start", "hemingway", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForLaunch(launches);

      const activeResult = runCli(root, ["status", "hemingway", "--json"]);
      expect(activeResult.status).toBe(0);
      const active = statusDtoSchema.parse(JSON.parse(activeResult.stdout));
      expect(active.workflows[0]?.unresolvedRun?.runId).toBe(runId);
      expect(active.workflows[0]?.unresolvedRun?.currentNodeId).toBe("generate");
      expect(active.workflows[0]?.unresolvedRun?.status).not.toBe("completed");

      const completed = await waitForRun(root, "hemingway", runId);
      expect(completed.status).toBe("completed");
      expect(completed.terminalOutput).toBe(sentence);
      const logsBeforeRestartResult = runCli(root, ["logs", "hemingway", "--run", runId, "--json"]);
      expect(logsBeforeRestartResult.status).toBe(0);
      const logsBeforeRestart = logsDtoSchema.parse(JSON.parse(logsBeforeRestartResult.stdout));
      expect(logsBeforeRestart.runId).toBe(runId);
      expect(logsBeforeRestart.sections.some((section) => section.kind === "worklog" && section.content.includes("One Hemingway sentence, written by the deterministic mock."))).toBe(true);
      expect(logsBeforeRestart.sections.some((section) => section.kind === "capture" && section.content === "mock-validator-passed")).toBe(true);
      const detailedWorklog = logsBeforeRestart.sections.find((section) => section.kind === "worklog");
      expect(detailedWorklog?.kind).toBe("worklog");
      if (detailedWorklog?.kind !== "worklog") throw new Error("detailed worklog is missing");
      expect(detailedWorklog.content).toContain("Candidate SHA-256");
      const compactLogs = runCli(root, ["logs", "hemingway", "--run", runId]);
      expect(compactLogs.status).toBe(0);
      expect(compactLogs.stdout).toMatch(/- generate #1 succeeded · \d+ms · tagged succeeded · One Hemingway sentence/u);
      expect(compactLogs.stdout).not.toContain("Candidate SHA-256");
      expect(compactLogs.stdout).not.toContain("## Global decision log");
      const firstLaunchCount = readLaunches(launches);
      expect(firstLaunchCount).toBe(1);

      const installationId = active.installationId;
      const firstBootId = active.service.bootId;
      await stopService(root);

      const afterRestart = runCli(root, ["runs", "hemingway", "--json"]);
      expect(afterRestart.status).toBe(0);
      const history = runsDtoSchema.parse(JSON.parse(afterRestart.stdout));
      expect(history.runs.some((run) => run.runId === runId && run.status === "completed")).toBe(true);
      const restartedStatusResult = runCli(root, ["status", "hemingway", "--json"]);
      expect(restartedStatusResult.status).toBe(0);
      const restartedStatus = statusDtoSchema.parse(JSON.parse(restartedStatusResult.stdout));
      expect(restartedStatus.installationId).toBe(installationId);
      expect(restartedStatus.service.bootId).not.toBe(firstBootId);
      const logsAfterRestartResult = runCli(root, ["logs", "hemingway", "--run", runId, "--json"]);
      expect(logsAfterRestartResult.status).toBe(0);
      const logsAfterRestart = logsDtoSchema.parse(JSON.parse(logsAfterRestartResult.stdout));
      expect(logsAfterRestart.runId).toBe(runId);
      expect(readLaunches(launches)).toBe(firstLaunchCount);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("runs two independently mapped mock harnesses through the same process contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-harness-parity-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const traceFile = join(root, "harness-trace.jsonl");
    const argvHarnessPath = join(REPO_ROOT, "tests/mock/read-argv-harness.ts");
    const envHarnessPath = join(REPO_ROOT, "tests/mock/read-env-harness.ts");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nkeep_files: always\n", "utf8");
    writeFileSync(join(workflows, "harness-parity.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - argv-harness:",
      "      agent:",
      "        model: mock-alpha/poet:high",
      "        harness:",
      "          command: >-",
      `            WORKSHOP_HARNESS_TRACE='${traceFile}' bun '${argvHarnessPath}' --model "$WORKSHOP_MODEL_WITH_THINKING"`,
      "        instructions: |",
      "          MOCK_ALPHA_PROMPT_SENTINEL",
      "          Read the prompt from stdin and write a tagged result to stdout.",
      "  - env-harness:",
      "      agent:",
      "        model: mock-beta/editor:low",
      "        harness:",
      "          command: >-",
      `            WORKSHOP_HARNESS_TRACE='${traceFile}' bun '${envHarnessPath}'`,
      "        instructions: |",
      "          MOCK_BETA_PROMPT_SENTINEL",
      "          Read the prompt from stdin and write a tagged result to stdout.",
      "",
    ].join("\n"), "utf8");

    try {
      const validated = runCli(root, ["validate", "harness-parity"]);
      expect(validated.status).toBe(0);
      const started = runCli(root, ["start", "harness-parity"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);

      const historyResult = runCli(root, ["runs", "harness-parity", "--json"]);
      expect(historyResult.status).toBe(0);
      const history = runsDtoSchema.parse(JSON.parse(historyResult.stdout));
      const completed = history.runs.find((run) => run.runId === runId);
      if (completed === undefined) throw new Error("mock harness run is missing from public history");
      const alphaOutput = "alpha:mock-alpha/poet:high:prompt=MOCK_ALPHA_PROMPT_SENTINEL";
      const expectedOutput = `beta:mock-beta/editor:low:prompt=MOCK_BETA_PROMPT_SENTINEL:previous=${alphaOutput}`;
      expect(completed.status).toBe("completed");
      expect(completed.terminalOutput).toBe(expectedOutput);

      const traceEntrySchema = z.strictObject({
        harness: z.enum(["argv", "environment"]),
        model: z.string(),
        promptLength: z.number(),
        promptMarker: z.string(),
        previousOutput: z.string().optional(),
      });
      const trace = readFileSync(traceFile, "utf8").trim().split("\n")
        .map((line) => traceEntrySchema.parse(JSON.parse(line)));
      expect(trace).toHaveLength(2);
      const argvTrace = trace[0];
      const envTrace = trace[1];
      if (argvTrace === undefined || envTrace === undefined) throw new Error("both mock harnesses must write trace records");
      expect(argvTrace).toMatchObject({
        harness: "argv", model: "mock-alpha/poet:high", promptMarker: "MOCK_ALPHA_PROMPT_SENTINEL",
      });
      expect(envTrace).toMatchObject({
        harness: "environment", model: "mock-beta/editor:low", promptMarker: "MOCK_BETA_PROMPT_SENTINEL",
        previousOutput: alphaOutput,
      });
      expect(argvTrace.promptLength).toBeGreaterThan("MOCK_ALPHA_PROMPT_SENTINEL".length);
      expect(envTrace.promptLength).toBeGreaterThan("MOCK_BETA_PROMPT_SENTINEL".length);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("supervises preflight, blocks workers on failure, retries after repair, and reuses only a matching pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-preflight-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workflowPath = join(workflows, "preflight-chain.yaml");
    const gatePath = join(root, "environment-ready.txt");
    const preflightLaunches = join(root, "preflight-launches.txt");
    const workerLaunches = join(root, "worker-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    const workflow = (workerCommand: string) => [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "environment:",
      "  preflight:",
      "    command: >-",
      `      printf preflight-check; printf run >> '${preflightLaunches}'; if test -f '${gatePath}'; then exit 0; else exit 7; fi`,
      "steps:",
      "  - work:",
      "      run: >-",
      `        printf worker >> '${workerLaunches}'; ${workerCommand}`,
      "",
    ].join("\n");
    writeFileSync(workflowPath, workflow("printf first-result"), "utf8");

    try {
      const firstStart = runCli(root, ["start", "preflight-chain", "--detach"]);
      expect(firstStart.status).toBe(0);
      const firstRunId = runIdSchema.parse(firstStart.stdout.match(/Started run (\S+)/)?.[1]);
      const failed = await waitForRunStatus(root, "preflight-chain", firstRunId, "blocked");
      expect(failed.block?.kind).toBe("preflight_failed");
      expect(readFileSync(preflightLaunches, "utf8")).toBe("run");
      expect(existsSync(workerLaunches)).toBe(false);

      const failedLogsResult = runCli(root, ["logs", "preflight-chain", "--run", firstRunId, "--json"]);
      expect(failedLogsResult.status).toBe(0);
      const failedLogs = logsDtoSchema.parse(JSON.parse(failedLogsResult.stdout));
      expect(failedLogs.sections.some((section) => section.kind === "capture" && section.label.includes("preflight") && section.content !== null && section.content.includes("preflight-check"))).toBe(true);

      writeFileSync(gatePath, "ready", "utf8");
      const resume = runCli(root, ["resume", "preflight-chain"]);
      expect(resume.status).toBe(0);
      const repaired = await waitForRunStatus(root, "preflight-chain", firstRunId, "completed");
      expect(repaired.terminalOutput).toBe("first-result");
      expect(readFileSync(preflightLaunches, "utf8")).toBe("runrun");
      expect(readFileSync(workerLaunches, "utf8")).toBe("worker");

      const cachedStart = runCli(root, ["start", "preflight-chain", "--detach"]);
      expect(cachedStart.status).toBe(0);
      const cachedRunId = runIdSchema.parse(cachedStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRunStatus(root, "preflight-chain", cachedRunId, "completed")).terminalOutput).toBe("first-result");
      expect(readFileSync(preflightLaunches, "utf8")).toBe("runrun");
      expect(readFileSync(workerLaunches, "utf8")).toBe("workerworker");

      writeFileSync(workflowPath, workflow("printf changed-definition"), "utf8");
      const changedStart = runCli(root, ["start", "preflight-chain", "--detach"]);
      expect(changedStart.status).toBe(0);
      const changedRunId = runIdSchema.parse(changedStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRunStatus(root, "preflight-chain", changedRunId, "completed")).terminalOutput).toBe("changed-definition");
      expect(readFileSync(preflightLaunches, "utf8")).toBe("runrunrun");
      expect(readFileSync(workerLaunches, "utf8")).toBe("workerworkerworker");
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("stops an active preflight after checked process-group retirement without dispatching a worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-stop-preflight-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const preflightGroupPath = join(root, "preflight-group.pid");
    const preflightChildPath = join(root, "preflight-child.pid");
    const workerStarted = join(root, "worker-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "preflight-stop.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "environment:",
      "  preflight:",
      "    command: >-",
      `      echo $$ > '${preflightGroupPath}'; (sleep 60) & echo $! > '${preflightChildPath}'; wait`,
      "steps:",
      "  - work:",
      `      run: 'printf started > ${workerStarted}; printf worker-result'`,
      "",
    ].join("\n"), "utf8");
    try {
      const started = runCli(root, ["start", "preflight-stop", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const groupId = await waitForPositiveIntegerFile(preflightGroupPath);
      const childId = await waitForPositiveIntegerFile(preflightChildPath);
      expect(isProcessGroupAlive(groupId)).toBe(true);
      expect(Number.isSafeInteger(childId) && childId > 0).toBe(true);
      const stopping = spawnCli(root, ["stop", "preflight-stop"]);
      const stopped = await stopping.completion;
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("cancelled (stopped)");
      await waitForProcessGroupGone(groupId);
      const run = await waitForRunStatus(root, "preflight-stop", runId, "cancelled");
      expect(run.status).toBe("cancelled");
      expect(existsSync(workerStarted)).toBe(false);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("client disconnect does not cancel a Durable run", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-client-disconnect-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workerStarted = join(root, "worker-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "disconnect.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - wait:",
      `      run: 'printf started > ${workerStarted}; sleep 0.5; printf client-disconnected'`,
      "",
    ].join("\n"), "utf8");

    try {
      const client = spawnCli(root, ["start", "disconnect"]);
      await waitForFile(workerStarted);
      expect(client.child.kill("SIGKILL")).toBe(true);
      const disconnected = await client.completion;
      expect(disconnected.status).not.toBe(0);

      // A killed client can disappear before the admission response reaches stdout.
      const history = runsDtoSchema.parse(JSON.parse(runCli(root, ["runs", "disconnect", "--json"]).stdout));
      expect(history.runs).toHaveLength(1);
      const runId = history.runs[0]!.runId;
      const completed = await waitForRun(root, "disconnect", runId);
      expect(completed.status).toBe("completed");
      expect(completed.terminalOutput).toBe("client-disconnected");
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("graceful pause finishes an active validator and holds successors until resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-pause-boundary-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workerStarted = join(root, "worker-started.txt");
    const validatorFinished = join(root, "validator-finished.txt");
    const successorStarted = join(root, "successor-started.txt");
    const otherStarted = join(root, "other-workflow-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "pause-chain.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - first:",
      "      run: >-",
      `        printf started > '${workerStarted}'; sleep 1; printf first-result`,
      "      verify:",
      "        run: >-",
      `          sleep 0.2; test -n \"$(cat)\" && printf done > '${validatorFinished}'`,
      "  - second:",
      "      run: >-",
      `        printf started >> '${successorStarted}'; sleep 0.5; printf second-result`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "other.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - mark:",
      `      run: 'printf started > ${otherStarted}; sleep 1; printf other-result'`,
      "",
    ].join("\n"), "utf8");


    try {
      const started = runCli(root, ["start", "pause-chain", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(workerStarted);

      const pause = runCli(root, ["pause", "pause-chain"]);
      expect(pause.status).toBe(0);
      expect(pause.stdout).toContain("running (paused)");
      const repeatedPause = runCli(root, ["pause", "pause-chain"]);
      expect(repeatedPause.status).toBe(0);

      const otherWhileFinishing = runCli(root, ["start", "other", "--detach"]);
      expect(otherWhileFinishing.status).not.toBe(0);
      expect(otherWhileFinishing.stdout + otherWhileFinishing.stderr).not.toBe("");
      expect(existsSync(otherStarted)).toBe(false);

      await waitForFile(validatorFinished);
      const firstNode = await waitForNodeStatus(root, "pause-chain", runId, "first", "succeeded");
      expect(firstNode.node.status).toBe("succeeded");
      const pausedRun = await waitForRunStatus(root, "pause-chain", runId, "paused");
      expect(pausedRun.currentNodeId).toBe("second");
      expect(existsSync(successorStarted)).toBe(false);

      const metadataPath = join(root, ".workshop", "state", "service.json");
      const oldService = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; bootId: string };
      process.kill(oldService.pid, "SIGKILL");
      await waitForPidGone(oldService.pid);
      const reopenedStatus = runCli(root, ["status", "pause-chain", "--json"]);
      expect(reopenedStatus.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(reopenedStatus.stdout)).service.bootId).not.toBe(oldService.bootId);
      expect((await waitForRunStatus(root, "pause-chain", runId, "paused")).status).toBe("paused");

      const pausedStatus = runCli(root, ["status", "pause-chain", "--json"]);
      expect(pausedStatus.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(pausedStatus.stdout)).workflows[0]?.unresolvedRun?.status).toBe("paused");

      const duplicateStart = runCli(root, ["start", "pause-chain", "--detach"]);
      expect(duplicateStart.status).toBe(0);
      expect(duplicateStart.stdout.match(/(?:Started|Using existing) run (\S+)/)?.[1]).toBe(runId);

      const otherStart = runCli(root, ["start", "other", "--detach"]);
      expect(otherStart.status).toBe(0);
      const otherRunId = runIdSchema.parse(otherStart.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(otherStarted);
      const resumeWhileAtCapacity = runCli(root, ["resume", "pause-chain"]);
      expect(resumeWhileAtCapacity.status).toBe(0);
      const capacityWait = await waitForRunStatus(root, "pause-chain", runId, "queued");
      expect(capacityWait.waitingForCapacity).toBe(true);
      const waitingStatus = runCli(root, ["status", "pause-chain", "--json"]);
      expect(statusDtoSchema.parse(JSON.parse(waitingStatus.stdout)).workflows[0]?.unresolvedRun?.waitingForCapacity).toBe(true);

      expect(runCli(root, ["pause", "pause-chain"]).status).toBe(0);
      const pausedCapacityWait = await waitForRunStatus(root, "pause-chain", runId, "queued");
      expect(pausedCapacityWait.desiredState).toBe("paused");
      expect(pausedCapacityWait.waitingForCapacity).toBe(true);
      expect((await waitForRun(root, "other", otherRunId)).status).toBe("completed");
      expect(existsSync(successorStarted)).toBe(false);
      expect(runCli(root, ["resume", "pause-chain"]).status).toBe(0);
      expect((await waitForRunStatus(root, "pause-chain", runId, "running")).waitingForCapacity).toBe(false);
      const repeatedResume = runCli(root, ["resume", "pause-chain"]);
      expect(repeatedResume.status).toBe(0);
      await waitForFile(successorStarted);
      const pauseFinalNode = runCli(root, ["pause", "pause-chain"]);
      expect(pauseFinalNode.status).toBe(0);
      const completed = await waitForRun(root, "pause-chain", runId);
      expect(completed.status).toBe("completed");
      expect(completed.terminalOutput).toBe("second-result");
      expect(readFileSync(successorStarted, "utf8")).toBe("started");
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("safe validator replay pauses, releases capacity, and waits for its persisted gate after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-safe-replay-capacity-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workerLaunches = join(root, "worker-launches.txt");
    const validatorLaunches = join(root, "validator-launches.txt");
    const validatorPgidPath = join(root, "validator-pgid.txt");
    const holderStarted = join(root, "holder-started.txt");
    const releaseHolder = join(root, "release-holder.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "safe-replay.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - work:",
      "      retries: 1",
      "      replay: safe",
      "      run: >-",
      `        printf w >> '${workerLaunches}'; printf candidate-output`,
      "      verify:",
      "        run: >-",
      `          printf v >> '${validatorLaunches}'; if [ "$(wc -c < '${validatorLaunches}')" -eq 1 ]; then printf '%s' "$$" > '${validatorPgidPath}'; sleep 60; else printf validator-replayed; fi`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "holder.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - hold:",
      "      run: >-",
      `        printf started > '${holderStarted}'; while [ ! -f '${releaseHolder}' ]; do sleep 0.02; done; printf holder-released`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "safe-replay", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const oldPgid = await waitForPositiveIntegerFile(validatorPgidPath);
      if (!Number.isSafeInteger(oldPgid) || oldPgid <= 0) throw new Error("validator fixture did not record its process group");
      const beforePause = runCli(root, ["step", "describe", "safe-replay", "work", "--run", runId, "--json"]);
      expect(beforePause.status).toBe(0);
      const originalNode = nodeDescriptionDtoSchema.parse(JSON.parse(beforePause.stdout)).node;
      expect(originalNode.attempts).toHaveLength(1);
      const originalAttempt = originalNode.attempts[0];
      if (originalAttempt === undefined) throw new Error("safe replay attempt is missing");
      expect(originalAttempt.candidate).not.toBeNull();
      expect(originalAttempt.processes.filter((entry) => entry.role === "validator")).toHaveLength(1);

      const pause = runCli(root, ["pause", "safe-replay"]);
      expect(pause.status).toBe(0);
      const oldService = JSON.parse(readFileSync(join(root, ".workshop", "state", "service.json"), "utf8")) as { pid: number; bootId: string };
      process.kill(oldService.pid, "SIGKILL");
      await waitForPidGone(oldService.pid);

      const reopened = runCli(root, ["status", "safe-replay", "--json"]);
      expect(reopened.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(reopened.stdout)).service.bootId).not.toBe(oldService.bootId);
      const paused = await waitForRunStatus(root, "safe-replay", runId, "paused");
      expect(paused.desiredState).toBe("paused");
      expect(paused.waitingForCapacity).toBe(false);
      await waitForProcessGroupGone(oldPgid);
      expect(readFileSync(workerLaunches, "utf8")).toBe("w");
      expect(readFileSync(validatorLaunches, "utf8")).toBe("v");

      const pausedNodeResult = runCli(root, ["step", "describe", "safe-replay", "work", "--run", runId, "--json"]);
      expect(pausedNodeResult.status).toBe(0);
      const pausedAttempt = nodeDescriptionDtoSchema.parse(JSON.parse(pausedNodeResult.stdout)).node.attempts[0];
      if (pausedAttempt === undefined) throw new Error("paused safe replay attempt is missing");
      expect(pausedAttempt.candidate).toEqual(originalAttempt.candidate);
      expect(pausedAttempt.processes.filter((entry) => entry.role === "validator").map((entry) => entry.cleanupState)).toEqual(["confirmed_dead"]);

      const holderStart = runCli(root, ["start", "holder", "--detach"]);
      expect(holderStart.status).toBe(0);
      const holderRunId = runIdSchema.parse(holderStart.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(holderStarted);
      const resumed = runCli(root, ["resume", "safe-replay"]);
      expect(resumed.status).toBe(0);
      const waiting = await waitForRunStatus(root, "safe-replay", runId, "queued");
      expect(waiting.waitingForCapacity).toBe(true);
      expect(readFileSync(workerLaunches, "utf8")).toBe("w");
      expect(readFileSync(validatorLaunches, "utf8")).toBe("v");
      expect((await waitForRunStatus(root, "holder", holderRunId, "running")).status).toBe("running");

      writeFileSync(releaseHolder, "release", "utf8");
      expect((await waitForRun(root, "holder", holderRunId)).status).toBe("completed");
      const completed = await waitForRun(root, "safe-replay", runId);
      expect(completed.status).toBe("completed");
      expect(completed.terminalOutput).toBe("candidate-output");
      expect(readFileSync(workerLaunches, "utf8")).toBe("w");
      expect(readFileSync(validatorLaunches, "utf8")).toBe("vv");

      const finalNodeResult = runCli(root, ["step", "describe", "safe-replay", "work", "--run", runId, "--json"]);
      expect(finalNodeResult.status).toBe(0);
      const finalNode = nodeDescriptionDtoSchema.parse(JSON.parse(finalNodeResult.stdout)).node;
      expect(finalNode.attempts).toHaveLength(1);
      const finalAttempt = finalNode.attempts[0];
      if (finalAttempt === undefined) throw new Error("completed safe replay attempt is missing");
      expect(finalAttempt.candidate).toEqual(originalAttempt.candidate);
      const validators = finalAttempt.processes.filter((entry) => entry.role === "validator");
      expect(validators.map((entry) => entry.incarnationNumber)).toEqual([1, 2]);
      expect(new Set(validators.map((entry) => entry.executionId)).size).toBe(1);
      expect(new Set(validators.map((entry) => entry.deadlineAt)).size).toBe(1);
      expect(new Set(validators.map((entry) => entry.incarnationId)).size).toBe(2);
      expect(validators[0]?.status).toBe("blocked");
      expect(validators[0]?.exit).toBeNull();
      expect(validators[0]?.cleanupState).toBe("confirmed_dead");
      expect(validators[1]?.status).toBe("exited");
      const historyResult = runCli(root, ["runs", "safe-replay", "--json"]);
      expect(historyResult.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(historyResult.stdout)).runs.map((entry) => entry.runId)).toEqual([runId]);
    } finally {
      writeFileSync(releaseHolder, "release", "utf8");
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("human retry, accept, and fail require evidence and retain idempotent receipts", async () => {
    const retryRoot = mkdtempSync(join(tmpdir(), "workshop-resolve-retry-"));
    const retryMarker = join(retryRoot, "worker-launches.txt");
    try {
      const retryStarted = join(retryRoot, "retry-started.txt");
      const retry = await startBlockedCommandRun(retryRoot, "retryable", `printf w >> '${retryMarker}'; if [ ! -f '${join(retryRoot, "attempt-")}-$WORKSHOP_RUN_ID' ]; then touch '${join(retryRoot, "attempt-")}-$WORKSHOP_RUN_ID'; sleep 60; else touch '${retryStarted}'; sleep 3; printf retry-success; fi`);
      const resume = runCli(retryRoot, ["resume", "retryable"]);
      expect(resume.status).not.toBe(0);
      expect(resume.stderr).toContain("resolve the current block");
      const missingOverrides = runCli(retryRoot, ["resolve", "retryable", "--action", "retry", "--reason", "retry after checking the external effect"]);
      expect(missingOverrides.status).not.toBe(0);
      expect(missingOverrides.stderr).toContain("requires --allow-repeat");
      expect(missingOverrides.stdout).toContain(`Resolving run ${retry.runId}`);
      const retryService = JSON.parse(readFileSync(join(retryRoot, ".workshop", "state", "service.json"), "utf8")) as { socketPath: string };
      const retryRequest = { version: 1 as const, requestId: randomUUID(), method: "resolve" as const, workflowId: "retryable", action: "retry" as const, reason: "retry after checking the external effect", allowRepeat: true };
      await dropFirstServiceReply(retryService.socketPath, retryRequest);
      await waitForFileLength(retryMarker, 2);
      await waitForFile(retryStarted);
      const retried = await sendServiceRequest(retryService.socketPath, retryRequest);
      expect(retried.ok).toBe(true);
      if (!retried.ok) throw new Error("retry resolution receipt was not replayed while the new worker was live");
      const retryResult = serviceResolveResultV1Schema.parse(retried.result);
      expect(retryResult).toMatchObject({ workflowId: "retryable", runId: retry.runId, status: "queued" });
      const retryReplay = await sendServiceRequest(retryService.socketPath, retryRequest);
      expect(retryReplay).toEqual(retried);
      const retryRun = await waitForRun(retryRoot, "retryable", retry.runId);
      expect(retryRun.status).toBe("completed");
      expect(retryRun.terminalOutput).toBe("retry-success");
      expect(readFileSync(retryMarker, "utf8")).toBe("ww");
      const retryNodeResult = runCli(retryRoot, ["step", "describe", "retryable", "work", "--run", retry.runId, "--json"]);
      expect(retryNodeResult.status).toBe(0);
      const retryNode = nodeDescriptionDtoSchema.parse(JSON.parse(retryNodeResult.stdout)).node;
      expect(retryNode.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
      expect(retryNode.attempts.map((attempt) => attempt.status)).toEqual(["interrupted", "succeeded"]);
      const retryLogs = runCli(retryRoot, ["logs", "retryable", "--run", retry.runId, "--json"]);
      expect(retryLogs.status).toBe(0);
      expect(logsDtoSchema.parse(JSON.parse(retryLogs.stdout)).sections.some((section) => section.kind === "worklog" && section.content.includes("retry after checking the external effect"))).toBe(true);
    } finally {
      await stopService(retryRoot);
      rmSync(retryRoot, { recursive: true, force: true });
    }

    const acceptRoot = mkdtempSync(join(tmpdir(), "workshop-resolve-accept-"));
    const acceptMarker = join(acceptRoot, "worker-launches.txt");
    const acceptedValidatorMarker = join(acceptRoot, "validator-launches.txt");
    const acceptedValidatorStarted = join(acceptRoot, "accepted-validator-started.txt");
    try {
      const blocked = await startBlockedCommandRun(
        acceptRoot,
        "acceptable",
        "printf w >> '" + acceptMarker + "'; sleep 60",
        { validatorCommand: "printf v >> '" + acceptedValidatorMarker + "'; touch '" + acceptedValidatorStarted + "'; sleep 3; test -n \"$(cat)\"" },
      );
      const resultFile = join(acceptRoot, "accepted-result.json");
      writeFileSync(resultFile, "human-accepted", "utf8");
      const cliAcceptance = runCli(acceptRoot, [
        "resolve", "acceptable", "--action", "accept", "--reason", "the recorded worker effect was checked",
        "--result-file", resultFile, "--acknowledge-effects",
      ]);
      expect(cliAcceptance.status).toBe(0);
      await waitForFile(acceptedValidatorStarted);

      const acceptService = JSON.parse(readFileSync(join(acceptRoot, ".workshop", "state", "service.json"), "utf8")) as { socketPath: string };
      const acceptRequest = {
        version: 1 as const,
        requestId: randomUUID(),
        method: "resolve" as const,
        workflowId: "acceptable",
        action: "accept" as const,
        reason: "the recorded worker effect was checked",
        resultFile,
        acknowledgeEffects: true,
      };
      const directAcceptance = await sendServiceRequest(acceptService.socketPath, acceptRequest);
      expect(directAcceptance.ok).toBe(false);
      const acceptedRun = await waitForRun(acceptRoot, "acceptable", blocked.runId);
      expect(acceptedRun.status).toBe("completed");
      expect(acceptedRun.terminalOutput).toBe("human-accepted");
      expect(readFileSync(acceptMarker, "utf8")).toBe("w");
      expect(readFileSync(acceptedValidatorMarker, "utf8")).toBe("v");
      const acceptedNode = runCli(acceptRoot, ["step", "describe", "acceptable", "work", "--run", blocked.runId, "--json"]);
      expect(acceptedNode.status).toBe(0);
      const acceptedDescription = nodeDescriptionDtoSchema.parse(JSON.parse(acceptedNode.stdout));
      expect(acceptedDescription.node.successfulOutput).toBe("human-accepted");
      expect(acceptedDescription.node.attempts[0]?.operatorAcceptances).toMatchObject([{ provenance: "human" }]);
    } finally {
      await stopService(acceptRoot);
      rmSync(acceptRoot, { recursive: true, force: true });
    }

    const failRoot = mkdtempSync(join(tmpdir(), "workshop-resolve-fail-"));
    const failMarker = join(failRoot, "worker-launches.txt");
    try {
      const blocked = await startBlockedCommandRun(failRoot, "fail-run", `printf w >> '${failMarker}'; sleep 60`);
      const service = JSON.parse(readFileSync(join(failRoot, ".workshop", "state", "service.json"), "utf8")) as { socketPath: string };
      const request = { version: 1 as const, requestId: randomUUID(), method: "resolve" as const, workflowId: "fail-run", action: "fail" as const, reason: "the external effect cannot be safely repeated" };
      await dropFirstServiceReply(service.socketPath, request);
      const firstResolution = await sendServiceRequest(service.socketPath, request);
      const duplicateResolution = await sendServiceRequest(service.socketPath, request);
      expect(firstResolution.ok).toBe(true);
      expect(duplicateResolution.ok).toBe(true);
      if (!firstResolution.ok || !duplicateResolution.ok) throw new Error("the committed operator resolution was not replayed after openRunId cleared");
      const firstResult = serviceResolveResultV1Schema.parse(firstResolution.result);
      const duplicateResult = serviceResolveResultV1Schema.parse(duplicateResolution.result);
      expect(duplicateResult).toEqual(firstResult);
      expect(firstResult.status).toBe("failed");
      const history = runCli(failRoot, ["runs", "fail-run", "--json"]);
      expect(history.status).toBe(0);
      const failedRun = runsDtoSchema.parse(JSON.parse(history.stdout)).runs.find((entry) => entry.runId === blocked.runId);
      expect(failedRun?.status).toBe("failed");
      expect(failedRun?.failure?.kind).toBe("operator");
      if (failedRun?.failure?.kind !== "operator") throw new Error("operator failure was not retained");
      expect(failedRun.failure.reason).toBe("the external effect cannot be safely repeated");
      const failureLogs = runCli(failRoot, ["logs", "fail-run", "--run", blocked.runId, "--json"]);
      expect(failureLogs.status).toBe(0);
      const failureSections = logsDtoSchema.parse(JSON.parse(failureLogs.stdout)).sections;
      expect(failureSections.map((section) => section.content).join("\n")).toContain("the external effect cannot be safely repeated");
      const failureNodeResult = runCli(failRoot, ["step", "describe", "fail-run", "work", "--run", blocked.runId, "--json"]);
      expect(failureNodeResult.status).toBe(0);
      expect(nodeDescriptionDtoSchema.parse(JSON.parse(failureNodeResult.stdout)).runFailure?.kind).toBe("operator");
    } finally {
      await stopService(failRoot);
      rmSync(failRoot, { recursive: true, force: true });
    }
  }, 60_000);


  test("capacity waiting survives service restart without dispatching twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-capacity-restart-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const waiterStarted = join(root, "waiter-started.txt");
    const holderStarted = join(root, "holder-started.txt");
    const holderPgid = join(root, "holder-pgid.txt");
    const successorStarted = join(root, "successor-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "waiter.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - first:",
      "      run: >-",
      `        printf 'started\\n' >> '${waiterStarted}'; sleep 0.5; printf first-result`,
      "  - second:",
      "      run: >-",
      `        printf started >> '${successorStarted}'; sleep 0.2; printf second-result`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "holder.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - hold:",
      "      run: >-",
      `        printf '%s' "$$" > '${holderPgid}'; printf started > '${holderStarted}'; sleep 10; printf holder-result`,
      "",
    ].join("\n"), "utf8");

    try {
      const waiterStart = runCli(root, ["start", "waiter", "--detach"]);
      expect(waiterStart.status).toBe(0);
      const waiterRunId = runIdSchema.parse(waiterStart.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(waiterStarted);
      expect(readFileSync(waiterStarted, "utf8").trim().split("\n")).toHaveLength(1);
      expect(runCli(root, ["pause", "waiter"]).status).toBe(0);
      expect((await waitForRunStatus(root, "waiter", waiterRunId, "paused")).currentNodeId).toBe("second");

      const holderStart = runCli(root, ["start", "holder", "--detach"]);
      expect(holderStart.status).toBe(0);
      await waitForFile(holderStarted);
      expect(runCli(root, ["resume", "waiter"]).status).toBe(0);
      expect((await waitForRunStatus(root, "waiter", waiterRunId, "queued")).waitingForCapacity).toBe(true);
      expect(runCli(root, ["pause", "waiter"]).status).toBe(0);
      const pausedWaiting = await waitForRunStatus(root, "waiter", waiterRunId, "queued");
      expect(pausedWaiting.desiredState).toBe("paused");
      expect(pausedWaiting.waitingForCapacity).toBe(true);
      expect(existsSync(successorStarted)).toBe(false);

      const metadataPath = join(root, ".workshop", "state", "service.json");
      const oldService = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; bootId: string };
      await stopService(root);
      const stoppedService = JSON.parse(readFileSync(metadataPath, "utf8")) as { status?: unknown };
      expect(stoppedService.status).toBe("stopped");
      await waitForPidGone(oldService.pid);
      await waitForProcessGroupGone(Number(readFileSync(holderPgid, "utf8")));

      const reopened = runCli(root, ["status", "waiter", "--json"]);
      expect(reopened.status).toBe(0);
      const reopenedDto = statusDtoSchema.parse(JSON.parse(reopened.stdout));
      expect(reopenedDto.service.bootId).not.toBe(oldService.bootId);
      expect(reopenedDto.workflows[0]?.unresolvedRun?.runId).toBe(waiterRunId);
      expect(reopenedDto.workflows[0]?.unresolvedRun?.status).toBe("queued");
      expect(reopenedDto.workflows[0]?.unresolvedRun?.desiredState).toBe("paused");
      const reopenedRuns = runCli(root, ["runs", "waiter", "--json"]);
      expect(reopenedRuns.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(reopenedRuns.stdout)).runs.map((run) => run.runId)).toEqual([waiterRunId]);
      expect(readFileSync(waiterStarted, "utf8").trim().split("\n")).toHaveLength(1);
      expect(reopenedDto.workflows[0]?.unresolvedRun?.waitingForCapacity).toBe(true);
      const stoppedWaiting = runCli(root, ["stop", "waiter"]);
      if (stoppedWaiting.status !== 0) throw new Error(`${stoppedWaiting.stdout} ${stoppedWaiting.stderr}`);
      const stoppedRuns = runCli(root, ["runs", "waiter", "--json"]);
      expect(runsDtoSchema.parse(JSON.parse(stoppedRuns.stdout)).runs.find((entry) => entry.runId === waiterRunId)?.status).toBe("cancelled");
      expect(existsSync(successorStarted)).toBe(false);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("retry exhaustion is terminal even when the run is paused", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-paused-failure-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workerStarted = join(root, "failing-worker-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "paused-failure.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - fail:",
      "      run: >-",
      `        printf started > '${workerStarted}'; sleep 1; exit 7`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "paused-failure", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(workerStarted);
      const pause = runCli(root, ["pause", "paused-failure"]);
      expect(pause.status).toBe(0);

      const failedAttempt = await waitForAttemptStatus(root, "paused-failure", runId, "fail", "failed");
      expect(failedAttempt.node.status).toBe("failed");
      const failed = await waitForRunStatus(root, "paused-failure", runId, "failed");
      expect(failed.status).toBe("failed");
      const status = runCli(root, ["status", "paused-failure", "--json"]);
      expect(status.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(status.stdout)).workflows[0]?.unresolvedRun).toBeNull();
      const resume = runCli(root, ["resume", "paused-failure"]);
      expect(resume.status).toBe(0);
      expect((await waitForRunStatus(root, "paused-failure", runId, "failed")).status).toBe("failed");
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("stop cancels at a safe boundary and retires an active worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-stop-boundary-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const safeWorkerStarted = join(root, "safe-worker-started.txt");
    const safeSuccessorStarted = join(root, "safe-successor-started.txt");
    const activePidPath = join(root, "active-worker.pid");
    const activeTermPath = join(root, "active-worker-term.txt");
    const afterStopStarted = join(root, "after-stop-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "safe-stop.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - first:",
      "      run: >-",
      `        printf started > '${safeWorkerStarted}'; sleep 1; printf first-result`,
      "  - second:",
      `      run: 'printf started > ${safeSuccessorStarted}; printf second-result'`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "active-stop.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - wait:",
      "      run: >-",
      `        trap "printf term > '${activeTermPath}'; trap '' TERM; sleep 30" TERM;`,
      `        echo $$ > '${activePidPath}';`,
      "        while :; do sleep 1; done",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "after-stop.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - mark:",
      `      run: 'printf started > ${afterStopStarted}; printf released-slot'`,
      "",
    ].join("\n"), "utf8");

    try {
      const safeStart = runCli(root, ["start", "safe-stop", "--detach"]);
      expect(safeStart.status).toBe(0);
      const safeRunId = runIdSchema.parse(safeStart.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(safeWorkerStarted);
      const pause = runCli(root, ["pause", "safe-stop"]);
      expect(pause.status).toBe(0);
      await waitForNodeStatus(root, "safe-stop", safeRunId, "first", "succeeded");
      const pausedRun = await waitForRunStatus(root, "safe-stop", safeRunId, "paused");
      expect(pausedRun.currentNodeId).toBe("second");

      const safeStop = runCli(root, ["stop", "safe-stop"]);
      expect(safeStop.status).toBe(0);
      expect(safeStop.stdout).toContain("cancelled (stopped)");
      const safeCancelled = await waitForRunStatus(root, "safe-stop", safeRunId, "cancelled");
      expect(safeCancelled.status).toBe("cancelled");
      expect(existsSync(safeSuccessorStarted)).toBe(false);
      const safeStatus = runCli(root, ["status", "safe-stop", "--json"]);
      expect(statusDtoSchema.parse(JSON.parse(safeStatus.stdout)).workflows[0]?.activation?.state).toBe("stopped");

      const activeStart = runCli(root, ["start", "active-stop", "--detach"]);
      expect(activeStart.status).toBe(0);
      const activeRunId = runIdSchema.parse(activeStart.stdout.match(/Started run (\S+)/)?.[1]);
      const processGroupId = await waitForPositiveIntegerFile(activePidPath);
      expect(Number.isSafeInteger(processGroupId)).toBe(true);
      if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) throw new Error("active stop fixture did not record a process-group ID");

      const activeStop = spawnCli(root, ["stop", "active-stop"]);
      await waitForFile(activeTermPath);
      expect(isProcessGroupAlive(processGroupId)).toBe(true);
      const concurrentStart = runCli(root, ["start", "after-stop", "--detach"]);
      expect(concurrentStart.status).not.toBe(0);
      expect(concurrentStart.stdout + concurrentStart.stderr).not.toBe("");
      expect(existsSync(afterStopStarted)).toBe(false);

      const pauseDuringStop = runCli(root, ["pause", "active-stop"]);
      expect(pauseDuringStop.status).not.toBe(0);
      expect(pauseDuringStop.stderr).toContain("run_stopped");
      const stopped = await activeStop.completion;
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("cancelled (stopped)");
      await waitForProcessGroupGone(processGroupId);
      const activeCancelled = await waitForRunStatus(root, "active-stop", activeRunId, "cancelled");
      expect(activeCancelled.status).toBe("cancelled");
      const activeDescription = runCli(root, ["step", "describe", "active-stop", "wait", "--run", activeRunId, "--json"]);
      expect(activeDescription.status).toBe(0);
      const activeAttempt = nodeDescriptionDtoSchema.parse(JSON.parse(activeDescription.stdout)).node.attempts[0];
      expect(activeAttempt?.status).toBe("cancelled");
      expect(activeAttempt?.processes.filter((entry) => entry.role === "worker")).toMatchObject([
        { status: "exited", exit: { kind: "signal" }, cleanupState: "confirmed_dead" },
      ]);

      const afterCleanup = runCli(root, ["start", "after-stop", "--detach"]);
      expect(afterCleanup.status).toBe(0);
      await waitForFile(afterStopStarted);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);


  test("stops a validator process group with descendants and preserves its candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-stop-validator-descendants-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const validatorGroupPath = join(root, "validator-group.pid");
    const validatorChildPath = join(root, "validator-child.pid");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "validator-stop.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - validate:",
      "      run: \"printf candidate\"",
      "      verify:",
      "        run: >-",
      `          echo $$ > '${validatorGroupPath}';`,
      "          (sleep 60) &",
      `          echo $! > '${validatorChildPath}';`,
      "          wait",
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "validator-stop", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const validatorGroupId = await waitForPositiveIntegerFile(validatorGroupPath);
      const validatorChildId = await waitForPositiveIntegerFile(validatorChildPath);
      expect(Number.isSafeInteger(validatorGroupId) && validatorGroupId > 0).toBe(true);
      expect(Number.isSafeInteger(validatorChildId) && validatorChildId > 0).toBe(true);
      expect(isProcessGroupAlive(validatorGroupId)).toBe(true);
      process.kill(validatorChildId, 0);

      const stopping = spawnCli(root, ["stop", "validator-stop"]);
      const stopped = await stopping.completion;
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("cancelled (stopped)");
      await waitForProcessGroupGone(validatorGroupId);
      const run = await waitForRunStatus(root, "validator-stop", runId, "cancelled");
      expect(run.status).toBe("cancelled");
      const description = runCli(root, ["step", "describe", "validator-stop", "validate", "--run", runId, "--json"]);
      expect(description.status).toBe(0);
      const node = nodeDescriptionDtoSchema.parse(JSON.parse(description.stdout)).node;
      const attempt = node.attempts[0];
      expect(attempt?.status).toBe("cancelled");
      expect(attempt?.candidate?.kind).toBe("candidate");
      expect(attempt?.candidate?.byteCount).toBeGreaterThan(0);
      expect(attempt?.validatorExecutionId).not.toBeNull();
      expect(attempt?.processes.filter((entry) => entry.role === "validator")).toMatchObject([
        { status: "exited", exit: { kind: "signal" }, cleanupState: "confirmed_dead" },
      ]);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("retires an uncertain process group on service restart without relaunching the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-uncertain-process-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const pidPath = join(root, "worker.pid");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "long-process.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - wait:",
      `      run: 'echo $$ > ${pidPath}; sleep 20'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "long-process", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const workerPid = await waitForPositiveIntegerFile(pidPath);
      expect(Number.isSafeInteger(workerPid)).toBe(true);
      if (!Number.isSafeInteger(workerPid) || workerPid <= 0) throw new Error("worker pid fixture did not record a positive process id");
      const serviceMetadataPath = join(root, ".workshop", "state", "service.json");
      const oldService = JSON.parse(readFileSync(serviceMetadataPath, "utf8")) as { pid: number; bootId: string };
      process.kill(oldService.pid, "SIGKILL");
      await waitForPidGone(oldService.pid);

      const historyResult = runCli(root, ["runs", "long-process", "--json"]);
      expect(historyResult.status).toBe(0);
      const history = runsDtoSchema.parse(JSON.parse(historyResult.stdout));
      const interrupted = history.runs.find((run) => run.runId === runId);
      expect(interrupted).toBeDefined();
      expect(interrupted?.status).not.toBe("completed");
      const statusResult = runCli(root, ["status", "long-process", "--json"]);
      expect(statusResult.status).toBe(0);
      const status = statusDtoSchema.parse(JSON.parse(statusResult.stdout));
      expect(status.service.bootId).not.toBe(oldService.bootId);
      const logsResult = runCli(root, ["logs", "long-process", "--run", runId, "--json"]);
      expect(logsResult.status).toBe(0);
      expect(logsDtoSchema.parse(JSON.parse(logsResult.stdout)).runId).toBe(runId);
      expect(Number(readFileSync(pidPath, "utf8").trim())).toBe(workerPid);
      await waitForProcessGroupGone(workerPid);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("recovers retained log metadata without confirming process death", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-retention-reopen-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const state = join(root, ".workshop", "state");
    const workerLaunches = join(state, "worker-launches.jsonl");
    const validatorLaunches = join(root, "validator-launches.txt");
    const successorLaunches = join(root, "successor-launches.txt");
    const capBytes = 32 * 1024 * 1024;
    const totalBytes = 34_000_000;
    mkdirSync(workflows, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), [
      "shell: /bin/sh",
      "stream_cap: 32mb",
      "agent:",
      "  harness:",
      `    command: 'WORKSHOP_LAUNCH_LOG=${workerLaunches} bun ${mockAgentPath}'`,
      "  model: fixture/mock-model:medium",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "capture-recovery.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - capture:",
      "      agent:",
      "        instructions: Write one original sentence in the tagged stdout format.",
      "      verify:",
      "        run: |",
      `          printf validator >> '${validatorLaunches}'`,
      `          head -c ${totalBytes} /dev/zero | tr '\\000' x >&2`,
      "          test -n \"$(cat)\"",
      "  - finish:",
      "      run: |",
      `        printf successor >> '${successorLaunches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "capture-recovery", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const oldService = JSON.parse(readFileSync(join(state, "service.json"), "utf8")) as { pid: number; bootId: string };
      const retainedPath = await waitForRetainedCapture(join(state, "captures", runId, "capture.1"), capBytes);
      const receipt: unknown = JSON.parse(readFileSync(`${retainedPath}.retention.json`, "utf8"));
      const retained = readFileSync(retainedPath);
      expect(retained.byteLength).toBe(capBytes);
      expect(receipt).toMatchObject({
        version: 1, capBytes, totalBytes, retainedBytes: capBytes, truncatedBytes: totalBytes - capBytes,
        keptHeadBytes: 22_369_622, keptTailBytes: 11_184_810,
        retainedSha256: `sha256:${createHash("sha256").update(retained).digest("hex")}`,
      });

      process.kill(oldService.pid, "SIGKILL");
      await waitForPidGone(oldService.pid);
      const restartResult = runCli(root, ["runs", "capture-recovery", "--json"], 60_000);
      expect(restartResult.status).toBe(0);
      const recoveredService = JSON.parse(readFileSync(join(state, "service.json"), "utf8")) as { status: string; bootId: string; socketPath: string };
      expect(recoveredService.status).toBe("ready");
      expect(recoveredService.bootId).not.toBe(oldService.bootId);
      const blockedRun = await waitForRunStatus(root, "capture-recovery", runId, "blocked");
      expect(blockedRun.block?.kind).toBe("process_death_unconfirmed");

      let cursor: string | undefined;
      let captureSection: Extract<ReturnType<typeof serviceLogSectionPageV1Schema.parse>["section"], { kind: "capture" }> | undefined;
      for (let index = 0; index < 16; index += 1) {
        const request: ServiceRequestV1 = {
          version: 1,
          method: "logs.page",
          workflowId: "capture-recovery",
          runId,
          ...(cursor === undefined ? {} : { cursor }),
        };
        const response = await sendServiceRequest(recoveredService.socketPath, request);
        if (!response.ok) throw new Error(`logs.page failed: ${response.error.message}`);
        const page = serviceLogSectionPageV1Schema.parse(response.result);
        if (page.section.kind === "capture" && page.section.capture.totalBytes === totalBytes) {
          captureSection = page.section;
          break;
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }
      expect(captureSection).toMatchObject({
        capture: {
          totalBytes, retainedBytes: capBytes, truncatedBytes: totalBytes - capBytes,
          keptHeadBytes: 22_369_622, keptTailBytes: 11_184_810, complete: false,
        },
      });

      const cliLogs = await runCliPrefix(root, ["logs", "capture-recovery", "--run", runId], 60_000);
      expect(cliLogs.status).toBe(0);
      expect(cliLogs.stdout).toContain(
        `${totalBytes} bytes total; ${capBytes} retained (22369622 head + 11184810 tail), ${totalBytes - capBytes} omitted; incomplete`,
      );
      expect(cliLogs.outputBytes).toBeGreaterThan(capBytes);
      expect(readFileSync(workerLaunches, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
      expect(readFileSync(validatorLaunches, "utf8")).toBe("validator");
      expect(existsSync(successorLaunches)).toBe(false);
      expect(statSync(retainedPath).size).toBe(capBytes);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);


  test("gates a queued run until restart confirms an older process group is dead", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-launch-gate-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const state = join(root, ".workshop", "state");
    const oldPidPath = join(root, "old-worker.pid");
    const termPath = join(root, "old-worker-term.txt");
    const queuedStartPath = join(root, "queued-worker-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 2\n", "utf8");
    writeFileSync(join(workflows, "long-process.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - wait:",
      "      run: >-",
      `        trap 'echo term > ${termPath}; trap "" TERM; sleep 5' TERM;`,
      `        echo $$ > ${oldPidPath};`,
      "        while :; do sleep 1; done",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "queued-clean.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - mark:",
      `      run: 'echo started > ${queuedStartPath}; sleep 0.2; echo queued-finished'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "long-process", "--detach"]);
      expect(started.status).toBe(0);
      const oldRunId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const oldWorkerPid = await waitForPositiveIntegerFile(oldPidPath);
      if (!Number.isSafeInteger(oldWorkerPid) || oldWorkerPid <= 0) throw new Error("old worker did not write a positive process-group ID");
      const metadataPath = join(state, "service.json");
      const oldService = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; bootId: string };
      process.kill(oldService.pid, "SIGKILL");
      await waitForPidGone(oldService.pid);
      const queuedRunId = await admitQueuedRunOffline(root, "queued-clean");

      const command = spawnCli(root, ["runs", "queued-clean", "--json"]);
      await waitForFile(termPath);
      expect(isProcessGroupAlive(oldWorkerPid)).toBe(true);
      expect(existsSync(queuedStartPath)).toBe(false);
      const result = await command.completion;
      expect(result.status).toBe(0);
      await waitForProcessGroupGone(oldWorkerPid);
      await waitForFile(queuedStartPath);

      const queuedRun = await waitForRun(root, "queued-clean", queuedRunId);
      expect(queuedRun.status).toBe("completed");
      expect(queuedRun.runId).toBe(queuedRunId);
      expect(readFileSync(queuedStartPath, "utf8")).toBe("started\n");
      const statusResult = runCli(root, ["status", "long-process", "--json"]);
      expect(statusResult.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(statusResult.stdout)).service.bootId).not.toBe(oldService.bootId);
      const oldRunHistory = runCli(root, ["runs", "long-process", "--json"]);
      expect(runsDtoSchema.parse(JSON.parse(oldRunHistory.stdout)).runs.some((run) => run.runId === oldRunId)).toBe(true);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("describes nodes from the admitted definition and preserves run identity across public reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-frozen-node-describe-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workflowPath = join(workflows, "frozen-chain.yaml");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(workflowPath, frozenWorkflow("sleep 3; printf frozen-first", "cat"), "utf8");

    try {
      const started = runCli(root, ["start", "frozen-chain", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      writeFileSync(workflowPath, frozenWorkflow("sleep 0.1; printf edited-first", "printf edited-second"), "utf8");

      const completed = await waitForRun(root, "frozen-chain", runId);
      expect(completed.status).toBe("completed");
      expect(completed.terminalOutput).toBe("frozen-first");
      const runsResult = runCli(root, ["runs", "frozen-chain", "--json"]);
      expect(runsResult.status).toBe(0);
      const runs = runsDtoSchema.parse(JSON.parse(runsResult.stdout));
      const listed = runs.runs.find((run) => run.runId === runId);
      expect(listed?.definitionHash).toBe(completed.definitionHash);
      expect(listed?.status).toBe("completed");

      const logsResult = runCli(root, ["logs", "frozen-chain", "--run", runId, "--json"]);
      expect(logsResult.status).toBe(0);
      expect(logsDtoSchema.parse(JSON.parse(logsResult.stdout)).runId).toBe(runId);

      const firstNodeResult = runCli(root, ["step", "describe", "frozen-chain", "first", "--run", runId, "--json"]);
      expect(firstNodeResult.status).toBe(0);
      const firstNode = nodeDescriptionDtoSchema.parse(JSON.parse(firstNodeResult.stdout));
      expect(firstNode.runId).toBe(runId);
      expect(firstNode.definitionHash).toBe(completed.definitionHash);
      expect(firstNode.runStatus).toBe("completed");
      expect(firstNode.node.status).toBe("succeeded");
      expect(firstNode.node.resolvedSettings.run).toMatchObject({ kind: "command", command: "sleep 3; printf frozen-first" });
      expect(firstNode.node.successfulOutput).toBe("frozen-first");
      expect(firstNode.node.attempts).toHaveLength(1);

      const secondNodeResult = runCli(root, ["step", "describe", "frozen-chain", "second", "--run", runId, "--json"]);
      expect(secondNodeResult.status).toBe(0);
      const secondNode = nodeDescriptionDtoSchema.parse(JSON.parse(secondNodeResult.stdout));
      expect(secondNode.runId).toBe(runId);
      expect(secondNode.node.resolvedSettings.run).toMatchObject({ kind: "command", command: "cat" });
      expect(secondNode.node.successfulOutput).toBe("frozen-first");

      writeFileSync(workflowPath, [
        "version: 4",
        "defaults:",
        "  retries: 0",
        "  replay: never",
        "steps:",
        "  - replacement:",
        "      run: 'printf replacement-output'",
        "",
      ].join("\n"), "utf8");
      const replacementStart = runCli(root, ["start", "frozen-chain", "--detach"]);
      expect(replacementStart.status).toBe(0);
      const replacementRunId = runIdSchema.parse(replacementStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "frozen-chain", replacementRunId)).status).toBe("completed");

      const historicalDiagram = runCli(root, ["diagram", "frozen-chain", "--run", runId, "--mermaid"]);
      expect(historicalDiagram.status).toBe(0);
      expect(historicalDiagram.stdout).toContain('first["first [succeeded]"]');
      expect(historicalDiagram.stdout).toContain('second["second [succeeded]"]');
      expect(historicalDiagram.stdout).not.toContain("replacement");
      const service = JSON.parse(readFileSync(join(root, ".workshop", "state", "service.json"), "utf8")) as { socketPath: string };
      const viewerSource = createViewerSource(service.socketPath);
      const latestView = await viewerSource.snapshot("frozen-chain");
      expect(latestView.detail?.nodes.map(node => node.nodeId)).toEqual(["replacement"]);
      expect(latestView.detail?.nodes.map(node => node.status)).toEqual(["succeeded"]);
      const latestDiagram = runCli(root, ["diagram", "frozen-chain", "--mermaid"]);
      expect(latestDiagram.status).toBe(0);
      expect(latestDiagram.stdout).toContain('replacement["replacement [succeeded]"]');
      expect(latestDiagram.stdout).not.toContain('first["first');
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  test("admits fixed-rate occurrences from the activation deadline until the finite limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-finite-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const launches = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1s",
      "  max_runs: 2",
      "steps:",
      "  - tick:",
      `      run: 'printf tick >> ${launches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "scheduled", "--detach"]);
      expect(started.status).toBe(0);
      const firstRunId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      const firstRun = await waitForRun(root, "scheduled", firstRunId);
      expect(firstRun.status).toBe("completed");
      writeFileSync(join(workflows, "scheduled.yaml"), [
        "version: 4",
        "defaults:",
        "  retries: 0",
        "  replay: never",
        "schedule:",
        "  every: 1s",
        "  max_runs: 2",
        "steps:",
        "  - tick:",
        `      run: 'printf future >> ${launches}'`,
        "",
      ].join("\n"), "utf8");

      const deadline = Date.now() + 8_000;
      let history = runsDtoSchema.parse({ version: 2, workflowId: "scheduled", total: 0, truncated: false, runs: [] });
      while (Date.now() < deadline && (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed"))) {
        const result = runCli(root, ["runs", "scheduled", "--json", "--all"]);
        if (result.status !== 0) throw new Error(result.stderr);
        history = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed")) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      }
      expect(history.runs).toHaveLength(2);
      expect(history.runs.every((run) => run.status === "completed")).toBe(true);
      expect(history.runs.some((run) => run.runId === firstRunId)).toBe(true);
      expect(readFileSync(launches, "utf8")).toBe("tickfuture");

      const statusResult = runCli(root, ["status", "scheduled", "--json"]);
      expect(statusResult.status).toBe(0);
      const status = statusDtoSchema.parse(JSON.parse(statusResult.stdout));
      const activation = status.workflows[0]?.activation;
      expect(activation).toMatchObject({ state: "exhausted", admittedCount: 2, maxRuns: 2, nextDueAt: null });
      const scheduledRun = history.runs.find((run) => run.runId !== firstRunId);
      expect(scheduledRun).toBeDefined();
      if (scheduledRun === undefined || activation === null || activation === undefined) throw new Error("scheduled occurrence or activation is missing");
      expect(scheduledRun.activationId).toBe(firstRun.activationId);
      expect(scheduledRun.definitionHash).not.toBe(firstRun.definitionHash);
      const elapsedFromActivation = Date.parse(scheduledRun.admittedAt) - Date.parse(activation.activatedAt);
      expect(elapsedFromActivation).toBeGreaterThanOrEqual(750);
      expect(elapsedFromActivation).toBeLessThan(4_000);
      const exhaustedActivationId = activation.activationId;
      const reactivated = runCli(root, ["start", "scheduled", "--detach"]);
      expect(reactivated.status).toBe(0);
      const thirdRunId = runIdSchema.parse(reactivated.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", thirdRunId)).status).toBe("completed");
      expect(readFileSync(launches, "utf8")).toBe("tickfuturefuture");
      const afterReactivation = runCli(root, ["status", "scheduled", "--json"]);
      expect(afterReactivation.status).toBe(0);
      const newActivation = statusDtoSchema.parse(JSON.parse(afterReactivation.stdout)).workflows[0]?.activation;
      expect(newActivation).toMatchObject({ state: "active", admittedCount: 1, maxRuns: 2 });
      if (newActivation === null || newActivation === undefined) throw new Error("reactivated activation is missing");
      expect(newActivation.activationId).not.toBe(exhaustedActivationId);
      const allRuns = runCli(root, ["runs", "scheduled", "--json", "--all"]);
      expect(allRuns.status).toBe(0);
      const retainedRuns = runsDtoSchema.parse(JSON.parse(allRuns.stdout)).runs;
      expect(retainedRuns).toHaveLength(3);
      expect(retainedRuns.some((run) => run.runId === firstRunId)).toBe(true);
      expect(retainedRuns.some((run) => run.runId === thirdRunId)).toBe(true);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
  test("disables scheduled admission without consuming an occurrence when YAML becomes invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-invalid-yaml-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const workflowPath = join(workflows, "scheduled.yaml");
    const launches = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(workflowPath, [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1s",
      "  max_runs: 5",
      "steps:",
      "  - tick:",
      `      run: 'printf tick >> ${launches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "scheduled", "--detach"]);
      expect(started.status).toBe(0);
      const firstRunId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", firstRunId)).status).toBe("completed");
      writeFileSync(workflowPath, "schedule:\n  every: nope\n", "utf8");

      const deadline = Date.now() + 5_000;
      let status: ReturnType<typeof statusDtoSchema.parse> | undefined;
      while (Date.now() < deadline) {
        const result = runCli(root, ["status", "scheduled", "--json"]);
        if (result.status !== 0) throw new Error(result.stderr);
        status = statusDtoSchema.parse(JSON.parse(result.stdout));
        if (status.workflows[0]?.activation?.state === "stopped") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      const workflow = status?.workflows[0];
      expect(workflow?.activation).toMatchObject({ state: "stopped", admittedCount: 1, maxRuns: 5, nextDueAt: null });
      expect(workflow?.configurationError).not.toBeNull();
      expect(readFileSync(launches, "utf8")).toBe("tick");
      const runsResult = runCli(root, ["runs", "scheduled", "--json", "--all"]);
      expect(runsResult.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(runsResult.stdout)).runs).toHaveLength(1);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
  test("skips recurrence slots while the workflow has an unresolved run", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-overlap-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const launches = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1s",
      "  max_runs: 2",
      "steps:",
      "  - tick:",
      `      run: 'sleep 2.4; printf tick >> ${launches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "scheduled", "--detach"]);
      expect(started.status).toBe(0);
      const firstRunId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", firstRunId)).status).toBe("completed");

      const deadline = Date.now() + 8_000;
      let history = runsDtoSchema.parse({ version: 2, workflowId: "scheduled", total: 0, truncated: false, runs: [] });
      while (Date.now() < deadline && (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed"))) {
        const result = runCli(root, ["runs", "scheduled", "--json", "--all"]);
        if (result.status !== 0) throw new Error(result.stderr);
        history = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed")) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      }
      expect(history.runs).toHaveLength(2);
      expect(history.runs.every((run) => run.status === "completed")).toBe(true);
      expect(readFileSync(launches, "utf8")).toBe("ticktick");
      const statusResult = runCli(root, ["status", "scheduled", "--json"]);
      expect(statusResult.status).toBe(0);
      const activation = statusDtoSchema.parse(JSON.parse(statusResult.stdout)).workflows[0]?.activation;
      expect(activation).toMatchObject({ state: "exhausted", admittedCount: 2, skippedSlots: 2 });
      if (activation === null || activation === undefined) throw new Error("overlap activation is missing");
      expect(activation.lastSkippedSlotAt).toBe(new Date(Date.parse(activation.activatedAt) + 2_000).toISOString());
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("does not persist a proposed activation when fail-fast admission lacks capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-fail-fast-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const holderStarted = join(root, "holder-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "holder.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - hold:",
      `      run: 'touch ${holderStarted}; sleep 2; printf held'`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1s",
      "  max_runs: 2",
      "steps:",
      "  - tick:",
      "      run: 'printf candidate'",
      "",
    ].join("\n"), "utf8");

    try {
      const holderStart = runCli(root, ["start", "holder", "--detach"]);
      expect(holderStart.status).toBe(0);
      const holderRunId = runIdSchema.parse(holderStart.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(holderStarted);

      const rejectedStart = runCli(root, ["start", "scheduled", "--detach"]);
      expect(rejectedStart.status).not.toBe(0);
      const statusResult = runCli(root, ["status", "scheduled", "--json"]);
      expect(statusResult.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(statusResult.stdout)).workflows[0]?.activation).toBeNull();
      const historyResult = runCli(root, ["runs", "scheduled", "--json"]);
      expect(historyResult.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(historyResult.stdout)).runs).toHaveLength(0);
      expect((await waitForRun(root, "holder", holderRunId)).status).toBe("completed");
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
  test("admits only the latest due slot after scheduler downtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-downtime-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const launches = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 10s",
      "  max_runs: 2",
      "steps:",
      "  - tick:",
      `      run: 'printf tick >> ${launches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "scheduled", "--detach"]);
      expect(started.status).toBe(0);
      const firstRunId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", firstRunId)).status).toBe("completed");
      const firstStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(firstStatus.status).toBe(0);
      const firstActivation = statusDtoSchema.parse(JSON.parse(firstStatus.stdout)).workflows[0]?.activation;
      if (firstActivation === null || firstActivation === undefined || firstActivation.nextDueAt === null) throw new Error("scheduled activation deadline is missing");
      const firstBootId = statusDtoSchema.parse(JSON.parse(firstStatus.stdout)).service.bootId;

      await stopService(root);
      // Restart after two slots become due, before the third slot.
      const restartAt = Date.parse(firstActivation.nextDueAt) + 15_000;
      const downtime = restartAt - Date.now();
      if (downtime > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, downtime));
      const restartedStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(restartedStatus.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(restartedStatus.stdout)).service.bootId).not.toBe(firstBootId);

      const deadline = Date.now() + 8_000;
      let history = runsDtoSchema.parse({ version: 2, workflowId: "scheduled", total: 0, truncated: false, runs: [] });
      while (Date.now() < deadline && history.runs.length < 2) {
        const result = runCli(root, ["runs", "scheduled", "--json", "--all"]);
        if (result.status !== 0) throw new Error(result.stderr);
        history = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (history.runs.length < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(history.runs).toHaveLength(2);
      expect(history.runs.some((run) => run.runId === firstRunId)).toBe(true);
      expect(readFileSync(launches, "utf8")).toBe("ticktick");

      const finalStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(finalStatus.status).toBe(0);
      const activation = statusDtoSchema.parse(JSON.parse(finalStatus.stdout)).workflows[0]?.activation;
      expect(activation).toMatchObject({ state: "exhausted", admittedCount: 2, skippedSlots: 1, maxRuns: 2 });
      if (activation === null || activation === undefined) throw new Error("final scheduled activation is missing");
      expect(activation.lastSkippedSlotAt).toBe(firstActivation.nextDueAt);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  test("pause, resume, and stop preserve recurrence activation semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-controls-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const launches = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 2s",
      "  max_runs: 4",
      "steps:",
      "  - tick:",
      `      run: 'printf tick >> ${launches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const firstStart = runCli(root, ["start", "scheduled", "--detach"]);
      expect(firstStart.status).toBe(0);
      const firstRunId = runIdSchema.parse(firstStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", firstRunId)).status).toBe("completed");
      const beforePause = runCli(root, ["status", "scheduled", "--json"]);
      expect(beforePause.status).toBe(0);
      const initialActivation = statusDtoSchema.parse(JSON.parse(beforePause.stdout)).workflows[0]?.activation;
      if (initialActivation === null || initialActivation === undefined) throw new Error("scheduled activation is missing");

      const paused = runCli(root, ["pause", "scheduled"]);
      expect(paused.status).toBe(0);
      const pausedStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(pausedStatus.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(pausedStatus.stdout)).workflows[0]?.activation)
        .toMatchObject({ activationId: initialActivation.activationId, state: "paused", admittedCount: 1 });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_300));
      const pausedHistory = runCli(root, ["runs", "scheduled", "--json", "--all"]);
      expect(pausedHistory.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(pausedHistory.stdout)).runs).toHaveLength(1);
      expect(readFileSync(launches, "utf8")).toBe("tick");

      const resumed = runCli(root, ["resume", "scheduled"]);
      expect(resumed.status).toBe(0);
      const deadline = Date.now() + 8_000;
      let history = runsDtoSchema.parse({ version: 2, workflowId: "scheduled", total: 0, truncated: false, runs: [] });
      while (Date.now() < deadline && (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed"))) {
        const result = runCli(root, ["runs", "scheduled", "--json", "--all"]);
        if (result.status !== 0) throw new Error(result.stderr);
        history = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed")) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      }
      expect(history.runs).toHaveLength(2);
      const afterResume = runCli(root, ["status", "scheduled", "--json"]);
      expect(afterResume.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(afterResume.stdout)).workflows[0]?.activation)
        .toMatchObject({ activationId: initialActivation.activationId, state: "active", admittedCount: 2 });
      expect(readFileSync(launches, "utf8")).toBe("ticktick");

      const stopped = runCli(root, ["stop", "scheduled"]);
      expect(stopped.status).toBe(0);
      const stoppedStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(stoppedStatus.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(stoppedStatus.stdout)).workflows[0]?.activation)
        .toMatchObject({ activationId: initialActivation.activationId, state: "stopped", nextDueAt: null });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));
      const afterStop = runCli(root, ["runs", "scheduled", "--json", "--all"]);
      expect(afterStop.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(afterStop.stdout)).runs).toHaveLength(2);
      const reactivated = runCli(root, ["start", "scheduled", "--detach"]);
      expect(reactivated.status).toBe(0);
      const thirdRunId = runIdSchema.parse(reactivated.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", thirdRunId)).status).toBe("completed");
      const finalStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(finalStatus.status).toBe(0);
      const newActivation = statusDtoSchema.parse(JSON.parse(finalStatus.stdout)).workflows[0]?.activation;
      expect(newActivation).toMatchObject({ state: "active", admittedCount: 1 });
      if (newActivation === null || newActivation === undefined) throw new Error("reactivated activation is missing");
      expect(newActivation.activationId).not.toBe(initialActivation.activationId);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("retries a final scheduled occurrence after a full-capacity restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-schedule-capacity-restart-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const holderPidPath = join(root, "holder.pid");
    const holderLaunches = join(root, "holder-launches.txt");
    const scheduledLaunches = join(root, "scheduled-launches.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
    writeFileSync(join(workflows, "holder.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - hold:",
      `      run: 'echo launch >> ${holderLaunches}; echo $$ > ${holderPidPath}; sleep 20'`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "scheduled.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "schedule:",
      "  every: 1s",
      "  max_runs: 2",
      "steps:",
      "  - tick:",
      `      run: 'printf tick >> ${scheduledLaunches}'`,
      "",
    ].join("\n"), "utf8");

    try {
      const firstStart = runCli(root, ["start", "scheduled", "--detach"]);
      expect(firstStart.status).toBe(0);
      const firstRunId = runIdSchema.parse(firstStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect((await waitForRun(root, "scheduled", firstRunId)).status).toBe("completed");
      const beforeHolder = runCli(root, ["status", "scheduled", "--json"]);
      expect(beforeHolder.status).toBe(0);
      const activation = statusDtoSchema.parse(JSON.parse(beforeHolder.stdout)).workflows[0]?.activation;
      if (activation === null || activation === undefined || activation.nextDueAt === null) {
        throw new Error("scheduled activation deadline is missing");
      }

      const holderStart = runCli(root, ["start", "holder", "--detach"]);
      expect(holderStart.status).toBe(0);
      const holderRunId = runIdSchema.parse(holderStart.stdout.match(/Started run (\S+)/)?.[1]);
      const holderPid = await waitForPositiveIntegerFile(holderPidPath);
      expect(Number.isSafeInteger(holderPid)).toBe(true);
      if (!Number.isSafeInteger(holderPid) || holderPid <= 0) throw new Error("holder process fixture did not record a positive PID");

      const delayUntilDue = Date.parse(activation.nextDueAt) + 500 - Date.now();
      if (delayUntilDue > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayUntilDue));
      const capacityRejectedHistory = runCli(root, ["runs", "scheduled", "--json", "--all"]);
      expect(capacityRejectedHistory.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(capacityRejectedHistory.stdout)).runs).toHaveLength(1);
      const capacityRejectedStatus = runCli(root, ["status", "scheduled", "--json"]);
      expect(capacityRejectedStatus.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(capacityRejectedStatus.stdout)).workflows[0]?.activation)
        .toMatchObject({ activationId: activation.activationId, state: "active", admittedCount: 1, nextDueAt: activation.nextDueAt });
      expect(readFileSync(holderLaunches, "utf8")).toBe("launch\n");

      const serviceMetadataPath = join(root, ".workshop", "state", "service.json");
      const oldService = JSON.parse(readFileSync(serviceMetadataPath, "utf8")) as { pid: number; bootId: string };
      process.kill(oldService.pid, "SIGKILL");
      await waitForPidGone(oldService.pid);
      const reopened = runCli(root, ["status", "scheduled", "--json"]);
      expect(reopened.status).toBe(0);
      const reopenedDto = statusDtoSchema.parse(JSON.parse(reopened.stdout));
      expect(reopenedDto.service.bootId).not.toBe(oldService.bootId);
      await waitForProcessGroupGone(holderPid);

      const deadline = Date.now() + 12_000;
      let history = runsDtoSchema.parse({ version: 2, workflowId: "scheduled", total: 0, truncated: false, runs: [] });
      while (Date.now() < deadline && (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed"))) {
        const result = runCli(root, ["runs", "scheduled", "--json", "--all"]);
        if (result.status !== 0) throw new Error(result.stderr);
        history = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (history.runs.length < 2 || !history.runs.every((run) => run.status === "completed")) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      }
      expect(history.runs).toHaveLength(2);
      expect(history.runs.filter((run) => run.activationId === activation.activationId).map((run) => run.runId)).toHaveLength(2);
      expect(new Set(history.runs.map((run) => run.occurrenceId)).size).toBe(2);
      expect(readFileSync(scheduledLaunches, "utf8")).toBe("ticktick");
      expect(readFileSync(holderLaunches, "utf8")).toBe("launch\n");
      const holderHistoryResult = runCli(root, ["runs", "holder", "--json", "--all"]);
      expect(holderHistoryResult.status).toBe(0);
      const interruptedHolder = runsDtoSchema.parse(JSON.parse(holderHistoryResult.stdout)).runs.find((run) => run.runId === holderRunId);
      expect(interruptedHolder).toBeDefined();
      expect(interruptedHolder?.status).not.toBe("completed");

      const afterRestart = runCli(root, ["status", "scheduled", "--json"]);
      expect(afterRestart.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(afterRestart.stdout)).workflows[0]?.activation)
        .toMatchObject({ activationId: activation.activationId, state: "exhausted", admittedCount: 2, maxRuns: 2 });
      const noDuplicate = runCli(root, ["runs", "scheduled", "--json", "--all"]);
      expect(noDuplicate.status).toBe(0);
      expect(runsDtoSchema.parse(JSON.parse(noDuplicate.stdout)).runs).toHaveLength(2);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

function frozenWorkflow(firstCommand: string, secondCommand: string): string {
  return [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - first:",
    "      run: >-",
    `        ${firstCommand}`,
    "  - second:",
    "      run: >-",
    `        ${secondCommand}`,
    "",
  ].join("\n");
}

function spawnCli(cwd: string, args: readonly string[]) {
  const child = spawn("bun", [cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
  return { child, completion };
}

async function admitQueuedRunOffline(root: string, workflowId: string): Promise<ReturnType<typeof runIdSchema.parse>> {
  const installation = loadInstallation(root);
  const checked = loadCheckedWorkflow(installation, workflowId);
  const openedStorage = await openDurableStorage(installation.databasePath);
  if (!openedStorage.ok) throw new Error(`${openedStorage.failure.message}: ${String(openedStorage.failure.cause)}`);
  const tasks = defineWorkshopTasks();
  const registry = createRegistry();
  registry.install({ name: "workshop-queued-admission-fixture", tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask] });
  let harness: Harness | undefined;
  try {
    harness = await Harness.open(openedStorage.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
    const current = installationDocumentV1Schema.parse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
    if (current.state !== "ready") throw new Error("service installation is not initialized");
    const activationId = randomUUID();
    const admittedAt = new Date().toISOString();
    const workflowIndex = {
      definitionHash: checked.canonicalHash,
      admissionHighWater: 0,
      openRunId: null,
      activations: [{
        activationId,
        state: "active" as const,
        admittedCount: 0,
        maxRuns: checked.definition.schedule?.max_runs ?? 1,
        activatedAt: admittedAt,
        nextDueAt: null,
      }],
      occurrenceCounters: { [activationId]: 0 },
      runs: [],
      requestIndex: {},
      capacityReservations: [],
      preflightCache: {},
    };
    await harness.commit(async (tx) => {
      const draft = await tx.doc(WorkshopInstallationDoc);
      Object.assign(draft, installationDocumentV1Schema.parse({
        ...current,
        workflows: { ...current.workflows, [workflowId]: workflowIndex },
      }));
    }, BACKGROUND_CONTEXT);
    const taskVersions = { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1 } as const;
    const prepared = prepareRunAdmission({
      sourceText: checked.sourceText,
      sourceLabel: checked.sourcePath,
      workflowId,
      machineConfig: installation.machine,
      projectCwd: installation.projectCwd,
      stateDirectory: installation.stateDirectory,
      resolvedSettings: checked.resolvedSettings,
      runtimeManifest: {
        durableVersion: "1.0.2",
        integrationManifestHash: canonicalHash({ taskVersions }),
        taskVersions,
      },
      runId: `${workflowId}-${randomUUID()}`,
      eventId: randomUUID(),
      activationId,
      occurrenceId: randomUUID(),
      requestId: randomUUID(),
      admittedAt,
    });
    if (!prepared.ok) throw new Error(`${prepared.failure.kind}: ${prepared.failure.message}`);
    const admitted = await admitPreparedRun({
      harness,
      prepared: prepared.value,
      workflowRunTask: tasks.WorkflowRunTask,
      createTaskInput: createWorkflowRunTaskInput,
      parseTaskInput: parseWorkflowRunTaskInput,
      context: BACKGROUND_CONTEXT,
    });
    if (!admitted.ok) throw new Error(`${admitted.failure.kind}: ${admitted.failure.message}`);
    return runIdSchema.parse(admitted.value.runId);
  } finally {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
    else await openedStorage.storage.close(BACKGROUND_CONTEXT);
  }
}

async function startBlockedCommandRun(
  root: string,
  workflowId: string,
  command: string,
  options: { readonly validatorCommand?: string } = {},
): Promise<{ runId: ReturnType<typeof runIdSchema.parse> }> {
  const config = join(root, ".workshop");
  const workflows = join(config, "workflows");
  const launchMarker = join(root, "worker-launches.txt");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\nmax_concurrent_runs: 1\n", "utf8");
  writeFileSync(join(workflows, `${workflowId}.yaml`), [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - work:",
    "      replay: never",
    ...(options.validatorCommand === undefined ? [] : [
      "      verify:",
      "        run: >-",
      `          ${options.validatorCommand}`,
    ]),
    "      run: >-",
    `        ${command}`,
    "",
  ].join("\n"), "utf8");
  const started = runCli(root, ["start", workflowId, "--detach"]);
  if (started.status !== 0) throw new Error(started.stderr);
  const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
  await waitForFile(launchMarker);
  const service = JSON.parse(readFileSync(join(root, ".workshop", "state", "service.json"), "utf8")) as { pid: number };
  process.kill(service.pid, "SIGKILL");
  await waitForPidGone(service.pid);
  const reopened = runCli(root, ["status", workflowId, "--json"]);
  if (reopened.status !== 0) throw new Error(reopened.stderr);
  await waitForRunStatus(root, workflowId, runId, "blocked");
  return { runId };
}

function runCli(cwd: string, args: readonly string[], timeoutMs = 10_000) {
  const result = spawnSync("bun", [cliPath, ...args], {
    cwd,
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

async function runCliPrefix(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  prefixBytes = 16 * 1024,
): Promise<{ status: number; stdout: string; stderr: string; outputBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      const remaining = prefixBytes - Buffer.byteLength(stdout);
      if (remaining > 0) stdout += chunk.subarray(0, remaining).toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = prefixBytes - Buffer.byteLength(stderr);
      if (remaining > 0) stderr += chunk.subarray(0, remaining).toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? -1 : code ?? -1, stdout, stderr, outputBytes });
    });
  });
}

async function waitForLaunch(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readLaunches(path) > 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("the deterministic Hemingway worker did not launch");
}

async function waitForRun(root: string, workflowId: string, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = runCli(root, ["runs", workflowId, "--json"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const projection = runsDtoSchema.parse(JSON.parse(result.stdout));
    const run = projection.runs.find((entry) => entry.runId === runId);
    if (run?.status === "completed") return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  }
  throw new Error(`run ${runId} did not complete before the fixture deadline`);
}

async function waitForRunStatus(root: string, workflowId: string, runId: string, expectedStatus: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = runCli(root, ["runs", workflowId, "--json"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const projection = runsDtoSchema.parse(JSON.parse(result.stdout));
    const run = projection.runs.find((entry) => entry.runId === runId);
    if (run?.status === expectedStatus) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus} before the fixture deadline`);
}

async function waitForNodeStatus(
  root: string,
  workflowId: string,
  runId: string,
  nodeId: string,
  expectedStatus: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = runCli(root, ["step", "describe", workflowId, nodeId, "--run", runId, "--json"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const description = nodeDescriptionDtoSchema.parse(JSON.parse(result.stdout));
    if (description.node.status === expectedStatus) return description;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  }
  throw new Error(`node ${workflowId}/${nodeId} did not reach ${expectedStatus} before the fixture deadline`);
}

async function waitForAttemptStatus(
  root: string,
  workflowId: string,
  runId: string,
  nodeId: string,
  expectedStatus: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = runCli(root, ["step", "describe", workflowId, nodeId, "--run", runId, "--json"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const description = nodeDescriptionDtoSchema.parse(JSON.parse(result.stdout));
    if (description.node.attempts.at(-1)?.status === expectedStatus) return description;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  }
  throw new Error(`node ${workflowId}/${nodeId} attempt did not reach ${expectedStatus} before the fixture deadline`);
}



async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`worker did not write ${path}`);
}

async function waitForFileLength(path: string, minimumBytes: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path).byteLength >= minimumBytes) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`worker did not append ${minimumBytes} bytes to ${path}`);
}

async function waitForPositiveIntegerFile(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  let previous: number | undefined;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = Number(readFileSync(path, "utf8").trim());
      if (Number.isSafeInteger(value) && value > 0) {
        if (value === previous) return value;
        previous = value;
      } else {
        previous = undefined;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("fixture did not write a stable positive integer to " + path);
}

function dropFirstServiceReply(
  socketPath: string,
  request: Extract<ServiceRequestV1, { method: "resolve" }>,
): Promise<void> {
  return new Promise((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("service did not reply before the dropped-reply fixture deadline")), 10_000);
    socket.once("connect", () => socket.write(encodeServiceRequestLine(request)));
    socket.once("data", () => finish());
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("service closed before committing a response"));
    });

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) rejectReply(error);
      else resolveReply();
    }
  });
}

async function waitForRetainedCapture(directory: string, retainedBytes: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(directory)) {
      for (const name of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
        if (!name.endsWith(".stderr")) continue;
        const path = join(directory, name);
        if (existsSync(`${path}.retention.json`) && statSync(path).size === retainedBytes) return path;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  }
  throw new Error(`no retained stderr window of ${retainedBytes} bytes appeared in ${directory}`);
}


async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`service process ${pid} did not exit after shutdown`);
}

function isProcessGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function waitForProcessGroupGone(pgid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(-pgid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`process group ${pgid} survived service restart reconciliation`);
}

function readLaunches(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "" && (JSON.parse(line) as { event?: unknown }).event === "launch")
    .length;
}

async function stopService(root: string): Promise<void> {
  const metadataPath = join(root, ".workshop", "state", "service.json");
  if (!existsSync(metadataPath)) return;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: unknown };
  if (typeof metadata.pid !== "number") return;
  try { process.kill(metadata.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const current = JSON.parse(readFileSync(metadataPath, "utf8")) as { status?: unknown };
      if (current.status === "stopped") return;
    } catch { return; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  try { process.kill(metadata.pid, "SIGKILL"); } catch { /* service already exited */ }
}
