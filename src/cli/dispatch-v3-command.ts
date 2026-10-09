import { findInstallation, ensureDirs } from "../load-installation.js";
import { DaemonLockHeld } from "../daemon/acquire-daemon-lock.js";
import { cmdRuntime } from "./agent-callbacks.js";
import { die } from "./errors.js";
import { cmdDiagram, cmdLogs, cmdNode, cmdRuns, cmdStatus, cmdValidate } from "./inspect.js";
import { cmdPause, cmdResume, cmdStart, cmdStop } from "./run-controls.js";
import { cmdWatch } from "./watch.js";

/**
 * Legacy v3 CLI, reached with `--engine v3` or by an agent's
 * `"$WORKSHOP_CLI" runtime ...` callback. Public surface:
 *   help | validate | start | pause | resume | stop | status |
 *   node describe | logs | diagram | orchestrate
 * Internal (agent-facing, not in help):
 *   runtime progress | runtime block
 */
const HELP = `workshop v3 — legacy SQLite runner, kept as an explicit fallback

Usage: workshop --engine v3 <command> [args]
Unqualified commands use the default v4 engine; see \`workshop help\`.
This engine reads version 1 YAML and the existing .workshop/state/workshop.db.

Commands:
  workshop --engine v3 help
      List commands and briefly explain each one.

  workshop --engine v3 validate <workflow-id>
      Validate the current YAML definition and print warnings; it does not run
      environment preflight.

  workshop --engine v3 start <workflow-id>
      Start a one-shot run, or enable recurrence and start run 1 immediately.
      Idempotent while a run is unresolved.

  workshop --engine v3 pause <workflow-id>
      Disable future occurrences, let the current node finish, and pause
      before its successor.

  workshop --engine v3 resume <workflow-id>
      Continue a paused or repaired run and re-enable its schedule.

  workshop --engine v3 stop <workflow-id>
      Disable future occurrences, abort the active process, and cancel the run.

  workshop --engine v3 status [<workflow-id>] [--json]
      Show workflows, activations, and each workflow's unresolved current run
      with its nodes, attempts, progress, validators, and blockers.

  workshop --engine v3 node describe <workflow-id> <node-id> [--json]
      Show the run's YAML snapshot properties, resolved agent settings,
      successor, validator, and runtime status.

  workshop --engine v3 logs <workflow-id> [--follow | --all]
      Print or follow the workflow's most recent run: its WORKLOG.md and
      process logs. --all instead collates every run's worklog, oldest first,
      each under a run header.

  workshop --engine v3 runs <workflow-id> [--all] [--json]
      List the workflow's occurrences, newest first, with status and timing;
      --json emits the versioned runs feed.

  workshop --engine v3 watch [<workflow-id>]
      Follow one workflow live: its chain, its log stream, and its occurrences,
      refreshed as the run progresses. Omit the id to pick from the configured
      workflows first.

  workshop --engine v3 diagram <workflow-id> [--mermaid]
      Render the current chain and overlay runtime status.

  workshop --engine v3 orchestrate
      Run the deterministic guardian daemon in the foreground.
`;

export async function dispatchV3Command(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = [...rest];
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
