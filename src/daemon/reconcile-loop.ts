import type { Installation } from "../load-installation.js";
import { Store, type RunRow } from "../storage/db/store.js";
import { openDb } from "../storage/db/open-and-migrate.js";
import { admitDueOccurrences } from "./create-due-runs.js";
import { advanceChain } from "../run/advance-chain.js";
import { scaffoldFirstAttempt } from "../run/start-run.js";
import { checkEnvironment } from "../run/check-environment.js";
import { loadAndValidateDefinition } from "../definition/load-definition.js";
import { recoverInstallation } from "../run/recover-after-crash.js";
import { loadSnapshot } from "../definition/load-definition.js";
import { invokeOrchestrator } from "../run/orchestrate-failure.js";
import { admitScheduledRun } from "../run/create-run.js";
import type { Clock } from "../util/clock.js";
import { SystemClock } from "../util/clock.js";
import { runtimeCliInvocation } from "../attempt/build-attempt-env.js";
import { acquireSingletonLock } from "./acquire-daemon-lock.js";

/**
 * One deterministic guardian process per installation: polls SQLite, admits
 * due scheduled runs, reconciles interrupted work, enforces top-level
 * concurrency, and invokes run-scoped orchestrators only for exceptions.
 * A second daemon is rejected via the singleton lock.
 */
const POLL_MS = 1000;

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
      advanceChain({
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
  await checkEnvironment({ store, inst, loaded, runId: run.run_id, clock });
  if (store.getRun(run.run_id)!.status !== "blocked" && !store.getLiveAttempt(run.run_id)) {
    scaffoldFirstAttempt({ store, inst, loaded, runId: run.run_id, now: clock.now() });
  }
}

/** Foreground daemon. Ctrl-C stops it; the lock releases on exit. */
export async function reconcileForever(inst: Installation): Promise<void> {
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

