import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import { parseStrictYaml } from "./definition/parse.js";
import { workflowSchema, type WorkflowDefinition } from "./definition/schema.js";
import { canonicalHash } from "./definition/hash.js";
import { validateChain, unresolvedAgentSites, type ChainInfo } from "./definition/validate.js";
import { openDb } from "./store/db.js";
import { Store, isTerminal, type RunRow } from "./store/store.js";
import { attemptDir, atomicWriteFileSync, scaffoldPacket } from "./worklog/worklog.js";
import { executeAttempt, resolveNode } from "./runner/attempt.js";
import { parseTimeout } from "./util/duration.js";
import { SystemClock, type Clock } from "./util/clock.js";
import { spawnTracked } from "./runner/spawn.js";
import { invokeOrchestrator } from "./orchestrator.js";
import { admitManualRun } from "./admission.js";

/** Deterministic Run outcome prose; the runtime owns this section. */
function appendRunOutcome(run: RunRow, text: string): void {
  try {
    const content = readFileSync(run.worklog_path, "utf8");
    const heading = "## Run outcome\n";
    const idx = content.indexOf(heading);
    if (idx === -1) return;
    const at = idx + heading.length;
    const updated = `${content.slice(0, at)}\n- ${new Date().toISOString()} — ${text}\n${content.slice(at)}`;
    atomicWriteFileSync(run.worklog_path, updated);
  } catch {
    /* outcome prose is best-effort; SQLite stays authoritative */
  }
}

/**
 * Loading, validation, and the chain executor. The executor claims pending
 * attempts and runs them to completion; the daemon reuses the same functions.
 */


export interface LoadedDefinition {
  def: WorkflowDefinition;
  chain: ChainInfo;
  canonicalHash: string;
  sourcePath: string;
  sourceText: string;
}

export function loadAndValidateDefinition(sourcePath: string): LoadedDefinition {
  let src: string;
  try {
    src = readFileSync(sourcePath, "utf8");
  } catch (e) {
    throw new Error(`cannot read workflow definition at ${sourcePath}: ${(e as Error).message}`);
  }
  const raw = parseStrictYaml(src, sourcePath);
  const def = workflowSchema.parse(raw);
  const chain = validateChain(def);
  return { def, chain, canonicalHash: canonicalHash(def), sourcePath, sourceText: src };
}

/** All start validation that must fail before any state exists. */
export function preflightValidation(def: WorkflowDefinition, inst: Installation): string[] {
  const warnings: string[] = [];
  const unresolved = unresolvedAgentSites(def, inst.machineAgent);
  if (unresolved.length > 0) {
    throw new Error(
      `cannot start: agent sites cannot resolve a harness command and model:\n  - ${unresolved.join("\n  - ")}`,
    );
  }
  if (def.schedule && def.schedule.max_runs <= 0) {
    warnings.push(`max_runs is ${def.schedule.max_runs} — this workflow runs until stopped (indefinite)`);
  }
  return warnings;
}

export class PreflightBlocked extends Error {
  constructor(
    public exitCode: number | null,
    public stderrTail: string,
  ) {
    super(`environment preflight failed with exit code ${exitCode ?? "null"}`);
    this.name = "PreflightBlocked";
  }
}

/** Run the optional command preflight. Exit 0 = ready. */
export async function runPreflight(inst: Installation, command: string, timeoutMs: number | null): Promise<void> {
  const out = join(inst.stateDir, "preflight-last.stdout");
  const err = join(inst.stateDir, "preflight-last.stderr");
  const proc = spawnTracked({
    shell: inst.shell,
    command,
    cwd: inst.projectDir,
    env: {},
    stdoutFile: out,
    stderrFile: err,
  });
  const result =
    timeoutMs === null
      ? { kind: "exit" as const, exit: await proc.exit }
      : await Promise.race([
          proc.exit.then((exit) => ({ kind: "exit" as const, exit })),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
        ]);
  if (result === "timeout") {
    await proc.kill();
    throw new PreflightBlocked(null, `preflight timed out after ${timeoutMs}ms`);
  }
  if (result.exit.code !== 0) {
    throw new PreflightBlocked(result.exit.code, tailOf(err, 2000));
  }
}

function tailOf(path: string, max: number): string {
  try {
    const content = readFileSync(path, "utf8");
    return content.length > max ? content.slice(-max) : content;
  } catch {
    return "";
  }
}

/**
 * Start a run: create or refresh the activation, admit the run (idempotent
 * while unresolved), scaffold worklog + first packet, snapshot the
 * definition, run preflight, and create the initial pending attempt.
 */
export async function startWorkflow(input: {
  inst: Installation;
  loaded: LoadedDefinition;
  clock?: Clock;
}): Promise<{ runId: string; created: boolean; warnings: string[] }> {
  const clock = input.clock ?? new SystemClock();
  const { inst, loaded } = input;
  const store = new Store(openDb(inst.dbPath));
  const now = clock.now();
  const def = loaded.def;

  const warnings = preflightValidation(def, inst);

  const admitted = admitManualRun({ store, inst, loaded, now });
  if (!admitted.created) return { runId: admitted.runId, created: false, warnings };

  // Preflight runs after replayable admission is fully prepared; a failure
  // blocks before any attempt exists.
  await preflightIfNeeded({ store, inst, loaded, runId: admitted.runId, clock });

  if (store.getRun(admitted.runId)!.status !== "blocked") {
    scaffoldFirstAttempt({ store, inst, loaded, runId: admitted.runId, now: clock.now() });
  }

  return { runId: admitted.runId, created: true, warnings };
}

export const preflightCacheDir = (inst: Installation): string => join(inst.stateDir, "preflight-cache");

/**
 * Run the optional command preflight unless already cached for this
 * canonical hash; a blocked preflight marks the run blocked.
 */
export async function preflightIfNeeded(input: {
  store: Store;
  inst: Installation;
  loaded: LoadedDefinition;
  runId: string;
  clock: Clock;
}): Promise<void> {
  const { store, inst, loaded, runId, clock } = input;
  const pf = loaded.def.environment?.preflight;
  if (!pf) {
    appendEnvironmentObservation(inst, runId, "no preflight configured");
    return;
  }
  const cacheFile = join(preflightCacheDir(inst), loaded.canonicalHash.replaceAll(":", "-"));
  if (existsSync(cacheFile)) {
    appendEnvironmentObservation(inst, runId, `preflight cached for ${loaded.canonicalHash}`);
    clearPreflightBlocker(store, runId, clock);
    return;
  }
  let timeoutMs: number | null = inst.defaultTimeoutMs;
  if (pf.timeout) {
    const t = parseTimeout(pf.timeout);
    timeoutMs = t.kind === "unlimited" ? null : t.ms;
  }
  try {
    await runPreflight(inst, pf.command, timeoutMs);
    mkdirSync(preflightCacheDir(inst), { recursive: true });
    atomicWriteFileSync(cacheFile, `${new Date().toISOString()} ${pf.command}\n`);
    appendEnvironmentObservation(inst, runId, `preflight passed (${pf.command})`);
    clearPreflightBlocker(store, runId, clock);
  } catch (e) {
    if (e instanceof PreflightBlocked) {
      appendEnvironmentObservation(inst, runId, `preflight blocked: ${e.message}\n\n\`\`\`\n${e.stderrTail}\n\`\`\``);
      store.setRunStatus(runId, "blocked", clock.now(), "preflight");
      return;
    }
    throw e;
  }
}

/** Successful initial or resumed preflight unblocks the run in one transaction. */
function clearPreflightBlocker(store: Store, runId: string, clock: Clock): void {
  store.tx(() => {
    store.db
      .query(
        "UPDATE runs SET status = 'running', block_kind = NULL, desired_state = 'running', updated_at = ? WHERE run_id = ? AND status = 'blocked' AND block_kind = 'preflight'",
      )
      .run(clock.now().toISOString(), runId);
  });
}

/** The initial pending attempt for the run's start node. */
export function scaffoldFirstAttempt(input: {
  store: Store;
  inst: Installation;
  loaded: LoadedDefinition;
  runId: string;
  now: Date;
}): void {
  const { store, inst, loaded, runId, now } = input;
  const startNode = loaded.chain.order[0]!;
  const startResolved = resolveNode(loaded.def, startNode, inst);
  const fresh = store.createSuccessorAttempt({
    runId,
    nodeId: startNode,
    resolvedMaxAttempts: startResolved.maxAttempts,
    resolvedTimeoutMs: startResolved.timeoutMs,
    chainPosition: loaded.chain.order.indexOf(startNode),
    now,
  });
  const run = store.getRun(runId)!;
  scaffoldPacket(attemptDir(run.run_dir, fresh.execution_seq, fresh.node_id), fresh.attempt, loaded.chain.next.get(startNode) ?? null);
}

export function runDirOf(inst: Installation, runId: string): string {
  return join(inst.runsDir, runId);
}


function appendEnvironmentObservation(inst: Installation, runId: string, observation: string): void {
  const logPath = join(runDirOf(inst, runId), "WORKSHOP_LOG.md");
  try {
    const content = readFileSync(logPath, "utf8");
    const marker = "## Environment\n";
    const idx = content.indexOf(marker);
    if (idx === -1) return;
    const at = idx + marker.length;
    const updated = `${content.slice(0, at)}\n- ${new Date().toISOString()} — ${observation}\n${content.slice(at)}`;
    writeFileSync(logPath, updated, "utf8");
  } catch {
    /* observation is best-effort; SQLite remains authoritative */
  }
}

/**
 * Execute all pending attempts of one run until the chain ends, fails, or
 * pauses. Uses the same guarded claims the daemon uses.
 */
export async function runChain(input: {
  store: Store;
  inst: Installation;
  loaded: LoadedDefinition;
  runId: string;
  clock?: Clock;
  cliPath: string;
}): Promise<RunRow> {
  const clock = input.clock ?? new SystemClock();
  const { store, inst, loaded, runId } = input;

  for (;;) {
    const run = store.getRun(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    if (isTerminal(run.status) || run.status === "paused" || run.status === "blocked") return run;

    const live = store.getLiveAttempt(runId);
    if (!live || live.status !== "pending") return store.getRun(runId)!;

    const prevNode = loaded.chain.prev.get(live.node_id) ?? null;
    const prevOutput = prevNode ? latestSuccessfulOutput(store, runId, prevNode) : null;

    const outcome = await executeAttempt({
      store,
      inst,
      def: loaded.def,
      chain: loaded.chain,
      run,
      nodeId: live.node_id,
      attemptNo: live.attempt,
      previousOutputFile: prevOutput,
      clock,
      cliPath: input.cliPath,
    });

    if (outcome.status === "failed") {
      // Exception judgment: the same transaction that failed the attempt
      // moved the run into the protected phase; a fresh orchestrator decides.
      await invokeOrchestrator({ store, inst, def: loaded.def, chain: loaded.chain, run: store.getRun(runId)!, clock, cliPath: input.cliPath });
      const judged = store.getRun(runId)!;
      if (judged.status === "failed") appendRunOutcome(judged, "run failed (orchestrator decision)");
      // A retry decision leaves the run running with a pending attempt —
      // keep looping; blocked/failed terminal states return via the head.
      if (judged.status !== "running") return judged;
      continue;
    }
    if (outcome.status === "completed" && !loaded.chain.next.get(live.node_id)) {
      appendRunOutcome(store.getRun(runId)!, "run completed: chain finished");
    }
    if (outcome.status !== "completed") {
      return store.getRun(runId)!;
    }
    // Loop: the completed attempt persisted its successor.
  }
}


function latestSuccessfulOutput(store: Store, runId: string, nodeId: string): string | null {
  const attempts = store
    .listAttempts(runId)
    .filter((a) => a.node_id === nodeId && a.status === "completed" && a.node_output_path)
    .sort((a, b) => b.attempt - a.attempt);
  return attempts[0]?.node_output_path ?? null;
}
