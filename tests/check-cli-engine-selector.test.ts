import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runIdV2Schema } from "../src/run/schema-v2.js";
import { logsDtoV2Schema, runsDtoV2Schema, statusDtoV2Schema } from "../src/views/schema-v2.js";
import { createV4ViewerSource } from "../src/cli/watch-v4.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");

describe("CLI engine selector", () => {
  test("defaults help to v4, keeps v3 help behind --engine v3, and stays offline", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-engine-selector-"));
    try {
      for (const args of [[], ["help"], ["--help"], ["--engine", "v4", "help"]]) {
        const help = runCli(directory, args);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("v4 is the default engine");
        expect(help.stdout).toContain("--engine v3");
        expect(help.stdout).toContain("watch [<workflow>]");
        expect(help.stdout).toContain("service start | serve | status [--json] | stop");
        expect(help.stdout).not.toContain("experimental");
      }

      const legacy = runCli(directory, ["--engine", "v3", "help"]);
      expect(legacy.status).toBe(0);
      expect(legacy.stdout).toContain("workshop v3 — legacy SQLite runner");
      expect(legacy.stdout).toContain("workshop --engine v3 orchestrate");
      expect(existsSync(join(directory, ".workshop"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unsupported, misplaced, and repeated selectors without falling back", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-engine-selector-invalid-"));
    try {
      const invalidArguments = [
        ["--engine"],
        ["--engine", "v5", "help"],
        ["--engine=v4", "help"],
        ["help", "--engine", "v4"],
        ["status", "--engine", "v3"],
        ["--engine", "v4", "--engine", "v4", "help"],
        ["--engine", "v3", "--engine", "v3", "help"],
      ];
      for (const args of invalidArguments) {
        const result = runCli(directory, args);
        expect(result.status).toBe(64);
        expect(result.stderr).toContain("error:");
        expect(result.stdout).toBe("");
      }

      const unknown = runCli(directory, ["unknown-command"]);
      expect(unknown.status).toBe(64);
      expect(unknown.stderr).toContain("unknown command: unknown-command");
      const invalidWatch = runCli(directory, ["watch", "--json"]);
      expect(invalidWatch.status).toBe(64);
      expect(invalidWatch.stderr).toContain("usage: workshop watch");
      expect(existsSync(join(directory, ".workshop"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("validates v2 YAML and resolved settings without creating service state", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-v4-validate-"));
    const configDirectory = join(directory, ".workshop", "config");
    const workflowsDirectory = join(configDirectory, "workflows");
    const stateDirectory = join(directory, ".workshop", "state");
    mkdirSync(workflowsDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "workshop.yaml"), "version: 2\nshell: /bin/bash\n", "utf8");
    writeFileSync(join(workflowsDirectory, "clock.yaml"), [
      "version: 2",
      "id: clock",
      "nodes:",
      "  tick:",
      "    run:",
      "      command: printf-tick",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    try {
      const result = runCli(directory, ["--engine", "v4", "validate", "clock"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('valid v4 workflow "clock" (1 nodes)');
      expect(existsSync(stateDirectory)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("routes public v4 commands through one temporary YAML installation and canonical run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-v4-public-cli-"));
    const configDirectory = join(directory, ".workshop", "config");
    const workflowsDirectory = join(configDirectory, "workflows");
    mkdirSync(workflowsDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "workshop.yaml"), "version: 2\nshell: /bin/bash\n", "utf8");
    writeFileSync(join(workflowsDirectory, "clock.yaml"), [
      "version: 2",
      "id: clock",
      "description: Public CLI fixture",
      "nodes:",
      "  tick:",
      "    run:",
      "      command: sleep 2; printf 'fixture-output'",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflowsDirectory, "big.yaml"), [
      "version: 2",
      "id: big",
      "nodes:",
      "  tick:",
      "    run:",
      "      command: >-",
      "        printf HEAD; head -c 699992 /dev/zero | tr '\\000' '\"'; printf TAIL",
      "    stream_cap: 1kb",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflowsDirectory, "unlimited.yaml"), [
      "version: 2",
      "id: unlimited",
      "nodes:",
      "  tick:",
      "    run:",
      "      command: printf 'unlimited-output'",
      "    stream_cap: unlimited",
      "    next: null",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflowsDirectory, "oversize.yaml"), [
      "version: 2",
      "id: oversize",
      "nodes:",
      "  first:",
      "    run:",
      "      command: head -c 700000 /dev/zero",
      "    stream_cap: 1mb",
      "    next: second",
      "  second:",
      "    run:",
      "      command: head -c 700000 /dev/zero",
      "    stream_cap: 1mb",
      "    next: third",
      "  third:",
      "    run:",
      "      command: head -c 700000 /dev/zero",
      "    stream_cap: 1mb",
      "    next: fourth",
      "  fourth:",
      "    run:",
      "      command: head -c 700000 /dev/zero",
      "    stream_cap: 1mb",
      "    next: null",
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(directory, ["--engine", "v4", "start", "clock", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdV2Schema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);

      const statusResult = runCli(directory, ["--engine", "v4", "status", "clock", "--json"]);
      expect(statusResult.status).toBe(0);
      const status = statusDtoV2Schema.parse(JSON.parse(statusResult.stdout));
      expect(status.installationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(status.workflows[0]?.workflowId).toBe("clock");
      expect(status.workflows[0]?.unresolvedRun?.runId).toBe(runId);
      const followedLogs = runCli(directory, ["--engine", "v4", "logs", "clock", "--run", runId, "--follow"], 15_000);
      expect(followedLogs.status).toBe(0);
      expect(followedLogs.stdout).toContain("fixture-output");

      let runs = runsDtoV2Schema.parse({ version: 2, workflowId: "clock", total: 0, truncated: false, runs: [] });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = runCli(directory, ["--engine", "v4", "runs", "clock", "--json"]);
        expect(result.status).toBe(0);
        runs = runsDtoV2Schema.parse(JSON.parse(result.stdout));
        if (runs.runs[0]?.status === "completed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(runs.runs[0]?.status).toBe("completed");
      expect(runs.runs[0]?.runId).toBe(runId);

      const logsResult = runCli(directory, ["--engine", "v4", "logs", "clock", "--run", runId!, "--json"]);
      expect(logsResult.status).toBe(0);
      const logs = logsDtoV2Schema.parse(JSON.parse(logsResult.stdout));
      expect(logs.runId).toBe(runId);
      expect(logs.sections.some((section) => section.kind === "capture" && section.content === "fixture-output")).toBe(true);
      const humanRuns = runCli(directory, ["--engine", "v4", "runs", "clock"]);
      expect(humanRuns.status).toBe(0);
      expect(humanRuns.stdout).toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(humanRuns.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

      const secondStart = runCli(directory, ["--engine", "v4", "start", "clock"], 15_000);
      expect(secondStart.status).toBe(0);
      const secondRunId = runIdV2Schema.parse(secondStart.stdout.match(/Started run (\S+)/)?.[1]);
      const allLogsText = runCli(directory, ["--engine", "v4", "logs", "clock", "--all"]);
      expect(allLogsText.status).toBe(0);
      const firstHeader = allLogsText.stdout.indexOf(`━━ run ${runId} — completed ━━`);
      const secondHeader = allLogsText.stdout.indexOf(`━━ run ${secondRunId} — completed ━━`);
      expect(firstHeader).toBeGreaterThanOrEqual(0);
      expect(secondHeader).toBeGreaterThan(firstHeader);
      const allLogsJsonResult = runCli(directory, ["--engine", "v4", "logs", "clock", "--all", "--json"]);
      expect(allLogsJsonResult.status).toBe(0);
      const allLogsJson = JSON.parse(allLogsJsonResult.stdout) as { version: number; workflowId: string; runs: { runId: string }[] };
      expect(allLogsJson).toMatchObject({ version: 2, workflowId: "clock" });
      expect(allLogsJson.runs.map((run) => run.runId)).toEqual([runId, secondRunId]);
      const selectedDiagram = runCli(directory, ["--engine", "v4", "diagram", "clock", "--run", runId]);
      expect(selectedDiagram.status).toBe(0);
      expect(selectedDiagram.stdout).toContain("tick (succeeded)");
      const mermaidDiagram = runCli(directory, ["--engine", "v4", "diagram", "clock", "--run", runId, "--mermaid"]);
      expect(mermaidDiagram.status).toBe(0);
      expect(mermaidDiagram.stdout).toContain("flowchart LR");
      expect(mermaidDiagram.stdout).toContain('tick["tick [succeeded]"]');
      const socketPath = status.service.socketPath;
      if (socketPath === null) throw new Error("v4 service socket path is missing");
      const viewerSource = createV4ViewerSource(socketPath);
      const viewerSnapshot = await viewerSource.snapshot("clock", runId);
      expect(viewerSnapshot.runs.runs.map((run) => run.id)).toEqual([secondRunId, runId]);
      expect(viewerSnapshot.runs.runs.find((run) => run.id === runId)?.nodes.map((node) => [node.id, node.status])).toEqual([["tick", "completed"]]);
      expect(viewerSnapshot.runs.runs.find((run) => run.id === secondRunId)?.nodes).toEqual([]);
      const worklogSection = logs.sections.find((section) => section.kind === "worklog");
      if (worklogSection?.kind !== "worklog") throw new Error("worklog section is missing");
      expect(await viewerSource.log("clock", runId)).toBe(worklogSection.content);
      const collatedViewerLog = await viewerSource.log("clock", null);
      const firstViewerLog = collatedViewerLog.indexOf(`━━ run ${runId} — completed ━━`);
      const secondViewerLog = collatedViewerLog.indexOf(`━━ run ${secondRunId} — completed ━━`);
      expect(firstViewerLog).toBeGreaterThanOrEqual(0);
      expect(secondViewerLog).toBeGreaterThan(firstViewerLog);
      const pickerSnapshot = await viewerSource.snapshot(null);
      expect(pickerSnapshot.status.workflows.map((workflow) => workflow.id)).toContain("clock");

      const laterStatusResult = runCli(directory, ["--engine", "v4", "status", "clock", "--json"]);
      expect(laterStatusResult.status).toBe(0);
      const laterStatus = statusDtoV2Schema.parse(JSON.parse(laterStatusResult.stdout));
      expect(laterStatus.installationId).toBe(status.installationId);
      expect(laterStatus.service.bootId).toBe(status.service.bootId);

      const bigStart = runCli(directory, ["--engine", "v4", "start", "big"]);
      if (bigStart.status !== 0) throw new Error(bigStart.stderr);
      const bigRunId = runIdV2Schema.parse(bigStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect(bigStart.stdout).toContain(`completed ${bigRunId}`);
      const bigDeadline = Date.now() + 10_000;
      let bigRuns = runsDtoV2Schema.parse({ version: 2, workflowId: "big", total: 0, truncated: false, runs: [] });
      while (Date.now() < bigDeadline) {
        const result = runCli(directory, ["--engine", "v4", "runs", "big", "--json"]);
        expect(result.status).toBe(0);
        bigRuns = runsDtoV2Schema.parse(JSON.parse(result.stdout));
        if (bigRuns.runs[0]?.status === "completed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(bigRuns.runs[0]?.runId).toBe(bigRunId);
      expect(bigRuns.runs[0]?.status).toBe("completed");
      expect(bigRuns.runs[0]?.terminalOutput?.length).toBe(700_000);
      const bigLogsResult = runCli(directory, ["--engine", "v4", "logs", "big", "--run", bigRunId, "--json"]);
      expect(bigLogsResult.status).toBe(0);
      const bigLogs = logsDtoV2Schema.parse(JSON.parse(bigLogsResult.stdout));
      expect(bigLogs.runId).toBe(bigRunId);
      const truncatedCapture = bigLogs.sections.find((section) => section.kind === "capture");
      if (truncatedCapture?.kind !== "capture") throw new Error("truncated worker capture is missing");
      expect(truncatedCapture.capture).toMatchObject({
        totalBytes: 700_000,
        retainedBytes: 1024,
        truncatedBytes: 698_976,
        keptHeadBytes: 683,
        keptTailBytes: 341,
        complete: false,
      });
      expect(truncatedCapture.content?.length).toBe(1024);
      expect(truncatedCapture.content?.startsWith("HEAD")).toBe(true);
      expect(truncatedCapture.content?.endsWith("TAIL")).toBe(true);
      const bigLogsText = runCli(directory, ["--engine", "v4", "logs", "big", "--run", bigRunId]);
      expect(bigLogsText.status).toBe(0);
      expect(bigLogsText.stdout).toMatch(/700000 bytes total; 1024 retained \(683 head \+ 341 tail\), 698976 omitted/);
      const unlimitedStart = runCli(directory, ["--engine", "v4", "start", "unlimited"]);
      expect(unlimitedStart.status).toBe(0);
      const unlimitedRunId = runIdV2Schema.parse(unlimitedStart.stdout.match(/Started run (\S+)/)?.[1]);
      const unlimitedLogsResult = runCli(directory, ["--engine", "v4", "logs", "unlimited", "--run", unlimitedRunId, "--json"]);
      expect(unlimitedLogsResult.status).toBe(0);
      const unlimitedLogs = logsDtoV2Schema.parse(JSON.parse(unlimitedLogsResult.stdout));
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
        const extra = runCli(directory, ["--engine", "v4", "start", "big"]);
        expect(extra.status).toBe(0);
        expect(extra.stdout).toContain("completed big-");
      }
      const boundedRunsResult = runCli(directory, ["--engine", "v4", "runs", "big", "--json"]);
      expect(boundedRunsResult.status).toBe(0);
      const boundedRuns = runsDtoV2Schema.parse(JSON.parse(boundedRunsResult.stdout));
      expect(boundedRuns.total).toBe(9);
      expect(boundedRuns.runs.length).toBeLessThan(boundedRuns.total);
      expect(boundedRuns.truncated).toBe(true);
      const allRunsResult = runCli(directory, ["--engine", "v4", "runs", "big", "--json", "--all"]);
      expect(allRunsResult.status).toBe(0);
      const allRuns = runsDtoV2Schema.parse(JSON.parse(allRunsResult.stdout));
      expect(allRuns.total).toBe(9);
      expect(allRuns.runs).toHaveLength(9);
      expect(allRuns.truncated).toBe(false);

      const oversizeStart = runCli(directory, ["--engine", "v4", "start", "oversize"]);
      if (oversizeStart.status !== 0) throw new Error(oversizeStart.stderr);
      const oversizeRunId = runIdV2Schema.parse(oversizeStart.stdout.match(/Started run (\S+)/)?.[1]);
      expect(oversizeStart.stdout).toContain(`completed ${oversizeRunId}`);
      const oversizeLogsResult = runCli(directory, ["--engine", "v4", "logs", "oversize", "--run", oversizeRunId, "--json"], 30_000);
      expect(oversizeLogsResult.status).toBe(0);
      const oversizeLogs = logsDtoV2Schema.parse(JSON.parse(oversizeLogsResult.stdout));
      expect(Buffer.byteLength(oversizeLogsResult.stdout, "utf8")).toBeGreaterThan(16 * 1024 * 1024);
      expect(oversizeLogs.runId).toBe(oversizeRunId);
      const completeStdoutSections = oversizeLogs.sections.filter((section) => section.kind === "capture" && section.content?.length === 700_000);
      expect(completeStdoutSections).toHaveLength(4);
    } finally {
      await stopV4Service(directory);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function runCli(cwd: string, args: readonly string[], timeout = 10_000) {
  const result = spawnSync("bun", [cliPath, ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function stopV4Service(root: string): Promise<void> {
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
