import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { makeInstallation, runCli, mockAgentHarness, dbRuns } from "./helpers.js";
import { openDb } from "../src/storage/db/open-and-migrate.js";
import { Store } from "../src/storage/db/store.js";
import { findInstallation, ensureDirs } from "../src/load-installation.js";
import { startWorkflow } from "../src/run/start-run.js";
import { checkEnvironment } from "../src/run/check-environment.js";
import { loadAndValidateDefinition } from "../src/definition/load-definition.js";
import { tick } from "../src/daemon/reconcile-loop.js";
import { DaemonLockHeld } from "../src/daemon/acquire-daemon-lock.js";
import { FakeClock } from "../src/util/clock.js";

const MOCK = mockAgentHarness();

function recurringWorkflow(): string {
  return `version: 1
id: clock
description: Recurring mock chain.
schedule:
  every: 10m
  max_runs: 6
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-only:
    run:
      command: echo tick
    next: null
`;
}

function freshHarness(installation: ReturnType<typeof makeInstallation>): Store {
  return new Store(openDb(installation.dbPath));
}

describe("gates 16+17 — schedule bounds and overlap suppression", () => {
  test("six runs ten minutes apart, then the activation exhausts; a due occurrence during an unresolved run is skipped", async () => {
    const inst = makeInstallation({ "clock": recurringWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));

    // Run 1 starts immediately.
    const started = await startWorkflow({ inst: real, loaded: loadAndValidateDefinition(join(inst.workflowsDir, "clock.yaml")), clock });
    expect(started.created).toBe(true);

    // Let run 1 finish.
    let report = await tick({ inst: real, clock });
    expect(report.launched.length).toBe(1);
    await Promise.all(report.pending);
    expect(dbRuns(inst).length).toBe(1);

    // Five more occurrences, ten minutes apart. Occurrences that arrive while
    // one run is unresolved are skipped without starting a run.
    for (let i = 2; i <= 6; i++) {
      clock.advance(10 * 60_000);
      report = await tick({ inst: real, clock });
      expect(report.admitted.length).toBe(1);
      await Promise.all(report.pending);
      const runs = dbRuns(inst);
      expect(runs.length).toBe(i);
      expect(runs[runs.length - 1]!.status).toBe("completed");
    }

    // The bound is six: the next due occurrence exhausts the activation.
    clock.advance(10 * 60_000);
    await tick({ inst: real, clock });
    const wf = freshHarness(real).getWorkflow("clock")!;
    expect(wf.activation_state).toBe("exhausted");
    expect(wf.schedule_started_runs).toBe(6);
    expect(dbRuns(inst).length).toBe(6);
  }, 60_000);

  test("a due occurrence arriving while one run is unresolved is skipped", async () => {
    const inst = makeInstallation({
      "clock": recurringWorkflow().replace("command: echo tick", "command: echo tick").replace(
        "  node-only:",
        `  node-only:
    timeout: 30s`
      ).replace("run:\n      command: echo tick", "run:\n      command: sleep 5"),
    });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));
    await startWorkflow({ inst: real, loaded: loadAndValidateDefinition(join(inst.workflowsDir, "clock.yaml")), clock });

    // Run 1 is unresolved (sleeping 5s). A due occurrence is suppressed.
    clock.advance(10 * 60_000);
    const report = await tick({ inst: real, clock });
    expect(report.admitted.length).toBe(0);
    expect(dbRuns(inst).length).toBe(1);

    // After run 1 resolves, the next due occurrence admits.
    await new Promise((r) => setTimeout(r, 6500));
    const settle = await tick({ inst: real, clock });
    await Promise.all(settle.pending);
    clock.advance(10 * 60_000);
    const later = await tick({ inst: real, clock });
    expect(later.admitted.length).toBe(1);
  }, 60_000);
});

describe("gate 18 — activation controls", () => {
  test("start is idempotent; a terminal activation resets its counter on the next start", async () => {
    const inst = makeInstallation({ "clock": recurringWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "clock.yaml"));

    const first = await startWorkflow({ inst: real, loaded, clock });
    const again = await startWorkflow({ inst: real, loaded, clock });
    expect(again.created).toBe(false);
    expect(again.runId).toBe(first.runId);

    // Exhaust the activation.
    for (let i = 0; i < 8; i++) {
      const t = await tick({ inst: real, clock });
      await Promise.all(t.pending);
      clock.advance(10 * 60_000);
    }
    expect(freshHarness(real).getWorkflow("clock")!.activation_state).toBe("exhausted");

    // Start after exhaustion creates a new activation and resets the counter.
    clock.advance(10 * 60_000);
    const restarted = await startWorkflow({ inst: real, loaded, clock });
    expect(restarted.created).toBe(true);
    const wf = freshHarness(real).getWorkflow("clock")!;
    expect(wf.activation_state).toBe("active");
    expect(wf.schedule_started_runs).toBe(1);
  }, 60_000);

  test("pause suppresses occurrences; resume re-enables and continues the run", async () => {
    const inst = makeInstallation({ "clock": recurringWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "clock.yaml"));

    const started = await startWorkflow({ inst: real, loaded, clock });
    const run1 = await tick({ inst: real, clock }); // run 1 completes
    await Promise.all(run1.pending);

    const paused = runCli(inst, "pause clock");
    expect(paused.code).toBe(0);
    clock.advance(10 * 60_000);
    const suppressed = await tick({ inst: real, clock });
    expect(suppressed.admitted.length).toBe(0);
    expect(freshHarness(real).getWorkflow("clock")!.activation_state).toBe("paused");

    const resumed = runCli(inst, "resume clock");
    expect(resumed.code).toBe(0);
    clock.advance(10 * 60_000);
    const admitted = await tick({ inst: real, clock });
    expect(admitted.admitted.length).toBe(1);
  }, 60_000);
});

describe("gate 21 — preflight cache", () => {
  test("exit 0 caches by canonical hash; a changed hash reruns", async () => {
    const markerPath = () => join(inst.root, "preflight-ran.marker");
    const inst = makeInstallation({
      "preflight": `version: 1
id: preflight
description: Preflight writes a marker.
environment:
  preflight:
    command: 'touch preflight-ran.marker'
nodes:
  node-only:
    run:
      command: echo done
    next: null
`,
    });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "preflight.yaml"));

    const first = await startWorkflow({ inst: real, loaded, clock });
    expect(existsSync(markerPath())).toBe(true);
    const run1 = await tick({ inst: real, clock });
    await Promise.all(run1.pending);

    // Second run with the same hash: the preflight command does not execute;
    // a fresh marker would not appear.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(markerPath());
    const second = await startWorkflow({ inst: real, loaded, clock });
    expect(second.created).toBe(true);
    expect(existsSync(markerPath())).toBe(false); // served from cache
    const run2 = await tick({ inst: real, clock });
    await Promise.all(run2.pending);

    // A changed definition reruns the preflight.
    const yamlPath = join(inst.workflowsDir, "preflight.yaml");
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace("echo done", "echo done-v2"), "utf8");
    const changed = await startWorkflow({ inst: real, loaded: loadAndValidateDefinition(yamlPath), clock });
    expect(changed.created).toBe(true);
    expect(existsSync(markerPath())).toBe(true);
    const run3 = await tick({ inst: real, clock });
    await Promise.all(run3.pending);
  }, 60_000);

  test("a blocked preflight blocks the run before any attempt exists; resume re-runs it", async () => {
    const flagPath = () => join(inst.root, "ready.flag");
    const inst = makeInstallation({
      "gate": `version: 1
id: gate
description: Preflight blocks until the flag exists.
environment:
  preflight:
    command: 'test -f ready.flag'
nodes:
  node-only:
    run:
      command: echo done
    next: null
`,
    });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));

    const started = await startWorkflow({ inst: real, loaded: loadAndValidateDefinition(join(inst.workflowsDir, "gate.yaml")), clock });
    expect(started.created).toBe(true);
    const runs = dbRuns(inst);
    expect(runs[0]!.status).toBe("blocked");
    expect(runs[0]!.block_kind).toBe("preflight");
    expect(dbAttemptsCount(inst, started.runId)).toBe(0); // no attempt exists

    // Fix the environment and resume: preflight passes, the first attempt lands.
    mkdirSync(inst.root, { recursive: true });
    writeFileSync(flagPath(), "ready\n");
    const resumed = runCli(inst, "resume gate");
    expect(resumed.code).toBe(0);
    expect(dbAttemptsCount(inst, started.runId)).toBe(1);
    expect(dbRuns(inst)[0]!.status).toBe("running");
  }, 60_000);
});

describe("gate 24 — daemon singleton", () => {
  test("a second daemon is rejected while one holds the lock", async () => {
    const inst = makeInstallation({ "clock": recurringWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    mkdirSync(join(real.stateDir), { recursive: true });
    // Simulate a live holder.
    const { openSync, closeSync, writeFileSync } = await import("node:fs");
    const lockPath = join(real.stateDir, "daemon.lock");
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    closeSync(fd);
    // process.pid is alive → second daemon must fail fast.
    const { reconcileForever } = await import("../src/daemon/reconcile-loop.js");
    let err: unknown = null;
    try {
      await reconcileForever(real);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonLockHeld);
  }, 30_000);
});

function dbAttemptsCount(inst: ReturnType<typeof makeInstallation>, runId: string): number {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(inst.dbPath, { readonly: true });
  try {
    return Number(db.query("SELECT COUNT(*) AS n FROM node_attempts WHERE run_id = ?").get(runId) ? (db.query("SELECT COUNT(*) AS n FROM node_attempts WHERE run_id = ?").get(runId) as { n: number }).n : 0);
  } finally {
    db.close();
  }
}
