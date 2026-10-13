import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(message);
}

test("checkpoints the service WAL after active tasks become idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "workshop-service-wal-"));
  const config = join(root, ".workshop");
  const workflows = join(config, "workflows");
  const launched = join(root, "launched");
  const release = join(root, "release");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
  writeFileSync(join(workflows, "idle.yaml"), [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - wait:",
    `      run: 'touch \"${launched}\"; while [ ! -e \"${release}\" ]; do sleep 0.01; done; printf done'`,
    "",
  ].join("\n"), "utf8");

  const installation = loadInstallation(root);
  const walPath = `${installation.databasePath}-wal`;
  const walSize = (): number => {
    try { return statSync(walPath).size; } catch { return 0; }
  };
  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    owner = await startWorkshopService(installation);
    const health = await probeServiceHealth(installation.stateDirectory);
    if (health.kind !== "ready") throw new Error(health.reason);
    const startedResponse = await sendServiceRequest(health.metadata.socketPath, {
      version: 1, method: "start", requestId: "wal-idle-start", workflowId: "idle",
    });
    if (!startedResponse.ok) throw new Error(startedResponse.error.message);
    const started = serviceStartResultV1Schema.parse(startedResponse.result);

    await waitFor(() => existsSync(launched), "run process did not reach its wait point");
    await waitFor(() => walSize() > 0, "active run did not produce a WAL");
    expect(walSize()).toBeGreaterThan(0);

    writeFileSync(release, "", "utf8");
    const completedDeadline = Date.now() + 10_000;
    let completed = false;
    while (Date.now() < completedDeadline) {
      const response = await sendServiceRequest(health.metadata.socketPath, { version: 1, method: "runs", workflowId: "idle", limit: 10 });
      if (!response.ok) throw new Error(response.error.message);
      const page = serviceRunsPageV1Schema.parse(response.result);
      if (page.runs.find((run) => run.runId === started.runId)?.status === "completed") {
        completed = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    if (!completed) throw new Error("run did not complete after release");
    await waitFor(() => walSize() === 0, "service did not truncate the WAL after the run became idle");
    expect(walSize()).toBe(0);
  } finally {
    if (owner !== undefined) await owner.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
