import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "../load-installation.js";
import type { WorkflowDefinition } from "../definition/schema.js";
import { type ChainInfo } from "../definition/check-chain.js";
import { type ParsedModel } from "../definition/parse-model.js";
import { type Clock } from "../util/clock.js";
import type { FailureKind, RunRow, Store } from "../storage/db/store.js";
import { CapacityRejected, GuardRejected } from "../storage/db/store.js";
import { capStreams } from "../storage/disk/cap-streams.js";
import { worklogFingerprint } from "../worklog/detect-tampering.js";
import { WorklogIntegrityError } from "../worklog/detect-tampering.js";
import { locatePacket } from "../storage/disk/locate-run-files.js";
import { attemptDirOfPacket } from "../storage/disk/locate-run-files.js";
import { atomicWriteFileSync, fsyncFileSync } from "../storage/disk/write-crash-safe.js";
import { authorizedMarker } from "../worklog/apply-marker-rules.js";
import { extractNodeOutput, validatePacket } from "../worklog/check-packet.js";
import { mergePacket } from "../worklog/merge-packet.js";
import { fillCommandPacket, scaffoldPacket } from "../worklog/prepare-packet.js";
import { packetTemplate } from "../worklog/prepare-packet.js";
import { RunLock } from "../storage/disk/lock-run.js";
import { attemptEnv } from "./build-attempt-env.js";
import { renderAgentPrompt } from "./render-agent-prompt.js";
import { raceDeadline, spawnTracked, type TrackedProcess } from "../process/launch-process.js";
import { resolveNode } from "../definition/resolve-node-settings.js";
import { judgeOutput, type ValidatorOutcome } from "./judge-output.js";

/**
 * The attempt runner. One execution of one node:
 * claim → spawn → monitor → durable evidence → owner-fenced finishing →
 * run-lock merge → guarded completion with successor creation.
 */
const HEARTBEAT_MS = 5000;

export interface AttemptOutcome {
  status: "completed" | "failed" | "blocked" | "cancelled";
  failureKind?: FailureKind;
  detail?: string;
}

export interface AttemptPaths {
  stdoutFile: string;
  stderrFile: string;
  outputFile: string;
  promptFile: string;
}

function attemptPaths(attemptFolder: string): AttemptPaths {
  mkdirSync(attemptFolder, { recursive: true });
  return {
    stdoutFile: join(attemptFolder, "stdout"),
    stderrFile: join(attemptFolder, "stderr"),
    outputFile: join(attemptFolder, "output"),
    promptFile: join(attemptFolder, "prompt"),
  };
}

/** Execute one attempt of one node. The attempt row must exist as pending. */
export async function executeAttempt(input: {
  store: Store;
  inst: Installation;
  def: WorkflowDefinition;
  chain: ChainInfo;
  run: RunRow;
  nodeId: string;
  attemptNo: number;
  previousOutputFile: string | null;
  clock: Clock;
  cliPath: string;
}): Promise<AttemptOutcome> {
  const { store, inst, def, chain, run, nodeId, attemptNo, clock } = input;
  const resolved = resolveNode(def, nodeId, inst);
  const attempt = store.getAttempt(run.run_id, nodeId, attemptNo);
  if (!attempt) throw new Error(`attempt row missing for ${nodeId} #${attemptNo}`);

  const successorId = chain.next.get(nodeId) ?? null;
  const now = () => clock.now();
  // The row's persisted packet_path is authoritative: new rows point at the
  // ordered-node layout, legacy rows at their original attempts/ folder. The
  // packet below repairs in place at the stored path — nothing is re-derived
  // or moved.
  const folder = attemptDirOfPacket(attempt.packet_path);
  const packetFile = locatePacket(folder);

  // Serialize pristine packet verification with the claim. A losing launcher
  // re-reads the row under this lock and never inspects a winner's live packet.
  let ownerToken: string;
  const preparationLock = new RunLock(run.run_dir);
  preparationLock.acquireSync();
  try {
    const fresh = store.getAttempt(run.run_id, nodeId, attemptNo);
    if (!fresh || fresh.status !== "pending") {
      return { status: "cancelled", detail: "attempt is no longer pending" };
    }
    try {
      // Repairs row→file crash gaps for first, successor, and retry attempts.
      // Exact existing evidence is accepted; any mismatch is preserved.
      scaffoldPacket(folder, fresh.attempt, successorId);
    } catch (e) {
      if (!(e instanceof WorklogIntegrityError)) throw e;
      store.failPendingPacketIntegrity({ runId: run.run_id, nodeId, attempt: attemptNo, error: e.message, now: now() });
      return { status: "cancelled", detail: e.message };
    }

    try {
      const claim = store.claimAttempt({
        runId: run.run_id,
        nodeId,
        attempt: attemptNo,
        now: now(),
        maxConcurrentRuns: inst.maxConcurrentRuns,
      });
      ownerToken = claim.ownerToken;
    } catch (e) {
      if (e instanceof CapacityRejected) return { status: "cancelled", detail: e.message };
      if (e instanceof GuardRejected) return { status: "cancelled", detail: `claim lost: ${e.message}` };
      throw e;
    }
  } finally {
    preparationLock.release();
  }
  const paths = attemptPaths(folder);
  const model: ParsedModel | null = resolved.run.kind === "agent" ? resolved.run.resolution.model : null;
  const env = attemptEnv({
    logPath: run.worklog_path,
    runId: run.run_id,
    nodeId,
    attempt: attemptNo,
    promptFile: paths.promptFile,
    nodeOutputFile: paths.outputFile,
    previousOutputFile: input.previousOutputFile,
    packetFile,
    stdoutFile: paths.stdoutFile,
    stderrFile: paths.stderrFile,
    ownerToken,
    validationFile: null,
    model,
    cliPath: input.cliPath,
  });

  // Before any agent work: fingerprint the worklog to detect tampering.
  const fingerprintBefore = resolved.run.kind === "agent" ? worklogFingerprint(run.run_dir) : null;

  let proc: TrackedProcess | null = null;
  let lastExitCode: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const retireWorker = async (active: TrackedProcess): Promise<boolean> => {
    const confirmed = await active.kill();
    if (!confirmed) return false;
    // Process-owned streams are evidence too. Flush them only after every
    // group member is gone and no writer can mutate the files.
    if (existsSync(paths.stdoutFile)) fsyncFileSync(paths.stdoutFile);
    if (existsSync(paths.stderrFile)) fsyncFileSync(paths.stderrFile);
    const cleared = store.clearAttemptProcessIdentity({
      runId: run.run_id, nodeId, attempt: attemptNo, ownerToken, role: "worker",
      pid: active.pid, startId: active.startId, pgid: active.pgid, now: now(),
    });
    if (cleared) return true;
    // Stop/recovery may have cleared the exact identity after independently
    // confirming death. That is safe; a replacement group is not.
    return store.getAttempt(run.run_id, nodeId, attemptNo)?.worker_process_group === null;
  };

  /**
   * Bound the raw capture once every reader is done with it. Command nodes
   * consume stdout to build their packet and their extracted output, so this
   * runs only at a terminal transition — never while evidence is still being
   * derived from the stream. Death must already be confirmed: capping a stream
   * whose writer may still be alive would truncate a live process's output.
   */
  const capAttemptStreams = (): void => {
    capStreams(
      [
        paths.stdoutFile,
        paths.stderrFile,
        join(folder, "validation", "stdout"),
        join(folder, "validation", "stderr"),
      ],
      resolved.streamCapBytes,
      now(),
    );
  };

  const fail = async (failureKind: FailureKind, detail: string, validatorReason?: string | null): Promise<AttemptOutcome> => {
    stopHeartbeat();
    if (proc) {
      const active = proc;
      if (!(await retireWorker(active))) {
        return { status: "cancelled", detail: `${detail}; process-group death was not confirmed` };
      }
      proc = null;
    }
    try {
      const result = store.failAttempt({
        runId: run.run_id, nodeId, attempt: attemptNo, ownerToken, failureKind,
        validatorReason: validatorReason ?? null, now: now(),
      });
      if (!result.failed) return { status: "cancelled", detail: "attempt already left running state" };
      await mergeFailureEvidence(failureKind);
      capAttemptStreams();
      return { status: "failed", failureKind, detail };
    } catch (e) {
      if (e instanceof GuardRejected) return { status: "cancelled", detail: `lost ownership: ${e.message}` };
      throw e;
    }
  };

  /**
   * Failed attempts are immutable evidence too: their packets merge into the
   * worklog when the agent actually wrote something. Untouched scaffolds
   * (timeouts, dead processes) leave no empty sections behind.
   */
  const mergeFailureEvidence = async (failureKind: FailureKind): Promise<void> => {
    const marker = authorizedMarker(successorId);
    let packet: string;
    try {
      packet = readFileSync(packetFile, "utf8");
    } catch {
      return; // no packet evidence to merge
    }
    if (packet === packetTemplate(attemptNo, marker)) return;
    if (resolved.run.kind === "command") {
      fillCommandPacket({
        packetFile,
        attempt: attemptNo,
        exitCode: lastExitCode,
        stdoutFile: paths.stdoutFile,
        validatorLine: `Attempt failed (${failureKind}) before validation.`,
        marker,
      });
    }
    try {
      validatePacket(packetFile, nodeId, attemptNo, successorId);
    } catch (e) {
      if (e instanceof WorklogIntegrityError) return; // tampered packet stays unmerged
      throw e;
    }
    const lock = new RunLock(run.run_dir);
    await lock.acquire();
    try {
      mergePacket({
        runDir: run.run_dir,
        runId: run.run_id,
        nodeId,
        attempt: attemptNo,
        attemptFolder: folder,
        successorId,
        now: now(),
      });
    } catch (e) {
      if (!(e instanceof WorklogIntegrityError)) throw e;
    } finally {
      lock.release();
    }
  };
  try {
    writeFileSync(paths.promptFile, resolved.run.kind === "command" ? "(command node — no prompt)\n" : "", "utf8");
    let command: string;
    if (resolved.run.kind === "command") {
      command = resolved.run.command;
    } else {
      const resolution = resolved.run.resolution;
      if (!resolution.harnessCommand || !resolution.model) {
        return await fail("process_error", "agent harness/model unresolved");
      }
      writeFileSync(
        paths.promptFile,
        renderAgentPrompt({
          workflowId: run.workflow_id,
          runId: run.run_id,
          nodeId,
          attempt: attemptNo,
          instructions: resolved.run.agent.instructions,
          logPath: run.worklog_path,
          packetFile,
          previousOutputFile: input.previousOutputFile,
          successorId,
        }),
        "utf8",
      );
      command = resolution.harnessCommand;
    }

    // Provenance under owner fencing before execution (spec §5/§11): persist
    // the unexpanded template, the exact command, and the resolved model.
    if (
      !store.recordResolvedExecution({
        runId: run.run_id,
        nodeId,
        attempt: attemptNo,
        ownerToken,
        harnessTemplate:
          resolved.run.kind === "command" ? resolved.run.command : (resolved.run.resolution.harnessTemplate ?? command),
        harnessCommand: command,
        model: resolved.run.kind === "agent" ? (resolved.run.resolution.model?.full ?? null) : null,
        now: now(),
      })
    ) {
      return { status: "cancelled", detail: "lost ownership before execution" };
    }

    // Spawn directly, detached; record the child identity immediately after
    // spawn (the accepted POC boundary — no pre-exec gate).
    proc = spawnTracked({
      shell: inst.shell,
      command,
      cwd: inst.projectDir,
      env,
      stdoutFile: paths.stdoutFile,
      stderrFile: paths.stderrFile,
    });
    store.recordChildIdentity({
      runId: run.run_id, nodeId, attempt: attemptNo, ownerToken,
      childPid: proc.pid, childStartId: proc.startId, childPgid: proc.pgid, now: now(),
    });

    heartbeat = setInterval(() => {
      try {
        const runRow = store.getRun(run.run_id);
        if (runRow?.desired_state === "stopped") {
          void proc?.kill();
          return;
        }
        // An agent-requested block asks the runner to terminate the group.
        const attemptRow = store.getAttempt(run.run_id, nodeId, attemptNo);
        if (attemptRow && attemptRow.status !== "running") {
          void proc?.kill();
          return;
        }
        store.heartbeat({ runId: run.run_id, nodeId, attempt: attemptNo, ownerToken, now: now() });
      } catch {
        /* heartbeat is advisory */
      }
    }, HEARTBEAT_MS);

    const exitOrTimeout = await raceDeadline(proc, resolved.timeoutMs);
    if (exitOrTimeout.kind === "timeout") {
      return await fail("timeout", `deadline exceeded (${resolved.timeoutMs}ms)`);
    }
    stopHeartbeat();
    const { code, signal } = exitOrTimeout.exit;
    lastExitCode = code;
    const exited = proc;
    if (!(await retireWorker(exited))) {
      return {
        status: "cancelled",
        detail: "harness leader exited but surviving process-group members could not be confirmed dead",
      };
    }
    proc = null;

    // Stop intent remains protected until all recorded groups are dead.
    const runAfter = store.getRun(run.run_id)!;
    if (runAfter.desired_state === "stopped") {
      store.finalizeStoppedRun({ runId: run.run_id, now: now() });
      return { status: "cancelled" };
    }

    if (code !== 0 || signal !== null) {
      return await fail("process_error", `harness exited with code ${code ?? "null"} signal ${signal ?? "none"}`);
    }

    // Agent integrity: worklog untouched, packet well-formed.
    if (resolved.run.kind === "agent") {
      if (fingerprintBefore && worklogFingerprint(run.run_dir) !== fingerprintBefore) {
        return await fail("worklog_integrity", "the worklog changed during the attempt");
      }
      try {
        validatePacket(packetFile, nodeId, attemptNo, successorId);
      } catch (e) {
        if (e instanceof WorklogIntegrityError) return await fail("worklog_integrity", e.message);
        throw e;
      }
    }

    // Durable evidence first. Externally written packet bytes are fsynced;
    // runtime-owned packet/output records use atomic write+fsync+rename.
    if (resolved.run.kind === "command") {
      fillCommandPacket({
        packetFile, attempt: attemptNo, exitCode: code, stdoutFile: paths.stdoutFile,
        validatorLine: "pending", marker: authorizedMarker(successorId),
      });
    } else {
      fsyncFileSync(packetFile); // the agent wrote the packet externally
    }
    const output = extractNodeOutput(resolved.run.kind, packetFile, paths.stdoutFile);
    if (output === null) {
      return await fail("worklog_integrity", `authorized marker missing from packet for ${nodeId} #${attemptNo}`);
    }
    atomicWriteFileSync(paths.outputFile, output);

    let validatorOutcome: ValidatorOutcome | null = null;
    if (resolved.validator) {
      validatorOutcome = await judgeOutput({
        store, ownerToken, clock, inst, run, nodeId, validator: resolved.validator,
        attemptFolder: folder, attemptNo, packetFile, outputFile: paths.outputFile,
        stdoutFile: paths.stdoutFile, stderrFile: paths.stderrFile, cliPath: input.cliPath,
      });
      if (validatorOutcome.outcome === "unconfirmed") {
        return { status: "cancelled", detail: validatorOutcome.reason };
      }
      if (validatorOutcome.outcome === "timeout") {
        return await fail("timeout", validatorOutcome.reason, validatorOutcome.reason);
      }
      if (validatorOutcome.outcome === "rejected") {
        return await fail("validator_rejection", validatorOutcome.reason, validatorOutcome.reason);
      }
      if (resolved.run.kind === "command") {
        fillCommandPacket({
          packetFile, attempt: attemptNo, exitCode: code, stdoutFile: paths.stdoutFile,
          validatorLine: `Validator passed: ${validatorOutcome.reason}`, marker: authorizedMarker(successorId),
        });
      }
    }

    // Owner-fenced finishing: evidence is durable and flushed; the merge is
    // fenced next. Every reader has consumed the raw streams by here.
    capAttemptStreams();
    try {
      store.claimFinishing({
        runId: run.run_id, nodeId, attempt: attemptNo, ownerToken,
        nodeOutputPath: paths.outputFile,
        validatorStatus: resolved.validator ? "passed" : null,
        validatorReason: resolved.validator ? (validatorOutcome?.reason ?? "validator passed") : null,
        now: now(),
      });
    } catch (e) {
      if (e instanceof GuardRejected) return { status: "cancelled", detail: e.message };
      throw e;
    }

    let successor: {
      nodeId: string; resolvedMaxAttempts: number; resolvedTimeoutMs: number | null; chainPosition: number;
    } | null = null;
    if (successorId) {
      const succResolved = resolveNode(def, successorId, inst);
      successor = {
        nodeId: successorId, resolvedMaxAttempts: succResolved.maxAttempts,
        resolvedTimeoutMs: succResolved.timeoutMs, chainPosition: chain.order.indexOf(successorId),
      };
    }

    // Merge under the run lock; the marked-block receipt makes it idempotent.
    const lock = new RunLock(run.run_dir);
    try {
      await lock.acquire();
      mergePacket({
        runDir: run.run_dir, runId: run.run_id, nodeId, attempt: attemptNo,
        attemptFolder: folder, successorId, now: now(),
      });
    } catch (e) {
      if (e instanceof WorklogIntegrityError) return await fail("worklog_integrity", e.message);
      throw e;
    } finally {
      lock.release();
    }

    // Guarded completion + persisted successor (one transaction).
    try {
      store.completeAttempt({ runId: run.run_id, nodeId, attempt: attemptNo, ownerToken, now: now(), successor });
    } catch (e) {
      if (e instanceof GuardRejected) return { status: "cancelled", detail: e.message };
      throw e;
    }
    // Scaffold the persisted successor's packet from its own row. A run paused
    // mid-attempt has no successor row: `completeAttempt` withholds it on
    // purpose, and `resume` recreates it from the snapshot. So the row is
    // genuinely optional here — asserting it away crashed the runner on the
    // documented pause path, after the completion had already been committed.
    if (successorId) {
      const row = store.getAttempt(run.run_id, successorId, 1);
      if (row) {
        scaffoldPacket(attemptDirOfPacket(row.packet_path), row.attempt, chain.next.get(successorId) ?? null);
      }
    }

    return { status: "completed" };
  } finally {
    stopHeartbeat();
  }
}

