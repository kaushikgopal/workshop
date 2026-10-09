#!/usr/bin/env bun
import { findInstallation, ensureDirs } from "../load-installation.js";
import { DaemonLockHeld } from "../daemon/acquire-daemon-lock.js";
import { cmdRuntime } from "./agent-callbacks.js";
import { die, errorText } from "./errors.js";
import { cmdDiagram, cmdLogs, cmdNode, cmdRuns, cmdStatus, cmdValidate } from "./inspect.js";
import { cmdPause, cmdResume, cmdStart, cmdStop } from "./run-controls.js";
import { cmdWatch } from "./watch.js";

/**
 * Workshop CLI. Public surface:
 *   help | validate | start | pause | resume | stop | status |
 *   node describe | logs | diagram | orchestrate
 * Internal (agent-facing, not in help):
 *   runtime progress | runtime block
 */
const HELP = `workshop — durable linked-list runner for agent workflows

Usage: workshop [--engine v4] <command> [args]
The default engine remains v3; --engine v4 selects the experimental Durable route.

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
      Print or follow the workflow's most recent run: its WORKLOG.md and
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

type EngineSelection =
  | { readonly engine: "v3" | "v4"; readonly args: readonly string[] }
  | { readonly error: string };

function selectEngine(argv: readonly string[]): EngineSelection {
  if (argv[0] === "--engine") {
    const engine = argv[1];
    if (engine === undefined) return { error: "missing engine after --engine; expected v4" };
    if (engine !== "v4") return { error: `unsupported engine ${JSON.stringify(engine)}; omit --engine for v3 or choose v4` };
    const args = argv.slice(2);
    if (args.some(isEngineOption)) return { error: "--engine may be specified only once and must lead the command" };
    return { engine: "v4", args };
  }
  if (argv.some(isEngineOption)) return { error: "--engine must lead the command; use --engine v4" };
  return { engine: "v3", args: argv };
}

function isEngineOption(value: string): boolean {
  return value === "--engine" || value.startsWith("--engine=");
}

async function main(): Promise<void> {
  const selection = selectEngine(process.argv.slice(2));
  if ("error" in selection) {
    console.error(`error: ${selection.error}`);
    process.exitCode = 64;
    return;
  }
  if (selection.engine === "v4") {
    const { dispatchV4Command } = await import("./dispatch-v4-command.js");
    return dispatchV4Command(selection.args);
  }
  const [command, ...args] = selection.args;
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
      const { reconcileForever } = await import("../daemon/reconcile-loop.js");
      try {
        await reconcileForever(inst);
      } catch (e) {
        if (e instanceof DaemonLockHeld) die(e.message);
        throw e;
      }
      return;
    }
  }
}

process.on("unhandledRejection", (e) => {
  die(errorText(e));
});

main().catch((e) => {
  die(errorText(e));
});
