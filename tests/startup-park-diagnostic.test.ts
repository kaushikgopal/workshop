import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { locateServiceSocket } from "../src/service/locate-service-socket.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import {
  MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1,
  MAX_STARTUP_PARK_TASKS_V1,
  STARTUP_PARK_TASK_KINDS_V1,
  startupParkDiagnosticV1Schema,
} from "../src/service/schema.js";
import {
  createStartupParkDiagnostic,
  selectLowestStartupParkTasks,
  serializeStartupParkDiagnostic,
  STARTUP_PARK_DIAGNOSTIC_FILE,
  writeStartupParkDiagnostic,
} from "../src/service/write-startup-park-diagnostic.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import {
  StartupParkPendingTask,
  StartupParkTaskOne,
  StartupParkTaskTwo,
} from "./fixtures/startup-park-fixture.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/startup-park-fixture.ts");
const CLI = join(process.cwd(), "src/cli/main.ts");

describe("startup park diagnostics", () => {
  test("reports multiple restart-limit parks through status without resuming pending work", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-status-"));
    const paths = await createRestartLimitFixture(root);
    let serviceChild: ChildProcess | undefined;
    try {
      serviceChild = spawn(process.execPath, [FIXTURE, "serve", root, paths.failureMarker, paths.pendingMarker, paths.resumeMarker]);
      await waitForFile(paths.failureMarker, serviceChild);
      await waitForExit(serviceChild);

      const failure = readFileSync(paths.failureMarker, "utf8");
      expect(failure).toContain("Durable startup inspection found blocked or uncertain task state");
      expect(failure).not.toContain("startup park diagnostic");
      expect(readFileSync(paths.firstMarker, "utf8")).toBe("x");
      expect(readFileSync(paths.secondMarker, "utf8")).toBe("x");
      expect(existsSync(paths.pendingMarker)).toBe(false);
      expect(existsSync(paths.resumeMarker)).toBe(false);

      const stateDirectory = loadInstallation(root).stateDirectory;
      const metadata = JSON.parse(readFileSync(join(stateDirectory, "service.json"), "utf8")) as { bootId: string; status: string };
      const diagnosticPath = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
      const diagnosticBytes = readFileSync(diagnosticPath);
      expect(statSync(diagnosticPath).mode & 0o777).toBe(0o600);
      expect(diagnosticBytes.byteLength).toBeLessThanOrEqual(MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1);
      const diagnostic = startupParkDiagnosticV1Schema.parse(JSON.parse(diagnosticBytes.toString("utf8")));
      expect(metadata.status).toBe("failed");
      expect(diagnostic).toMatchObject({
        state: "historical_not_ready",
        bootId: metadata.bootId,
        blockedTaskCount: 2,
        observationComplete: false,
        truncated: false,
      });
      expect(diagnostic.blockedTasks).toHaveLength(2);
      expect(diagnostic.blockedTasks.map((task) => task.reason)).toEqual(["restart_limit", "restart_limit"]);
      expect(diagnostic.blockedTasks.map((task) => task.taskId)).toEqual([...diagnostic.blockedTasks.map((task) => task.taskId)].sort((left, right) => left - right));
      expect(diagnostic.limitations).toContain("graph_only_blocked_tasks");
      expect(diagnostic.limitations).toContain("process_task_uncertain");
      expect(diagnostic.blockedTasks.every((task) => task.attribution.kind === "unknown" && task.kind === "unknown")).toBe(true);
      expect(diagnosticBytes.toString("utf8")).not.toContain(paths.firstMarker);
      expect(diagnosticBytes.toString("utf8")).not.toContain(paths.pendingMarker);

      const probe = await probeServiceHealth(stateDirectory);
      expect(probe.kind).toBe("not_ready");
      if (probe.kind !== "not_ready") throw new Error("parked service unexpectedly became ready");
      expect(probe.startupFailure).toEqual(diagnostic);

      const status = spawnSync(process.execPath, [CLI, "service", "status", "--json"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(status.status).toBe(3);
      expect(JSON.parse(status.stdout)).toMatchObject({
        version: 1,
        state: "not_running",
        startupFailure: { state: "historical_not_ready", bootId: metadata.bootId, blockedTaskCount: 2, observationComplete: false },
      });
      const humanStatus = spawnSync(process.execPath, [CLI, "service", "status"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(humanStatus.status).toBe(3);
      expect(humanStatus.stdout).toContain("service not ready");
      expect(humanStatus.stdout).toContain("ownership: unknown");
      expect(humanStatus.stdout).not.toContain("service not running");
      expect(humanStatus.stdout).toContain("blocked tasks observed: 2");
      expect(humanStatus.stdout).toContain("omitted tasks: 0");
      expect(humanStatus.stdout).toContain("startup observation: incomplete");
      expect(humanStatus.stdout).toContain("limitation: graph_only_blocked_tasks");

      const truncated = createStartupParkDiagnostic(metadata.bootId, Array.from({ length: 300 }, (_, index) => ({
        taskId: index + 1,
        kind: "unknown" as const,
        reason: "restart_limit" as const,
        attribution: { kind: "unknown" as const },
      })));
      writeStartupParkDiagnostic(stateDirectory, truncated);
      expect(truncated.observationComplete).toBe(true);
      expect(truncated.truncated).toBe(true);
      const truncatedStatus = spawnSync(process.execPath, [CLI, "service", "status"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(truncatedStatus.status).toBe(3);
      expect(truncatedStatus.stdout).toContain("blocked tasks observed: 300");
      expect(truncatedStatus.stdout).toContain("omitted tasks: " + (300 - truncated.blockedTasks.length));
      expect(truncatedStatus.stdout).toContain("startup observation: complete");

      const arbitraryKind = "workshop.private-untrusted-kind";
      writeFileSync(diagnosticPath, JSON.stringify({
        ...truncated,
        blockedTasks: [{ ...truncated.blockedTasks[0]!, kind: arbitraryKind }, ...truncated.blockedTasks.slice(1)],
      }), { mode: 0o600 });
      const invalidKindStatus = spawnSync(process.execPath, [CLI, "service", "status"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(invalidKindStatus.status).toBe(3);
      expect(invalidKindStatus.stdout).not.toContain(arbitraryKind);
      expect(invalidKindStatus.stdout).not.toContain("startup diagnostic:");
    } finally {
      if (serviceChild !== undefined) await stopChild(serviceChild);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("selects the lowest task IDs from a large iterator", () => {
    const count = MAX_STARTUP_PARK_TASKS_V1 * 40;
    const tasks = (function* () {
      for (let taskId = count; taskId >= 1; taskId -= 1) yield { taskId };
    })();
    const selected = selectLowestStartupParkTasks(tasks);
    expect(selected.map((task) => task.taskId)).toEqual(
      Array.from({ length: MAX_STARTUP_PARK_TASKS_V1 }, (_, index) => index + 1),
    );
  });

  test("keeps the exact total and byte truncation for a bounded sorted prefix", () => {
    const workflowId = "a".repeat(80);
    const runId = workflowId + "-00000000-0000-4000-8000-000000000000";
    const candidates = Array.from({ length: 300 }, (_, index) => ({
      taskId: 300 - index,
      kind: "workshop.workflow-run" as const,
      reason: "migration_failed" as const,
      attribution: { kind: "workflow_run" as const, workflowId, runId },
    }));
    const selected = selectLowestStartupParkTasks(candidates);
    const diagnostic = createStartupParkDiagnostic(
      randomUUID(), selected, "2026-07-15T10:00:00.000Z", [], candidates.length,
    );
    expect(diagnostic.blockedTaskCount).toBe(candidates.length);
    expect(diagnostic.blockedTasks.length).toBeLessThan(selected.length);
    expect(diagnostic.blockedTasks.map((task) => task.taskId)).toEqual(
      Array.from({ length: diagnostic.blockedTasks.length }, (_, index) => index + 1),
    );
    expect(diagnostic.blockedTaskCount - diagnostic.blockedTasks.length).toBe(candidates.length - diagnostic.blockedTasks.length);
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.observationComplete).toBe(true);
    expect(Buffer.byteLength(serializeStartupParkDiagnostic(diagnostic), "utf8"))
      .toBeLessThanOrEqual(MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1);
  });

  test("keeps the startup safety error when the diagnostic destination cannot be replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-write-failure-"));
    const paths = await createRestartLimitFixture(root);
    const stateDirectory = loadInstallation(root).stateDirectory;
    mkdirSync(join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE));
    let serviceChild: ChildProcess | undefined;
    try {
      serviceChild = spawn(process.execPath, [FIXTURE, "serve", root, paths.failureMarker, paths.pendingMarker, paths.resumeMarker]);
      await waitForFile(paths.failureMarker, serviceChild);
      await waitForExit(serviceChild);
      const failure = readFileSync(paths.failureMarker, "utf8");
      expect(failure).toContain("Durable startup inspection found blocked or uncertain task state");
      expect(failure).not.toContain("diagnostic destination");
      expect(existsSync(paths.pendingMarker)).toBe(false);
      expect(existsSync(paths.resumeMarker)).toBe(false);
      const status = spawnSync(process.execPath, [CLI, "service", "status"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(status.status).toBe(3);
      expect(status.stdout).toContain("service not ready");
      expect(status.stdout).toContain("ownership: unknown");
      expect(status.stdout).not.toContain("startup diagnostic:");
    } finally {
      if (serviceChild !== undefined) await stopChild(serviceChild);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("fails closed without a task graph and does not resume cleanup work", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-no-graph-"));
    const paths = await createRestartLimitFixture(root);
    const stateDirectory = loadInstallation(root).stateDirectory;
    let serviceChild: ChildProcess | undefined;
    try {
      serviceChild = spawn(process.execPath, [FIXTURE, "serve", root, paths.failureMarker, paths.pendingMarker, paths.resumeMarker, "graph-unavailable"]);
      await waitForFile(paths.failureMarker, serviceChild);
      await waitForExit(serviceChild);
      const failure = readFileSync(paths.failureMarker, "utf8");
      expect(failure).toContain("Durable startup inspection found blocked or uncertain task state");
      const diagnosticPath = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
      expect(existsSync(diagnosticPath)).toBe(true);
      const diagnostic = startupParkDiagnosticV1Schema.parse(JSON.parse(readFileSync(diagnosticPath, "utf8")));
      expect(diagnostic.limitations).toContain("task_graph_unavailable");
      expect(existsSync(paths.pendingMarker)).toBe(false);
      expect(existsSync(paths.resumeMarker)).toBe(false);
    } finally {
      if (serviceChild !== undefined) await stopChild(serviceChild);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("does not resume when the installation readiness commit fails after inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-init-failure-"));
    const paths = await createRestartLimitFixture(root);
    const stateDirectory = loadInstallation(root).stateDirectory;
    let serviceChild: ChildProcess | undefined;
    try {
      serviceChild = spawn(process.execPath, [FIXTURE, "serve", root, paths.failureMarker, paths.pendingMarker, paths.resumeMarker, "initialization-fails"]);
      await waitForFile(paths.failureMarker, serviceChild);
      await waitForExit(serviceChild);
      const failure = readFileSync(paths.failureMarker, "utf8");
      expect(failure).toContain("fixture initialization commit failed");
      expect(existsSync(join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE))).toBe(false);
      expect(existsSync(paths.pendingMarker)).toBe(false);
      expect(existsSync(paths.resumeMarker)).toBe(false);
    } finally {
      if (serviceChild !== undefined) await stopChild(serviceChild);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("does not resume cleanup work when startup task inspection fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-no-inspection-"));
    const paths = await createRestartLimitFixture(root);
    const stateDirectory = loadInstallation(root).stateDirectory;
    let serviceChild: ChildProcess | undefined;
    try {
      serviceChild = spawn(process.execPath, [FIXTURE, "serve", root, paths.failureMarker, paths.pendingMarker, paths.resumeMarker, "inspection-unavailable"]);
      await waitForFile(paths.failureMarker, serviceChild);
      await waitForExit(serviceChild);
      const failure = readFileSync(paths.failureMarker, "utf8");
      expect(failure).toContain("Durable startup inspection found blocked or uncertain task state");
      const diagnosticPath = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
      expect(existsSync(diagnosticPath)).toBe(true);
      const diagnostic = startupParkDiagnosticV1Schema.parse(JSON.parse(readFileSync(diagnosticPath, "utf8")));
      expect(diagnostic.limitations).toContain("task_inspection_unavailable");
      expect(diagnostic.blockedTaskCount).toBe(2);
      expect(existsSync(paths.pendingMarker)).toBe(false);
      expect(existsSync(paths.resumeMarker)).toBe(false);
    } finally {
      if (serviceChild !== undefined) await stopChild(serviceChild);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("bounds and marks a truncated snapshot, then writes it privately", () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-bounds-"));
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    try {
      const blockedTasks = Array.from({ length: 1_000 }, (_, index) => ({
        taskId: index + 1,
        kind: "unknown" as const,
        reason: "restart_limit" as const,
        attribution: { kind: "unknown" as const },
      }));
      const diagnostic = createStartupParkDiagnostic(randomUUID(), blockedTasks, "2026-07-15T10:00:00.000Z");
      expect(diagnostic.blockedTaskCount).toBe(1_000);
      expect(diagnostic.truncated).toBe(true);
      expect(diagnostic.observationComplete).toBe(true);
      expect(diagnostic.blockedTasks.length).toBeLessThan(1_000);
      expect(Buffer.byteLength(JSON.stringify(diagnostic) + "\n", "utf8")).toBeLessThanOrEqual(MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1);

      writeStartupParkDiagnostic(stateDirectory, diagnostic);
      const path = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toContain('"truncated":true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts only the static task-kind allowlist", () => {
    const task = { taskId: 1, kind: "unknown" as const, reason: "restart_limit" as const, attribution: { kind: "unknown" as const } };
    const diagnostic = createStartupParkDiagnostic(randomUUID(), [task]);
    for (const kind of STARTUP_PARK_TASK_KINDS_V1) {
      const checked = startupParkDiagnosticV1Schema.safeParse({
        ...diagnostic,
        blockedTasks: [{ ...task, kind }],
      });
      expect(checked.success).toBe(true);
    }
    const arbitraryKind = startupParkDiagnosticV1Schema.safeParse({
      ...diagnostic,
      blockedTasks: [{ ...task, kind: "workshop.private-untrusted-kind" }],
    });
    expect(arbitraryKind.success).toBe(false);
  });

  test("rejects stale, malformed, unavailable, and symlinked diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-reader-"));
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    const currentBootId = randomUUID();
    const metadataPath = join(stateDirectory, "service.json");
    const diagnosticPath = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
    const metadata = {
      version: 1,
      status: "failed",
      pid: process.pid,
      startIdentity: "test-owner",
      bootId: currentBootId,
      startedAt: new Date().toISOString(),
      socketPath: locateServiceSocket(stateDirectory).socketPath,
    };
    writeFileSync(metadataPath, JSON.stringify(metadata) + "\n", { mode: 0o600 });
    try {
      const task = { taskId: 7, kind: "unknown" as const, reason: "restart_limit" as const, attribution: { kind: "unknown" as const } };
      writeStartupParkDiagnostic(stateDirectory, createStartupParkDiagnostic(randomUUID(), [task]));
      expect((await probeServiceHealth(stateDirectory)).kind).toBe("not_ready");
      const stale = await probeServiceHealth(stateDirectory);
      expect(stale.kind).toBe("not_ready");
      if (stale.kind === "not_ready") expect(stale.startupFailure).toBeUndefined();

      const unexpectedField = { ...createStartupParkDiagnostic(currentBootId, [task]), payload: "must-not-be-read" };
      writeFileSync(diagnosticPath, JSON.stringify(unexpectedField), { mode: 0o600 });
      const invalidSchema = await probeServiceHealth(stateDirectory);
      expect(invalidSchema.kind).toBe("not_ready");
      if (invalidSchema.kind === "not_ready") expect(invalidSchema.startupFailure).toBeUndefined();

      writeFileSync(diagnosticPath, "{ malformed", { mode: 0o600 });
      const malformed = await probeServiceHealth(stateDirectory);
      expect(malformed.kind).toBe("not_ready");
      if (malformed.kind === "not_ready") expect(malformed.startupFailure).toBeUndefined();

      rmSync(diagnosticPath);
      const unavailable = await probeServiceHealth(stateDirectory);
      expect(unavailable.kind).toBe("not_ready");
      if (unavailable.kind === "not_ready") expect(unavailable.startupFailure).toBeUndefined();

      const outside = join(root, "outside.json");
      writeFileSync(outside, JSON.stringify(createStartupParkDiagnostic(currentBootId, [task])) + "\n", { mode: 0o600 });
      symlinkSync(outside, diagnosticPath);
      const symlinked = await probeServiceHealth(stateDirectory);
      expect(symlinked.kind).toBe("not_ready");
      if (symlinked.kind === "not_ready") expect(symlinked.startupFailure).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not block while opening FIFO metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-park-fifo-"));
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    try {
      const path = join(stateDirectory, "service.json");
      const created = spawnSync("mkfifo", [path]);
      if (created.status !== 0) return;
      const probe = await probeServiceHealth(stateDirectory);
      expect(probe.kind).toBe("not_ready");
      if (probe.kind === "not_ready") expect(probe.reason).toBe("service metadata is not a regular file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function createRestartLimitFixture(root: string): Promise<{
  readonly firstMarker: string;
  readonly secondMarker: string;
  readonly pendingMarker: string;
  readonly failureMarker: string;
  readonly resumeMarker: string;
}> {
  const configDirectory = join(root, ".workshop");
  mkdirSync(join(configDirectory, "workflows"), { recursive: true });
  writeFileSync(join(configDirectory, "workshop.yaml"), "\n", "utf8");
  const installation = loadInstallation(root);
  const firstMarker = join(root, "held-one.marker");
  const secondMarker = join(root, "held-two.marker");
  const pendingMarker = join(root, "pending.marker");
  const failureMarker = join(root, "startup-failure.txt");
  const resumeMarker = join(root, "resume-called.marker");
  const opened = await openDurableStorage(installation.databasePath);
  if (!opened.ok) throw new Error(opened.failure.message);
  const registry = createRegistry();
  registry.install({ name: "startup-park-seed-fixture", tasks: [StartupParkTaskOne, StartupParkTaskTwo, StartupParkPendingTask] });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
  try {
    await harness.createConversation({
      ownership: { kind: "ownerless" },
      init: async (tx, conversationId) => {
        await tx.createTask(StartupParkTaskOne, { markerPath: firstMarker }, { ownership: { kind: "conversation" }, conversationId });
        await tx.createTask(StartupParkTaskTwo, { markerPath: secondMarker }, { ownership: { kind: "conversation" }, conversationId });
        await tx.createTask(StartupParkPendingTask, { markerPath: pendingMarker }, { ownership: { kind: "conversation" }, conversationId });
      },
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  const crashChild = spawn(process.execPath, [FIXTURE, "crash", installation.databasePath, firstMarker, secondMarker]);
  try {
    await waitForFile(firstMarker, crashChild);
    await waitForFile(secondMarker, crashChild);
    await stopChild(crashChild, "SIGKILL");
  } catch (error) {
    await stopChild(crashChild, "SIGKILL");
    throw error;
  }
  expect(readFileSync(firstMarker, "utf8")).toBe("x");
  expect(readFileSync(secondMarker, "utf8")).toBe("x");
  return { firstMarker, secondMarker, pendingMarker, failureMarker, resumeMarker };
}

async function waitForFile(path: string, child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (child.exitCode !== null) throw new Error("fixture process exited before writing " + path);
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture file " + path);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill(signal);
  await exited;
}
