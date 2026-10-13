import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { runIdSchema } from "../src/run/schema.js";
import { serviceLogSectionPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { nodeDescriptionDtoSchema, statusDtoSchema } from "../src/views/schema.js";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("projection fixture did not reach its expected state");
}

async function socketFor(root: string) {
  const health = await probeServiceHealth(loadInstallation(root).stateDirectory);
  if (health.kind !== "ready") throw new Error(health.reason);
  return health.metadata.socketPath;
}

async function node(socket: string, runId: string, stepId: string) {
  const response = await sendServiceRequest(socket, { version: 1, method: "node.describe", workflowId: "projection", runId: runIdSchema.parse(runId), nodeId: stepId });
  if (!response.ok) throw new Error(response.error.message);
  return nodeDescriptionDtoSchema.parse(response.result);
}

function installation(root: string) {
  const config = join(root, ".workshop");
  const workflows = join(config, "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\nkeep_files: failed\n");
  writeFileSync(join(workflows, "projection.yaml"), [
    "version: 4",
    "defaults: { retries: 0, replay: never }",
    "steps:",
    "  - first:",
    "      run: |",
    "        printf x >> first-launches",
    "        printf 'live diagnostic\\n' >&2",
    "        touch first-started",
    "        while ! test -f release-first; do sleep 0.02; done",
    "        printf alpha",
    "        printf 'first diagnostic' >&2",
    "  - second:",
    "      run: |",
    "        printf x >> second-launches",
    "        grep -q '^alpha$' \"$WORKSHOP_RESULTS_PATH\" || exit 9",
    "        cp \"$WORKSHOP_RESULTS_PATH\" successor-results",
    "        printf '%s-beta' \"$(cat)\"",
    "",
  ].join("\n"));
  return loadInstallation(root);
}

describe("service run projections", () => {
  test("makes accepted results current before a successor and retains readable bytes after cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-service-projections-"));
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      const configured = installation(root);
      owner = await startWorkshopService(configured);
      const socket = await socketFor(root);
      const response = await sendServiceRequest(socket, { version: 1, method: "start", requestId: "projection-start", workflowId: "projection" });
      if (!response.ok) throw new Error(response.error.message);
      const { runId } = serviceStartResultV1Schema.parse(response.result);
      await until(async () => existsSync(join(root, "first-started")) ? true : undefined);
      const live = await node(socket, runId, "first");
      expect(live.node.status).toBe("running");
      expect(live.node.liveStderr).toContain("live diagnostic");
      writeFileSync(join(root, "release-first"), "");
      const completed = await until(async () => { const value = await node(socket, runId, "second"); return value.runStatus === "completed" ? value : undefined; });
      expect(completed.node.status).toBe("succeeded");
      const directory = join(configured.runsDirectory, runId);
      const resultsPath = join(directory, "results.md");
      const logPath = join(directory, "execution.log");
      const runTag = createHash("sha256").update(runId).digest("hex").slice(0, 8);
      expect(readFileSync(join(root, "successor-results"), "utf8")).toContain("<result-first-" + runTag + ' status="succeeded">\nalpha\n</result-first-' + runTag + ">");
      expect(readFileSync(resultsPath, "utf8")).toContain("alpha-beta");
      expect(readFileSync(logPath, "utf8")).toContain("[step=first attempt=1 role=worker] incarnation 1 stderr\nlive diagnostic\nfirst diagnostic");
      const first = await node(socket, runId, "first");
      const captures = first.node.attempts[0]!.processes[0]!.captures;
      expect(captures).toHaveLength(2);
      for (const capture of captures) expect(existsSync(capture.path)).toBe(false);
      const stdout = captures.find((capture) => capture.stream === "stdout")!;
      expect(Buffer.from(stdout.retained!.bytes, "base64").toString()).toBe("alpha");
      expect(readFileSync(join(root, "first-launches"), "utf8")).toBe("x");
      const before = JSON.stringify(first);
      writeFileSync(resultsPath, "human result edits");
      writeFileSync(logPath, "human log edits");
      expect(JSON.stringify(await node(socket, runId, "first"))).toBe(before);
      expect(readFileSync(resultsPath, "utf8")).not.toContain("human result edits");
      expect(readFileSync(logPath, "utf8")).not.toContain("human log edits");
      let cursor: string | undefined;
      let retainedStdout = "";
      do {
        const read = await sendServiceRequest(socket, { version: 1, method: "logs.page", workflowId: "projection", runId, ...(cursor === undefined ? {} : { cursor }) });
        if (!read.ok) throw new Error(read.error.message);
        const page = serviceLogSectionPageV1Schema.parse(read.result);
        if (page.section.kind === "capture" && page.section.label === "first worker stdout") retainedStdout += page.section.content;
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(retainedStdout).toBe("alpha");
      expect(readFileSync(resultsPath, "utf8").match(new RegExp("<result-first-" + runTag + ' status="', "gu"))).toHaveLength(1);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("restarts during an unavailable projection without repeating the accepted worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-projection-restart-"));
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      const configured = installation(root);
      owner = await startWorkshopService(configured);
      let socket = await socketFor(root);
      const response = await sendServiceRequest(socket, { version: 1, method: "start", requestId: "projection-restart", workflowId: "projection" });
      if (!response.ok) throw new Error(response.error.message);
      const { runId } = serviceStartResultV1Schema.parse(response.result);
      await until(async () => existsSync(join(root, "first-started")) ? true : undefined);
      const directory = join(configured.runsDirectory, runId);
      const resultsPath = join(directory, "results.md");
      rmSync(resultsPath, { force: true });
      mkdirSync(resultsPath);
      writeFileSync(join(root, "release-first"), "");
      await until(async () => { const value = await node(socket, runId, "first"); return value.node.status === "succeeded" ? value : undefined; });
      expect(existsSync(join(root, "second-launches"))).toBe(false);
      const logs = await sendServiceRequest(socket, { version: 1, method: "logs.page", workflowId: "projection", runId });
      if (!logs.ok) throw new Error(logs.error.message);
      expect(serviceLogSectionPageV1Schema.parse(logs.result).section.content).toContain("unavailable view:");
      await owner.shutdown();
      owner = undefined;
      expect(existsSync(join(root, "second-launches"))).toBe(false);
      rmSync(resultsPath, { recursive: true });
      writeFileSync(resultsPath + ".projection-interrupted", "partial stale data");
      owner = await startWorkshopService(configured);
      socket = await socketFor(root);
      await until(async () => { const value = await node(socket, runId, "second"); return value.runStatus === "completed" ? value : undefined; });
      expect(readFileSync(resultsPath, "utf8")).toContain("alpha-beta");
      expect(readFileSync(join(root, "first-launches"), "utf8")).toBe("x");
      expect(readFileSync(join(root, "second-launches"), "utf8")).toBe("x");
      expect(readFileSync(resultsPath, "utf8")).not.toContain("partial stale data");
      expect(existsSync(resultsPath + ".projection-interrupted")).toBe(false);
      const status = await sendServiceRequest(socket, { version: 1, method: "status", workflowId: "projection" });
      if (!status.ok) throw new Error(status.error.message);
      expect(statusDtoSchema.parse(status.result).workflows[0]!.unresolvedRun).toBeNull();
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("logs worker and verifier envelopes, diagnostics, and feedback with process labels", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-projection-envelopes-"));
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      const configured = installation(root);
      const harness = "input=$(cat); printf 'role diagnostic' >&2; case \"$input\" in *'Role: verifier'*) printf 'verifier preamble\\n<decision>accept</decision>\\n<reason>checked</reason>\\nverifier trailer' ;; *) printf 'worker preamble\\n<status>succeeded</status>\\n<output>proposal</output>\\nworker trailer' ;; esac";
      writeFileSync(join(root, ".workshop", "workshop.yaml"), "shell: /bin/sh\nagent:\n  model: mock/model:low\n  harness:\n    command: " + JSON.stringify(harness) + "\n");
      writeFileSync(join(root, ".workshop", "workflows", "projection.yaml"), "version: 4\ndefaults: { retries: 0, replay: never }\nsteps:\n  - first:\n      agent: Write proposal.\n      verify:\n        agent: Check proposal.\n");
      owner = await startWorkshopService(loadInstallation(root));
      const socket = await socketFor(root);
      const response = await sendServiceRequest(socket, { version: 1, method: "start", requestId: "envelope-projection", workflowId: "projection" });
      if (!response.ok) throw new Error(response.error.message);
      const { runId } = serviceStartResultV1Schema.parse(response.result);
      await until(async () => { const value = await node(socket, runId, "first"); return value.runStatus === "completed" ? value : undefined; });
      const log = readFileSync(join(configured.runsDirectory, runId, "execution.log"), "utf8");
      for (const role of ["worker", "validator"]) {
        expect(log).toContain("[step=first attempt=1 role=" + role + "] incarnation 1 stderr\nrole diagnostic");
        expect(log).toContain("[step=first attempt=1 role=" + role + "] incarnation 1 preamble\n");
        expect(log).toContain("[step=first attempt=1 role=" + role + "] incarnation 1 trailer\n");
      }
      expect(log).toContain("verifier feedback\nchecked");
      expect(log).toContain("attempt_settled");
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("repairs files after a service crash at the pre-launch projection gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-projection-crash-"));
    const cli = (arguments_: string[]) => {
      const result = spawnSync(process.execPath, [new URL("../src/cli/main.ts", import.meta.url).pathname, ...arguments_], { cwd: root, encoding: "utf8", timeout: 15_000 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };
    try {
      const configured = installation(root);
      const runId = runIdSchema.parse(cli(["start", "projection", "--detach"]).match(/Started run (\S+)/u)?.[1]);
      await until(async () => existsSync(join(root, "first-started")) ? true : undefined);
      const resultsPath = join(configured.runsDirectory, runId, "results.md");
      rmSync(resultsPath, { force: true });
      mkdirSync(resultsPath);
      writeFileSync(join(root, "release-first"), "");
      const health = await probeServiceHealth(configured.stateDirectory);
      if (health.kind !== "ready") throw new Error(health.reason);
      await until(async () => { const value = await node(health.metadata.socketPath, runId, "first"); return value.node.status === "succeeded" ? value : undefined; });
      expect(existsSync(join(root, "second-launches"))).toBe(false);
      process.kill(health.metadata.pid, "SIGKILL");
      await until(async () => {
        try { process.kill(health.metadata.pid, 0); return undefined; } catch { return true; }
      });
      rmSync(resultsPath, { recursive: true });
      cli(["status", "projection"]);
      const socket = await socketFor(root);
      await until(async () => { const value = await node(socket, runId, "second"); return value.runStatus === "completed" ? value : undefined; });
      expect(readFileSync(resultsPath, "utf8")).toContain("alpha-beta");
      expect(readFileSync(join(root, "first-launches"), "utf8")).toBe("x");
      expect(readFileSync(join(root, "second-launches"), "utf8")).toBe("x");
    } finally {
      cli(["service", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
