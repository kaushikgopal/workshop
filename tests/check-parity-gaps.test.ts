import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { machineConfigSchema } from "../src/definition/schema.js";
import { runIdSchema } from "../src/run/schema.js";
import { logsDtoSchema, nodeDescriptionDtoSchema, runsDtoSchema, statusDtoSchema } from "../src/views/schema.js";
import { REPO_ROOT } from "./helpers.js";

const cliPath = join(REPO_ROOT, "src/cli/main.ts");

describe("public inspection parity", () => {
  test("status text, validator streams, node text, and a failed selected chain follow canonical state", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-parity-gaps-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    const firstStarted = join(root, "first-started.txt");
    const releaseFirst = join(root, "release-first.txt");
    const thirdStarted = join(root, "third-started.txt");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "chain.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - first:",
      "      run: >-",
      `        printf started > '${firstStarted}'; while [ ! -e '${releaseFirst}' ]; do sleep 0.05; done; printf worker-err >&2; printf first-output`,
      "      verify:",
      "        run: >-",
      "          printf validator-out; printf validator-err >&2",
      "  - second:",
      "      run: 'printf second-err >&2; exit 7'",
      "  - third:",
      `      run: 'printf started > ${thirdStarted}'`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workflows, "idle.yaml"), [
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - only: printf idle",
      "",
    ].join("\n"), "utf8");

    try {
      const started = runCli(root, ["start", "chain", "--detach"]);
      expect(started.status).toBe(0);
      const runId = runIdSchema.parse(started.stdout.match(/Started run (\S+)/)?.[1]);
      await waitForFile(firstStarted);

      const statusJson = runCli(root, ["status", "--json"]);
      expect(statusJson.status).toBe(0);
      const status = statusDtoSchema.parse(JSON.parse(statusJson.stdout));
      const chainStatus = status.workflows.find((workflow) => workflow.workflowId === "chain");
      expect(chainStatus?.unresolvedRun?.runId).toBe(runId);
      expect(chainStatus?.unresolvedRun?.status).toBe("running");
      expect(chainStatus?.activation).toMatchObject({ state: "exhausted", admittedCount: 1, maxRuns: 1 });
      expect(status.workflows.find((workflow) => workflow.workflowId === "idle")?.unresolvedRun).toBeNull();
      const statusText = runCli(root, ["status"]);
      expect(statusText.status).toBe(0);
      expect(statusText.stdout).toMatch(/chain\s+Running\s+—/);
      expect(statusText.stdout).toMatch(/idle\s+Ready\s+—/);
      const filteredText = runCli(root, ["status", "chain"]);
      expect(filteredText.stdout).toMatch(/chain\s+Running\s+—/);
      expect(filteredText.stdout).not.toContain("idle");

      writeFileSync(releaseFirst, "go", "utf8");
      const failed = await waitForRunStatus(root, "chain", runId, "failed");
      expect(failed.currentNodeId).toBe("second");
      expect(existsSync(thirdStarted)).toBe(false);
      const settledText = runCli(root, ["status", "chain"]);
      expect(settledText.stdout).toMatch(/chain\s+Failed\s+—/);

      const logsJson = runCli(root, ["logs", "chain", "--run", runId, "--json"]);
      expect(logsJson.status).toBe(0);
      const logs = logsDtoSchema.parse(JSON.parse(logsJson.stdout));
      // Stderr may begin with noise from the caller's BASH_ENV, so stderr checks match the suffix.
      const captures = new Map(logs.sections.flatMap((section) => section.kind === "capture" ? [[section.label, section.content] as const] : []));
      expect(captures.get("first worker stdout")).toBe("first-output");
      expect(captures.get("first worker stderr")).toEndWith("worker-err");
      expect(captures.get("first validator stdout")).toBe("validator-out");
      expect(captures.get("first validator stderr")).toEndWith("validator-err");
      expect(captures.get("second worker stderr")).toEndWith("second-err");
      expect([...captures.keys()].some((label) => label.startsWith("third "))).toBe(false);
      const logsText = runCli(root, ["logs", "chain", "--run", runId]);
      expect(logsText.status).toBe(0);
      for (const text of ["first validator stdout", "validator-out", "first validator stderr", "validator-err", "second-err"]) {
        expect(logsText.stdout).toContain(text);
      }

      const failedNodeJson = runCli(root, ["step", "describe", "chain", "second", "--run", runId, "--json"]);
      expect(failedNodeJson.status).toBe(0);
      const failedNode = nodeDescriptionDtoSchema.parse(JSON.parse(failedNodeJson.stdout));
      expect(failedNode.runStatus).toBe("failed");
      expect(failedNode.node.status).toBe("failed");
      expect(failedNode.node.successfulOutput).toBeNull();
      expect(failedNode.node.resolvedSettings.run).toMatchObject({ kind: "command", command: "printf second-err >&2; exit 7" });
      const failedNodeText = runCli(root, ["step", "describe", "chain", "second", "--run", runId]);
      expect(failedNodeText.status).toBe(0);
      expect(failedNodeText.stdout).toContain(`chain/second  failed  ${runId}`);
      const firstNodeText = runCli(root, ["step", "describe", "chain", "first", "--run", runId]);
      expect(firstNodeText.stdout).toContain(`chain/first  succeeded  ${runId}`);
      expect(firstNodeText.stdout).toContain("first-output");
      const pendingNode = nodeDescriptionDtoSchema.parse(JSON.parse(
        runCli(root, ["step", "describe", "chain", "third", "--run", runId, "--json"]).stdout,
      ));
      expect(pendingNode.node.status).toBe("pending");
      expect(pendingNode.node.attempts).toHaveLength(0);

      const diagram = runCli(root, ["diagram", "chain", "--run", runId]);
      expect(diagram.status).toBe(0);
      expect(diagram.stdout).toContain("first (succeeded)");
      expect(diagram.stdout).toContain("second (failed)");
      expect(diagram.stdout).not.toContain("third (succeeded)");
      expect(diagram.stdout).not.toContain("third (failed)");
      const mermaid = runCli(root, ["diagram", "chain", "--run", runId, "--mermaid"]);
      expect(mermaid.status).toBe(0);
      expect(mermaid.stdout).toContain('first["first [succeeded]"]');
      expect(mermaid.stdout).toContain('second["second [failed]"]');
      expect(mermaid.stdout).not.toMatch(/third\["third \[(succeeded|failed|running)\]"\]/);
    } finally {
      await stopService(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("retention limits", () => {
  test("resolves stream caps from node override, workflow default, machine default, then the built-in limit", () => {
    const definition = (defaults: string) => checkDefinitionText([
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      ...defaults === "" ? [] : [`  stream_cap: ${defaults}`],
      "steps:",
      "  - inherited:",
      "      run: printf inherited",
      "      verify: printf ok",
      "  - overridden:",
      "      run: printf overridden",
      "      stream_cap: unlimited",
      "",
    ].join("\n"), "caps.yaml", "caps").def;
    const caps = (defaults: string, machineCap: string | undefined) => {
      const machine = machineConfigSchema.parse({ ...machineCap === undefined ? {} : { stream_cap: machineCap } });
      const settings = resolveWorkflowSettings({ definition: definition(defaults), machine, projectCwd: "/tmp" });
      return {
        inherited: settings.nodes.inherited?.run.streamCapBytes,
        validator: settings.nodes.inherited?.validator?.streamCapBytes,
        overridden: settings.nodes.overridden?.run.streamCapBytes,
      };
    };

    expect(caps("", undefined)).toEqual({ inherited: 256 * 1024, validator: 256 * 1024, overridden: "unlimited" });
    expect(caps("", "2kb")).toEqual({ inherited: 2048, validator: 2048, overridden: "unlimited" });
    expect(caps("1kb", "2kb")).toEqual({ inherited: 1024, validator: 1024, overridden: "unlimited" });
  });
});

describe("import boundaries", () => {
  const sourceRoot = join(REPO_ROOT, "src");
  const productFiles = sourceFiles(sourceRoot);

  test("all source files are reachable", () => {
    // Type-only imports count: a file that only declares a contract is still in use.
    const reachable = importClosure(["src/cli/main.ts", "src/service/serve-service-process.ts"], { includeTypes: true });
    const unreachable = productFiles.map(repoPath).filter((path) => !reachable.includes(path));
    expect(unreachable).toEqual([]);
  });

  test("help and validate load neither the service client nor the viewer", () => {
    const loaded = importClosure(["src/cli/main.ts"], { includeTypes: false, includeDynamic: false });
    expect(loaded).toContain("src/installation/load-installation.ts");
    expect(loaded.filter((path) => path.startsWith("src/tui/") || path.startsWith("src/service/"))).toEqual([]);
  });

  test("the CLI is a socket client and never loads Durable storage", () => {
    // `service serve` turns the CLI process into the service, so the walk stops there.
    const loaded = importClosure(["src/cli/main.ts"], { includeTypes: false, stopAt: ["src/service/serve-service-process.ts"] });
    expect(loaded).toContain("src/cli/watch.ts");
    expect(loaded.filter((path) => path.startsWith("src/storage/durable/"))).toEqual([]);
  });

  test("product code does not hardcode the Hemingway workflow or node ids", () => {
    const hardcoded = /["'`](hemingway[-.][a-z.-]+|node-(timestamp|generate|generate-line|publish-quote|append-quote|archive))["'`]/;
    const offenders = productFiles.filter((file) => hardcoded.test(withoutComments(readFileSync(file, "utf8"))));
    expect(offenders.map(repoPath)).toEqual([]);
  });

  function importClosure(
    entries: readonly string[],
    options: { includeTypes: boolean; includeDynamic?: boolean; stopAt?: readonly string[] },
  ): string[] {
    const seen = new Set<string>();
    const pending = entries.map((entry) => join(REPO_ROOT, entry));
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file) || options.stopAt?.includes(repoPath(file))) continue;
      seen.add(file);
      pending.push(...relativeImports(file, options));
    }
    return [...seen].map(repoPath).sort();
  }

  function relativeImports(file: string, options: { includeTypes: boolean; includeDynamic?: boolean }): string[] {
    let source = withoutComments(readFileSync(file, "utf8"));
    // Type-only imports vanish at compile time, so they cannot load a module at runtime.
    if (!options.includeTypes) source = source.replace(/^(?:import|export)\s+type\s[^;]*?from\s+"[^"]+";?/gm, "");
    if (options.includeDynamic === false) source = source.replace(/import\(\s*"[^"]+"\s*\)/g, "");
    const targets: string[] = [];
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = resolve(dirname(file), match[1]!).replace(/\.js$/, ".ts");
      if (!existsSync(target)) throw new Error(`${repoPath(file)} imports unresolved ${match[1]}`);
      targets.push(target);
    }
    return targets;
  }
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path);
}

function runCli(cwd: string, args: readonly string[], timeout = 10_000) {
  const result = spawnSync("bun", [cliPath, ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`${path} did not appear before the fixture deadline`);
}

async function waitForRunStatus(root: string, workflowId: string, runId: string, expectedStatus: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = runCli(root, ["runs", workflowId, "--json"]);
    if (result.status !== 0) throw new Error(result.stderr);
    const run = runsDtoSchema.parse(JSON.parse(result.stdout)).runs.find((entry) => entry.runId === runId);
    if (run?.status === expectedStatus) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus} before the fixture deadline`);
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
