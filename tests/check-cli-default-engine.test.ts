import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { processStartIdOrThrow } from "../src/process/identify-process.js";
import { locateServiceSocket } from "../src/service/locate-service-socket.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");

const V1_WORKFLOW = [
  "version: 1",
  "id: legacy",
  "description: Legacy fixture",
  "nodes:",
  "  tick:",
  "    run:",
  "      command: printf legacy",
  "    next: null",
  "",
].join("\n");

const V2_WORKFLOW = [
  "version: 2",
  "id: clock",
  "nodes:",
  "  tick:",
  "    run:",
  "      command: printf fixture-output",
  "    next: null",
  "",
].join("\n");

describe("default v4 engine", () => {
  test("unqualified commands use v4, the shipped examples validate, and --engine v4 stays valid", () => {
    const root = makeRoot({ machine: null, workflows: {} });
    try {
      copyFileSync(join(REPO_ROOT, "examples", "workshop.yaml"), join(root, ".workshop", "config", "workshop.yaml"));
      copyFileSync(
        join(REPO_ROOT, "examples", "workflows", "hemingway-clock.yaml"),
        join(root, ".workshop", "config", "workflows", "hemingway-clock.yaml"),
      );

      const unqualified = runCli(root, ["validate", "hemingway-clock"]);
      expect(unqualified.stderr).toBe("");
      expect(unqualified.status).toBe(0);
      expect(unqualified.stdout).toContain('valid v4 workflow "hemingway-clock" (3 nodes)');

      const explicit = runCli(root, ["--engine", "v4", "validate", "hemingway-clock"]);
      expect(explicit.status).toBe(0);
      expect(explicit.stdout).toBe(unqualified.stdout);
      expect(existsSync(join(root, ".workshop", "state"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("service start, status, and stop manage one owner idempotently", async () => {
    const root = makeRoot({ machine: "version: 2\nshell: /bin/bash\n", workflows: { clock: V2_WORKFLOW } });
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
    const root = makeRoot({ machine: "version: 2\nshell: /bin/bash\n", workflows: {} });
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
});

describe("legacy v3 installations under the default engine", () => {
  test("a v3 machine config gets migration guidance while --engine v3 keeps working", () => {
    const root = makeRoot({ machine: "shell: /bin/bash\n", workflows: { legacy: V1_WORKFLOW } });
    try {
      for (const args of [["validate", "legacy"], ["status"], ["start", "legacy"], ["service", "start"]]) {
        const refused = runCli(root, args);
        expect(refused.status).toBe(64);
        expect(refused.stderr).toContain("is a v3 machine config");
        expect(refused.stderr).toContain("workshop --engine v3 <command>");
        expect(refused.stderr).toContain("add `version: 2` to .workshop/config/workshop.yaml");
        expect(refused.stderr).toContain("replay: safe");
      }
      expect(existsSync(join(root, ".workshop", "state"))).toBe(false);

      const legacy = runCli(root, ["--engine", "v3", "validate", "legacy"]);
      expect(legacy.status).toBe(0);
      expect(legacy.stdout).toContain("legacy");
      expect(readFileSync(join(root, ".workshop", "config", "workshop.yaml"), "utf8")).toBe("shell: /bin/bash\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("v3 state without a machine config is refused and left untouched", () => {
    const root = makeRoot({ machine: null, workflows: { legacy: V1_WORKFLOW } });
    const stateDirectory = join(root, ".workshop", "state");
    try {
      const legacyStatus = runCli(root, ["--engine", "v3", "status", "--json"]);
      expect(legacyStatus.status).toBe(0);
      expect(existsSync(join(stateDirectory, "workshop.db"))).toBe(true);
      const before = readdirSync(stateDirectory).sort();

      const refused = runCli(root, ["status"]);
      expect(refused.status).toBe(64);
      expect(refused.stderr).toContain("this installation has v3 state");
      expect(refused.stderr).toContain("workshop --engine v3 <command>");
      expect(readdirSync(stateDirectory).sort()).toEqual(before);
      expect(existsSync(join(stateDirectory, "service.json"))).toBe(false);
      expect(existsSync(join(stateDirectory, "durable.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("version 1 workflows without a machine config are refused before v4 creates state", () => {
    const root = makeRoot({ machine: null, workflows: { legacy: V1_WORKFLOW } });
    try {
      for (const args of [["status"], ["service", "start"]]) {
        const refused = runCli(root, args);
        expect(refused.status).toBe(64);
        expect(refused.stderr).toContain("this installation has a version 1 workflow");
        expect(refused.stderr).toContain("workshop --engine v3 <command>");
      }
      expect(existsSync(join(root, ".workshop", "state"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a version 1 workflow under a v2 machine config names the v3 fallback", () => {
    const root = makeRoot({ machine: "version: 2\nshell: /bin/bash\n", workflows: { legacy: V1_WORKFLOW } });
    try {
      const refused = runCli(root, ["validate", "legacy"]);
      expect(refused.status).toBe(64);
      expect(refused.stderr).toContain("workflow version 1 is not supported by the v4 runtime");
      expect(refused.stderr).toContain("workshop --engine v3 <command>");
      expect(refused.stderr).toContain("max_runs: unlimited");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unqualified runtime callbacks stay on v3", () => {
    // End-to-end coverage lives in remediation-r1 S4, where a v3 agent reports
    // progress through `"$WORKSHOP_CLI" runtime progress` with no selector.
    const root = makeRoot({ machine: null, workflows: { legacy: V1_WORKFLOW } });
    try {
      const env = { ...process.env };
      for (const name of ["WORKSHOP_RUN_ID", "WORKSHOP_NODE_ID", "WORKSHOP_ATTEMPT", "WORKSHOP_OWNER_TOKEN"]) delete env[name];
      const callback = runCli(root, ["runtime", "progress", "--text", "working"], env);
      expect(callback.status).toBe(1);
      expect(callback.stderr).toContain("runtime commands require WORKSHOP_RUN_ID");
      expect(callback.stderr).not.toContain("unknown command");

      const v4Runtime = runCli(root, ["--engine", "v4", "runtime", "progress"], env);
      expect(v4Runtime.status).toBe(64);
      expect(v4Runtime.stderr).toContain("unknown command: runtime");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unqualified orchestrate points to the v4 service and --engine v3 orchestrate still runs the daemon", async () => {
    const root = makeRoot({ machine: null, workflows: { legacy: V1_WORKFLOW } });
    const lockPath = join(root, ".workshop", "state", "daemon.lock");
    try {
      const refused = runCli(root, ["orchestrate"]);
      expect(refused.status).toBe(64);
      expect(refused.stderr).toContain("workshop service start");
      expect(refused.stderr).toContain("workshop --engine v3 orchestrate");
      expect(existsSync(lockPath)).toBe(false);

      const daemon = spawn("bun", [cliPath, "--engine", "v3", "orchestrate"], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
      try {
        let stderr = "";
        daemon.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const deadline = Date.now() + 10_000;
        while (!stderr.includes("workshop daemon: polling") && Date.now() < deadline) await delay(25);
        expect(stderr).toContain("workshop daemon: polling");
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        const exited = new Promise((resolveExit) => daemon.once("exit", resolveExit));
        daemon.kill("SIGTERM");
        await exited;
      }
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function makeRoot(input: { readonly machine: string | null; readonly workflows: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), "workshop-default-engine-"));
  const configDirectory = join(root, ".workshop", "config");
  mkdirSync(join(configDirectory, "workflows"), { recursive: true });
  if (input.machine !== null) writeFileSync(join(configDirectory, "workshop.yaml"), input.machine, "utf8");
  for (const [id, yaml] of Object.entries(input.workflows)) {
    writeFileSync(join(configDirectory, "workflows", `${id}.yaml`), yaml, "utf8");
  }
  return root;
}

function runCli(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync("bun", [cliPath, ...args], { cwd, encoding: "utf8", timeout: 20_000, env });
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
