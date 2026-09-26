import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedDefinition } from "../definition/load-definition.js";
import { unresolvedAgentSites } from "../definition/resolve-node-settings.js";
import type { WorkflowDefinition } from "../definition/schema.js";
import type { Installation } from "../load-installation.js";
import { spawnTracked } from "../process/launch-process.js";
import type { Store } from "../storage/db/store.js";
import { locateWorklog } from "../storage/disk/locate-run-files.js";
import { atomicWriteFileSync } from "../storage/disk/write-crash-safe.js";
import type { Clock } from "../util/clock.js";
import { parseTimeout } from "../util/parse-units.js";
import { appendRuntimeNote } from "../worklog/edit-sections.js";

/** All start validation that must fail before any state exists. */
export function checkStartable(def: WorkflowDefinition, inst: Installation): string[] {
  const warnings: string[] = [];
  const unresolved = unresolvedAgentSites(def, inst.machineAgent);
  if (unresolved.length > 0) {
    throw new Error(
      `cannot start: agent sites cannot resolve a harness command and model:\n  - ${unresolved.join("\n  - ")}`
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
    public stderrTail: string
  ) {
    super(`environment preflight failed with exit code ${exitCode ?? "null"}`);
    this.name = "PreflightBlocked";
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
/** Run the optional command preflight. Exit 0 = ready. */
export async function executePreflight(inst: Installation, command: string, timeoutMs: number | null): Promise<void> {
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
  const result = timeoutMs === null
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
export const preflightCacheDir = (inst: Installation): string => join(inst.stateDir, "preflight-cache");
/** Successful initial or resumed preflight unblocks the run in one transaction. */
function clearPreflightBlocker(store: Store, runId: string, clock: Clock): void {
  store.tx(() => {
    store.db
      .query(
        "UPDATE runs SET status = 'running', block_kind = NULL, desired_state = 'running', updated_at = ? WHERE run_id = ? AND status = 'blocked' AND block_kind = 'preflight'"
      )
      .run(clock.now().toISOString(), runId);
  });
}
function appendEnvironmentObservation(inst: Installation, runId: string, observation: string): void {
  appendRuntimeNote(locateWorklog(join(inst.runsDir, runId)), "Environment", observation);
}
/**
 * Run the optional command preflight unless already cached for this
 * canonical hash; a blocked preflight marks the run blocked.
 */
export async function checkEnvironment(input: {
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
    await executePreflight(inst, pf.command, timeoutMs);
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
