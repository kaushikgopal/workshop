import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import type { WorkflowDefinition } from "./definition/schema.js";
import { resolveAgent, type ChainInfo, type ParsedModel } from "./definition/validate.js";
import type { RunRow, Store } from "./store/store.js";
import { attemptEnv, renderAgentPrompt } from "./runner/env.js";
import { spawnTracked } from "./runner/spawn.js";
import { atomicWriteFileSync, packetPath, RunLock, scaffoldPacket, sha256File } from "./worklog/worklog.js";
import type { Clock } from "./util/clock.js";
import { parseTimeout } from "./util/duration.js";

/**
 * The orchestrator is a role, not a session: one fresh invocation, scoped to
 * one run, invoked only when exception judgment is needed. It claims the
 * protected phase (pending → owned), writes one owner-bound result file, and
 * the runtime applies the decision idempotently (owned → applying → idle).
 * Hidden conversation memory is never authoritative; SQLite is.
 */

export type OrchestratorDecision = "retry" | "block" | "fail";

export interface OrchestratorResult {
  decision: OrchestratorDecision;
  reason: string;
  notes: string | null;
}

const MAX_INVALID_RESULTS = 3;

export function orchestratorResolution(
  def: WorkflowDefinition,
  machine: { harness?: { command: string }; model?: string } | undefined,
): { harnessCommand: string | null; model: ParsedModel | null } {
  const r = resolveAgent({ node: def.orchestrator?.agent, machine });
  return { harnessCommand: r.harnessCommand, model: r.model };
}

export function orchestratorTimeoutMs(def: WorkflowDefinition, inst: Installation): number | null {
  if (!def.orchestrator?.timeout) return inst.defaultTimeoutMs;
  const t = parseTimeout(def.orchestrator.timeout);
  return t.kind === "unlimited" ? null : t.ms;
}

function resultFile(runDir: string, ownerToken: string): string {
  return join(runDir, "results", `orchestrator-${ownerToken}.json`);
}

function receiptFile(runDir: string, ownerToken: string): string {
  return join(runDir, "receipts", `orchestrator-${ownerToken}.json`);
}

interface DecisionReceipt {
  ownerToken: string;
  resultSha256: string;
  appliedAt: string;
}

/**
 * Run the orchestrator for a run whose phase is pending. Recurses (bounded)
 * on invalid results; crash recovery re-enters safely via phase guards and
 * the decision receipt.
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
  const { store, inst, def, chain, run, clock } = input;
  const invalidSeen = input.invalidResultsSeen ?? 0;

  const resolution = orchestratorResolution(def, inst.machineAgent);
  if (!resolution.harnessCommand || !resolution.model) {
    blockOrchestratorUnresolved(store, run.run_id, clock);
    return;
  }

  const claimed = store.claimOrchestrator(run.run_id, clock.now());
  if (!claimed) return; // recovery or another owner holds the phase
  const { ownerToken } = claimed;

  const rFile = resultFile(run.run_dir, ownerToken);
  const promptFile = join(run.run_dir, "results", `orchestrator-${ownerToken}.prompt.md`);
  atomicWriteFileSync(
    promptFile,
    renderOrchestratorPrompt({ def, run: store.getRun(run.run_id)!, resultFile: rFile }),
  );

  const env = attemptEnv({
    logPath: run.worklog_path,
    runId: run.run_id,
    nodeId: "orchestrator",
    attempt: 1,
    promptFile,
    nodeOutputFile: rFile,
    previousOutputFile: null,
    packetFile: promptFile,
    stdoutFile: join(run.run_dir, "results", `orchestrator-${ownerToken}.stdout`),
    stderrFile: join(run.run_dir, "results", `orchestrator-${ownerToken}.stderr`),
    ownerToken,
    validationFile: null,
    model: resolution.model,
    cliPath: input.cliPath,
    extra: { WORKSHOP_ORCHESTRATOR_RESULT_FILE: rFile },
  });

  const proc = spawnTracked({
    shell: inst.shell,
    command: resolution.harnessCommand,
    cwd: inst.projectDir,
    env,
    stdoutFile: join(run.run_dir, "results", `orchestrator-${ownerToken}.stdout`),
    stderrFile: join(run.run_dir, "results", `orchestrator-${ownerToken}.stderr`),
  });

  const heartbeat = setInterval(() => {
    try {
      store.db
        .query(
          "UPDATE runs SET orchestrator_last_heartbeat_at = ? WHERE run_id = ? AND orchestrator_phase = 'owned' AND orchestrator_owner_token = ?",
        )
        .run(clock.now().toISOString(), run.run_id, ownerToken);
    } catch {
      /* advisory */
    }
  }, 5000);

  const timeoutMs = orchestratorTimeoutMs(def, inst);
  const outcome =
    timeoutMs === null
      ? { kind: "exit" as const, exit: await proc.exit }
      : await Promise.race([
          proc.exit.then((exit) => ({ kind: "exit" as const, exit })),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
        ]);
  clearInterval(heartbeat);

  if (outcome === "timeout") {
    const confirmed = await proc.kill();
    store.releaseOrchestratorToPending(run.run_id, ownerToken, clock.now());
    if (confirmed) {
      blockOrchestratorUnresolved(store, run.run_id, clock);
    } else {
      // Death unconfirmed: block without moving the phase; operator resolves.
      blockRunOnly(store, run.run_id, clock);
    }
    return;
  }

  // Missing or invalid result returns owned → pending after the process has
  // ended; fresh invocations are bounded before giving up.
  const parsed = parseResult(rFile);
  if (!parsed.ok) {
    store.releaseOrchestratorToPending(run.run_id, ownerToken, clock.now());
    if (invalidSeen + 1 >= MAX_INVALID_RESULTS) {
      blockOrchestratorUnresolved(store, run.run_id, clock);
    } else {
      await invokeOrchestrator({ ...input, invalidResultsSeen: invalidSeen + 1 });
    }
    return;
  }

  // owned → applying; recovery of a lost phase finishes the decision
  // idempotently from the result digest.
  if (!store.claimApplying(run.run_id, ownerToken, clock.now())) {
    return;
  }
  await applyDecision({ store, chain, run: store.getRun(run.run_id)!, ownerToken, result: parsed.result, clock });
}

function parseResult(path: string): { ok: true; result: OrchestratorResult } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: "orchestrator wrote no result file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, error: `orchestrator result is not valid JSON: ${(e as Error).message}` };
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

/**
 * Apply the decision: idempotent prose merge keyed by result digest, then one
 * guarded transaction for retry / block / fail before returning to idle.
 */
async function applyDecision(input: {
  store: Store;
  chain: ChainInfo;
  run: RunRow;
  ownerToken: string;
  result: OrchestratorResult;
  clock: Clock;
}): Promise<void> {
  const { store, chain, run, ownerToken, result, clock } = input;
  const rFile = resultFile(run.run_dir, ownerToken);
  const receipt = receiptFile(run.run_dir, ownerToken);

  const resultSha = sha256File(rFile);
  if (existsSync(receipt)) {
    const prior = JSON.parse(readFileSync(receipt, "utf8")) as DecisionReceipt;
    if (prior.resultSha256 === resultSha) {
      store.finishOrchestrator(run.run_id, clock.now());
      return; // same decision already applied
    }
  }

  const lock = new RunLock(run.run_dir);
  await lock.acquire();
  try {
    // Orchestrator prose reaches the worklog only through the runtime merge.
    appendDecisionLog(run.worklog_path, result, clock.now());

    store.tx(() => {
      const guard = store.db
        .query(
          "SELECT COUNT(*) AS n FROM runs WHERE run_id = ? AND orchestrator_phase = 'applying' AND orchestrator_owner_token = ?",
        )
        .get(run.run_id, ownerToken) as { n: number };
      if (guard.n === 0) return;

      if (result.decision === "retry") {
        const failed = store
          .listAttempts(run.run_id)
          .filter((a) => a.status === "failed")
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        const latest = failed[0];
        const created = latest
          ? store.createRetryAttempt({
              runId: run.run_id,
              nodeId: latest.node_id,
              previousAttempt: latest.attempt,
              packetPath: packetPath(run.run_dir, latest.node_id, latest.attempt + 1),
              resolvedMaxAttempts: latest.resolved_max_attempts,
              resolvedTimeoutMs: latest.resolved_timeout_ms,
              now: clock.now(),
            })
          : null;
        if (created) {
          // The orchestrator cannot exceed the resolved bound; the retry is
          // in-bounds here. Scaffold the packet with the same authorized marker.
          const successorId = chain.next.get(latest!.node_id) ?? null;
          scaffoldPacket(run.run_dir, latest!.node_id, latest!.attempt + 1, successorId);
        } else {
          store.setRunStatus(run.run_id, "failed", clock.now(), null);
        }
      } else if (result.decision === "block") {
        store.setRunStatus(run.run_id, "blocked", clock.now(), "orchestrator");
      } else {
        store.setRunStatus(run.run_id, "failed", clock.now(), null);
      }

      atomicWriteFileSync(
        receipt,
        JSON.stringify({ ownerToken, resultSha256: resultSha, appliedAt: clock.now().toISOString() }, null, 2) + "\n",
      );
      store.finishOrchestrator(run.run_id, clock.now());
    });
  } finally {
    lock.release();
  }
}

function appendDecisionLog(worklogPath: string, result: OrchestratorResult, now: Date): void {
  const content = readFileSync(worklogPath, "utf8");
  const heading = "## Global decision log\n";
  const idx = content.indexOf(heading);
  if (idx === -1) return; // section is runtime-owned; never expected missing
  const at = idx + heading.length;
  const line =
    `\n- ${now.toISOString()} — orchestrator ${result.decision}: ${result.reason}` +
    (result.notes ? `\n  - notes: ${result.notes.replaceAll("\n", " ")}` : "");
  atomicWriteFileSync(worklogPath, `${content.slice(0, at)}${line}\n${content.slice(at)}`);
}

function blockOrchestratorUnresolved(store: Store, runId: string, clock: Clock): void {
  store.tx(() => {
    store.db
      .query(
        "UPDATE runs SET status = 'blocked', block_kind = 'orchestrator_unresolved', updated_at = ? WHERE run_id = ? AND status IN ('queued','running')",
      )
      .run(clock.now().toISOString(), runId);
  });
}

/** Block without touching the protected phase (death unconfirmed). */
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
- Attempt logs live under ${input.run.run_dir}/logs

## Rules

- Read the worklog and the failed attempt's packet and logs.
- retry: only when the failed node is repeat-safe and a fresh attempt can
  plausibly succeed.
- block: when an operator must act first.
- fail: when retrying cannot help.
- Record your evidence and reasoning in the result file.

## Output contract

Write exactly one JSON object to ${input.resultFile}:

{"decision": "retry|block|fail", "reason": "<short reason>", "notes": "<optional prose merged into the worklog>"}
`;
}
