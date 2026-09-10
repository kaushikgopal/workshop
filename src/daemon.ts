import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import { Store, type RunRow } from "./store/store.js";
import { openDb } from "./store/db.js";
import { admitDueOccurrences } from "./scheduler.js";
import { loadAndValidateDefinition } from "./execute.js";
import { recoverInstallation, loadSnapshot } from "./recovery.js";
import { runChain, scaffoldFirstAttempt, preflightIfNeeded } from "./execute.js";
import { invokeOrchestrator } from "./orchestrator.js";
import type { Clock } from "./util/clock.js";
import { SystemClock } from "./util/clock.js";
import { parseDuration } from "./util/duration.js";
import { atomicWriteFileSync, scaffoldWorklog } from "./worklog/worklog.js";
import { terminateProcessGroup } from "./util/process.js";
import { runtimeCliInvocation } from "./util/cli-path.js";
import { openSync, closeSync, rmSync, writeFileSync } from "node:fs";

/**
 * One deterministic guardian process per installation: polls SQLite, admits
 * due scheduled runs, reconciles interrupted work, enforces top-level
 * concurrency, and invokes run-scoped orchestrators only for exceptions.
 * A second daemon is rejected via the singleton lock.
 */

const POLL_MS = 1000;

export class DaemonLockHeld extends Error {
  constructor(public holderPid: number | null) {
    super(`another daemon holds the singleton lock${holderPid ? ` (pid ${holderPid})` : ""}`);
    this.name = "DaemonLockHeld";
  }
}

interface SingletonLock {
  release: () => void;
}

/** O_EXCL singleton with stale takeover by pid liveness. */
function acquireSingletonLock(stateDir: string): SingletonLock {
  const path = join(stateDir, "daemon.lock");
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return { release: () => unlinkLock(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holderPid: number | null = null;
      try {
        const holder = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
        holderPid = holder.pid;
        process.kill(holder.pid, 0);
        throw new DaemonLockHeld(holderPid); // holder alive
      } catch (err) {
        if (err instanceof DaemonLockHeld) throw err;
        rmLock(path); // holder dead or unreadable
      }
    }
  }
}

function unlinkLock(path: string): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}

function rmLock(path: string): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}

export interface TickResult {
  admitted: string[];
  launched: string[];
  orchestrated: string[];
  /** Chains launched this tick; awaiting them gives deterministic tests. */
  pending: Array<Promise<void>>;
}

/**
 * One deterministic reconciliation tick. Exported for tests with an
 * injectable clock; the foreground daemon loops it.
 */
export async function tick(input: { inst: Installation; clock?: Clock }): Promise<TickResult> {
  const clock = input.clock ?? new SystemClock();
  const { inst } = input;
  const store = new Store(openDb(inst.dbPath));
  const result: TickResult = { admitted: [], launched: [], orchestrated: [], pending: [] };

  // 1. Reconcile stale work first — never admit new work onto unreconciled state.
  await recoverInstallation({ store, inst, clock });

  // 2. Admit due scheduled occurrences.
  const workflowIds = store.listWorkflows().map((w) => w.workflow_id);
  const admissions = admitDueOccurrences({
    store,
    workflowIds,
    clock,
    createRun: (workflowId, now) => {
      const run = admitScheduledRun({ store, inst, workflowId, now });
      return run ? { runId: run } : null;
    },
  });
  for (const a of admissions) if (a.admitted) result.admitted.push(a.admitted);

  // 3. Execute pending attempts within the concurrency pool. A queued run
  // is bootstrapped (first attempt) and launched in the same tick.
  let slots = inst.maxConcurrentRuns;
  for (const run of store.listUnresolvedRuns()) {
    if (slots <= 0) break;
    if (run.desired_state !== "running" || run.orchestrator_phase !== "idle") continue;

    let live = store.getLiveAttempt(run.run_id);
    if (!live) {
      if (run.status !== "queued") continue;
      await bootstrapFirstAttempt({ store, inst, run, clock });
      live = store.getLiveAttempt(run.run_id);
      if (!live || live.status !== "pending") continue;
    }
    if (live.status !== "pending") continue;

    const bundle = loadSnapshot(join(run.run_dir, "definition.yaml"));
    slots--;
    result.launched.push(`${run.run_id}/${live.node_id}`);
    // In-process execution through the same guarded path the CLI uses;
    // the promise is surfaced so tests and the daemon can await it.
    result.pending.push(
      runChain({
        store,
        inst,
        loaded: { def: bundle.def, chain: bundle.chain, canonicalHash: "", sourcePath: "" },
        runId: run.run_id,
        clock,
        cliPath: runtimeCliInvocation(),
      }).then(() => undefined),
    );
  }

  // 4. Invoke the orchestrator for protected failures.
  for (const run of store.listUnresolvedRuns()) {
    const fresh = store.getRun(run.run_id)!;
    if (fresh.orchestrator_phase !== "pending" || fresh.desired_state !== "running") continue;
    const bundle = loadSnapshot(join(fresh.run_dir, "definition.yaml"));
    await invokeOrchestrator({ store, inst, def: bundle.def, chain: bundle.chain, run: fresh, clock, cliPath: runtimeCliInvocation() });
    result.orchestrated.push(fresh.run_id);
  }

  return result;
}

/** Admit one scheduled occurrence: snapshot, scaffold, preflight, first attempt. */
function admitScheduledRun(input: {
  store: Store;
  inst: Installation;
  workflowId: string;
  now: Date;
}): string | null {
  const { store, inst, workflowId, now } = input;
  const wf = store.getWorkflow(workflowId)!;
  const definitionPath = wf.definition_path;
  if (!definitionPath || !existsSync(definitionPath)) return null;

  const loaded = loadAndValidateDefinition(definitionPath);
  const everyMs = wf.schedule_every ? parseDuration(wf.schedule_every) : null;
  const admitted = store.createRun({
    workflowId,
    definitionHash: loaded.canonicalHash,
    definitionSnapshotPath: "",
    runDir: "",
    worklogPath: "",
    now,
    isRecurring: Boolean(wf.schedule_every),
    everyMs,
  });
  const run = store.getRun(admitted.runId)!;
  const runDir = join(inst.runsDir, run.run_id);
  atomicWriteFileSync(join(runDir, "definition.yaml"), readFileSync(definitionPath, "utf8"));
  scaffoldWorklog(runDir, loaded.def.id, loaded.def.description, loaded.chain.order);
  store.tx(() => {
    store.db
      .query("UPDATE runs SET definition_snapshot_path = ?, run_dir = ?, worklog_path = ? WHERE run_id = ?")
      .run(join(runDir, "definition.yaml"), runDir, join(runDir, "WORKSHOP_LOG.md"), run.run_id);
  });
  return run.run_id;
}

async function bootstrapFirstAttempt(input: {
  store: Store;
  inst: Installation;
  run: RunRow;
  clock: Clock;
}): Promise<void> {
  const { store, inst, run, clock } = input;
  const fresh = store.getRun(run.run_id)!;
  if (!existsSync(fresh.definition_snapshot_path)) return;
  const loaded = loadAndValidateDefinition(fresh.definition_snapshot_path);
  await preflightIfNeeded({ store, inst, loaded, runId: run.run_id, clock });
  scaffoldFirstAttempt({ store, inst, loaded, runId: run.run_id, now: clock.now() });
}

/** Foreground daemon. Ctrl-C stops it; the lock releases on exit. */
export async function runDaemon(inst: Installation): Promise<void> {
  const lock = acquireSingletonLock(inst.stateDir);
  process.on("SIGINT", () => {
    lock.release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    lock.release();
    process.exit(0);
  });
  process.stderr.write(`workshop daemon: polling ${inst.dbPath} every ${POLL_MS}ms (pid ${process.pid})\n`);
  for (;;) {
    try {
      await tick({ inst });
    } catch (e) {
      process.stderr.write(`workshop daemon: tick error: ${(e as Error).message}\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

