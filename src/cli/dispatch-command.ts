import { loadCheckedWorkflow, findInstallation } from "../installation/load-installation.js";
import { errorText } from "./errors.js";

const HELP = `workshop — local agent workflows on a durable background service

Usage: workshop <command> [args]
Workflows live in .workshop/workflows/<id>.yaml; machine defaults in .workshop/workshop.yaml.

Commands:
  validate <workflow>
      Check workflow YAML and resolved settings without starting the service.
  start <workflow> [--detach]
      Admit a run; wait for its result unless detached.
  pause <workflow>
      Pause new work and let the active step finish.
  resume <workflow>
      Resume a paused run.
  stop <workflow>
      Stop activation and cancel only after safe task cleanup.
  resolve <workflow> --action retry|accept|fail --reason <text> [options]
      Explicitly resolve a blocked run after process cleanup is confirmed.
  status [<workflow>] [--json]
      Read service-backed workflow state.
  runs <workflow> [--json] [--all]
      Read paged run history.
  logs <workflow> [--run <run-id>] [--follow | --all] [--json | --verbose]
      Read, follow, or collate selected worklogs and process captures.
  diagram <workflow> [--run <run-id>] [--mermaid]
      Render a checked chain with the selected run's status.
  step describe <workflow> <step> [--run <run-id>] [--json]
      Read frozen settings and execution evidence for one step.
  watch [<workflow>]
      Follow the selected run, or choose a workflow from the service-backed list.
  service start | serve | status [--json] | stop
      Start the detached service owner (idempotent), serve it in the
      foreground, read its health and identity, or shut it down gracefully.
      The service runs schedules.
`;

/** Route one command line; help and validate stay offline, and unknown commands fail closed. */
export async function dispatchCommand(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "validate") {
    if (rest.length !== 1) {
      return usage("usage: workshop validate <workflow>");
    }
    try {
      const installation = findInstallation();
      const workflow = loadCheckedWorkflow(installation, rest[0]!);
      process.stdout.write(`valid workflow ${JSON.stringify(workflow.workflowId)} (${workflow.chain.order.length} steps)\n`);
    } catch (error) {
      console.error(`error: ${errorText(error)}`);
      process.exitCode = 64;
    }
    return;
  }

  if (command === "start" || command === "pause" || command === "resume" || command === "stop" || command === "resolve" || command === "status" || command === "runs" || command === "logs" || command === "diagram" || command === "watch" || (command === "step" && rest[0] === "describe")) {
    const { dispatchPublicCommand } = await import("./dispatch-public-command.js");
    return dispatchPublicCommand(command === "step" ? "step.describe" : command, command === "step" ? rest.slice(1) : rest);
  }
  if (command === "service") {
    const { cmdService } = await import("./service.js");
    return cmdService(rest);
  }
  return usage(`unknown command: ${command}; run \`workshop help\``);
}

function usage(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 64;
}
