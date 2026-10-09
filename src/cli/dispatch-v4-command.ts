import { loadCheckedV2Workflow, findV2Installation } from "../installation/load-v2-installation.js";
import { errorText } from "./errors.js";

const HELP = `workshop — local agent workflows on a durable background service

Usage: workshop <command> [args]
Workflows and the machine config are version 2 YAML under .workshop/config/.

Commands:
  validate <workflow>
      Check workflow YAML and resolved settings without starting the service.
  start <workflow> [--detach]
      Admit a run; wait for its result unless detached.
  pause <workflow>
      Pause new work and let the active node finish.
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
  logs <workflow> [--run <run-id>] [--follow | --all] [--json]
      Read, follow, or collate selected worklogs and process captures.
  diagram <workflow> [--run <run-id>] [--mermaid]
      Render a checked chain with the selected run's status.
  node describe <workflow> <node> [--run <run-id>] [--json]
      Read frozen settings and execution evidence for one node.
  watch [<workflow>]
      Follow the selected run, or choose a workflow from the service-backed list.
  service start | serve | status [--json] | stop
      Start the detached service owner (idempotent), serve it in the
      foreground, read its health and identity, or shut it down gracefully.
      The service runs schedules.
`;

/** Route one command line; help and validate stay offline, and unknown commands fail closed. */
export async function dispatchV4Command(args: readonly string[]): Promise<void> {
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
      const installation = findV2Installation();
      const workflow = loadCheckedV2Workflow(installation, rest[0]!);
      process.stdout.write(`valid workflow ${JSON.stringify(workflow.workflowId)} (${workflow.chain.order.length} nodes)\n`);
    } catch (error) {
      console.error(`error: ${errorText(error)}`);
      process.exitCode = 64;
    }
    return;
  }

  if (command === "start" || command === "pause" || command === "resume" || command === "stop" || command === "resolve" || command === "status" || command === "runs" || command === "logs" || command === "diagram" || command === "watch" || (command === "node" && rest[0] === "describe")) {
    const { dispatchV4PublicCommand } = await import("./dispatch-v4-public-command.js");
    return dispatchV4PublicCommand(command === "node" ? "node.describe" : command, command === "node" ? rest.slice(1) : rest);
  }
  if (command === "service") {
    const { cmdService } = await import("./service-v4.js");
    return cmdService(rest);
  }
  return usage(`unknown command: ${command}; run \`workshop help\``);
}

function usage(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 64;
}
