import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, Harness } from "@earendil-works/pi-durable";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";

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
  test("publishes readiness without waiting for an unrelated long checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-startup-checkpoint-"));
    const config = join(root, ".workshop", "config");
    mkdirSync(join(config, "workflows"), { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "version: 2\nshell: /bin/bash\n", "utf8");
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
