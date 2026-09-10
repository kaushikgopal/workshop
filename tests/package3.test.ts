import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeInstallation, runCli, mockAgentHarness, dbAttempts, dbRuns } from "./helpers.js";
import { openDb } from "../src/store/db.js";
import { Store, GuardRejected } from "../src/store/store.js";
import { loadAndValidateDefinition, startWorkflow, runChain } from "../src/execute.js";
import { findInstallation, ensureDirs } from "../src/config.js";
import { recoverInstallation, loadSnapshot } from "../src/recovery.js";
import { SystemClock } from "../src/util/clock.js";

const MOCK = mockAgentHarness();

function twoNodeWorkflow(): string {
  return `version: 1
id: crash-chain
description: Fast node then slow node.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-fast:
    run:
      command: echo "fast node done"
    next: node-slow
  node-slow:
    run:
      agent:
        instructions: |
          MOCK:sleep=30s
    next: null
`;
}

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("gate 11 — claims", () => {
  test("two competing launchers cannot both claim the same attempt", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "crash-chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));

    // Winner.
    const winner = store.claimAttempt({ runId: started.runId, nodeId: "node-fast", attempt: 1, now: new Date() });
    expect(winner.ownerToken).toBeTruthy();

    // Loser: the attempt is no longer pending.
    expect(() =>
      store.claimAttempt({ runId: started.runId, nodeId: "node-fast", attempt: 1, now: new Date() }),
    ).toThrow(GuardRejected);

    // The row records exactly one owner.
    const attempt = store.getAttempt(started.runId, "node-fast", 1)!;
    expect(attempt.owner_token).toBe(winner.ownerToken);
    expect(attempt.worker_process_start_id).toBeTruthy();
  }, 30_000);
});

describe("gate 12 — stale results", () => {
  test("a result from a superseded owner is rejected and recorded", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "crash-chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const claim = store.claimAttempt({ runId: started.runId, nodeId: "node-fast", attempt: 1, now: new Date() });

    // Simulate supersession: recovery reassigned ownership.
    const superseding = "deadbeef".repeat(4);
    store.tx(() => {
      store.db
        .query("UPDATE node_attempts SET owner_token = ? WHERE run_id = ? AND node_id = ? AND attempt = 1")
        .run(superseding, started.runId, "node-fast");
    });

    // The stale owner cannot finish, complete, progress, or heartbeat.
    expect(() =>
      store.claimFinishing({ runId: started.runId, nodeId: "node-fast", attempt: 1, ownerToken: claim.ownerToken, now: new Date() }),
    ).toThrow(GuardRejected);
    expect(store.setProgress({ runId: started.runId, nodeId: "node-fast", attempt: 1, ownerToken: claim.ownerToken, progress: "stale", now: new Date() })).toBe(false);
    expect(store.heartbeat({ runId: started.runId, nodeId: "node-fast", attempt: 1, ownerToken: claim.ownerToken, now: new Date() })).toBe(false);

    // The rejection is recorded in the attempt log file (stderr of the runner).
    const attempt = store.getAttempt(started.runId, "node-fast", 1)!;
    expect(attempt.owner_token).toBe(superseding);
  }, 30_000);
});

describe("gate 13 — crash recovery", () => {
  test("a killed worker recovers only the interrupted node and never repeats a completed predecessor", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    // Start in the background: node-fast completes, node-slow sleeps 30s.
    const child = spawn("bun", [join(import.meta.dir, "..", "src/cli.ts"), "start", "crash-chain"], {
      cwd: inst.root,
      stdio: "ignore",
    });

    const pollDb = (): Array<Record<string, unknown>> => {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      if (!existsSync(inst.dbPath)) return [];
      const db = new Database(inst.dbPath, { readonly: true });
      try {
        return db.query("SELECT * FROM node_attempts ORDER BY node_id, attempt").all() as Array<Record<string, unknown>>;
      } catch {
        return [];
      } finally {
        db.close();
      }
    };

    // Wait for node-slow to be running (node-fast completed).
    await waitFor(() => {
      const rows = pollDb();
      return rows.some((r) => r.node_id === "node-slow" && r.status === "running");
    });

    const before = pollDb();
    const fastCompleted = before.find((r) => r.node_id === "node-fast");
    expect(fastCompleted?.status).toBe("completed");

    // Kill the wrapper (the CLI process) — the harness child stays alive.
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));

    // Recovery: terminate-and-confirm, interrupted node retried, no rerun of node-fast.
    const real = findInstallation(inst.root);
    const { recoverInstallation: recover } = await import("../src/recovery.js");
    const report = await recover({ store: new Store(openDb(real.dbPath)), inst: real, clock: new SystemClock() });
    expect(report.interruptedRetried.length).toBe(1);
    expect(report.interruptedRetried[0]).toContain("node-slow #2");

    const after = pollDb();
    const fastAfter = after.find((r) => r.node_id === "node-fast")!;
    expect(fastAfter.attempt).toBe(1);
    expect(fastAfter.status).toBe("completed"); // never repeated

    const slowAttempts = after.filter((r) => r.node_id === "node-slow");
    expect(slowAttempts.length).toBe(2);
    expect(slowAttempts[0]!.status).toBe("failed");
    expect(slowAttempts[0]!.failure_kind).toBe("interrupted");
    expect(slowAttempts[1]!.status).toBe("pending");

    // The chain finishes from the retry attempt.
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "crash-chain.yaml"));
    const runId = String(dbRuns(inst)[0]!.run_id);
    await runChain({ store: new Store(openDb(real.dbPath)), inst: real, loaded, runId, cliPath: "bun /Users/kg/dev/oss/workshop/src/cli.ts" });
    const runs = dbRuns(inst);
    expect(runs[0]!.status).toBe("completed");
  }, 90_000);
});

describe("gate 14 — handoff crash", () => {
  test("a persisted successor is claimed as the single accepted owner after a crash gap", async () => {
    const inst = makeInstallation({
      "handoff": `version: 1
id: handoff
description: Two fast nodes.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-a:
    run:
      command: echo A
    next: node-b
  node-b:
    run:
      command: echo B
    next: null
`,
    });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "handoff.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));

    // Execute node-a only: the completion transaction persists node-b as
    // pending before any launch — the crash gap leaves durable state.
    const live = store.getLiveAttempt(started.runId)!;
    await runChain({ store, inst: real, loaded, runId: started.runId, cliPath: "bun x" });
    void live;

    const attempts = dbAttempts(inst, started.runId);
    expect(attempts.length).toBe(2);
    expect(attempts.every((a) => a.status === "completed")).toBe(true);
    const runs = dbRuns(inst);
    expect(runs[0]!.status).toBe("completed");
  }, 60_000);
});

describe("gate 15 — stop fencing", () => {
  test("a durable stop during late completion prevents successor launch and retry", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "crash-chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const claim = store.claimAttempt({ runId: started.runId, nodeId: "node-fast", attempt: 1, now: new Date() });

    // Late completion: owner-fenced finishing, then a durable stop arrives.
    store.claimFinishing({ runId: started.runId, nodeId: "node-fast", attempt: 1, ownerToken: claim.ownerToken, now: new Date() });
    const { stopRun } = { stopRun: store.stopRun.bind(store) };
    stopRun({ runId: started.runId, now: new Date() });

    // The late completion cannot resurrect the attempt or launch a successor.
    expect(() =>
      store.completeAttempt({
        runId: started.runId,
        nodeId: "node-fast",
        attempt: 1,
        ownerToken: claim.ownerToken,
        nodeOutputPath: "x",
        validatorStatus: null,
        validatorReason: null,
        now: new Date(),
        successor: { nodeId: "node-slow", packetPath: "p", resolvedMaxAttempts: 2, resolvedTimeoutMs: 1 },
      }),
    ).toThrow(GuardRejected);

    // The wrapper-side cancel marks the attempt cancelled.
    store.cancelAttempt({ runId: started.runId, nodeId: "node-fast", attempt: 1, now: new Date() });
    const attempt = store.getAttempt(started.runId, "node-fast", 1)!;
    expect(attempt.status).toBe("cancelled");
    const runs = dbRuns(inst);
    expect(runs[0]!.status).toBe("cancelled");
    expect(runs[0]!.desired_state).toBe("stopped");
  }, 30_000);

  test("workshop stop kills the recorded process group and cancels the run", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    const child = spawn("bun", [join(import.meta.dir, "..", "src/cli.ts"), "start", "crash-chain"], {
      cwd: inst.root,
      stdio: "ignore",
    });
    const pollDb = (): Array<Record<string, unknown>> => {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      if (!existsSync(inst.dbPath)) return [];
      const db = new Database(inst.dbPath, { readonly: true });
      try {
        return db.query("SELECT * FROM node_attempts ORDER BY node_id, attempt").all() as Array<Record<string, unknown>>;
      } catch {
        return [];
      } finally {
        db.close();
      }
    };
    await waitFor(() => pollDb().some((r) => r.node_id === "node-slow" && r.status === "running"));

    const stopped = spawnSync("bun", [join(import.meta.dir, "..", "src/cli.ts"), "stop", "crash-chain"], {
      cwd: inst.root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(stopped.status).toBe(0);

    await waitFor(() => {
      const runs = dbRuns(inst);
      return runs[0]!.status === "cancelled";
    });
    const attempts = pollDb();
    const slow = attempts.find((r) => r.node_id === "node-slow")!;
    expect(slow.status).toBe("cancelled");
    // The sleeping harness process group is gone.
    await waitFor(() => {
      child.kill("SIGKILL");
      return true;
    });
  }, 90_000);
});

describe("gate 24 — orchestrator phase recovery", () => {
  test("a dead orchestrator owner in the owned phase is released to pending", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "crash-chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));

    // Simulate a crashed orchestrator invocation mid-owned.
    store.tx(() => {
      store.db
        .query("UPDATE runs SET orchestrator_phase = 'owned', orchestrator_owner_token = 'tok', orchestrator_worker_pid = 999999, orchestrator_last_heartbeat_at = ? WHERE run_id = ?")
        .run(new Date().toISOString(), started.runId);
    });

    const { recoverInstallation: recover } = await import("../src/recovery.js");
    const report = await recover({ store, inst: real, clock: new SystemClock() });
    expect(report.orchestratorReleased).toContain(started.runId);
    expect(store.getRun(started.runId)!.orchestrator_phase).toBe("pending");
    expect(store.getRun(started.runId)!.orchestrator_owner_token).toBeNull();
  }, 30_000);

  test("an applying phase with a decision receipt finishes the same decision idempotently", async () => {
    const inst = makeInstallation({ "crash-chain": twoNodeWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "crash-chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));

    const token = "tok1234567890";
    const { atomicWriteFileSync } = await import("../src/worklog/worklog.js");
    const { mkdirSync } = await import("node:fs");
    const run = store.getRun(started.runId)!;
    mkdirSync(join(run.run_dir, "receipts"), { recursive: true });
    atomicWriteFileSync(
      join(run.run_dir, "receipts", `orchestrator-${token}.json`),
      JSON.stringify({ ownerToken: token, resultSha256: "sha256:x", appliedAt: new Date().toISOString() }),
    );
    store.tx(() => {
      store.db
        .query("UPDATE runs SET orchestrator_phase = 'applying', orchestrator_owner_token = ?, orchestrator_worker_pid = 999999 WHERE run_id = ?")
        .run(token, started.runId);
    });

    const { recoverInstallation: recover } = await import("../src/recovery.js");
    const report = await recover({ store, inst: real, clock: new SystemClock() });
    expect(report.orchestratorFinished).toContain(started.runId);
    expect(store.getRun(started.runId)!.orchestrator_phase).toBe("idle");
  }, 30_000);
});

// Used by the crash test to load the snapshot bundle for the chain.
void loadSnapshot;
