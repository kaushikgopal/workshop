import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { loadInstallation } from "../src/installation/load-installation.js";
import { acquireServiceLock, ServiceOwnershipConflict } from "../src/service/acquire-service-lock.js";
import { STARTUP_PARK_DIAGNOSTIC_FILE } from "../src/service/write-startup-park-diagnostic.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { ParkedTask, PendingTask } from "./fixtures/define-parked-service-owner-tasks.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/hold-parked-service-owner.ts");
const CLI = join(process.cwd(), "src/cli/main.ts");
const ownedChildren: ChildProcess[] = [];
const supportsKillSignal = process.platform === "darwin" || process.platform === "linux";

afterEach(async () => {
  await stopOwnedChildren();
});

describe("failed parked service owner", () => {
  test.skipIf(!supportsKillSignal)("exits after real startup rejects a restart-limit park", async () => {
    await verifyFailedOwner("normal");
  }, 60_000);

  test.skipIf(!supportsKillSignal)("exits after recording a graph-only park omitted by task inspection", async () => {
    await verifyFailedOwner("graph-only");
  }, 60_000);

  test.skipIf(!supportsKillSignal)("keeps a failed parked owner exclusive until process exit", async () => {
    await verifyFailedOwner("normal", true);
  }, 60_000);
});

async function verifyFailedOwner(inspectionMode: "normal" | "graph-only", holdFailedOwner = false): Promise<void> {
  let root: string | undefined;
  let crash: ChildProcess | undefined;
  let service: ChildProcess | undefined;
  try {
    const testRoot = mkdtempSync(join(tmpdir(), "workshop-parked-service-owner-"));
    root = testRoot;
    const config = join(testRoot, ".workshop");
    mkdirSync(join(config, "workflows"), { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "\n", "utf8");
    const installation = loadInstallation(testRoot);
    const heldMarker = join(testRoot, "held.marker");
    const pendingMarker = join(testRoot, "pending.marker");
    const ownerHeldMarker = join(testRoot, "owner-held.marker");
    let fixtureStderr = "";
    const crashProcess = spawn(process.execPath, [FIXTURE, "crash", installation.databasePath, heldMarker], {
      cwd: testRoot, env: process.env, stdio: ["ignore", "ignore", "pipe"],
    });
    crash = crashProcess;
    ownedChildren.push(crashProcess);
    crashProcess.stderr?.setEncoding("utf8");
    crashProcess.stderr?.on("data", (chunk: string) => { fixtureStderr += chunk; });
    await seedParkedInstallation(installation.databasePath, heldMarker, pendingMarker);
    await waitForFile(heldMarker, crashProcess, () => fixtureStderr);
    await killOwnedChild(crashProcess, "SIGKILL");

    const serviceProcess = spawn(process.execPath, [FIXTURE, "serve", testRoot, inspectionMode, ...(holdFailedOwner ? [ownerHeldMarker] : [])], {
      cwd: testRoot, env: process.env, stdio: ["ignore", "ignore", "pipe"],
    });
    service = serviceProcess;
    ownedChildren.push(serviceProcess);
    let serviceStderr = "";
    serviceProcess.stderr?.setEncoding("utf8");
    serviceProcess.stderr?.on("data", (chunk: string) => { serviceStderr += chunk; });
    const stateDirectory = installation.stateDirectory;
    const diagnosticPath = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
    const metadataPath = join(stateDirectory, "service.json");
    await waitForFailedStartup(serviceProcess, metadataPath, diagnosticPath, () => serviceStderr);
    if (holdFailedOwner) {
      await waitForFile(ownerHeldMarker, serviceProcess, () => serviceStderr);
      expect(() => acquireServiceLock(join(stateDirectory, "service.lock"))).toThrow(ServiceOwnershipConflict);
      expect(serviceProcess.exitCode).toBeNull();
      await killOwnedChild(serviceProcess, "SIGKILL");
    } else {
      await waitForExit(serviceProcess, 15_000);
    }

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; bootId: string; status: string };
    expect(metadata).toMatchObject({ pid: serviceProcess.pid, status: "failed" });
    expect(existsSync(pendingMarker)).toBe(false);
    expect(serviceProcess.signalCode === "SIGKILL").toBe(holdFailedOwner);
    if (!holdFailedOwner) expect(serviceProcess.exitCode).toBe(1);

    const status = spawnSync(process.execPath, [CLI, "service", "status", "--json"], {
      cwd: testRoot, env: process.env, encoding: "utf8", timeout: 10_000,
    });
    expect(status.status).toBe(3);
    const statusJson = JSON.parse(status.stdout) as {
      state: string;
      startupFailure?: {
        state: string;
        bootId: string;
        blockedTaskCount: number;
        blockedTasks: { reason: string }[];
        limitations: string[];
      };
    };
    expect(statusJson.state).toBe("not_running");
    expect(statusJson.startupFailure).toMatchObject({
      state: "historical_not_ready",
      bootId: metadata.bootId,
      blockedTaskCount: 1,
      blockedTasks: [{ reason: "restart_limit" }],
    });
    if (inspectionMode === "graph-only") {
      expect(statusJson.startupFailure?.limitations).toContain("graph_only_blocked_tasks");
    } else {
      expect(statusJson.startupFailure?.limitations).not.toContain("graph_only_blocked_tasks");
    }
    expect(existsSync(pendingMarker)).toBe(false);

    const reclaimed = acquireServiceLock(join(stateDirectory, "service.lock"));
    expect(reclaimed.metadata.bootId).not.toBe(metadata.bootId);
    reclaimed.release();
    expect(existsSync(pendingMarker)).toBe(false);
  } finally {
    try {
      if (service !== undefined) await killOwnedChild(service, "SIGKILL");
    } finally {
      try {
        if (crash !== undefined) await killOwnedChild(crash, "SIGKILL");
      } finally {
        if (root !== undefined) rmSync(root, { recursive: true, force: true });
      }
    }
  }
}

async function seedParkedInstallation(databasePath: string, heldMarker: string, pendingMarker: string): Promise<void> {
  const opened = await openDurableStorage(databasePath);
  if (!opened.ok) throw new Error(opened.failure.message);
  const registry = createRegistry();
  registry.install({ name: "parked-service-owner-seed-fixture", tasks: [ParkedTask, PendingTask] });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry, settings: { restartLimit: 1 } }, BACKGROUND_CONTEXT);
  try {
    await harness.createConversation({
      ownership: { kind: "ownerless" },
      init: async (tx, conversationId) => {
        await tx.createTask(ParkedTask, { markerPath: heldMarker }, { ownership: { kind: "conversation" }, conversationId });
        await tx.createTask(PendingTask, { markerPath: pendingMarker }, { ownership: { kind: "conversation" }, conversationId });
      },
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

async function waitForFile(path: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("fixture exited before writing " + path + ": " + stderr());
    await delay(10);
  }
  throw new Error("timed out waiting for fixture file " + path + ": " + stderr());
}

async function waitForFailedStartup(child: ChildProcess, metadataPath: string, diagnosticPath: string, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(metadataPath) && existsSync(diagnosticPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { status?: string };
      if (metadata.status === "failed") return;
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("failed service owner exited: " + stderr());
    await delay(10);
  }
  throw new Error("timed out waiting for failed service startup: " + stderr());
}

async function killOwnedChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill(signal);
  await exited;
}

async function stopOwnedChildren(): Promise<void> {
  for (const child of ownedChildren.splice(0)) await killOwnedChild(child, "SIGKILL");
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(10);
  if (child.exitCode === null && child.signalCode === null) throw new Error("service owner did not exit before the deadline");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
