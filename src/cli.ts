#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { findInstallation, ensureDirs, workflowPath, type Installation } from "./config.js";
import { join } from "node:path";
import { loadAndValidateDefinition, startWorkflow, runChain, preflightIfNeeded, scaffoldFirstAttempt } from "./execute.js";
import { openDb } from "./store/db.js";
import { Store, GuardRejected, type AttemptRow } from "./store/store.js";
import { buildNodesForRun, buildStatusDto } from "./status/dto.js";
import { renderTreeStatus } from "./status/tree.js";
import { glyph, localClock } from "./status/format.js";
import { buildRunsFeed, DEFAULT_RUNS_LIMIT } from "./status/runs-feed.js";
import type { ViewerSource } from "./tui-source.js";
import { resolveNode } from "./runner/attempt.js";
import { deriveNodeStatus } from "./status/node-status.js";
import { attemptFolderOfPacket } from "./worklog/worklog.js";
import { isTerminal } from "./store/store.js";
import { blockKindFor } from "./runner/attempt.js";
import { SystemClock } from "./util/clock.js";
import { runtimeCliInvocation } from "./util/cli-path.js";
import { readTruncationRecord } from "./util/retention.js";
import { DaemonLockHeld } from "./daemon.js";
import { die, errorText, requireArg } from "./cli-io.js";
import { cmdDiagram, cmdLogs, cmdNode, cmdRuns, cmdStatus } from "./cli-inspect.js";

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

  workshop logs <workflow-id> [--follow | --all]
      Print or follow the workflow's most recent run: its WORKSHOP_LOG.md and
      process logs. --all instead collates every run's worklog, oldest first,
      each under a run header.

  workshop runs <workflow-id> [--all] [--json]
      List the workflow's occurrences, newest first, with status and timing;
      --json emits the versioned runs feed.

  workshop watch [<workflow-id>]
      Follow one workflow live: its chain, its log stream, and its occurrences,
      refreshed as the run progresses. Omit the id to pick from the configured
      workflows first.



  workshop diagram <workflow-id> [--mermaid]
      Render the current chain and overlay runtime status.

  workshop orchestrate
      Run the deterministic guardian daemon in the foreground.
`;




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
    case "runs":
      return cmdRuns(args);
    case "watch":
      return await cmdWatch(args);
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
  if (!run) {
    store.setActivationState(workflowId, "stopped");
    process.stdout.write(`stopped ${workflowId}: no unresolved run\n`);
    return;
  }

  // Commit schedule suppression and run stop intent before signalling any
  // group. Attempt/orchestrator ownership remains protected until confirmed
  // death allows the separate final-cancellation transaction.
  store.tx(() => {
    store.stopRun({ runId: run.run_id, now });
    store.setActivationState(workflowId, "stopped");
  });
  const { reconcileStoppedIntent } = await import("./recovery.js");
  const cancelled = await reconcileStoppedIntent({
    store, runId: run.run_id, clock: new SystemClock(),
  });
  if (!cancelled) {
    die(`stop intent recorded for ${run.run_id}, but a process group could not be confirmed dead; recovery will continue cancellation`);
  }
  process.stdout.write(`stopped ${workflowId}: run ${run.run_id} cancelled\n`);
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
      store.operatorResetOrchestrator(run.run_id, now);
      store.setRunStatus(run.run_id, "running", now, null);
      break;
    }
    case "agent_requested":
    case "orchestrator":
    case "operator": {
      // One transaction: clear the blocker and create the fresh retry attempt
      // for the latest blocked attempt (by execution sequence). The retry
      // carries one manual bound extension.
      const loaded = loadAndValidateDefinition(join(run.run_dir, "definition.yaml"));
      const fresh = store.resumeBlockedRun({ runId: run.run_id, now });
      if (!fresh) die("blocked run has no blocked attempt");
      const { scaffoldPacket, attemptFolderOfPacket } = await import("./worklog/worklog.js");
      scaffoldPacket(
        attemptFolderOfPacket(fresh.packet_path),
        fresh.attempt,
        loaded.chain.next.get(fresh.node_id) ?? null,
      );
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
  const run = store.getRun(runId)!;
  const fresh = store.createSuccessorAttempt({
    runId,
    nodeId: nextId,
    resolvedMaxAttempts: resolved.maxAttempts,
    resolvedTimeoutMs: resolved.timeoutMs,
    chainPosition: loaded.chain.order.indexOf(nextId),
    now,
  });
  const { scaffoldPacket, attemptFolderOfPacket } = await import("./worklog/worklog.js");
  scaffoldPacket(attemptFolderOfPacket(fresh.packet_path), fresh.attempt, loaded.chain.next.get(nextId) ?? null);
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

/**
 * The viewer's data source over the CLI's own projections. The viewer depends
 * on the projections, never on the store: `status --json` and `runs --json` are
 * the same builders this calls, and the log is the run's worklog.
 */
function viewerSourceFor(inst: Installation, store: Store): ViewerSource {
  return {
    async snapshot(workflowId) {
      return {
        // With no workflow chosen yet, every workflow is offered to the picker.
        status: buildStatusDto(store, new Date(), workflowId ?? undefined),
        // The picker draws only the workflow list, so an empty feed is honest
        // until a workflow is chosen. Per-workflow runs arrive after that.
        runs: buildRunsFeed({
          workflowId: workflowId ?? "",
          runs: workflowId ? store.listRuns(workflowId) : [],
          all: false,
          nodes: (runId) => buildNodesForRun(store, runId),
        }),
      };
    },
    async log(workflowId, runId) {
      if (runId === null) {
        const every = workflowId ? store.listRuns(workflowId) : [];
        return every.map((r) => `\n━━ run ${r.run_id} — ${r.status} ━━\n${readFileSync(r.worklog_path, "utf8")}`).join("");
      }
      const run = store.getRun(runId);
      return run ? readFileSync(run.worklog_path, "utf8") : "(run not found)";
    },
  };
}

/**
 * The runs feed: every occurrence of one workflow, newest first. The status
 * DTO carries only the unresolved current run, so the viewer needs this to
 * render a recurring workflow as the stream of occurrences a human reads.
 * `--all` lifts the default cap; `--json` emits the versioned shape.
 */
/**
 * The live viewer. It reads the same projections the CLI publishes and never
 * touches SQLite itself, so a second viewer (HTML, web) can be built from the
 * same contract without this code changing.
 */
async function cmdWatch(args: string[]): Promise<void> {
  // Omitting the workflow opens the picker instead of guessing which one.
  const workflowId = args.find((a) => !a.startsWith("--")) ?? null;
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  if (workflowId && !store.getWorkflow(workflowId)) die(`no workflow "${workflowId}"`);
  if (!workflowId && store.listWorkflows().length === 0) die("no workflows configured");
  const { runViewer } = await import("./tui-app.js");
  await runViewer({ workflowId, source: viewerSourceFor(inst, store) });
}

process.on("unhandledRejection", (e) => {
  die(errorText(e));
});

main().catch((e) => {
  die(errorText(e));
});
