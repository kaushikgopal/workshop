import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "../config.js";
import type { NodeDefinition, WorkflowDefinition } from "../definition/schema.js";
import { resolveAgent, type AgentResolution, type ChainInfo, type ParsedModel } from "../definition/validate.js";
import { parseTimeout } from "../util/duration.js";
import { type Clock } from "../util/clock.js";
import type { BlockKind, FailureKind, RunRow, Store } from "../store/store.js";
import { CapacityRejected, GuardRejected } from "../store/store.js";
import {
  WorklogIntegrityError,
  atomicWriteFileSync,
  fsyncFileSync,
  attemptFolderOfPacket,
  authorizedMarker,
  extractMarker as extractMarkerText,
  mergePacket,
  packetPath,
  packetTemplate,
  scaffoldPacket,
  validatePacket,
  worklogFingerprint,
  RunLock,
} from "../worklog/worklog.js";
import { attemptEnv, renderAgentPrompt } from "./env.js";
import { spawnTracked, type TrackedProcess } from "./spawn.js";
import { capStreams, parseByteSize, type StreamCap } from "../util/retention.js";

/**
 * The attempt runner. One execution of one node:
 * claim → spawn → monitor → durable evidence → owner-fenced finishing →
 * run-lock merge → guarded completion with successor creation.
 */

const HEARTBEAT_MS = 5000;

export type NodeRun =
  | { kind: "command"; command: string }
  | { kind: "agent"; agent: { harness?: { command: string }; model?: string; instructions: string }; resolution: AgentResolution };

export type NodeValidator =
  | { kind: "command"; command: string; timeoutMs: number | null }
  | { kind: "agent"; agent: { harness?: { command: string }; model?: string; instructions: string }; resolution: AgentResolution; timeoutMs: number | null };

export interface NodeResolved {
  maxAttempts: number;
  timeoutMs: number | null; // null = unlimited
  streamCapBytes: StreamCap;
  run: NodeRun;
  validator: NodeValidator | null;
}

/** Resolve one node's bounds and execution union. */
export function resolveNode(
  def: WorkflowDefinition,
  nodeId: string,
  inst: { defaultTimeoutMs: number; streamCapBytes: StreamCap; machineAgent: { harness?: { command: string }; model?: string } | undefined },
): NodeResolved {
  const node: NodeDefinition = def.nodes[nodeId]!;
  if (!node) throw new Error(`no node "${nodeId}" in definition`);
  const maxAttempts = node.max_attempts ?? def.defaults?.max_attempts ?? 2;

  const timeout = parseTimeout(node.timeout);
  const defaultTimeout = def.defaults?.timeout ? parseTimeout(def.defaults.timeout) : null;
  let timeoutMs: number | null;
  if (timeout.kind === "unlimited") {
    timeoutMs = null;
  } else if (timeout.ms >= 0) {
    timeoutMs = timeout.ms;
  } else if (defaultTimeout && defaultTimeout.kind === "limited" && defaultTimeout.ms >= 0) {
    timeoutMs = defaultTimeout.ms;
  } else if (defaultTimeout?.kind === "unlimited") {
    timeoutMs = null;
  } else {
    timeoutMs = inst.defaultTimeoutMs;
  }

  let run: NodeRun;
  if ("command" in node.run) {
    run = { kind: "command", command: node.run.command };
  } else {
    const agent = node.run.agent;
    const resolution = resolveAgent({ node: agent, workflowDefault: def.defaults?.agent, machine: inst.machineAgent });
    run = { kind: "agent", agent, resolution };
  }

  let validator: NodeValidator | null = null;
  if (node.validator) {
    if ("command" in node.validator) {
      const vt = node.validator.timeout ? parseTimeout(node.validator.timeout) : null;
      validator = {
        kind: "command",
        command: node.validator.command,
        timeoutMs: vt ? (vt.kind === "unlimited" ? null : vt.ms) : inst.defaultTimeoutMs,
      };
    } else {
      const agent = node.validator.agent;
      const resolution = resolveAgent({ node: agent, workflowDefault: def.defaults?.agent, machine: inst.machineAgent });
      const vt = node.validator.timeout ? parseTimeout(node.validator.timeout) : null;
      validator = {
        kind: "agent",
        agent,
        resolution,
        timeoutMs: vt ? (vt.kind === "unlimited" ? null : vt.ms) : inst.defaultTimeoutMs,
      };
    }
  }

  return { maxAttempts, timeoutMs, streamCapBytes: node.stream_cap ? parseByteSize(node.stream_cap) : inst.streamCapBytes, run, validator };
}

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
  const folder = attemptFolderOfPacket(attempt.packet_path);
  const packetFile = packetPath(folder);

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
        ownerToken,
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
      validatorOutcome = await runValidator({
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
        attemptFolder: folder, successorId, ownerToken, now: now(),
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
    // Scaffold the persisted successor's packet from its own row.
    if (successorId) {
      const row = store.getAttempt(run.run_id, successorId, 1)!;
      scaffoldPacket(attemptFolderOfPacket(row.packet_path), row.attempt, chain.next.get(successorId) ?? null);
    }

    return { status: "completed" };
  } finally {
    stopHeartbeat();
  }
}

async function raceDeadline(
  proc: TrackedProcess,
  timeoutMs: number | null,
): Promise<{ kind: "exit"; exit: { code: number | null; signal: NodeJS.Signals | null } } | { kind: "timeout" }> {
  if (timeoutMs === null) return { kind: "exit", exit: await proc.exit };
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const exit = await Promise.race([proc.exit.then((e) => ({ kind: "exit" as const, exit: e })), timer]);
    return exit === "timeout" ? { kind: "timeout" } : exit;
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Node output for handoff and validation: command stdout, or the agent's
 * marker content; an empty agent marker falls back to the complete packet.
 */
export function extractNodeOutput(
  kind: "command" | "agent",
  packetFile: string,
  stdoutFile: string,
): string | null {
  const packet = readFileSync(packetFile, "utf8");
  if (kind === "command") {
    return readFileSync(stdoutFile, "utf8");
  }
  const usesWorkflowOutput = packet.includes("<workflow-output>");
  const marker = usesWorkflowOutput
    ? { opening: "<workflow-output>", closing: "</workflow-output>" }
    : /<next-node-output id="[^"]*">/.exec(packet)?.[0]
      ? { opening: /<next-node-output id="[^"]*">/.exec(packet)![0], closing: "</next-node-output>" }
      : null;
  if (marker === null) return null;
  const content = extractMarkerText(packet, marker.opening, marker.closing);
  return content.trim() === "" ? packet : content;
}

/** Fill a command node's packet deterministically — the runtime writes it. */
export function fillCommandPacket(input: {
  packetFile: string;
  attempt: number;
  exitCode: number | null;
  stdoutFile: string;
  validatorLine: string;
  marker: { opening: string; closing: string };
}): void {
  const stdout = existsSync(input.stdoutFile) ? readFileSync(input.stdoutFile, "utf8") : "";
  const content = `#### Attempt ${input.attempt}

##### Progress

Command completed with exit code ${input.exitCode ?? "null"}.

##### Decisions

Deterministic command node; no model decisions.

##### Validation

${input.validatorLine}

##### Blockers

None.

${input.marker.opening}
${stdout.trimEnd()}
${input.marker.closing}
`;
  atomicWriteFileSync(input.packetFile, content);
}

/**
 * The normalized validator record both validator kinds converge on: command
 * validators record their exit-code verdict, agent validators the verdict
 * parsed from their validation.json. Atomic and durable (S9).
 */
function writeValidatorRecord(
  validationDir: string,
  record: { kind: "command" | "agent"; status: "passed" | "failed"; reason: string },
): void {
  atomicWriteFileSync(join(validationDir, "validator-record.json"), JSON.stringify({ version: 1, ...record }, null, 2) + "\n");
}

/**
 * Discriminated validator result. A timeout is machinery, not judgment: it is
 * typed `timeout` (spec §10), never a `validator_rejection`.
 */
type ValidatorOutcome =
  | { outcome: "passed"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "timeout"; reason: string }
  | { outcome: "unconfirmed"; reason: string };

async function runValidator(input: {
  store: Store;
  ownerToken: string;
  clock: Clock;
  inst: Installation;
  run: RunRow;
  nodeId: string;
  validator: NodeValidator;
  attemptFolder: string;
  attemptNo: number;
  packetFile: string;
  outputFile: string;
  stdoutFile: string;
  stderrFile: string;
  cliPath: string;
}): Promise<ValidatorOutcome> {
  const validationDir = join(input.attemptFolder, "validation");
  mkdirSync(validationDir, { recursive: true });
  const validationFile = join(validationDir, "validation.json");
  const validationStdout = join(validationDir, "stdout");
  const validationStderr = join(validationDir, "stderr");
  const normalized = (outcome: "passed" | "rejected", reason: string): ValidatorOutcome => {
    // The runtime-owned normalized verdict: durable evidence both validator
    // kinds converge on (command exit code, or the parsed validation.json).
    writeValidatorRecord(validationDir, {
      kind: input.validator.kind,
      status: outcome === "passed" ? "passed" : "failed",
      reason,
    });
    return { outcome, reason };
  };

  const model = input.validator.kind === "agent" ? input.validator.resolution.model : null;
  if (
    input.validator.kind === "agent" &&
    (!input.validator.resolution.harnessCommand || !input.validator.resolution.model)
  ) {
    return normalized("rejected", "validator agent harness/model unresolved");
  }

  const env = attemptEnv({
    logPath: input.run.worklog_path,
    runId: input.run.run_id,
    nodeId: input.nodeId,
    attempt: input.attemptNo,
    promptFile: null,
    nodeOutputFile: input.outputFile,
    previousOutputFile: null,
    packetFile: input.packetFile,
    stdoutFile: input.stdoutFile,
    stderrFile: input.stderrFile,
    ownerToken: "validator-not-an-owner",
    validationFile,
    model,
    cliPath: input.cliPath,
  });

  let command: string;
  if (input.validator.kind === "command") {
    command = input.validator.command;
  } else {
    const promptFile = join(validationDir, "prompt.md");
    atomicWriteFileSync(
      promptFile,
      renderValidatorPrompt(input.nodeId, input.validator.agent.instructions, {
        packetFile: input.packetFile, outputFile: input.outputFile,
        logPath: input.run.worklog_path, validationFile,
      }),
    );
    env.WORKSHOP_PROMPT_FILE = promptFile;
    command = input.validator.resolution.harnessCommand!;
  }

  const proc = spawnTracked({
    shell: input.inst.shell,
    command,
    cwd: input.inst.projectDir,
    env,
    stdoutFile: validationStdout,
    stderrFile: validationStderr,
  });
  input.store.recordValidatorIdentity({
    runId: input.run.run_id, nodeId: input.nodeId, attempt: input.attemptNo, ownerToken: input.ownerToken,
    childPid: proc.pid, childStartId: proc.startId, childPgid: proc.pgid, now: input.clock.now(),
  });


  const retire = async (): Promise<boolean> => {
    const confirmed = await proc.kill();
    if (!confirmed) return false;
    if (existsSync(validationStdout)) fsyncFileSync(validationStdout);
    if (existsSync(validationStderr)) fsyncFileSync(validationStderr);
    const cleared = input.store.clearAttemptProcessIdentity({
      runId: input.run.run_id, nodeId: input.nodeId, attempt: input.attemptNo, ownerToken: input.ownerToken,
      role: "validator", pid: proc.pid, startId: proc.startId, pgid: proc.pgid, now: input.clock.now(),
    });
    return cleared || input.store.getAttempt(input.run.run_id, input.nodeId, input.attemptNo)?.validator_process_group === null;
  };

  const exitOrTimeout = await raceDeadline(proc, input.validator.timeoutMs);
  if (exitOrTimeout.kind === "timeout") {
    if (!(await retire())) {
      return { outcome: "unconfirmed", reason: "validator timed out and group death could not be confirmed" };
    }
    return { outcome: "timeout", reason: `validator timed out after ${input.validator.timeoutMs}ms` };
  }
  const { code } = exitOrTimeout.exit;
  if (!(await retire())) {
    return { outcome: "unconfirmed", reason: "validator leader exited but surviving group members remain" };
  }

  if (input.validator.kind === "command") {
    return code === 0
      ? normalized("passed", "command validator exited 0")
      : normalized("rejected", `command validator exited ${code ?? "null"}`);
  }

  // The agent wrote this file externally. Flush it before parsing or deriving
  // the runtime-owned normalized validator record.
  if (!existsSync(validationFile)) {
    return normalized("rejected", `validator wrote no validation.json (exit ${code ?? "null"})`);
  }
  fsyncFileSync(validationFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(validationFile, "utf8"));
  } catch (e) {
    return normalized("rejected", `validation.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = parsed as { passed?: unknown; reason?: unknown };
  if (typeof result.passed !== "boolean") {
    return normalized("rejected", "validation.json has no boolean 'passed'");
  }
  const reason = typeof result.reason === "string" ? result.reason : "";
  return result.passed
    ? normalized("passed", reason || "validator passed")
    : normalized("rejected", reason || "validator failed without a reason");
}

function renderValidatorPrompt(
  nodeId: string,
  instructions: string,
  ctx: { packetFile: string; outputFile: string; logPath: string; validationFile: string },
): string {
  return `# Workshop validator

You are a fresh validator for node ${nodeId}. Judge only what the instructions say.

## Instructions

${instructions}

## Evidence

- Attempt packet: ${ctx.packetFile}
- Marked node output: ${ctx.outputFile}
- Worklog: ${ctx.logPath}

## Output contract

Write exactly one JSON object to ${ctx.validationFile}:

{"passed": true, "reason": "<short reason>"}

Missing or invalid validation output counts as failure.
`;
}

export function blockKindFor(kind: string): BlockKind | null {
  const valid: BlockKind[] = [
    "agent_requested",
    "preflight",
    "orchestrator",
    "orchestrator_unresolved",
    "unknown_external",
    "operator",
  ];
  return valid.includes(kind as BlockKind) ? (kind as BlockKind) : null;
}
