import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import { Store, type RunRow } from "./store/store.js";
import { openDb } from "./store/db.js";
import { admitDueOccurrences } from "./scheduler.js";
import { loadAndValidateDefinition, runChain, scaffoldFirstAttempt, preflightIfNeeded } from "./execute.js";
import { recoverInstallation } from "./recovery.js";
import { loadSnapshot } from "./definition/snapshot.js";
import { invokeOrchestrator } from "./orchestrator.js";
import { admitScheduledRun } from "./admission.js";
import type { Clock } from "./util/clock.js";
import { SystemClock } from "./util/clock.js";
import { openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { runtimeCliInvocation } from "./util/cli-path.js";

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
    createRun: (workflowId, now) => admitScheduledRun({ store, inst, workflowId, now }),
  });
  for (const a of admissions) if (a.admitted) result.admitted.push(a.admitted);

  // 3. Bootstrap all prepared queued runs. Capacity controls claims, not
  // pending work creation, so rejected work remains available next tick.
  for (const run of store.listUnresolvedRuns()) {
    if (run.admission_state !== "ready" || run.desired_state !== "running") continue;
    if (!store.getLiveAttempt(run.run_id) && run.status === "queued") {
      await bootstrapFirstAttempt({ store, inst, run, clock });
    }
  }

  // 4. Protected exception judgment takes the same global run slots.
  for (const run of store.listUnresolvedRuns()) {
    const fresh = store.getRun(run.run_id)!;
    if (fresh.admission_state !== "ready" || fresh.orchestrator_phase !== "pending" || fresh.desired_state !== "running") continue;
    if (!store.hasExecutionCapacity(inst.maxConcurrentRuns)) break;
    const bundle = loadSnapshot(fresh.definition_snapshot_path);
    await invokeOrchestrator({ store, inst, def: bundle.def, chain: bundle.chain, run: fresh, clock, cliPath: runtimeCliInvocation() });
    result.orchestrated.push(fresh.run_id);
  }

  // 5. Claims re-check global capacity inside BEGIN IMMEDIATE. The advisory
  // check only keeps reporting honest and avoids launching doomed promises.
  for (const run of store.listUnresolvedRuns()) {
    if (!store.hasExecutionCapacity(inst.maxConcurrentRuns)) break;
    const fresh = store.getRun(run.run_id)!;
    if (fresh.admission_state !== "ready" || fresh.desired_state !== "running" || fresh.orchestrator_phase !== "idle") continue;
    const live = store.getLiveAttempt(run.run_id);
    if (!live || live.status !== "pending") continue;

    const bundle = loadSnapshot(fresh.definition_snapshot_path);
    result.launched.push(`${run.run_id}/${live.node_id}`);
    result.pending.push(
      runChain({
        store,
        inst,
        loaded: { def: bundle.def, chain: bundle.chain, canonicalHash: fresh.definition_hash, sourcePath: fresh.definition_snapshot_path, sourceText: "" },
        runId: run.run_id,
        clock,
        cliPath: runtimeCliInvocation(),
      })
        // A chain that throws must not take the guardian with it: the CLI's
        // `unhandledRejection` handler exits the process, so one bad run would
        // stop recurrence and recovery for every workflow in the installation.
        // Attempt state is durable, so the next tick reconciles whatever this
        // left behind.
        .catch((e: unknown) => {
          process.stderr.write(
            `workshop: chain ${run.run_id} failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
          return undefined;
        })
        .then(() => undefined),
    );
  }

  return result;
}


async function bootstrapFirstAttempt(input: {
  store: Store;
  inst: Installation;
  run: RunRow;
  clock: Clock;
}): Promise<void> {
  const { store, inst, run, clock } = input;
  const fresh = store.getRun(run.run_id)!;
  if (fresh.admission_state !== "ready") return;
  const loaded = loadAndValidateDefinition(fresh.definition_snapshot_path);
  await preflightIfNeeded({ store, inst, loaded, runId: run.run_id, clock });
  if (store.getRun(run.run_id)!.status !== "blocked" && !store.getLiveAttempt(run.run_id)) {
    scaffoldFirstAttempt({ store, inst, loaded, runId: run.run_id, now: clock.now() });
  }
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

