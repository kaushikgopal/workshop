import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { processStartIdOrThrow } from "../src/process/identify-process.js";
import { runIdSchema } from "../src/run/schema.js";
import { locateServiceSocket } from "../src/service/locate-service-socket.js";
import { logsDtoSchema, runsDtoSchema, statusDtoSchema } from "../src/views/schema.js";
import { createViewerSource } from "../src/cli/watch.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");

const CLOCK_WORKFLOW = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - tick: printf fixture-output",
  "",
].join("\n");

describe("CLI commands", () => {
  test("help is offline and describes one runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-cli-help-"));
    try {
      for (const args of [[], ["help"], ["--help"], ["-h"]]) {
        const help = runCli(directory, args);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("Usage: workshop <command> [args]");
        expect(help.stdout).toContain("watch [<workflow>]");
        expect(help.stdout).toContain("service start | serve | status [--json] | stop");
        expect(help.stdout).toContain("Workflows live in .workshop/workflows/<id>.yaml; machine defaults in .workshop/workshop.yaml.");
        expect(help.stdout).toContain("step describe <workflow> <step>");
        expect(help.stdout).toContain("Pause new work and let the active step finish.");
        expect(help.stdout).not.toMatch(/\bv[34]\b|experimental|engine|orchestrate|legacy/i);
      }
      expect(existsSync(join(directory, ".workshop"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("chat refuses a non-TTY without starting the service", () => {
    const root = makeRoot({ machine: null, workflows: {} });
    try {
      const result = runCli(root, ["chat"]);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("workshop chat requires a TTY");
      expect(existsSync(join(root, ".workshop", "state"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown commands, including the removed --engine selector", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-cli-unknown-"));
    try {
      for (const args of [["unknown-command"], ["--engine", "v4", "help"], ["--engine=v4", "status"], ["runtime", "worklog"], ["orchestrate"]]) {
        const result = runCli(directory, args);
        expect(result.status).toBe(64);
        expect(result.stderr).toContain(`unknown command: ${args[0]}`);
        expect(result.stdout).toBe("");
      }
      const invalidWatch = runCli(directory, ["watch", "--unknown"]);
      expect(invalidWatch.status).toBe(64);
      expect(invalidWatch.stderr).toContain("usage: workshop status");
      expect(existsSync(join(directory, ".workshop"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("validates every shipped workflow example without creating state", () => {
    const root = makeRoot({ machine: null, workflows: {} });
    try {
      copyFileSync(join(REPO_ROOT, "examples", "workshop.yaml"), join(root, ".workshop", "workshop.yaml"));
      const examples = join(REPO_ROOT, "examples", "workflows");
      const files = readdirSync(examples).filter(file => file.endsWith(".yaml"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        copyFileSync(join(examples, file), join(root, ".workshop", "workflows", file));
        const workflowId = file.slice(0, -5);
        const result = runCli(root, ["validate", workflowId]);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toStartWith('valid workflow "' + workflowId + '" (');
      }
      expect(existsSync(join(root, ".workshop", "state"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects obsolete versions, accepts an omitted machine version, and explains legacy workflow keys", () => {
    const oldWorkflow = makeRoot({
      machine: null,
      workflows: { clock: CLOCK_WORKFLOW.replace("version: 4", "version: 1") },
    });
    const oldMachine = makeRoot({ machine: "version: 1\nshell: /bin/bash\n", workflows: { clock: CLOCK_WORKFLOW } });
    const unversionedMachine = makeRoot({ machine: "shell: /bin/bash\n", workflows: { clock: CLOCK_WORKFLOW } });
    const legacyId = makeRoot({
      machine: null,
      workflows: { clock: [
        "id: clock",
        "nodes:",
        "  tick:",
        "    run:",
        "      command: echo tick",
        "    next: null",
        "",
      ].join("\n") },
    });
    const legacyNodes = makeRoot({
      machine: null,
      workflows: { clock: ["nodes:", "  tick:", "    run: echo tick", ""].join("\n") },
    });
    try {
      const workflow = runCli(oldWorkflow, ["validate", "clock"]);
      expect(workflow.status).toBe(64);
      expect(workflow.stderr).toContain("workflow version 1 is no longer supported; remove id:, list steps: in order, declare version: 4, replace max_attempts: N with retries: N-1");

      const machine = runCli(oldMachine, ["validate", "clock"]);
      expect(machine.status).toBe(64);
      expect(machine.stderr).toContain("machine config version 1 is no longer supported; remove version: (or declare version: 3)");

      const unversioned = runCli(unversionedMachine, ["validate", "clock"]);
      expect(unversioned.status).toBe(0);
      expect(unversioned.stdout).toBe('valid workflow "clock" (1 steps)\n');

      const legacyIdResult = runCli(legacyId, ["validate", "clock"]);
      expect(legacyIdResult.status).toBe(64);
      expect(legacyIdResult.stderr).toContain("id: is not accepted; the workflow id is the file name");

      const legacyNodesResult = runCli(legacyNodes, ["validate", "clock"]);
      expect(legacyNodesResult.status).toBe(64);
      expect(legacyNodesResult.stderr).toContain("nodes: is replaced by an ordered steps: list");

      for (const root of [oldWorkflow, oldMachine, unversionedMachine, legacyId, legacyNodes]) {
        expect(existsSync(join(root, ".workshop", "state"))).toBe(false);
      }
    } finally {
      for (const root of [oldWorkflow, oldMachine, unversionedMachine, legacyId, legacyNodes]) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("service start, status, and stop manage one owner idempotently", async () => {
    const root = makeRoot({ machine: "shell: /bin/bash\n", workflows: { clock: CLOCK_WORKFLOW } });
    const metadataPath = join(root, ".workshop", "state", "service.json");
    try {
      const absent = runCli(root, ["service", "status", "--json"]);
      expect(absent.status).toBe(3);
      expect(JSON.parse(absent.stdout)).toMatchObject({ version: 1, state: "not_running" });
      const absentStop = runCli(root, ["service", "stop"]);
      expect(absentStop.status).toBe(0);
      expect(absentStop.stdout).toContain("service is not running");

      const started = runCli(root, ["service", "start"]);
      expect(started.stderr).toBe("");
      expect(started.status).toBe(0);
      expect(started.stdout).toMatch(/^service started \(pid \d+, boot [0-9a-f-]{36}\)\n$/);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; bootId: string };

      const again = runCli(root, ["service", "start"]);
      expect(again.status).toBe(0);
      expect(again.stdout).toBe(`service already running (pid ${metadata.pid}, boot ${metadata.bootId})\n`);

      const status = runCli(root, ["service", "status", "--json"]);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ version: 1, state: "ready", pid: metadata.pid, bootId: metadata.bootId });
      const human = runCli(root, ["service", "status"]);
      expect(human.status).toBe(0);
      expect(human.stdout).toContain(`service ready (pid ${metadata.pid}, boot ${metadata.bootId})`);

      const run = runCli(root, ["start", "clock"]);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("completed clock-");

      const stopped = runCli(root, ["service", "stop"]);
      expect(stopped.stderr).toBe("");
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toBe(`service stopped (pid ${metadata.pid}, boot ${metadata.bootId})\n`);
      expect(isAlive(metadata.pid)).toBe(false);
      expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toMatchObject({ status: "stopped", bootId: metadata.bootId });

      const stoppedAgain = runCli(root, ["service", "stop"]);
      expect(stoppedAgain.status).toBe(0);
      expect(stoppedAgain.stdout).toContain("service is not running");
      expect(runCli(root, ["service", "status"]).status).toBe(3);
      expect(runCli(root, ["service", "bogus"]).status).toBe(64);
    } finally {
      killRecordedService(metadataPath);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("service stop never signals a PID it cannot verify as the healthy owner", async () => {
    const root = makeRoot({ machine: "shell: /bin/bash\n", workflows: {} });
    const stateDirectory = join(root, ".workshop", "state");
    mkdirSync(stateDirectory, { recursive: true });
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pid = await pidOf(bystander);
      const writeMetadata = (startIdentity: string, status: string): void => {
        writeFileSync(join(stateDirectory, "service.json"), JSON.stringify({
          version: 1,
          status,
          pid,
          startIdentity,
          bootId: randomUUID(),
          startedAt: new Date().toISOString(),
          socketPath: locateServiceSocket(stateDirectory).socketPath,
        }), "utf8");
      };

      writeMetadata(processStartIdOrThrow(pid), "ready");
      const unhealthy = runCli(root, ["service", "stop"]);
      expect(unhealthy.status).toBe(3);
      expect(unhealthy.stderr).toContain(`service pid ${pid} is still alive but not healthy`);
      expect(isAlive(pid)).toBe(true);

      writeMetadata("not the bystander's start identity", "ready");
      const stale = runCli(root, ["service", "stop"]);
      expect(stale.status).toBe(0);
      expect(stale.stdout).toContain("service is not running");
      expect(isAlive(pid)).toBe(true);
    } finally {
      bystander.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routes public commands through one temporary YAML installation and canonical run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-public-cli-"));
    const workshopDirectory = join(directory, ".workshop");
    const workflowsDirectory = join(workshopDirectory, "workflows");
    mkdirSync(workflowsDirectory, { recursive: true });
    writeFileSync(join(workshopDirectory, "workshop.yaml"), "shell: /bin/bash\nkeep_files: always\n", "utf8");
    writeFileSync(join(workflowsDirectory, "clock.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "description: Public CLI fixture",
      "steps:",
      "  - tick:",
      "      run: sleep 2; printf 'fixture-output'",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflowsDirectory, "big.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - tick:",
      "      run: >-",
      "        printf HEAD; head -c 699992 /dev/zero | tr '\\000' '\"'; printf TAIL",
      "      stream_cap: 1kb",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflowsDirectory, "unlimited.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - tick:",
      "      run: printf 'unlimited-output'",
      "      stream_cap: unlimited",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflowsDirectory, "oversize.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - first:",
      "      run: head -c 700000 /dev/zero",
      "      stream_cap: 1mb",
      "  - second:",
      "      run: head -c 700000 /dev/zero",
      "      stream_cap: 1mb",
      "  - third:",
      "      run: head -c 700000 /dev/zero",
      "      stream_cap: 1mb",
      "  - fourth:",
      "      run: head -c 700000 /dev/zero",
      "      stream_cap: 1mb",
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(directory, ["start", "clock", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);

      const statusResult = runCli(directory, ["status", "clock", "--json"]);
      expect(statusResult.status).toBe(0);
      const status = statusDtoSchema.parse(JSON.parse(statusResult.stdout));
      expect(status.installationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(status.workflows[0]?.workflowId).toBe("clock");
      expect(status.workflows[0]?.unresolvedRun?.runId).toBe(runId);
      const followedLogs = runCli(directory, ["logs", "clock", "--run", runId, "--follow"], 15_000);
      expect(followedLogs.status).toBe(0);
      expect(followedLogs.stdout).toContain("fixture-output");

      let runs = runsDtoSchema.parse({ version: 2, workflowId: "clock", total: 0, truncated: false, runs: [] });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = runCli(directory, ["runs", "clock", "--json"]);
        expect(result.status).toBe(0);
        runs = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (runs.runs[0]?.status === "completed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(runs.runs[0]?.status).toBe("completed");
      expect(runs.runs[0]?.runId).toBe(runId);

      const logsResult = runCli(directory, ["logs", "clock", "--run", runId!, "--json"]);
      expect(logsResult.status).toBe(0);
      const logs = logsDtoSchema.parse(JSON.parse(logsResult.stdout));
      expect(logs.runId).toBe(runId);
      expect(logs.sections.some((section) => section.kind === "capture" && section.content === "fixture-output")).toBe(true);
      const humanRuns = runCli(directory, ["runs", "clock"]);
      expect(humanRuns.status).toBe(0);
      expect(humanRuns.stdout).toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(humanRuns.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

      const secondStart = runCli(directory, ["start", "clock"], 15_000);
      expect(secondStart.status).toBe(0);
      const secondRunId = runIdSchema.parse(secondStart.stdout.match(/Started run (\S+)/)?.[1]);
      const allLogsText = runCli(directory, ["logs", "clock", "--all"]);
      expect(allLogsText.status).toBe(0);
      const firstHeader = allLogsText.stdout.indexOf(`━━ run ${runId} — completed ━━`);
      const secondHeader = allLogsText.stdout.indexOf(`━━ run ${secondRunId} — completed ━━`);
      expect(firstHeader).toBeGreaterThanOrEqual(0);
      expect(secondHeader).toBeGreaterThan(firstHeader);
      const allLogsJsonResult = runCli(directory, ["logs", "clock", "--all", "--json"]);
      expect(allLogsJsonResult.status).toBe(0);
      const allLogsJson = JSON.parse(allLogsJsonResult.stdout) as { version: number; workflowId: string; runs: { runId: string }[] };
      expect(allLogsJson).toMatchObject({ version: 2, workflowId: "clock" });
      expect(allLogsJson.runs.map((run) => run.runId)).toEqual([runId, secondRunId]);
      const selectedDiagram = runCli(directory, ["diagram", "clock", "--run", runId]);
      expect(selectedDiagram.status).toBe(0);
      expect(selectedDiagram.stdout).toContain("tick (succeeded)");
      const mermaidDiagram = runCli(directory, ["diagram", "clock", "--run", runId, "--mermaid"]);
      expect(mermaidDiagram.status).toBe(0);
      expect(mermaidDiagram.stdout).toContain("flowchart LR");
      expect(mermaidDiagram.stdout).toContain('tick["tick [succeeded]"]');
      const socketPath = status.service.socketPath;
      if (socketPath === null) throw new Error("service socket path is missing");
      const viewerSource = createViewerSource(socketPath);
      const viewerSnapshot = await viewerSource.snapshot("clock");
      expect(viewerSnapshot.detail?.diagram.runId).toBe(secondRunId);
      expect(viewerSnapshot.detail?.nodes.map(node => [node.nodeId, node.status])).toEqual([["tick", "succeeded"]]);
      const worklogSection = logs.sections.find((section) => section.kind === "worklog");
      if (worklogSection?.kind !== "worklog") throw new Error("worklog section is missing");
      expect(worklogSection.content).toStartWith("# Workflow run: clock");
      const overviewSnapshot = await viewerSource.snapshot(null);
      expect(overviewSnapshot.status.workflows.map(workflow => workflow.workflowId)).toContain("clock");
      expect(overviewSnapshot.detail).toBeNull();
      for (const args of [["status"], ["watch"], ["status", "clock"], ["watch", "clock"]]) {
        const snapshot = runCli(directory, args);
        expect(snapshot.status).toBe(0);
        expect(snapshot.stdout).toContain("Title");
        expect(snapshot.stdout).toContain("Next run");
        expect(snapshot.stdout).toContain("Completed");
        expect(snapshot.stdout).not.toContain("inactive");
      }
      const aliasJson = runCli(directory, ["watch", "clock", "--json"]);
      expect(aliasJson.status).toBe(0);
      expect(statusDtoSchema.parse(JSON.parse(aliasJson.stdout)).workflows[0]?.latestRun?.runId).toBe(secondRunId);

      const laterStatusResult = runCli(directory, ["status", "clock", "--json"]);
      expect(laterStatusResult.status).toBe(0);
      const laterStatus = statusDtoSchema.parse(JSON.parse(laterStatusResult.stdout));
      expect(laterStatus.installationId).toBe(status.installationId);
      expect(laterStatus.service.bootId).toBe(status.service.bootId);

      const bigStart = runCli(directory, ["start", "big"]);
      if (bigStart.status !== 0) throw new Error(bigStart.stderr);
      const bigRunId = runIdSchema.parse(bigStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect(bigStart.stdout).toContain(`completed ${bigRunId}`);
      const bigDeadline = Date.now() + 10_000;
      let bigRuns = runsDtoSchema.parse({ version: 2, workflowId: "big", total: 0, truncated: false, runs: [] });
      while (Date.now() < bigDeadline) {
        const result = runCli(directory, ["runs", "big", "--json"]);
        expect(result.status).toBe(0);
        bigRuns = runsDtoSchema.parse(JSON.parse(result.stdout));
        if (bigRuns.runs[0]?.status === "completed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(bigRuns.runs[0]?.runId).toBe(bigRunId);
      expect(bigRuns.runs[0]?.status).toBe("completed");
      expect(bigRuns.runs[0]?.terminalOutput?.length).toBe(700_000);
      const bigLogsResult = runCli(directory, ["logs", "big", "--run", bigRunId, "--json"]);
      expect(bigLogsResult.status).toBe(0);
      const bigLogs = logsDtoSchema.parse(JSON.parse(bigLogsResult.stdout));
      expect(bigLogs.runId).toBe(bigRunId);
      const retainedCapture = bigLogs.sections.find((section) => section.kind === "capture");
      if (retainedCapture?.kind !== "capture") throw new Error("truncated worker capture is missing");
      expect(retainedCapture.capture).toMatchObject({
        totalBytes: 700_000,
        retainedBytes: 700_000,
        truncatedBytes: 0,
        keptHeadBytes: 700_000,
        keptTailBytes: 0,
        complete: true,
      });
      expect(retainedCapture.content?.length).toBe(700_000);
      expect(retainedCapture.content?.startsWith("HEAD")).toBe(true);
      expect(retainedCapture.content?.endsWith("TAIL")).toBe(true);
      const bigLogsText = runCli(directory, ["logs", "big", "--run", bigRunId]);
      expect(bigLogsText.status).toBe(0);
      expect(bigLogsText.stdout).toMatch(/700000 bytes total; 700000 retained \(700000 head \+ 0 tail\)/);
      const unlimitedStart = runCli(directory, ["start", "unlimited"]);
      expect(unlimitedStart.status).toBe(0);
      const unlimitedRunId = runIdSchema.parse(unlimitedStart.stdout.match(/Started run (\S+)/)?.[1]);
      const unlimitedLogsResult = runCli(directory, ["logs", "unlimited", "--run", unlimitedRunId, "--json"]);
      expect(unlimitedLogsResult.status).toBe(0);
      const unlimitedLogs = logsDtoSchema.parse(JSON.parse(unlimitedLogsResult.stdout));
      const unlimitedCapture = unlimitedLogs.sections.find((section) => section.kind === "capture" && section.capture.stream === "stdout");
      if (unlimitedCapture?.kind !== "capture") throw new Error("unlimited stdout capture is missing");
      expect(unlimitedCapture.content).toBe("unlimited-output");
      expect(unlimitedCapture.capture).toMatchObject({
        totalBytes: 16,
        retainedBytes: 16,
        truncatedBytes: 0,
        keptHeadBytes: 16,
        keptTailBytes: 0,
        complete: true,
      });
      for (let index = 0; index < 8; index += 1) {
        const extra = runCli(directory, ["start", "big"]);
        expect(extra.status).toBe(0);
        expect(extra.stdout).toContain("completed big-");
      }
      const boundedRunsResult = runCli(directory, ["runs", "big", "--json"]);
      expect(boundedRunsResult.status).toBe(0);
      const boundedRuns = runsDtoSchema.parse(JSON.parse(boundedRunsResult.stdout));
      expect(boundedRuns.total).toBe(9);
      expect(boundedRuns.runs.length).toBeLessThan(boundedRuns.total);
      expect(boundedRuns.truncated).toBe(true);
      const allRunsResult = runCli(directory, ["runs", "big", "--json", "--all"]);
      expect(allRunsResult.status).toBe(0);
      const allRuns = runsDtoSchema.parse(JSON.parse(allRunsResult.stdout));
      expect(allRuns.total).toBe(9);
      expect(allRuns.runs).toHaveLength(9);
      expect(allRuns.truncated).toBe(false);

      const oversizeStart = runCli(directory, ["start", "oversize"]);
      if (oversizeStart.status !== 0) throw new Error(oversizeStart.stderr);
      const oversizeRunId = runIdSchema.parse(oversizeStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect(oversizeStart.stdout).toContain(`completed ${oversizeRunId}`);
      const oversizeLogsResult = runCli(directory, ["logs", "oversize", "--run", oversizeRunId, "--json"], 30_000);
      expect(oversizeLogsResult.status).toBe(0);
      const oversizeLogs = logsDtoSchema.parse(JSON.parse(oversizeLogsResult.stdout));
      expect(Buffer.byteLength(oversizeLogsResult.stdout, "utf8")).toBeGreaterThan(16 * 1024 * 1024);
      expect(oversizeLogs.runId).toBe(oversizeRunId);
      const completeStdoutSections = oversizeLogs.sections.filter((section) => section.kind === "capture" && section.content?.length === 700_000);
      expect(completeStdoutSections).toHaveLength(4);
    } finally {
      await stopService(directory);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function makeRoot(input: { machine: string | null; workflows: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), "workshop-cli-"));
  const workshopDirectory = join(root, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  if (input.machine !== null) writeFileSync(join(workshopDirectory, "workshop.yaml"), input.machine, "utf8");
  for (const [id, text] of Object.entries(input.workflows)) writeFileSync(join(workshopDirectory, "workflows", `${id}.yaml`), text, "utf8");
  return root;
}

function runCli(cwd: string, args: readonly string[], timeout = 20_000) {
  const result = spawnSync("bun", [cliPath, ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(child: ChildProcess): Promise<number> {
  if (child.pid === undefined) await new Promise((resolveSpawn) => child.once("spawn", resolveSpawn));
  return child.pid!;
}

function killRecordedService(metadataPath: string): void {
  if (!existsSync(metadataPath)) return;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: unknown; status?: unknown };
  if (typeof metadata.pid === "number" && metadata.status !== "stopped") {
    try { process.kill(metadata.pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

async function stopService(root: string): Promise<void> {
  const metadataPath = join(root, ".workshop", "state", "service.json");
  if (!existsSync(metadataPath)) return;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: unknown; status?: unknown };
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
