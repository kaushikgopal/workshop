import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "../config.js";
import type { NodeDefinition, WorkflowDefinition } from "../definition/schema.js";
import { resolveAgent, type AgentResolution, type ChainInfo, type ParsedModel } from "../definition/validate.js";
import { parseTimeout } from "../util/duration.js";
import { toIso, type Clock } from "../util/clock.js";
import { isProcessAlive, terminateProcessGroup } from "../util/process.js";
import type { AttemptRow, BlockKind, FailureKind, RunRow, Store } from "../store/store.js";
import { GuardRejected } from "../store/store.js";
import {
  WorklogIntegrityError,
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
  run: NodeRun;
  validator: NodeValidator | null;
}

/** Resolve one node's bounds and execution union. */
export function resolveNode(
  def: WorkflowDefinition,
  nodeId: string,
  inst: { defaultTimeoutMs: number; machineAgent: { harness?: { command: string }; model?: string } | undefined },
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

  return { maxAttempts, timeoutMs, run, validator };
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

export function attemptPaths(runDir: string, nodeId: string, attempt: number): AttemptPaths {
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  return {
    stdoutFile: join(logsDir, `${nodeId}-attempt-${attempt}.stdout`),
    stderrFile: join(logsDir, `${nodeId}-attempt-${attempt}.stderr`),
    outputFile: join(logsDir, `${nodeId}-attempt-${attempt}.output`),
    promptFile: join(logsDir, `${nodeId}-attempt-${attempt}.prompt`),
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
  const paths = attemptPaths(run.run_dir, nodeId, attemptNo);
  const packetFile = packetPath(run.run_dir, nodeId, attemptNo);

  // Claim: CAS pending → running with our identity. Losers never spawn.
  let ownerToken: string;
  try {
    const claim = store.claimAttempt({ runId: run.run_id, nodeId, attempt: attemptNo, now: now() });
    ownerToken = claim.ownerToken;
  } catch (e) {
    if (e instanceof GuardRejected) return { status: "cancelled", detail: `claim lost: ${e.message}` };
    throw e;
  }

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

  const fail = async (failureKind: FailureKind, detail: string, validatorReason?: string | null): Promise<AttemptOutcome> => {
    stopHeartbeat();
    if (proc) await proc.kill();
    try {
      const result = store.failAttempt({
        runId: run.run_id,
        nodeId,
        attempt: attemptNo,
        ownerToken,
        failureKind,
        validatorReason: validatorReason ?? null,
        now: now(),
      });
      // The CAS loses when a block or stop already ended the attempt; that
      // outcome wins and the run keeps its blocked/cancelled status.
      if (!result.failed) return { status: "cancelled", detail: "attempt already left running state" };
      await mergeFailureEvidence(failureKind);
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
    const marker = authorizedMarker(nodeId, successorId);
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
        }),
        "utf8",
      );
      command = resolution.harnessCommand;
    }

    // Spawn the harness in its own process group; record child identity.
    proc = spawnTracked({
      shell: inst.shell,
      command,
      cwd: inst.projectDir,
      env,
      stdoutFile: paths.stdoutFile,
      stderrFile: paths.stderrFile,
    });
    store.recordChildIdentity({
      runId: run.run_id,
      nodeId,
      attempt: attemptNo,
      ownerToken,
      childPid: proc.pid,
      childStartId: proc.startId,
      childPgid: proc.pgid,
      now: now(),
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
      const confirmed = await proc.kill();
      if (!confirmed) {
        return {
          status: "failed",
          failureKind: "timeout",
          detail: "deadline exceeded and the process group could not be confirmed dead",
        };
      }
      return await fail("timeout", `deadline exceeded (${resolved.timeoutMs}ms)`);
    }
    stopHeartbeat();
    const { code, signal } = exitOrTimeout.exit;
    lastExitCode = code;

    // Durable stop: desired_state stopped cancels the attempt and the run.
    const runAfter = store.getRun(run.run_id)!;
    if (runAfter.desired_state === "stopped") {
      store.cancelAttempt({ runId: run.run_id, nodeId, attempt: attemptNo, now: now() });
      store.setRunStatus(run.run_id, "cancelled", now(), null);
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


    // Durable evidence first: command packets are filled by the runtime; agent
    // packets were written by the agent. The extracted output lands in the
    // output file before validation — validators judge durable evidence.
    if (resolved.run.kind === "command") {
      fillCommandPacket({
        packetFile,
        attempt: attemptNo,
        exitCode: code,
        stdoutFile: paths.stdoutFile,
        validatorLine: "pending",
        marker: authorizedMarker(nodeId, successorId),
      });
    }
    const output = extractNodeOutput(resolved.run.kind, packetFile, paths.stdoutFile);
    if (output === null) {
      return await fail("worklog_integrity", `authorized marker missing from packet for ${nodeId} #${attemptNo}`);
    }
    writeFileSync(paths.outputFile, output, "utf8");

    // Validator: optional internal completion gate.
    let validatorOutcome: { passed: boolean; reason: string } | null = null;
    if (resolved.validator) {
      validatorOutcome = await runValidator({
        inst,
        run,
        validator: resolved.validator,
        nodeId,
        attemptNo,
        packetFile,
        outputFile: paths.outputFile,
        stdoutFile: paths.stdoutFile,
        stderrFile: paths.stderrFile,
        cliPath: input.cliPath,
      });
      if (!validatorOutcome.passed) {
        return await fail("validator_rejection", validatorOutcome.reason, validatorOutcome.reason);
      }
      // Record the passing evidence in the packet before the merge.
      if (resolved.run.kind === "command") {
        fillCommandPacket({
          packetFile,
          attempt: attemptNo,
          exitCode: code,
          stdoutFile: paths.stdoutFile,
          validatorLine: `Validator passed: ${validatorOutcome.reason}`,
          marker: authorizedMarker(nodeId, successorId),
        });
      }
    }
    // Owner-fenced finishing: evidence is durable; the merge is fenced next.
    try {
      store.claimFinishing({ runId: run.run_id, nodeId, attempt: attemptNo, ownerToken, now: now() });
    } catch (e) {
      if (e instanceof GuardRejected) return { status: "cancelled", detail: e.message };
      throw e;
    }

    // Merge under the run lock; the receipt makes it idempotent.
    const lock = new RunLock(run.run_dir);
    try {
      await lock.acquire();
      mergePacket({
        runDir: run.run_dir,
        runId: run.run_id,
        nodeId,
        attempt: attemptNo,
        successorId,
        ownerToken,
        now: now(),
      });
    } catch (e) {
      if (e instanceof WorklogIntegrityError) return await fail("worklog_integrity", e.message);
      throw e;
    } finally {
      lock.release();
    }

    // Guarded completion + persisted successor (one transaction).
    let successor: {
      nodeId: string;
      packetPath: string;
      resolvedMaxAttempts: number;
      resolvedTimeoutMs: number | null;
      chainPosition: number;
    } | null = null;
    if (successorId) {
      const succResolved = resolveNode(def, successorId, inst);
      scaffoldPacket(run.run_dir, successorId, 1, chain.next.get(successorId) ?? null);
      successor = {
        nodeId: successorId,
        packetPath: packetPath(run.run_dir, successorId, 1),
        resolvedMaxAttempts: succResolved.maxAttempts,
        resolvedTimeoutMs: succResolved.timeoutMs,
        chainPosition: chain.order.indexOf(successorId),
      };
    }
    try {
      store.completeAttempt({
        runId: run.run_id,
        nodeId,
        attempt: attemptNo,
        ownerToken,
        nodeOutputPath: paths.outputFile,
        validatorStatus: resolved.validator ? "passed" : null,
        validatorReason: resolved.validator ? (validatorOutcome?.reason ?? "validator passed") : null,
        now: now(),
        successor,
      });
    } catch (e) {
      if (e instanceof GuardRejected) return { status: "cancelled", detail: e.message };
      throw e;
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
  writeFileSync(input.packetFile, content, "utf8");
}

interface ValidatorOutcome {
  passed: boolean;
  reason: string;
}

async function runValidator(input: {
  inst: Installation;
  run: RunRow;
  validator: NodeValidator;
  nodeId: string;
  attemptNo: number;
  packetFile: string;
  outputFile: string;
  stdoutFile: string;
  stderrFile: string;
  cliPath: string;
}): Promise<ValidatorOutcome> {
  const validationDir = join(input.run.run_dir, "validation", `${input.nodeId}-attempt-${input.attemptNo}`);
  mkdirSync(validationDir, { recursive: true });
  const validationFile = join(validationDir, "validation.json");

  const model = input.validator.kind === "agent" ? input.validator.resolution.model : null;
  if (
    input.validator.kind === "agent" &&
    (!input.validator.resolution.harnessCommand || !input.validator.resolution.model)
  ) {
    return { passed: false, reason: "validator agent harness/model unresolved" };
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
    ownerToken: "validator-not-an-owner", // validators never own the attempt
    validationFile,
    model,
    cliPath: input.cliPath,
  });

  let command: string;
  if (input.validator.kind === "command") {
    command = input.validator.command;
  } else {
    const promptFile = join(validationDir, "prompt.md");
    writeFileSync(
      promptFile,
      renderValidatorPrompt(input.nodeId, input.validator.agent.instructions, {
        packetFile: input.packetFile,
        outputFile: input.outputFile,
        logPath: input.run.worklog_path,
        validationFile,
      }),
      "utf8",
    );
    env.WORKSHOP_PROMPT_FILE = promptFile;
    command = input.validator.resolution.harnessCommand!;
  }

  const proc = spawnTracked({
    shell: input.inst.shell,
    command,
    cwd: input.inst.projectDir,
    env,
    stdoutFile: join(validationDir, "stdout"),
    stderrFile: join(validationDir, "stderr"),
  });

  const exitOrTimeout = await raceDeadline(proc, input.validator.timeoutMs);
  if (exitOrTimeout.kind === "timeout") {
    await proc.kill();
    return { passed: false, reason: `validator timed out after ${input.validator.timeoutMs}ms` };
  }
  const { code } = exitOrTimeout.exit;

  if (input.validator.kind === "command") {
    return code === 0
      ? { passed: true, reason: "command validator exited 0" }
      : { passed: false, reason: `command validator exited ${code ?? "null"}` };
  }

  // Agent validator: parse validation.json; missing or invalid output fails.
  if (!existsSync(validationFile)) {
    return { passed: false, reason: `validator wrote no validation.json (exit ${code ?? "null"})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(validationFile, "utf8"));
  } catch (e) {
    return { passed: false, reason: `validation.json is not valid JSON: ${(e as Error).message}` };
  }
  const result = parsed as { passed?: unknown; reason?: unknown };
  if (typeof result.passed !== "boolean") {
    return { passed: false, reason: "validation.json has no boolean 'passed'" };
  }
  const reason = typeof result.reason === "string" ? result.reason : "";
  return {
    passed: result.passed,
    reason: reason || (result.passed ? "validator passed" : "validator failed without a reason"),
  };
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

/** Recovery helpers (used by daemon reconciliation). */

export async function terminateAttemptProcessGroup(attempt: AttemptRow): Promise<boolean> {
  if (attempt.worker_process_group === null) return false;
  return terminateProcessGroup(attempt.worker_process_group);
}

export function workerAlive(attempt: AttemptRow): boolean {
  if (attempt.worker_pid === null) return false;
  return isProcessAlive(attempt.worker_pid);
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

export function attemptStartedIso(attempt: AttemptRow): string {
  return attempt.started_at ?? toIso(new Date(0));
}
