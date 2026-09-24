import { existsSync, readFileSync } from "node:fs";
import type { Installation } from "./config.js";
import { canonicalHash } from "./definition/hash.js";
import type { ChainInfo } from "./definition/chain.js";
import type { WorkflowDefinition } from "./definition/schema.js";
import { loadSnapshot, type SnapshotBundle } from "./definition/snapshot.js";
import { parseStrictYaml } from "./definition/parse.js";
import { resolveNode } from "./runner/attempt.js";
import type { Store } from "./store/store.js";
import { GuardRejected, type AttemptRow, type RunRow } from "./store/store.js";
import { recoverAdmissions } from "./admission.js";
import { isProcessAlive, processStartId, terminateProcessGroup } from "./util/process.js";
import type { Clock } from "./util/clock.js";
import {
  WorklogIntegrityError,
  attemptFolderOfPacket,
  mergePacket,
  scaffoldPacket,
  RunLock,
} from "./worklog/worklog.js";
import { recoverOrchestratorDecision } from "./orchestrator.js";

/**
 * Deterministic recovery. A stale wrapper starts terminate-and-confirm; it
 * never grants reclaim by itself. False/unknown death confirmation preserves
 * ownership and process identity, so a replacement cannot overlap old work.
 */

export interface RecoveryReport {
  interruptedRetried: string[];
  interruptedProtected: string[];
  finishingRecovered: string[];
  orchestratorReleased: string[];
  orchestratorFinished: string[];
  skipped: string[];
}

export async function recoverInstallation(input: {
  store: Store;
  inst: Installation;
  clock: Clock;
}): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    interruptedRetried: [],
    interruptedProtected: [],
    finishingRecovered: [],
    orchestratorReleased: [],
    orchestratorFinished: [],
    skipped: [],
  };

  recoverAdmissions({ store: input.store, inst: input.inst, now: input.clock.now() });

  const candidates = input.store.listUnresolvedRuns();
  for (const run of candidates) {
    if (run.admission_state !== "ready") {
      report.skipped.push(`${run.run_id} (admission ${run.admission_state})`);
      continue;
    }

    // Stopped intent is a recovery phase, not a terminal status. Reconcile all
    // durable groups before final cancellation; never skip it.
    if (run.desired_state === "stopped") {
      await reconcileStoppedRun(input.store, run, input.clock, report);
      continue;
    }

    let bundle: SnapshotBundle;
    try {
      bundle = loadSnapshot(run.definition_snapshot_path);
      if (canonicalHash(bundle.def) !== run.definition_hash) {
        throw new WorklogIntegrityError(`definition snapshot for ${run.run_id} does not match its reserved hash`);
      }
    } catch (e) {
      const dead = await terminateAllRunGroups(input.store, run, input.clock);
      if (!dead) {
        report.skipped.push(`${run.run_id} (snapshot integrity; process death unconfirmed)`);
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      input.store.failRunIntegrity(run.run_id, message, input.clock.now());
      report.skipped.push(`${run.run_id} (snapshot integrity)`);
      continue;
    }
    await recoverRunPhases({ ...input, run, bundle, report });
  }
  return report;
}

async function recoverRunPhases(input: {
  store: Store;
  inst: Installation;
  run: RunRow;
  bundle: SnapshotBundle;
  clock: Clock;
  report: RecoveryReport;
}): Promise<void> {
  const { store, inst, run, bundle, clock, report } = input;

  for (const attempt of store.listAttempts(run.run_id)) {
    if (attempt.status === "running") {
      await recoverRunningAttempt({ store, inst, run, attempt, bundle, clock, report });
    } else if (attempt.status === "finishing") {
      await recoverFinishingAttempt({ store, inst, run, attempt, bundle, clock, report });
    }
  }

  const fresh = store.getRun(run.run_id);
  if (!fresh || (fresh.orchestrator_phase !== "owned" && fresh.orchestrator_phase !== "applying")) return;
  if (orchestratorWrapperAlive(fresh)) {
    report.skipped.push(`${run.run_id} (orchestrator wrapper alive)`);
    return;
  }
  if (!(await terminateOrchestratorGroup(store, fresh, clock))) {
    report.skipped.push(`${run.run_id} (orchestrator process death unconfirmed)`);
    return;
  }
  const reconciled = await recoverOrchestratorDecision({ store, chain: bundle.chain, run: fresh, clock });
  if (reconciled === "released") report.orchestratorReleased.push(run.run_id);
  else if (reconciled === "finished") report.orchestratorFinished.push(run.run_id);
  else report.skipped.push(`${run.run_id} (orchestrator evidence protected)`);
}

async function recoverRunningAttempt(input: {
  store: Store;
  inst: Installation;
  run: RunRow;
  attempt: AttemptRow;
  bundle: SnapshotBundle;
  clock: Clock;
  report: RecoveryReport;
}): Promise<void> {
  const { store, run, attempt, bundle, clock, report } = input;
  if (wrapperIdentityAlive(attempt)) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (worker alive)`);
    return;
  }
  if (!(await terminateAttemptGroups(store, attempt, clock))) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (process death unconfirmed)`);
    return;
  }

  const ownerToken = store.getAttempt(run.run_id, attempt.node_id, attempt.attempt)?.owner_token;
  if (!ownerToken) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (owner missing)`);
    return;
  }
  const failed = store.failAttempt({
    runId: run.run_id,
    nodeId: attempt.node_id,
    attempt: attempt.attempt,
    ownerToken,
    failureKind: "interrupted",
    protectForOrchestration: false,
    now: clock.now(),
  });
  if (!failed.failed) return;

  const retried = store.createRetryAttempt({
    runId: run.run_id,
    nodeId: attempt.node_id,
    previousAttempt: attempt.attempt,
    resolvedMaxAttempts: attempt.resolved_max_attempts,
    resolvedTimeoutMs: attempt.resolved_timeout_ms,
    chainPosition: bundle.chain.order.indexOf(attempt.node_id),
    now: clock.now(),
  });
  if (retried) {
    scaffoldPacket(
      attemptFolderOfPacket(retried.packet_path),
      retried.attempt,
      bundle.chain.next.get(attempt.node_id) ?? null,
    );
    report.interruptedRetried.push(`${run.run_id}/${attempt.node_id} #${retried.attempt}`);
  } else {
    store.db
      .query(
        `UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, updated_at = ?
         WHERE run_id = ? AND orchestrator_phase = 'idle' AND desired_state = 'running'`,
      )
      .run(clock.now().toISOString(), run.run_id);
    report.interruptedProtected.push(`${run.run_id}/${attempt.node_id}`);
  }
}

async function recoverFinishingAttempt(input: {
  store: Store;
  inst: Installation;
  run: RunRow;
  attempt: AttemptRow;
  bundle: SnapshotBundle;
  clock: Clock;
  report: RecoveryReport;
}): Promise<void> {
  const { store, inst, run, attempt, bundle, clock, report } = input;
  if (wrapperIdentityAlive(attempt)) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (finishing owner alive)`);
    return;
  }
  if (!(await terminateAttemptGroups(store, attempt, clock))) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (process death unconfirmed)`);
    return;
  }

  const prior = store.getAttempt(run.run_id, attempt.node_id, attempt.attempt)?.owner_token;
  if (!prior) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (owner missing)`);
    return;
  }
  const newToken = store.transferFinishingOwner({
    runId: run.run_id,
    nodeId: attempt.node_id,
    attempt: attempt.attempt,
    priorOwnerToken: prior,
    now: clock.now(),
  });
  if (!newToken) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (transfer lost)`);
    return;
  }

  const attemptFolder = attemptFolderOfPacket(attempt.packet_path);
  const integrityFail = (message: string): void => {
    const fresh = store.getAttempt(run.run_id, attempt.node_id, attempt.attempt);
    if (fresh?.owner_token !== newToken) return;
    store.failAttempt({
      runId: run.run_id,
      nodeId: attempt.node_id,
      attempt: attempt.attempt,
      ownerToken: newToken,
      failureKind: "worklog_integrity",
      validatorReason: message,
      now: clock.now(),
    });
  };

  // S9: the finishing row bound the output path and validator verdict at
  // running → finishing; recovery consumes those fields as-is. A missing
  // row-bound output file is a fail-closed integrity fault, never a rerun.
  const finishing = store.getAttempt(run.run_id, attempt.node_id, attempt.attempt)!;
  if (!finishing.node_output_path) {
    integrityFail(`finishing attempt ${attempt.node_id} #${attempt.attempt} has no bound output path`);
    return;
  }
  if (!existsSync(finishing.node_output_path)) {
    integrityFail(`bound output file for ${attempt.node_id} #${attempt.attempt} is missing at ${finishing.node_output_path}`);
    return;
  }

  const successorId = bundle.chain.next.get(attempt.node_id) ?? null;
  const successor = successorId
    ? (() => {
        const resolved = resolveNode(bundle.def, successorId, inst);
        return {
          nodeId: successorId,
          resolvedMaxAttempts: resolved.maxAttempts,
          resolvedTimeoutMs: resolved.timeoutMs,
          chainPosition: bundle.chain.order.indexOf(successorId),
        };
      })()
    : null;

  const lock = new RunLock(run.run_dir);
  try {
    await lock.acquire();
    // S10: the marked-block receipt makes this idempotent — a block present
    // without a receipt is verified and the receipt recreated, never re-appended.
    mergePacket({
      runDir: run.run_dir,
      runId: run.run_id,
      nodeId: attempt.node_id,
      attempt: attempt.attempt,
      attemptFolder,
      successorId,
      now: clock.now(),
    });
    store.completeAttempt({
      runId: run.run_id,
      nodeId: attempt.node_id,
      attempt: attempt.attempt,
      ownerToken: newToken,
      now: clock.now(),
      successor,
    });
  } catch (e) {
    if (e instanceof WorklogIntegrityError) {
      integrityFail(e.message);
      return;
    }
    if (e instanceof GuardRejected) {
      report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (completion guard rejected)`);
      return;
    }
    throw e;
  } finally {
    lock.release();
  }

  if (successorId) {
    const row = store.getAttempt(run.run_id, successorId, 1);
    if (row) {
      scaffoldPacket(
        attemptFolderOfPacket(row.packet_path),
        row.attempt,
        bundle.chain.next.get(successorId) ?? null,
      );
    }
  }
  report.finishingRecovered.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt}`);
}

async function reconcileStoppedRun(store: Store, run: RunRow, clock: Clock, report: RecoveryReport): Promise<void> {
  if (!(await terminateAllRunGroups(store, run, clock))) {
    report.skipped.push(`${run.run_id} (stopped; process death unconfirmed)`);
    return;
  }
  if (!store.finalizeStoppedRun({ runId: run.run_id, now: clock.now() })) {
    report.skipped.push(`${run.run_id} (stopped; cancellation still protected)`);
  }
}

/** Reconcile one already-persisted stop intent; used by CLI and recovery. */
export async function reconcileStoppedIntent(input: {
  store: Store; runId: string; clock: Clock;
}): Promise<boolean> {
  const run = input.store.getRun(input.runId);
  if (!run || run.desired_state !== "stopped") return false;
  if (!(await terminateAllRunGroups(input.store, run, input.clock))) return false;
  return input.store.finalizeStoppedRun({ runId: run.run_id, now: input.clock.now() });
}

async function terminateAllRunGroups(store: Store, run: RunRow, clock: Clock): Promise<boolean> {
  for (const attempt of store.listAttempts(run.run_id)) {
    if (!(await terminateAttemptGroups(store, attempt, clock))) return false;
  }
  const fresh = store.getRun(run.run_id);
  return fresh ? terminateOrchestratorGroup(store, fresh, clock) : false;
}

async function terminateAttemptGroups(store: Store, attempt: AttemptRow, clock: Clock): Promise<boolean> {
  for (const role of ["validator", "worker"] as const) {
    const fresh = store.getAttempt(attempt.run_id, attempt.node_id, attempt.attempt);
    if (!fresh) return false;
    const pid = role === "worker" ? fresh.worker_pid : fresh.validator_pid;
    const startId = role === "worker" ? fresh.worker_process_start_id : fresh.validator_process_start_id;
    const pgid = role === "worker" ? fresh.worker_process_group : fresh.validator_process_group;
    if (pgid === null) continue;
    if (pid === null || !startId) return false;
    if (!(await terminateRecordedGroup(pid, startId, pgid))) return false;
    if (!store.confirmAttemptProcessStopped({
      runId: fresh.run_id,
      nodeId: fresh.node_id,
      attempt: fresh.attempt,
      role,
      pid,
      startId,
      pgid,
      now: clock.now(),
    })) {
      const after = store.getAttempt(fresh.run_id, fresh.node_id, fresh.attempt);
      const remaining = role === "worker" ? after?.worker_process_group : after?.validator_process_group;
      if (remaining !== null) return false;
    }
  }
  return true;
}

async function terminateOrchestratorGroup(store: Store, run: RunRow, clock: Clock): Promise<boolean> {
  const fresh = store.getRun(run.run_id);
  if (!fresh || fresh.orchestrator_process_group === null) return true;
  if (fresh.orchestrator_worker_pid === null || !fresh.orchestrator_worker_process_start_id) return false;
  if (!(await terminateRecordedGroup(
    fresh.orchestrator_worker_pid,
    fresh.orchestrator_worker_process_start_id,
    fresh.orchestrator_process_group,
  ))) return false;
  if (store.confirmOrchestratorProcessStopped({
    runId: fresh.run_id,
    childPid: fresh.orchestrator_worker_pid,
    childStartId: fresh.orchestrator_worker_process_start_id,
    childPgid: fresh.orchestrator_process_group,
    now: clock.now(),
  })) return true;
  return store.getRun(fresh.run_id)?.orchestrator_process_group === null;
}

async function terminateRecordedGroup(pid: number, startId: string, pgid: number): Promise<boolean> {
  const current = processStartId(pid);
  // A live PID with another start identity may be an unrelated reused PID.
  // Never signal its group and never call that uncertainty "dead".
  if (current !== null && current !== startId) return false;
  return terminateProcessGroup(pgid);
}

function wrapperIdentityAlive(attempt: AttemptRow): boolean {
  const pid = attempt.wrapper_pid;
  const startId = attempt.wrapper_process_start_id;
  if (pid === null || !isProcessAlive(pid)) return false;
  return startId ? processStartId(pid) === startId : true;
}

function orchestratorWrapperAlive(run: RunRow): boolean {
  const pid = run.orchestrator_wrapper_pid;
  const startId = run.orchestrator_wrapper_process_start_id;
  if (pid === null || !isProcessAlive(pid)) return false;
  return startId ? processStartId(pid) === startId : true;
}
