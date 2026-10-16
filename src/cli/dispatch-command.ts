import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { checkDefinitionText } from "../definition/check-definition.js";
import { errorText } from "./errors.js";

const HELP = `workshop — local agent workflows on a durable background service

Usage: workshop <command> [args]
Workflows live in .workshop/workflows/<id>.yaml; machine defaults in .workshop/workshop.yaml.

Commands:
  validate <path>
      Check a YAML workflow file directly, without an installation or service.
  start <workflow> [--detach]
      Admit a run; wait for its result unless detached.
  pause <workflow>
      Pause new work and let the active step finish.
  resume <workflow>
      Resume a paused run.
  stop <workflow>
      Stop activation and cancel only after safe task cleanup.
  resolve <workflow> --action retry|accept|fail --reason <text> [options]
      Resolve only the actions permitted by the block kind after confirmed cleanup.
      retry grants one attempt outside retries; verifier_failed reruns only the verifier.
      Unknown effects require --allow-repeat for retry.
      accept requires --result-file <path> --acknowledge-effects for external_outcome_unknown.
      Supply UTF-8 text or tagged worker output in the step result mode.
      Format 4 does not support --extra-attempt or --target judgment.
  reply <workflow> --continue|--reject --answer TEXT
      Reply to the current human wait with an explicit decision.
  chat
      Open the shared bot conversation and pending decisions.
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
      return usage("usage: workshop validate <path>");
    }
    try {
      const sourcePath = resolve(rest[0]!);
      const extension = extname(sourcePath);
      if (extension !== ".yaml" && extension !== ".yml") {
        throw new Error("expected a path to a .yaml or .yml workflow file");
      }
      const workflowId = basename(sourcePath, extension);
      const workflow = checkDefinitionText(readFileSync(sourcePath, "utf8"), sourcePath, workflowId);
      process.stdout.write(`valid workflow ${JSON.stringify(workflowId)} (${workflow.chain.order.length} steps)\n`);
    } catch (error) {
      console.error(`error: ${errorText(error)}`);
      process.exitCode = 64;
    }
    return;
  }

  if (command === "start" || command === "pause" || command === "resume" || command === "stop" || command === "resolve" || command === "reply" || command === "chat" || command === "status" || command === "runs" || command === "logs" || command === "diagram" || command === "watch" || (command === "step" && rest[0] === "describe")) {
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
