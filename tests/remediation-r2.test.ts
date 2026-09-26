import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitManualRun } from "../src/run/create-run.js";
import { findInstallation, ensureDirs } from "../src/load-installation.js";
import { tick } from "../src/daemon/reconcile-loop.js";
import { executeAttempt } from "../src/attempt/execute-attempt.js";
import { advanceChain } from "../src/run/advance-chain.js";
import { startWorkflow } from "../src/run/start-run.js";
import { loadAndValidateDefinition } from "../src/definition/load-definition.js";
import { recoverInstallation } from "../src/run/recover-after-crash.js";
import { openDb } from "../src/storage/db/open-and-migrate.js";
import { CapacityRejected, Store } from "../src/storage/db/store.js";
import { FakeClock, SystemClock } from "../src/util/clock.js";
import { runtimeCliInvocation } from "../src/attempt/build-attempt-env.js";
import { worklogTemplate } from "../src/worklog/edit-sections.js";
import { dbAttempts, dbRuns, makeInstallation } from "./helpers.js";

function workflow(id: string, command = "echo done", schedule = ""): string {
  return `version: 1
id: ${id}
description: ${id} workflow.
${schedule}nodes:
  node-only:
    run:
      command: ${command}
    next: null
`;
}

function recurring(id: string, command = "echo done"): string {
  return workflow(id, command, `schedule:\n  every: 10m\n  max_runs: 10\n`);
}

function setup(definitions: Record<string, string>) {
  const temp = makeInstallation(definitions);
  const inst = findInstallation(temp.root);
  ensureDirs(inst);
  return { temp, inst };
}

async function start(inst: ReturnType<typeof findInstallation>, path: string, clock?: FakeClock) {
  const loaded = loadAndValidateDefinition(path);
  const started = await startWorkflow({ inst, loaded, clock });
  return { loaded, started };
}

function reserveOnly(
  inst: ReturnType<typeof findInstallation>,
  loaded: ReturnType<typeof loadAndValidateDefinition>,
  now: Date,
) {
  const store = new Store(openDb(inst.dbPath));
  store.upsertWorkflowActivation({
    workflowId: loaded.def.id,
    definitionPath: loaded.sourcePath,
    definitionHash: loaded.canonicalHash,
    every: null,
    maxRuns: 1,
    now,
  });
  const reserved = store.createRun({
    workflowId: loaded.def.id,
    definitionHash: loaded.canonicalHash,
    definitionYaml: loaded.sourceText,
    runsDir: inst.runsDir,
    now,
    mode: "manual",
    isRecurring: false,
    everyMs: null,
  });
  return { store, run: store.getRun(reserved.runId)! };
}

describe("R2 schedule admission", () => {
  test("a suppressed due slot is consumed without incrementing started runs", async () => {
    const { temp, inst } = setup({ clock: recurring("clock", "sleep 1") });
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));
    await start(inst, join(temp.workflowsDir, "clock.yaml"), clock);

    clock.advance(35 * 60_000);
    const report = await tick({ inst, clock });
    expect(report.admitted).toEqual([]);
    const wf = new Store(openDb(inst.dbPath)).getWorkflow("clock")!;
    expect(wf.schedule_started_runs).toBe(1);
    expect(wf.next_run_at).toBe("2026-09-10T00:40:00.000Z");
    await Promise.all(report.pending);
  });

  test("downtime admits at most one run and advances from the persisted cursor", async () => {
    const { temp, inst } = setup({ clock: recurring("clock") });
    const clock = new FakeClock(new Date("2026-09-10T00:00:00Z"));
    await start(inst, join(temp.workflowsDir, "clock.yaml"), clock);
    let report = await tick({ inst, clock });
    await Promise.all(report.pending);

    clock.advance(35 * 60_000);
    report = await tick({ inst, clock });
    expect(report.admitted).toHaveLength(1);
    expect(new Store(openDb(inst.dbPath)).getWorkflow("clock")!.next_run_at).toBe("2026-09-10T00:40:00.000Z");
    await Promise.all(report.pending);

    const sameInstant = await tick({ inst, clock });
    expect(sameInstant.admitted).toEqual([]);
    expect(dbRuns(temp)).toHaveLength(2);
  });
});

describe("R2 authoritative run capacity", () => {
  test("a running attempt from an earlier tick holds the only slot", async () => {
    const { temp, inst } = setup({ alpha: workflow("alpha", "sleep 1"), beta: workflow("beta", "sleep 1") });
    await start(inst, join(temp.workflowsDir, "alpha.yaml"));
    await start(inst, join(temp.workflowsDir, "beta.yaml"));

    const first = await tick({ inst });
    expect(first.launched).toHaveLength(1);
    const second = await tick({ inst });
    expect(second.launched).toHaveLength(0);
    const live = dbAttempts(temp, String(dbRuns(temp)[0]!.run_id)).concat(dbAttempts(temp, String(dbRuns(temp)[1]!.run_id)));
    expect(live.filter((a) => a.status === "running")).toHaveLength(1);
    expect(live.filter((a) => a.status === "pending")).toHaveLength(1);

    await Promise.all(first.pending);
    const later = await tick({ inst });
    expect(later.launched).toHaveLength(1);
    await Promise.all(later.pending);
  });

  test("manual inline execution cannot bypass a running slot", async () => {
    const { temp, inst } = setup({ alpha: workflow("alpha", "sleep 1"), beta: workflow("beta") });
    const alpha = await start(inst, join(temp.workflowsDir, "alpha.yaml"));
    const beta = await start(inst, join(temp.workflowsDir, "beta.yaml"));
    const storeA = new Store(openDb(inst.dbPath));
    const storeB = new Store(openDb(inst.dbPath));

    const running = advanceChain({ store: storeA, inst, loaded: alpha.loaded, runId: alpha.started.runId, cliPath: runtimeCliInvocation() });
    const rejected = await advanceChain({ store: storeB, inst, loaded: beta.loaded, runId: beta.started.runId, cliPath: runtimeCliInvocation() });
    expect(rejected.status).toBe("queued");
    expect(storeB.getLiveAttempt(beta.started.runId)!.status).toBe("pending");
    await running;

    const completed = await advanceChain({ store: storeB, inst, loaded: beta.loaded, runId: beta.started.runId, cliPath: runtimeCliInvocation() });
    expect(completed.status).toBe("completed");
  });

  test("owned orchestrators consume slots and pending orchestrators wait", async () => {
    const { temp, inst } = setup({ alpha: workflow("alpha", "sleep 1"), beta: workflow("beta"), gamma: workflow("gamma") });
    const alpha = await start(inst, join(temp.workflowsDir, "alpha.yaml"));
    const beta = await start(inst, join(temp.workflowsDir, "beta.yaml"));
    const gamma = await start(inst, join(temp.workflowsDir, "gamma.yaml"));
    const runner = new Store(openDb(inst.dbPath));
    const contender = new Store(openDb(inst.dbPath));
    const running = advanceChain({ store: runner, inst, loaded: alpha.loaded, runId: alpha.started.runId, cliPath: runtimeCliInvocation() });

    contender.tx(() => {
      contender.db.query("UPDATE node_attempts SET status = 'failed' WHERE run_id = ?").run(beta.started.runId);
      contender.db.query("UPDATE runs SET orchestrator_phase = 'pending' WHERE run_id = ?").run(beta.started.runId);
    });
    expect(() => contender.claimOrchestrator(beta.started.runId, new Date(), 1)).toThrow(CapacityRejected);
    expect(contender.getRun(beta.started.runId)!.orchestrator_phase).toBe("pending");

    await running;
    const owned = contender.claimOrchestrator(beta.started.runId, new Date(), 1)!;
    expect(contender.getRun(beta.started.runId)!.orchestrator_phase).toBe("owned");
    expect(() => contender.claimAttempt({
      runId: gamma.started.runId,
      nodeId: "node-only",
      attempt: 1,
      now: new Date(),
      maxConcurrentRuns: 1,
    })).toThrow(CapacityRejected);
    expect(contender.getAttempt(gamma.started.runId, "node-only", 1)!.status).toBe("pending");
    contender.releaseOrchestratorToPending(beta.started.runId, owned.ownerToken, new Date());
  });
});

describe("R2 replayable shared admission", () => {
  test("manual admission races across connections converge on one prepared run", () => {
    const { temp, inst } = setup({ shared: workflow("shared") });
    const loaded = loadAndValidateDefinition(join(temp.workflowsDir, "shared.yaml"));
    const now = new Date("2026-09-10T00:00:00Z");
    const first = admitManualRun({ store: new Store(openDb(inst.dbPath)), inst, loaded, now });
    const second = admitManualRun({ store: new Store(openDb(inst.dbPath)), inst, loaded, now });

    expect(first.created).toBe(true);
    expect(second).toEqual({ runId: first.runId, created: false });
    expect(dbRuns(temp)).toHaveLength(1);
    const run = new Store(openDb(inst.dbPath)).getRun(first.runId)!;
    expect(run.admission_state).toBe("ready");
    expect(run.run_dir).not.toBe("");
    expect(run.definition_snapshot_path).not.toBe("");
    expect(run.worklog_path).not.toBe("");
  });

  test("recovery completes reservation-only, one-file, and files-before-ready crashes from persisted bytes", async () => {
    for (const crashState of ["reservation", "snapshot", "files"] as const) {
      const id = `recover-${crashState}`;
      const { temp, inst } = setup({ [id]: workflow(id) });
      const loaded = loadAndValidateDefinition(join(temp.workflowsDir, `${id}.yaml`));
      const { store, run } = reserveOnly(inst, loaded, new Date("2026-09-10T00:00:00Z"));
      if (crashState !== "reservation") {
        mkdirSync(run.run_dir, { recursive: true });
        writeFileSync(run.definition_snapshot_path, loaded.sourceText, "utf8");
      }
      if (crashState === "files") {
        writeFileSync(run.worklog_path, worklogTemplate(loaded.def.id, loaded.def.description, loaded.chain.order), "utf8");
      }
      writeFileSync(loaded.sourcePath, workflow(id, "echo changed-after-reservation"), "utf8");

      await recoverInstallation({ store, inst, clock: new SystemClock() });
      const recovered = store.getRun(run.run_id)!;
      expect(recovered.admission_state).toBe("ready");
      expect(readFileSync(recovered.definition_snapshot_path, "utf8")).toBe(loaded.sourceText);
      expect(existsSync(recovered.worklog_path)).toBe(true);
    }
  });

  test("mismatched admission evidence is preserved and failed closed", async () => {
    for (const target of ["snapshot", "worklog"] as const) {
      const id = `mismatch-${target}`;
      const { temp, inst } = setup({ [id]: workflow(id) });
      const loaded = loadAndValidateDefinition(join(temp.workflowsDir, `${id}.yaml`));
      const { store, run } = reserveOnly(inst, loaded, new Date("2026-09-10T00:00:00Z"));
      const path = target === "snapshot" ? run.definition_snapshot_path : run.worklog_path;
      mkdirSync(run.run_dir, { recursive: true });
      writeFileSync(path, "foreign evidence\n", "utf8");

      await recoverInstallation({ store, inst, clock: new SystemClock() });
      expect(readFileSync(path, "utf8")).toBe("foreign evidence\n");
      expect(store.getRun(run.run_id)!.status).toBe("failed");
      expect(store.getRun(run.run_id)!.admission_state).toBe("blocked");
    }
  });
});

describe("R2 pending packet repair", () => {
  test("first, successor, and retry pending rows recreate only a missing pristine packet", async () => {
    // First-attempt gap.
    {
      const { temp, inst } = setup({ first: workflow("first") });
      const ctx = await start(inst, join(temp.workflowsDir, "first.yaml"));
      const store = new Store(openDb(inst.dbPath));
      const row = store.getAttempt(ctx.started.runId, "node-only", 1)!;
      rmSync(row.packet_path);
      expect((await advanceChain({ store, inst, loaded: ctx.loaded, runId: ctx.started.runId, cliPath: runtimeCliInvocation() })).status).toBe("completed");
    }

    // Successor gap.
    {
      const yaml = workflow("successor").replace("command: echo done\n    next: null", "command: echo first\n    next: node-two\n  node-two:\n    run:\n      command: echo second\n    next: null");
      const { temp, inst } = setup({ successor: yaml });
      const ctx = await start(inst, join(temp.workflowsDir, "successor.yaml"));
      const store = new Store(openDb(inst.dbPath));
      const run = store.getRun(ctx.started.runId)!;
      await executeAttempt({ store, inst, def: ctx.loaded.def, chain: ctx.loaded.chain, run, nodeId: "node-only", attemptNo: 1, previousOutputFile: null, clock: new SystemClock(), cliPath: runtimeCliInvocation() });
      const successor = store.getAttempt(ctx.started.runId, "node-two", 1)!;
      rmSync(successor.packet_path);
      expect((await advanceChain({ store, inst, loaded: ctx.loaded, runId: ctx.started.runId, cliPath: runtimeCliInvocation() })).status).toBe("completed");
    }

    // Retry gap.
    {
      const { temp, inst } = setup({ retry: workflow("retry") });
      const ctx = await start(inst, join(temp.workflowsDir, "retry.yaml"));
      const store = new Store(openDb(inst.dbPath));
      store.db.query("UPDATE node_attempts SET status = 'failed' WHERE run_id = ?").run(ctx.started.runId);
      const retry = store.createRetryAttempt({ runId: ctx.started.runId, nodeId: "node-only", previousAttempt: 1, resolvedMaxAttempts: 2, resolvedTimeoutMs: 60_000, chainPosition: 0, now: new Date() })!;
      expect(existsSync(retry.packet_path)).toBe(false); // pending retries scaffold at run time
      expect((await advanceChain({ store, inst, loaded: ctx.loaded, runId: ctx.started.runId, cliPath: runtimeCliInvocation() })).status).toBe("completed");
    }
  });

  test("a mismatched pending packet is never overwritten", async () => {
    const { temp, inst } = setup({ packet: workflow("packet") });
    const ctx = await start(inst, join(temp.workflowsDir, "packet.yaml"));
    const store = new Store(openDb(inst.dbPath));
    const row = store.getAttempt(ctx.started.runId, "node-only", 1)!;
    writeFileSync(row.packet_path, "foreign packet evidence\n", "utf8");

    await advanceChain({ store, inst, loaded: ctx.loaded, runId: ctx.started.runId, cliPath: runtimeCliInvocation() });
    expect(readFileSync(row.packet_path, "utf8")).toBe("foreign packet evidence\n");
    expect(store.getRun(ctx.started.runId)!.status).toBe("failed");
  });
});
