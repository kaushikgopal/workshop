#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { findInstallation, ensureDirs, workflowPath } from "./config.js";
import { join } from "node:path";
import { loadAndValidateDefinition, startWorkflow, runChain, preflightIfNeeded, scaffoldFirstAttempt } from "./execute.js";
import { openDb } from "./store/db.js";
import { Store, GuardRejected } from "./store/store.js";
import { buildStatusDto, renderStatusText, STATUS_DTO_VERSION } from "./status/dto.js";
import { resolveNode } from "./runner/attempt.js";
import { isTerminal } from "./store/store.js";
import { blockKindFor } from "./runner/attempt.js";
import { SystemClock } from "./util/clock.js";
import { runtimeCliInvocation } from "./util/cli-path.js";
import { DaemonLockHeld } from "./daemon.js";

/**
 * Workshop CLI. Public surface:
 *   help | validate | start | pause | resume | stop | status |
 *   node describe | logs | diagram | orchestrate
 * Internal (agent-facing, not in help):
 *   runtime progress | runtime block
 */

const HELP = `workshop — durable linked-list runner for agent workflows

Usage: workshop <command> [args]

Commands:
  workshop help
      List commands and briefly explain each one.

  workshop validate <workflow-id>
      Validate the current YAML definition and print warnings; it does not run
      environment preflight.

  workshop start <workflow-id>
      Start a one-shot run, or enable recurrence and start run 1 immediately.
      Idempotent while a run is unresolved.

  workshop pause <workflow-id>
      Disable future occurrences, let the current node finish, and pause
      before its successor.

  workshop resume <workflow-id>
      Continue a paused or repaired run and re-enable its schedule.

  workshop stop <workflow-id>
      Disable future occurrences, abort the active process, and cancel the run.

  workshop status [<workflow-id>] [--json]
      Show workflows, activations, and each workflow's unresolved current run
      with its nodes, attempts, progress, validators, and blockers.

  workshop node describe <workflow-id> <node-id> [--json]
      Show the run's YAML snapshot properties, resolved agent settings,
      successor, validator, and runtime status.

  workshop logs <workflow-id> [--follow]
      Print or follow the workflow's most recent run: its WORKSHOP_LOG.md and
      process logs.

  workshop diagram <workflow-id> [--mermaid]
      Render the current chain and overlay runtime status.

  workshop orchestrate
      Run the deterministic guardian daemon in the foreground.
`;

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

import { ZodError } from "zod";

/** Human-readable failure text for CLI errors, including zod issues. */
function errorText(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((i) => `  - ${i.path.join(".") || "definition"}: ${i.message}`).join("\n");
  }
  return e instanceof Error ? e.message : String(e);
}

function requireArg(args: string[], name: string): string {
  const value = args[0];
  if (!value) die(`missing <${name}> argument`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "validate":
      return cmdValidate(args);
    case "start":
      return cmdStart(args);
    case "status":
      return cmdStatus(args);
    case "runtime":
      return cmdRuntime(args);
    case "pause":
      return cmdPause(args);
    case "resume":
      await cmdResume(args);
      process.exit(0);
    case "stop":
      await cmdStop(args);
      process.exit(0);
    case "logs":
      return cmdLogs(args);
    case "diagram":
      return cmdDiagram(args);
    case "node":
      return cmdNode(args);
    case "orchestrate": {
      const inst = findInstallation();
      ensureDirs(inst);
      const { runDaemon } = await import("./daemon.js");
      try {
        await runDaemon(inst);
      } catch (e) {
        if (e instanceof DaemonLockHeld) die(e.message);
        throw e;
      }
      return;
    }
  }
}

function cmdValidate(args: string[]): void {
  const workflowId = requireArg(args, "workflow-id");
  const inst = findInstallation();
  const path = workflowPath(inst, workflowId);
  try {
    const loaded = loadAndValidateDefinition(path);
    const warnings = preflightWarnings(loaded.def, inst);
    process.stdout.write(`ok: ${workflowId} — valid (chain of ${loaded.chain.order.length} node(s))\n`);
    for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
  } catch (e) {
    die(errorText(e));
  }
}

function preflightWarnings(def: import("./definition/schema.js").WorkflowDefinition, inst: ReturnType<typeof findInstallation>): string[] {
  // validate checks the definition only; agent-resolution is also a start
  // failure, so it is reported here as a warning-level diagnosis.
  const warnings: string[] = [];
  const { unresolvedAgentSites } = require("./definition/validate.js") as typeof import("./definition/validate.js");
  for (const site of unresolvedAgentSites(def, inst.machineAgent)) {
    warnings.push(`agent site cannot resolve harness/model: ${site} (start will fail)`);
  }
  if (def.schedule && def.schedule.max_runs <= 0) {
    warnings.push(`max_runs is ${def.schedule.max_runs} — this workflow runs until stopped (indefinite)`);
  }
  return warnings;
}

async function cmdStart(args: string[]): Promise<void> {
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
  const final = await runChain({ store, inst, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });
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
async function cmdStop(args: string[]): Promise<void> {
  const workflowId = requireArg(args, "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const now = new Date();

  const wf = store.getWorkflow(workflowId);
  if (!wf) die(`no workflow "${workflowId}"`);

  const run = store.getUnresolvedRun(workflowId);
  if (run) {
    // 1. Durable intent first.
    store.stopRun({ runId: run.run_id, now });

    // 2. Terminate and confirm the recorded process groups.
    const live = store.getLiveAttempt(run.run_id);
    if (live?.worker_process_group != null) {
      const { terminateProcessGroup } = await import("./util/process.js");
      await terminateProcessGroup(live.worker_process_group);
    }
    const fresh = store.getRun(run.run_id)!;
    if (fresh.orchestrator_worker_pid != null && (fresh.orchestrator_phase === "owned" || fresh.orchestrator_phase === "applying")) {
      const { terminateProcessGroup } = await import("./util/process.js");
      await terminateProcessGroup(fresh.orchestrator_worker_pid);
      store.finishOrchestrator(run.run_id, now);
    }

    // 3. Cancel any live attempt rows left after the signal.
    const after = store.getLiveAttempt(run.run_id);
    if (after) store.cancelAttempt({ runId: run.run_id, nodeId: after.node_id, attempt: after.attempt, now });
    process.stdout.write(`stopped ${workflowId}: run ${run.run_id} cancelled\n`);
  } else {
    process.stdout.write(`stopped ${workflowId}: no unresolved run\n`);
  }
  store.setActivationState(workflowId, "stopped");
}

/** Pause: suppress future occurrences; the current node finishes, then no successor. */
function cmdPause(args: string[]): void {
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
async function cmdResume(args: string[]): Promise<void> {
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
      await preflightIfNeeded({ store, inst, loaded, runId: run.run_id, clock: new SystemClock() });
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
      store.releaseOrchestratorToPending(run.run_id, null, now);
      store.setRunStatus(run.run_id, "running", now, null);
      break;
    }
    case "agent_requested":
    case "orchestrator":
    case "operator": {
      // A fresh attempt when the node is repeat-safe; one manual bound extension.
      const loaded = loadAndValidateDefinition(join(run.run_dir, "definition.yaml"));
      const chain = loaded.chain;
      const attempts = store.listAttempts(run.run_id).filter((a) => a.status === "blocked");
      const blocked = attempts[attempts.length - 1];
      if (!blocked) die("blocked run has no blocked attempt");
      const fresh = store.createRetryAttempt({
        runId: run.run_id,
        nodeId: blocked.node_id,
        previousAttempt: blocked.attempt,
        packetPath: join("packets", `${blocked.node_id}-attempt-${blocked.attempt + 1}.md`),
        resolvedMaxAttempts: blocked.resolved_max_attempts + 1, // one manual extension
        resolvedTimeoutMs: blocked.resolved_timeout_ms,
        chainPosition: loaded.chain.order.indexOf(blocked.node_id),
        now,
      });
      if (fresh) {
        const { scaffoldPacket } = await import("./worklog/worklog.js");
        scaffoldPacket(run.run_dir, blocked.node_id, fresh.attempt, chain.next.get(blocked.node_id) ?? null);
      }
      store.setRunStatus(run.run_id, "running", now, null);
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
  const resolved = (await import("./runner/attempt.js")).resolveNode(loaded.def, nextId, inst);
  const { scaffoldPacket, packetPath } = await import("./worklog/worklog.js");
  const run = store.getRun(runId)!;
  scaffoldPacket(run.run_dir, nextId, 1, loaded.chain.next.get(nextId) ?? null);
  store.createSuccessorAttempt({
    runId,
    nodeId: nextId,
    packetPath: packetPath(run.run_dir, nextId, 1),
    resolvedMaxAttempts: resolved.maxAttempts,
    resolvedTimeoutMs: resolved.timeoutMs,
    chainPosition: loaded.chain.order.indexOf(nextId),
    now,
  });
}

function cmdStatus(args: string[]): void {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const dto = buildStatusDto(store, new SystemClock().now());
  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
  } else {
    process.stdout.write(renderStatusText(dto));
  }
  void positional;
}

/** Internal agent-facing commands. Owner-authenticated via environment. */
function cmdRuntime(args: string[]): void {
  const [sub, ...rest] = args;
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));

  const runId = process.env.WORKSHOP_RUN_ID;
  const nodeId = process.env.WORKSHOP_NODE_ID;
  const attempt = Number(process.env.WORKSHOP_ATTEMPT);
  const ownerToken = process.env.WORKSHOP_OWNER_TOKEN;
  if (!runId || !nodeId || !Number.isInteger(attempt) || !ownerToken) {
    die("runtime commands require WORKSHOP_RUN_ID, WORKSHOP_NODE_ID, WORKSHOP_ATTEMPT, WORKSHOP_OWNER_TOKEN");
  }
  const row = store.getAttempt(runId, nodeId, attempt);
  if (!row || row.owner_token !== ownerToken) {
    die("runtime command rejected: owner token does not match the live attempt");
  }
  const now = new SystemClock().now();

  if (sub === "progress") {
    const text = flagValue(rest, "--text") ?? "";
    if (!text) die("--text is required");
    const ok = store.setProgress({ runId, nodeId, attempt, ownerToken, progress: text, now });
    process.exit(ok ? 0 : 1);
  }
  if (sub === "block") {
    const kind = flagValue(rest, "--kind") ?? "agent_requested";
    const blockKind = blockKindFor(kind);
    if (!blockKind) die(`unknown block kind "${kind}"`);
    if (kind !== "agent_requested" && kind !== "unknown_external") {
      die(`runtime block supports agent_requested (default) or unknown_external, not "${kind}"`);
    }
    const reason = flagValue(rest, "--reason") ?? "";
    if (!reason) die("--reason is required");
    const ok = store.blockAttempt({ runId, nodeId, attempt, ownerToken, blockKind, reason, now });
    process.exit(ok ? 0 : 1);
  }
  die(`unknown runtime subcommand "${sub}" (expected progress or block)`);
}

function flagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

/** Most recent run by seq; prints its worklog, optionally tailing to completion. */
async function cmdLogs(args: string[]): Promise<void> {
  const follow = args.includes("--follow");
  const workflowId = requireArg(args.filter((a) => !a.startsWith("--")), "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const run = store.getMostRecentRun(workflowId);
  if (!run) die(`no runs for workflow "${workflowId}"`);

  process.stdout.write(readFileSync(run.worklog_path, "utf8"));
  if (!follow) return;

  // Tail: print appended worklog lines until the run reaches a terminal state.
  let offset = (readFileSync(run.worklog_path, "utf8")).length;
  for (;;) {
    const fresh = store.getRun(run.run_id)!;
    const content = readFileSync(fresh.worklog_path, "utf8");
    if (content.length > offset) {
      process.stdout.write(content.slice(offset));
      offset = content.length;
    }
    if (isTerminal(fresh.status)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Chain rendering with runtime status; --mermaid emits a flowchart. */
function cmdDiagram(args: string[]): void {
  const mermaid = args.includes("--mermaid");
  const workflowId = requireArg(args.filter((a) => !a.startsWith("--")), "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const wf = store.getWorkflow(workflowId);
  if (!wf) die(`no workflow "${workflowId}"`);
  const run = store.getMostRecentRun(workflowId);
  const loaded = loadAndValidateDefinition(wf.canonical_definition_hash === "" ? workflowPath(inst, workflowId) : join(run?.run_dir ?? "", "definition.yaml"));
  const nodeStatus = new Map<string, string>();
  if (run) {
    for (const attempt of store.listAttempts(run.run_id)) {
      const existing = nodeStatus.get(attempt.node_id);
      const rank = (s: string) => (s === "completed" ? 0 : s === "failed" || s === "blocked" || s === "cancelled" ? 1 : 2);
      if (!existing || rank(attempt.status) < rank(existing)) nodeStatus.set(attempt.node_id, attempt.status);
    }
  }

  if (mermaid) {
    const lines = ["flowchart LR"];
    for (const id of loaded.chain.order) {
      const status = nodeStatus.get(id);
      const label = status ? `${id} [${status}]` : id;
      lines.push(`  ${id.replaceAll("-", "_")}["${label}"]`);
      const next = loaded.chain.next.get(id);
      if (next) lines.push(`  ${id.replaceAll("-", "_")} --> ${next.replaceAll("-", "_")}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    const parts = loaded.chain.order.map((id) => {
      const status = nodeStatus.get(id);
      const glyph = status === "completed" ? "◉" : status === "failed" ? "✗" : status === "blocked" ? "⊘" : status ? "◎" : "○";
      return `${glyph} ${id}${status ? ` (${status})` : ""}`;
    });
    process.stdout.write(parts.join(" → ") + "\n");
  }
}

/** Snapshot properties + resolved settings + runtime status for one node. */
function cmdNode(args: string[]): void {
  const [sub, workflowId, nodeId] = args;
  if (sub !== "describe" || !workflowId || !nodeId) die("usage: workshop node describe <workflow-id> <node-id> [--json]");
  const json = args.includes("--json");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const run = store.getMostRecentRun(workflowId);
  const snapshotPath = run ? join(run.run_dir, "definition.yaml") : workflowPath(inst, workflowId);
  const loaded = loadAndValidateDefinition(snapshotPath);
  const node = loaded.def.nodes[nodeId];
  if (!node) die(`no node "${nodeId}" in ${workflowId}`);
  const resolved = resolveNode(loaded.def, nodeId, inst);
  const attempts = run ? store.listAttempts(run.run_id).filter((a) => a.node_id === nodeId) : [];

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          id: nodeId,
          run: resolved.run.kind === "command" ? { command: resolved.run.command } : { agent: { model: resolved.run.resolution.model?.full, instructions: resolved.run.agent.instructions } },
          validator: resolved.validator
            ? resolved.validator.kind === "command"
              ? { command: resolved.validator.command, timeoutMs: resolved.validator.timeoutMs }
              : { agent: { model: resolved.validator.resolution.model?.full } }
            : null,
          successor: loaded.chain.next.get(nodeId) ?? null,
          resolvedMaxAttempts: resolved.maxAttempts,
          resolvedTimeoutMs: resolved.timeoutMs,
          attempts: attempts.map((a) => ({ number: a.attempt, status: a.status, failure: a.failure_kind, progress: a.current_progress, validator: a.validator_status })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [
    `Node      ${nodeId}`,
    `Run       ${resolved.run.kind === "command" ? "command" : "agent"}${resolved.run.kind === "command" ? ": " + resolved.run.command : ""}`,
    `Successor ${loaded.chain.next.get(nodeId) ?? "(end)"}`,
    `Attempts  ≤ ${resolved.maxAttempts} · timeout ${resolved.timeoutMs ?? "unlimited"}ms`,
  ];
  for (const a of attempts) {
    lines.push(`  #${a.attempt} ${a.status}${a.failure_kind ? ` (${a.failure_kind})` : ""}${a.current_progress ? ` — ${a.current_progress}` : ""}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

process.on("unhandledRejection", (e) => {
  die(errorText(e));
});

main().catch((e) => {
  die(errorText(e));
});

void STATUS_DTO_VERSION;
