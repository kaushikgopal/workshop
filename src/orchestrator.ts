import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import type { WorkflowDefinition } from "./definition/schema.js";
import { resolveAgent, type ChainInfo, type ParsedModel } from "./definition/validate.js";
import { CapacityRejected, GuardRejected, type RunRow, type Store } from "./store/store.js";
import { attemptEnv } from "./runner/env.js";
import { spawnTracked, type TrackedProcess } from "./runner/spawn.js";
import {
  WorklogIntegrityError,
  attemptDir,
  atomicWriteFileSync,
  fsyncFileSync,
  orchestratorDir,
  RunLock,
  scaffoldPacket,
  sha256File,
  sha256String,
} from "./worklog/worklog.js";
import type { Clock } from "./util/clock.js";
import { parseTimeout } from "./util/duration.js";

/**
 * One fresh orchestrator invocation owns pending → owned. The child identity
 * is recorded immediately after spawn; a normalized result is then bound on
 * owned → applying. The decision prose merges idempotently under the run
 * lock, and the DB effect + phase close commit in one guarded transaction —
 * SQLite is the truth; no filesystem receipt can prove a DB commit.
 */

export type OrchestratorDecision = "retry" | "block" | "fail";

export interface OrchestratorResult {
  decision: OrchestratorDecision;
  reason: string;
  notes: string | null;
}

const MAX_INVALID_RESULTS = 3;

function orchestratorResolution(
  def: WorkflowDefinition,
  machine: { harness?: { command: string }; model?: string } | undefined,
): { harnessCommand: string | null; model: ParsedModel | null } {
  const r = resolveAgent({ node: def.orchestrator?.agent, machine });
  return { harnessCommand: r.harnessCommand, model: r.model };
}

function orchestratorTimeoutMs(def: WorkflowDefinition, inst: Installation): number | null {
  if (!def.orchestrator?.timeout) return inst.defaultTimeoutMs;
  const t = parseTimeout(def.orchestrator.timeout);
  return t.kind === "unlimited" ? null : t.ms;
}

export function orchestratorResultFile(runDir: string, ownerToken: string): string {
  return join(orchestratorDir(runDir, ownerToken), "result.json");
}

function orchestratorArtifact(runDir: string, ownerToken: string, name: string): string {
  return join(orchestratorDir(runDir, ownerToken), name);
}

/**
 * Run the orchestrator for a run whose phase is pending. Recurses (bounded)
 * on invalid results; crash recovery re-enters safely via phase guards and
 * the normalized result file.
 */
export async function invokeOrchestrator(input: {
  store: Store;
  inst: Installation;
  def: WorkflowDefinition;
  chain: ChainInfo;
  run: RunRow;
  clock: Clock;
  cliPath: string;
  invalidResultsSeen?: number;
}): Promise<void> {
  const { store, inst, def, chain, clock } = input;
  const invalidSeen = input.invalidResultsSeen ?? 0;

  const resolution = orchestratorResolution(def, inst.machineAgent);
  if (!resolution.harnessCommand || !resolution.model) {
    blockOrchestratorUnresolved(store, input.run.run_id, clock);
    return;
  }

  let claimed: { ownerToken: string } | null;
  try {
    claimed = store.claimOrchestrator(input.run.run_id, clock.now(), inst.maxConcurrentRuns);
  } catch (e) {
    if (e instanceof CapacityRejected) return;
    throw e;
  }
  if (!claimed) return; // recovery or another owner holds the phase
  const { ownerToken } = claimed;
  const run = store.getRun(input.run.run_id)!;

  const rFile = orchestratorResultFile(run.run_dir, ownerToken);
  const promptFile = orchestratorArtifact(run.run_dir, ownerToken, "prompt.md");
  atomicWriteFileSync(promptFile, renderOrchestratorPrompt({ def, run, resultFile: rFile }));

  const stdoutFile = orchestratorArtifact(run.run_dir, ownerToken, "stdout");
  const stderrFile = orchestratorArtifact(run.run_dir, ownerToken, "stderr");
  const env = attemptEnv({
    logPath: run.worklog_path,
    runId: run.run_id,
    nodeId: "orchestrator",
    attempt: 1,
    promptFile,
    nodeOutputFile: rFile,
    previousOutputFile: null,
    packetFile: promptFile,
    stdoutFile,
    stderrFile,
    ownerToken,
    validationFile: null,
    model: resolution.model,
    cliPath: input.cliPath,
    extra: { WORKSHOP_ORCHESTRATOR_RESULT_FILE: rFile },
  });

  // Spawn directly, detached; record the child identity immediately after
  // spawn (the accepted POC boundary — no pre-exec gate).
  const proc = spawnTracked({
    shell: inst.shell,
    command: resolution.harnessCommand,
    cwd: inst.projectDir,
    env,
    stdoutFile,
    stderrFile,
  });
  store.recordOrchestratorIdentity({
    runId: run.run_id,
    ownerToken,
    childPid: proc.pid,
    childStartId: proc.startId,
    childPgid: proc.pgid,
    now: clock.now(),
  });

  const heartbeat = setInterval(() => {
    try {
      const fresh = store.getRun(run.run_id);
      if (fresh?.desired_state === "stopped") {
        void proc.kill();
        return;
      }
      store.heartbeatOrchestrator({ runId: run.run_id, ownerToken, now: clock.now() });
    } catch {
      /* advisory */
    }
  }, 5000);

  const outcome = await raceDeadline(proc, orchestratorTimeoutMs(def, inst));
  clearInterval(heartbeat);
  if (!(await retireOrchestratorProcess(store, run.run_id, ownerToken, proc, clock, stdoutFile, stderrFile))) {
    return; // death unconfirmed: ownership stays protected for recovery
  }

  const afterExit = store.getRun(run.run_id);
  if (!afterExit || afterExit.desired_state === "stopped") {
    store.finalizeStoppedRun({ runId: run.run_id, now: clock.now() });
    return;
  }

  if (outcome.kind === "timeout") {
    if (store.releaseOrchestratorToPending(run.run_id, ownerToken, clock.now())) {
      blockOrchestratorUnresolved(store, run.run_id, clock);
    }
    return;
  }

  // Missing or invalid result returns owned → pending after the process has
  // ended; fresh invocations are bounded before giving up.
  const normalized = normalizeResult(rFile);
  if (!normalized.ok) {
    if (!store.releaseOrchestratorToPending(run.run_id, ownerToken, clock.now())) return;
    if (invalidSeen + 1 >= MAX_INVALID_RESULTS) {
      blockOrchestratorUnresolved(store, run.run_id, clock);
      return;
    }
    // The prior child is confirmed dead and its owner released. A fresh claim
    // is safe; the recursion bounds the retry loop in memory.
    await invokeOrchestrator({ ...input, invalidResultsSeen: invalidSeen + 1 });
    return;
  }

  // owned → applying keeps the owner token stable: the same owner merges the
  // prose and applies the decision it verified.
  if (!store.claimApplying({ runId: run.run_id, ownerToken, resultPath: rFile, now: clock.now() })) {
    return;
  }
  try {
    await applyDecision({ store, chain, runId: run.run_id, ownerToken, clock });
  } catch (e) {
    if (e instanceof WorklogIntegrityError || e instanceof GuardRejected) {
      blockRunOnly(store, run.run_id, clock);
      return;
    }
    throw e;
  }
}

/**
 * Recover a dead owned/applying orchestrator without invoking a model. The
 * caller must first terminate-confirm and clear any recorded child group.
 */
export async function recoverOrchestratorDecision(input: {
  store: Store;
  chain: ChainInfo;
  run: RunRow;
  clock: Clock;
}): Promise<"released" | "finished" | "protected"> {
  const { store, chain, clock } = input;
  const fresh = store.getRun(input.run.run_id);
  if (!fresh || !fresh.orchestrator_owner_token) return "protected";
  const ownerToken = fresh.orchestrator_owner_token;

  if (fresh.orchestrator_phase === "owned") {
    // Dead owned with a valid result claims applying and applies the same
    // result; invalid evidence releases pending for a fresh invocation.
    const rFile = orchestratorResultFile(fresh.run_dir, ownerToken);
    const normalized = normalizeResult(rFile);
    if (!normalized.ok) {
      return store.releaseOrchestratorToPending(fresh.run_id, ownerToken, clock.now()) ? "released" : "protected";
    }
    if (!store.claimApplying({ runId: fresh.run_id, ownerToken, resultPath: rFile, now: clock.now() })) {
      return "protected";
    }
  } else if (fresh.orchestrator_phase !== "applying") {
    return "protected";
  }

  // Dead applying: re-read the result, merge the prose idempotently, and
  // reapply the guarded DB decision. Invalid applying evidence fails closed.
  try {
    await applyDecision({ store, chain, runId: fresh.run_id, ownerToken, clock });
    return "finished";
  } catch (e) {
    if (e instanceof WorklogIntegrityError || e instanceof GuardRejected) return "protected";
    throw e;
  }
}

async function retireOrchestratorProcess(
  store: Store,
  runId: string,
  ownerToken: string,
  proc: TrackedProcess,
  clock: Clock,
  stdoutFile: string,
  stderrFile: string,
): Promise<boolean> {
  // Descendants may outlive the leader; publication, release, and recovery
  // all stop here unless the whole PGID is confirmed dead.
  if (!(await proc.kill())) return false;
  if (existsSync(stdoutFile)) fsyncFileSync(stdoutFile);
  if (existsSync(stderrFile)) fsyncFileSync(stderrFile);
  const cleared = store.clearOrchestratorIdentity({
    runId,
    ownerToken,
    childPid: proc.pid,
    childStartId: proc.startId,
    childPgid: proc.pgid,
    now: clock.now(),
  });
  return cleared || store.getRun(runId)?.orchestrator_process_group === null;
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
    const result = await Promise.race([proc.exit.then((exit) => ({ kind: "exit" as const, exit })), timer]);
    return result === "timeout" ? { kind: "timeout" } : result;
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Normalize the externally written result in place: flush the model's bytes,
 * parse strictly, and atomically replace the file with the canonical form.
 * The normalized content is durable — recovery re-reads it instead of
 * calling a fresh model.
 */
function normalizeResult(path: string): { ok: true; result: OrchestratorResult } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: "orchestrator wrote no result file" };
  fsyncFileSync(path);
  const parsed = parseResultText(readFileSync(path, "utf8"));
  if (!parsed.ok) return parsed;
  atomicWriteFileSync(path, canonicalResult(parsed.result));
  return { ok: true, result: parsed.result };
}

function parseResultText(text: string): { ok: true; result: OrchestratorResult } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `orchestrator result is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "orchestrator result must be an object" };
  }
  const r = parsed as { decision?: unknown; reason?: unknown; notes?: unknown };
  if (typeof r.decision !== "string" || !["retry", "block", "fail"].includes(r.decision)) {
    return { ok: false, error: 'orchestrator result must carry decision "retry" | "block" | "fail"' };
  }
  return {
    ok: true,
    result: {
      decision: r.decision as OrchestratorDecision,
      reason: typeof r.reason === "string" ? r.reason : "",
      notes: typeof r.notes === "string" ? r.notes : null,
    },
  };
}

function canonicalResult(result: OrchestratorResult): string {
  return JSON.stringify({ decision: result.decision, reason: result.reason, notes: result.notes }, null, 2) + "\n";
}

/**
 * Apply the applying phase's decision: the idempotent prose merge first, then
 * the effect + phase close in one guarded SQLite transaction. The retry
 * packet scaffolds after the commit; pending-packet repair covers the gap.
 */
async function applyDecision(input: {
  store: Store;
  chain: ChainInfo;
  runId: string;
  ownerToken: string;
  clock: Clock;
}): Promise<void> {
  const { store, chain, clock } = input;
  const run = store.getRun(input.runId);
  if (!run || run.orchestrator_phase !== "applying") throw new GuardRejected("orchestrator is not applying");
  const result = verifyNormalizedResult(run, input.ownerToken);

  const lock = new RunLock(run.run_dir);
  try {
    await lock.acquire();
    const committedAt = clock.now();
    // Prose merge is idempotent by one marker derived from owner + result.
    // A filesystem receipt is never DB-commit proof, so there is none.
    mergeDecisionProse(run, input.ownerToken, result, committedAt);
    const { effectNodeId, effectAttempt } = store.applyOrchestratorDecision({
      runId: run.run_id,
      ownerToken: input.ownerToken,
      decision: result.decision,
      now: committedAt,
    });

    // Retry scaffolding follows the decision transaction.
    if (effectNodeId !== null && effectAttempt !== null) {
      const retry = store.getAttempt(run.run_id, effectNodeId, effectAttempt);
      if (!retry) throw new WorklogIntegrityError("committed orchestrator retry row is missing");
      scaffoldPacket(
        attemptDir(run.run_dir, retry.execution_seq, retry.node_id),
        retry.attempt,
        chain.next.get(retry.node_id) ?? null,
      );
    }
  } finally {
    lock.release();
  }
}

/** Read the row-bound result file; it must still be the normalized form. */
function verifyNormalizedResult(run: RunRow, ownerToken: string): OrchestratorResult {
  const path = run.orchestrator_result_path;
  if (!path || !existsSync(path)) {
    throw new WorklogIntegrityError(`applying orchestrator ${run.run_id} is missing its owner-bound result`);
  }
  if (path !== orchestratorResultFile(run.run_dir, ownerToken)) {
    throw new WorklogIntegrityError(`applying orchestrator ${run.run_id} has a result outside its owner scope`);
  }
  const text = readFileSync(path, "utf8");
  const parsed = parseResultText(text);
  if (!parsed.ok || canonicalResult(parsed.result) !== text) {
    throw new WorklogIntegrityError(`orchestrator result for ${run.run_id} is not normalized durable evidence`);
  }
  return parsed.result;
}

/**
 * Idempotent decision prose under the worklog's global decision log, inside
 * one marker pair keyed by owner token digest + result digest. An existing
 * exact block is a no-op; any other decision-marker shape is corruption.
 */
function mergeDecisionProse(run: RunRow, ownerToken: string, result: OrchestratorResult, now: Date): void {
  const ownerSha = sha256String(ownerToken);
  const resultSha = sha256File(run.orchestrator_result_path!);
  const marker = decisionMarkers(ownerSha, resultSha);
  const block = decisionBlock(marker, now.toISOString(), result);
  // The idempotent identity is the marker pair (owner + result digest); the
  // merged block keeps its original merge timestamp, so an existing block is
  // verified by its decision content, not by re-rendered bytes.
  const expectedDecision = `orchestrator ${result.decision}: ${sanitizeDecisionText(result.reason)}`;
  const worklog = readFileSync(run.worklog_path, "utf8");
  const exactBegins = countOccurrences(worklog, marker.begin);
  const exactEnds = countOccurrences(worklog, marker.end);
  const anyBegins = countOccurrences(worklog, "<!-- workshop:decision begin");
  const anyEnds = countOccurrences(worklog, "<!-- workshop:decision end");
  if (exactBegins !== exactEnds || anyBegins !== anyEnds || (exactBegins === 1 && anyBegins !== 1)) {
    throw new WorklogIntegrityError(`orchestrator decision markers for ${run.run_id} disagree with the durable result`);
  }

  if (exactBegins === 1) {
    const start = worklog.indexOf(marker.begin);
    const end = worklog.indexOf(marker.end, start + marker.begin.length);
    const existing = worklog.slice(start, end + marker.end.length);
    if (!existing.includes(expectedDecision) ||
        (result.notes !== null && !existing.includes(`notes: ${sanitizeDecisionText(result.notes)}`))) {
      throw new WorklogIntegrityError(`orchestrator decision block for ${run.run_id} was modified`);
    }
    return; // same decision already merged
  }
  if (anyBegins > 0) {
    throw new WorklogIntegrityError(`worklog already holds a different orchestrator decision block for ${run.run_id}`);
  }

  const heading = "## Global decision log\n";
  const idx = worklog.indexOf(heading);
  if (idx === -1) throw new WorklogIntegrityError(`worklog for ${run.run_id} is missing the global decision log`);
  const at = idx + heading.length;
  atomicWriteFileSync(run.worklog_path, `${worklog.slice(0, at)}\n${block}\n${worklog.slice(at)}`);
}

function decisionMarkers(ownerSha256: string, resultSha256: string): { begin: string; end: string } {
  const key = `owner=${ownerSha256} result=${resultSha256}`;
  return {
    begin: `<!-- workshop:decision begin ${key} -->`,
    end: `<!-- workshop:decision end ${key} -->`,
  };
}

function decisionBlock(
  marker: { begin: string; end: string },
  decidedAt: string,
  result: OrchestratorResult,
): string {
  const reason = sanitizeDecisionText(result.reason);
  const notes = result.notes === null ? "" : `\n  - notes: ${sanitizeDecisionText(result.notes)}`;
  return `${marker.begin}\n- ${decidedAt} — orchestrator ${result.decision}: ${reason}${notes}\n${marker.end}`;
}

function sanitizeDecisionText(value: string): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("<!-- workshop:decision", "\\<!-- workshop:decision");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function blockOrchestratorUnresolved(store: Store, runId: string, clock: Clock): void {
  store.tx(() => {
    store.db
      .query(
        `UPDATE runs SET status = 'blocked', block_kind = 'orchestrator_unresolved', updated_at = ?
         WHERE run_id = ? AND status IN ('queued','running') AND orchestrator_owner_token IS NULL
           AND orchestrator_process_group IS NULL`,
      )
      .run(clock.now().toISOString(), runId);
  });
}

/** Block without releasing a protected owner/result after an integrity fault. */
function blockRunOnly(store: Store, runId: string, clock: Clock): void {
  store.tx(() => {
    store.db
      .query(
        "UPDATE runs SET status = 'blocked', block_kind = 'orchestrator_unresolved', updated_at = ? WHERE run_id = ? AND status IN ('queued','running')",
      )
      .run(clock.now().toISOString(), runId);
  });
}

function renderOrchestratorPrompt(input: { def: WorkflowDefinition; run: RunRow; resultFile: string }): string {
  return `# Workshop orchestrator

You are a fresh orchestrator invoked because this run hit an exception that
needs judgment. Decide once: retry, block, or fail.

## Context

- Workflow: ${input.def.id} — ${input.def.description}
- Run: ${input.run.run_id} (status ${input.run.status})
- Definition snapshot: ${join(input.run.run_dir, "definition.yaml")}
- Worklog (read-only): ${input.run.worklog_path}
- Attempt evidence lives under ${join(input.run.run_dir, "attempts")}

## Rules

- Read the worklog and the failed attempt's packet and logs.
- retry: only when the failed node is repeat-safe and a fresh attempt can plausibly succeed.
- block: when an operator must act first.
- fail: when retrying cannot help.
- Record your evidence and reasoning in the result file.

## Output contract

Write exactly one JSON object to ${input.resultFile}:

{"decision": "retry|block|fail", "reason": "<short reason>", "notes": "<optional prose merged into the worklog>"}
`;
}
