import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { defineTask, Harness } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { locateServiceSocket } from "../src/service/locate-service-socket.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { encodeServiceResponseFrames, serviceSuccess } from "../src/service/parse-service-protocol.js";

let releaseCheckpoint!: () => void;
let checkpointStarted = false;
const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });

const LongCheckpointTask = defineTask<Record<string, never>, { phase: "hold" }, { released: true }>({
  name: "workshop.test.long-checkpoint",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, runtime, context) => {
      checkpointStarted = true;
      await checkpointGate;
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "completed", result: { released: true } },
      }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "aborted", reason: "test checkpoint released" },
    }), context);
  },
});

describe("service startup reconciliation", () => {
  test("starts in fresh private state without reading legacy state or attaching its service", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-private-state-isolation-"));
    const config = join(root, ".workshop");
    const legacyStateDirectory = join(config, "state");
    mkdirSync(join(config, "workflows"), { recursive: true });
    mkdirSync(legacyStateDirectory, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");

    const legacyDatabasePath = join(legacyStateDirectory, "durable.db");
    const legacyDatabase = Buffer.from("invalid legacy database sentinel\0bytes");
    const legacyBootId = randomUUID();
    const legacySocketLocation = locateServiceSocket(legacyStateDirectory);
    const legacySocketPath = legacySocketLocation.socketPath;
    if (legacySocketLocation.runtimeDirectory !== null) {
      mkdirSync(legacySocketLocation.runtimeDirectory, { recursive: true, mode: 0o700 });
    }
    const legacyMetadataPath = join(legacyStateDirectory, "service.json");
    const legacyMetadata = Buffer.from(JSON.stringify({
      version: 1, status: "ready", pid: process.pid, startIdentity: "legacy-fixture",
      bootId: legacyBootId, startedAt: new Date().toISOString(), socketPath: legacySocketPath,
    }) + "\n");
    writeFileSync(legacyDatabasePath, legacyDatabase);
    writeFileSync(legacyMetadataPath, legacyMetadata);

    let legacyConnections = 0;
    const legacyServer = createServer((socket) => {
      legacyConnections += 1;
      socket.once("data", () => {
        socket.end(encodeServiceResponseFrames(serviceSuccess(null, {
          version: 1, status: "ready", pid: process.pid, bootId: legacyBootId,
        })).join(""));
      });
    });
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let isolatedRuntimeDirectory: string | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        legacyServer.once("error", reject);
        legacyServer.listen(legacySocketPath, resolve);
      });
      const legacyEntries = readdirSync(legacyStateDirectory).sort();
      const installation = loadInstallation(root);
      isolatedRuntimeDirectory = locateServiceSocket(installation.stateDirectory).runtimeDirectory;
      expect(installation.stateDirectory).toBe(join(config, ".state"));
      expect(installation.databasePath).toBe(join(installation.stateDirectory, "durable.db"));
      expect(existsSync(installation.databasePath)).toBe(false);
      expect((await probeServiceHealth(installation.stateDirectory)).kind).toBe("not_ready");
      expect(legacyConnections).toBe(0);

      owner = await startWorkshopService(installation);
      const health = await probeServiceHealth(installation.stateDirectory);
      expect(health.kind).toBe("ready");
      const metadata = JSON.parse(readFileSync(join(installation.stateDirectory, "service.json"), "utf8")) as { socketPath: string };
      expect(metadata.socketPath).toBe(locateServiceSocket(installation.stateDirectory).socketPath);
      expect(metadata.socketPath).not.toBe(legacySocketPath);
      expect(existsSync(installation.databasePath)).toBe(true);
      expect(legacyConnections).toBe(0);
      expect(readdirSync(legacyStateDirectory).sort()).toEqual(legacyEntries);
      expect(readFileSync(legacyDatabasePath)).toEqual(legacyDatabase);
      expect(readFileSync(legacyMetadataPath)).toEqual(legacyMetadata);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      if (legacyServer.listening) {
        await new Promise<void>((resolve) => legacyServer.close(() => resolve()));
      }
      if (legacySocketLocation.runtimeDirectory !== null) {
        rmSync(legacySocketLocation.runtimeDirectory, { recursive: true, force: true });
      }
      if (isolatedRuntimeDirectory !== null) {
        rmSync(isolatedRuntimeDirectory, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("publishes readiness without waiting for an unrelated long checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-checkpoint-"));
    const config = join(root, ".workshop");
    mkdirSync(join(config, "workflows"), { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    const originalOpen = Harness.open;
    let openedHarness: Harness | undefined;
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;

    try {
      checkpointStarted = false;
      Harness.open = async (storage, options, context) => {
        const registry = options.registry as unknown as { install(extension: unknown): void };
        registry.install({ name: "long-checkpoint-fixture", tasks: [LongCheckpointTask] });
        const harness = await originalOpen(storage, options, context);
        openedHarness = harness;
        const rootConversation = await harness.root(BACKGROUND_CONTEXT);
        await harness.commit((tx) => tx.createTask(LongCheckpointTask, {}, {
          ownership: { kind: "conversation" },
          conversationId: rootConversation.id,
        }), BACKGROUND_CONTEXT);
        return harness;
      };

      const beganAt = Date.now();
      owner = await startWorkshopService(loadInstallation(root));
      expect(Date.now() - beganAt).toBeLessThan(5_000);
      await waitForCheckpoint();
      const inspection = await openedHarness?.inspect(BACKGROUND_CONTEXT);
      const task = inspection?.tasks.find((entry) => entry.record.kind === LongCheckpointTask.definition.name);
      expect(task).toBeDefined();
      expect(task?.record.abortRequested).toBe(false);
    } finally {
      releaseCheckpoint();
      Harness.open = originalOpen;
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

async function waitForCheckpoint(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!checkpointStarted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!checkpointStarted) throw new Error("long Durable checkpoint did not start after service readiness");
}
