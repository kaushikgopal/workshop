import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import { validateChain, type ChainInfo } from "./definition/validate.js";
import { workflowSchema, type WorkflowDefinition } from "./definition/schema.js";
import { parseStrictYaml } from "./definition/parse.js";
import { resolveNode } from "./runner/attempt.js";
import type { Store } from "./store/store.js";
import { isTerminal, type AttemptRow, type RunRow } from "./store/store.js";
import { isProcessAlive, processStartId, terminateProcessGroup } from "./util/process.js";
import type { Clock } from "./util/clock.js";
import {
  WorklogIntegrityError,
  extractMarker,
  mergePacket,
  packetPath,
  scaffoldPacket,
  validatePacket,
  verifyMergeReceipt,
} from "./worklog/worklog.js";

/**
 * Deterministic recovery. A stale lease never authorizes reclaim by itself;
 * it starts terminate-and-confirm. Recovery transfers ownership by
 * compare-and-set and finalizes from durable evidence — completed nodes
 * never rerun.
 */

export interface SnapshotBundle {
  def: WorkflowDefinition;
  chain: ChainInfo;
}

/** Load the validated snapshot a run executes against. */
export function loadSnapshot(snapshotPath: string): SnapshotBundle {
  const raw = parseStrictYaml(readFileSync(snapshotPath, "utf8"), snapshotPath);
  const def = workflowSchema.parse(raw);
  return { def, chain: validateChain(def) };
}

export interface RecoveryReport {
  interruptedRetried: string[];
  interruptedProtected: string[];
  finishingRecovered: string[];
  orchestratorReleased: string[];
  orchestratorFinished: string[];
  skipped: string[];
}

/** Recover all stale work in one installation pass. */
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

  for (const run of input.store.listUnresolvedRuns()) {
    if (run.desired_state === "stopped") {
      report.skipped.push(`${run.run_id} (stopped)`);
      continue;
    }
    const bundle = loadSnapshot(join(run.run_dir, "definition.yaml"));
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

  // 1. Stale node attempts (interrupted or left finishing).
  for (const attempt of store.listAttempts(run.run_id)) {
    if (attempt.status === "running") {
      await recoverRunningAttempt({ store, inst, run, attempt, bundle, clock, report });
    } else if (attempt.status === "finishing") {
      await recoverFinishingAttempt({ store, inst, run, attempt, bundle, clock, report });
    }
  }

  // 2. Stale orchestrator phases.
  const fresh = store.getRun(run.run_id)!;
  if (fresh.orchestrator_phase === "owned" || fresh.orchestrator_phase === "applying") {
    if (orchestratorOwnerDead(fresh)) {
      await killRecordedGroup(fresh.orchestrator_worker_pid);
      const token = fresh.orchestrator_owner_token!;
      const receipt = join(fresh.run_dir, "receipts", `orchestrator-${token}.json`);
      if (fresh.orchestrator_phase === "applying" && existsSync(receipt)) {
        // The decision was applied; only the phase close is missing.
        store.finishOrchestrator(fresh.run_id, clock.now());
        report.orchestratorFinished.push(fresh.run_id);
      } else {
        store.releaseOrchestratorToPending(fresh.run_id, token, clock.now());
        report.orchestratorReleased.push(fresh.run_id);
      }
    }
  }
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
  const { store, inst, run, attempt, bundle, clock, report } = input;
  if (workerIdentityAlive(attempt)) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (worker alive)`);
    return;
  }

  // Stale lease: terminate-and-confirm the recorded process group first.
  await killRecordedGroup(attempt.worker_process_group);

  // A dead worker is the only automatically retryable technical interruption.
  const failed = store.failAttempt({
    runId: run.run_id,
    nodeId: attempt.node_id,
    attempt: attempt.attempt,
    ownerToken: null,
    failureKind: "interrupted",
    protectForOrchestration: false, // a dead worker auto-retries within policy
    now: clock.now(),
  });
  if (!failed.failed) return;


  const retried = store.createRetryAttempt({
    runId: run.run_id,
    nodeId: attempt.node_id,
    previousAttempt: attempt.attempt,
    packetPath: packetPath(run.run_dir, attempt.node_id, attempt.attempt + 1),
    resolvedMaxAttempts: attempt.resolved_max_attempts,
    resolvedTimeoutMs: attempt.resolved_timeout_ms,
    now: clock.now(),
  });
  if (retried) {
    scaffoldPacket(run.run_dir, attempt.node_id, retried.attempt, bundle.chain.next.get(attempt.node_id) ?? null);
    report.interruptedRetried.push(`${run.run_id}/${attempt.node_id} #${retried.attempt}`);
  } else {
    // Bound exhausted: protect for orchestration.
    store.db
      .query("UPDATE runs SET orchestrator_phase = 'pending', orchestrator_owner_token = NULL, updated_at = ? WHERE run_id = ? AND orchestrator_phase = 'idle'")
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
  if (workerIdentityAlive(attempt)) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (finishing owner alive)`);
    return;
  }

  // Terminate-and-confirm, then transfer ownership to a recovery owner.
  await killRecordedGroup(attempt.worker_process_group);
  const newToken = store.transferFinishingOwner({
    runId: run.run_id,
    nodeId: attempt.node_id,
    attempt: attempt.attempt,
    priorOwnerToken: attempt.owner_token!,
    now: clock.now(),
  });
  if (!newToken) {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (transfer lost)`);
    return;
  }

  // Verify the receipt — or idempotently perform the missing merge — then
  // finalize from durable evidence without rerunning the node.
  let receipt = verifyMergeReceipt({ runDir: run.run_dir, nodeId: attempt.node_id, attempt: attempt.attempt });
  if (!receipt) {
    const packetFile = packetPath(run.run_dir, attempt.node_id, attempt.attempt);
    try {
      validatePacket(packetFile, attempt.node_id, attempt.attempt, bundle.chain.next.get(attempt.node_id) ?? null);
    } catch (e) {
      if (!(e instanceof WorklogIntegrityError)) throw e;
      // The packet cannot be trusted for merge: fail as worklog_integrity
      // and let the orchestrator judge.
      store.failAttempt({
        runId: run.run_id,
        nodeId: attempt.node_id,
        attempt: attempt.attempt,
        ownerToken: null,
        failureKind: "worklog_integrity",
        now: clock.now(),
      });
      return;
    }
    receipt = mergePacket({
      runDir: run.run_dir,
      runId: run.run_id,
      nodeId: attempt.node_id,
      attempt: attempt.attempt,
      successorId: bundle.chain.next.get(attempt.node_id) ?? null,
      ownerToken: newToken,
      now: clock.now(),
    });
  }

  // Node output from the packet — durable evidence, never a rerun.
  const packetFile = packetPath(run.run_dir, attempt.node_id, attempt.attempt);
  const packet = readFileSync(packetFile, "utf8");
  const usesWorkflowOutput = packet.includes("<workflow-output>");
  const opening = usesWorkflowOutput ? "<workflow-output>" : /<next-node-output id="[^"]*">/.exec(packet)?.[0] ?? "";
  const closing = usesWorkflowOutput ? "</workflow-output>" : "</next-node-output>";
  let output = extractMarker(packet, opening, closing);
  if (output.trim() === "") output = packet;
  const logsDir = join(run.run_dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const outputFile = join(logsDir, `${attempt.node_id}-attempt-${attempt.attempt}.output`);
  writeFileSync(outputFile, output, "utf8");

  const successorId = bundle.chain.next.get(attempt.node_id) ?? null;
  const successor = successorId
    ? (() => {
        const resolved = resolveNode(bundle.def, successorId, inst);
        return {
          nodeId: successorId,
          packetPath: packetPath(run.run_dir, successorId, 1),
          resolvedMaxAttempts: resolved.maxAttempts,
          resolvedTimeoutMs: resolved.timeoutMs,
        };
      })()
    : null;
  try {
    store.completeAttempt({
      runId: run.run_id,
      nodeId: attempt.node_id,
      attempt: attempt.attempt,
      ownerToken: newToken,
      nodeOutputPath: outputFile,
      validatorStatus: attempt.validator_status,
      validatorReason: attempt.validator_reason,
      now: clock.now(),
      successor,
    });
    report.finishingRecovered.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt}`);
  } catch {
    report.skipped.push(`${run.run_id}/${attempt.node_id} #${attempt.attempt} (completion guard rejected)`);
  }
}

/**
 * Wrapper identity check — the claimer that collects evidence. The harness
 * child being alive is irrelevant once its wrapper is gone: nobody will
 * collect its result. Pid liveness plus matching process-start identity.
 */
function workerIdentityAlive(attempt: AttemptRow): boolean {
  const pid = attempt.wrapper_pid ?? attempt.worker_pid;
  const startId = attempt.wrapper_process_start_id ?? attempt.worker_process_start_id;
  if (pid === null) return false;
  if (!isProcessAlive(pid)) return false;
  if (!startId) return true; // identity unknown; assume alive
  return processStartId(pid) === startId;
}

function orchestratorOwnerDead(run: RunRow): boolean {
  if (run.orchestrator_worker_pid === null) return true;
  return !isProcessAlive(run.orchestrator_worker_pid);
}

async function killRecordedGroup(pgid: number | null): Promise<void> {
  if (pgid === null) return;
  await terminateProcessGroup(pgid);
}

/** True when the run row is beyond help. */
export function runIsTerminal(run: RunRow): boolean {
  return isTerminal(run.status);
}
