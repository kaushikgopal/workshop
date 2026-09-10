#!/usr/bin/env bun
import { findInstallation, ensureDirs, workflowPath } from "./config.js";
import { loadAndValidateDefinition, startWorkflow, runChain } from "./execute.js";
import { openDb } from "./store/db.js";
import { Store, GuardRejected } from "./store/store.js";
import { buildStatusDto, renderStatusText, STATUS_DTO_VERSION } from "./status/dto.js";
import { blockKindFor } from "./runner/attempt.js";
import { SystemClock } from "./util/clock.js";

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
    case "resume":
    case "stop":
    case "logs":
    case "diagram":
    case "orchestrate":
      die(`"${command}" is not implemented yet — it lands in a later work package`);
    default:
      process.stdout.write(HELP);
      die(`unknown command "${command}"`);
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
  const final = await runChain({ store, inst, loaded, runId: started.runId, cliPath: cliPathOf() });
  process.stdout.write(`run ${final.run_id} → ${final.status}\n`);
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

function cliPathOf(): string {
  // Unquoted-expansion friendly: "bun /abs/path/cli.ts".
  const script = process.argv[1];
  return script ? `bun ${new URL(`file://${script}`).pathname}` : "workshop";
}
process.on("unhandledRejection", (e) => {
  die(errorText(e));
});

main().catch((e) => {
  die(errorText(e));
});

void STATUS_DTO_VERSION;
