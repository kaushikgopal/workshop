import { join } from "node:path";
import { findInstallation, ensureDirs, workflowPath } from "../load-installation.js";
import { advanceChain } from "../run/advance-chain.js";
import { scaffoldFirstAttempt } from "../run/start-run.js";
import { startWorkflow } from "../run/start-run.js";
import { checkEnvironment } from "../run/check-environment.js";
import { loadAndValidateDefinition } from "../definition/load-definition.js";
import { openDb } from "../storage/db/open-and-migrate.js";
import { Store } from "../storage/db/store.js";
import { attemptDirOfPacket } from "../storage/disk/locate-run-files.js";
import { SystemClock } from "../util/clock.js";
import { runtimeCliInvocation } from "../attempt/build-attempt-env.js";
import { die, requireArg } from "./errors.js";

/**
 * The operator's run controls: start, stop, pause, and resume. Each one writes
 * durable intent to SQLite first, then acts on it.
 */
export async function cmdStart(args: string[]): Promise<void> {
  const workflowId = requireArg(args, "workflow-id");
  const inst = findInstallation();
  ensureDirs(inst);
  const loaded = loadAndValidateDefinition(workflowPath(inst, workflowId));

  const store = new Store(openDb(inst.dbPath));
  const started = await startWorkflow({ inst, loaded });
  if (!started.created) {
    const run = store.getRun(started.runId)!;
    process.stdout.write(
      `no-op: workflow "${workflowId}" already has unresolved run ${run.run_id} (${run.status})\n`,
    );
    return;
  }

  process.stdout.write(`started ${workflowId} → ${started.runId}\n`);
  for (const w of started.warnings) process.stdout.write(`warning: ${w}\n`);

  // Package 1: execute the chain inline. The daemon (package 4) takes over
  // claiming and recurrence; the same guarded path is reused.
  const final = await advanceChain({ store, inst, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });
  process.stdout.write(`run ${final.run_id} → ${final.status}\n`);
  // The runner holds live handles (spawned-process listeners) by design;
  // CLI commands terminate their own process when the work is done.
  process.exit(0);
}

/**
 * Durable stop: the intent (desired_state + activation) is written before the
 * runner is signalled, so a restart cannot reinterpret it as a retry. The
 * recorded process group is terminated and confirmed afterwards.
 */
export async function cmdStop(args: string[]): Promise<void> {
  const workflowId = requireArg(args, "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const now = new Date();

  const wf = store.getWorkflow(workflowId);
  if (!wf) die(`no workflow "${workflowId}"`);

  const run = store.getUnresolvedRun(workflowId);
  if (!run) {
    store.setActivationState(workflowId, "stopped");
    process.stdout.write(`stopped ${workflowId}: no unresolved run\n`);
    return;
  }

  // Commit schedule suppression and run stop intent before signalling any
  // group. Attempt/orchestrator ownership remains protected until confirmed
  // death allows the separate final-cancellation transaction.
  store.tx(() => {
    store.stopRun({ runId: run.run_id, now });
    store.setActivationState(workflowId, "stopped");
  });
  const { reconcileStoppedIntent } = await import("../run/recover-after-crash.js");
  const cancelled = await reconcileStoppedIntent({
    store, runId: run.run_id, clock: new SystemClock(),
  });
  if (!cancelled) {
    die(`stop intent recorded for ${run.run_id}, but a process group could not be confirmed dead; recovery will continue cancellation`);
  }
  process.stdout.write(`stopped ${workflowId}: run ${run.run_id} cancelled\n`);
}

/** Pause: suppress future occurrences; the current node finishes, then no successor. */
export function cmdPause(args: string[]): void {
  const workflowId = requireArg(args, "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const run = store.getUnresolvedRun(workflowId);
  if (run) store.setDesiredState(run.run_id, "paused", new Date());
  store.setActivationState(workflowId, "paused");
  process.stdout.write(run ? `paused ${workflowId}: run ${run.run_id} pauses before its successor\n` : `paused ${workflowId}\n`);
}

/**
 * Resume run-level blockers per kind, re-enable the schedule, and recreate
 * any missing successor attempt.
 */
export async function cmdResume(args: string[]): Promise<void> {
  const workflowId = requireArg(args, "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const now = new Date();
  const wf = store.getWorkflow(workflowId);
  if (!wf) die(`no workflow "${workflowId}"`);

  const run = store.getUnresolvedRun(workflowId);
  if (!run) {
    store.setActivationState(workflowId, "active");
    process.stdout.write(`resumed ${workflowId}: schedule re-enabled (no unresolved run)\n`);
    return;
  }

  switch (run.block_kind) {
    case "preflight": {
      const loaded = loadAndValidateDefinition(join(run.run_dir, "definition.yaml"));
      await checkEnvironment({ store, inst, loaded, runId: run.run_id, clock: new SystemClock() });
      const after = store.getRun(run.run_id)!;
      if (after.status === "blocked" && after.block_kind === "preflight") {
        die("preflight still blocked — fix the environment first");
      }
      store.setRunStatus(run.run_id, "running", now, null); // clears the blocker
      scaffoldFirstAttempt({ store, inst, loaded, runId: run.run_id, now });
      break;
    }
    case "orchestrator_unresolved": {
      // Re-resolve happens at next orchestrator claim; move the protected
      // phase back to pending so judgment can proceed.
      store.operatorResetOrchestrator(run.run_id, now);
      store.setRunStatus(run.run_id, "running", now, null);
      break;
    }
    case "agent_requested":
    case "orchestrator":
    case "operator": {
      // One transaction: clear the blocker and create the fresh retry attempt
      // for the latest blocked attempt (by execution sequence). The retry
      // carries one manual bound extension.
      const loaded = loadAndValidateDefinition(join(run.run_dir, "definition.yaml"));
      const fresh = store.resumeBlockedRun({ runId: run.run_id, now });
      if (!fresh) die("blocked run has no blocked attempt");
      const { scaffoldPacket } = await import("../worklog/prepare-packet.js");
      scaffoldPacket(
        attemptDirOfPacket(fresh.packet_path),
        fresh.attempt,
        loaded.chain.next.get(fresh.node_id) ?? null,
      );
      break;
    }
    case "unknown_external":
      die("unknown_external is not resumable — stop the run and explicitly change workflow policy");
    default:
      // Plain paused run: just continue; missing successors are recreated.
      store.setRunStatus(run.run_id, "running", now, null);
  }

  // Recreate the missing successor attempt for a paused-before-successor run.
  const freshRun = store.getRun(run.run_id)!;
  if (freshRun.status === "running" && !store.getLiveAttempt(run.run_id)) {
    const loaded = loadAndValidateDefinition(join(run.run_dir, "definition.yaml"));
    await recreateMissingSuccessor(store, inst, loaded, run.run_id, now);
  }

  store.setActivationState(workflowId, "active");
  process.stdout.write(`resumed ${workflowId}: run ${run.run_id} → ${store.getRun(run.run_id)!.status}\n`);
}

/** Create the pending successor attempt when a completed node has none. */
async function recreateMissingSuccessor(
  store: Store,
  inst: ReturnType<typeof findInstallation>,
  loaded: ReturnType<typeof loadAndValidateDefinition>,
  runId: string,
  now: Date,
): Promise<void> {
  const completed = store
    .listAttempts(runId)
    .filter((a) => a.status === "completed")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
  const lastNodeId = completed?.node_id ?? loaded.chain.order[loaded.chain.order.length - 1]!;
  const nextId = loaded.chain.next.get(lastNodeId) ?? null;
  if (!nextId) return;
  const resolved = (await import("../definition/resolve-node-settings.js")).resolveNode(loaded.def, nextId, inst);
  const run = store.getRun(runId)!;
  const fresh = store.createSuccessorAttempt({
    runId,
    nodeId: nextId,
    resolvedMaxAttempts: resolved.maxAttempts,
    resolvedTimeoutMs: resolved.timeoutMs,
    chainPosition: loaded.chain.order.indexOf(nextId),
    now,
  });
  const { scaffoldPacket } = await import("../worklog/prepare-packet.js");
  scaffoldPacket(attemptDirOfPacket(fresh.packet_path), fresh.attempt, loaded.chain.next.get(nextId) ?? null);
}

