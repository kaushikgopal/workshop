import { fileURLToPath } from "node:url";
import { findInstallation, type Installation } from "../installation/load-installation.js";
import { launchServiceProcess } from "../service/launch-service-process.js";
import { probeServiceHealth } from "../service/probe-service-health.js";
import { ServiceConnectionError } from "../service/send-service-request.js";
import { stopServiceProcess } from "../service/stop-service-process.js";
import type { ServiceMetadataV1 } from "../service/schema.js";
import { errorText } from "./errors.js";

const CLI_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const USAGE = "usage: workshop service start | serve | status [--json] | stop";

/** `workshop service start|status|stop`; `serve` stays in the service process module. */
export async function cmdService(args: readonly string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "serve") {
    const { serveServiceProcess } = await import("../service/serve-service-process.js");
    return serveServiceProcess(args);
  }
  if (subcommand === "status") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) return fail(64, USAGE);
    const installation = findInstallationForCommand();
    if (installation === null) return;
    return statusCommand(installation, rest[0] === "--json");
  }
  if ((subcommand === "start" || subcommand === "stop") && rest.length === 0) {
    const installation = findInstallationForCommand();
    if (installation === null) return;
    return subcommand === "start" ? startCommand(installation) : stopCommand(installation);
  }
  return fail(64, USAGE);
}

async function startCommand(installation: Installation): Promise<void> {
  try {
    const launched = await launchServiceProcess({
      root: installation.root,
      stateDirectory: installation.stateDirectory,
      serveArguments: [CLI_PATH, "service", "serve"],
    });
    const verb = launched._tag === "started" ? "started" : "already running";
    process.stdout.write(`service ${verb} (${describeIdentity(launched.metadata)})\n`);
  } catch (error) {
    fail(error instanceof ServiceConnectionError ? 3 : 1, errorText(error));
  }
}

async function statusCommand(installation: Installation, json: boolean): Promise<void> {
  const probe = await probeServiceHealth(installation.stateDirectory);
  if (probe.kind === "ready") {
    const { pid, bootId, startedAt, socketPath } = probe.metadata;
    if (json) process.stdout.write(`${JSON.stringify({ version: 1, state: "ready", pid, bootId, startedAt, socketPath }, null, 2)}\n`);
    else process.stdout.write(`service ready (${describeIdentity(probe.metadata)})\n  started ${startedAt}\n  socket  ${socketPath}\n`);
    return;
  }
  if (json) process.stdout.write(`${JSON.stringify({ version: 1, state: "not_running", reason: probe.reason }, null, 2)}\n`);
  else process.stdout.write(`service not running (${probe.reason})\n`);
  process.exitCode = 3;
}

async function stopCommand(installation: Installation): Promise<void> {
  const result = await stopServiceProcess(installation.stateDirectory);
  switch (result._tag) {
    case "not_running":
      process.stdout.write(`service is not running (${result.reason})\n`);
      return;
    case "stopped":
      process.stdout.write(`service stopped (${describeIdentity(result.metadata)})\n`);
      return;
    case "unverified":
      return fail(3, result.reason);
    case "shutdown_failed":
      return fail(3, `service ${describeIdentity(result.metadata)} could not finish graceful shutdown and still holds ownership`);
    case "timed_out":
      return fail(3, `service ${describeIdentity(result.metadata)} did not exit before the stop deadline`);
  }
}

function describeIdentity(metadata: ServiceMetadataV1): string {
  return `pid ${metadata.pid}, boot ${metadata.bootId}`;
}

function findInstallationForCommand(): Installation | null {
  try {
    return findInstallation();
  } catch (error) {
    fail(64, errorText(error));
    return null;
  }
}

function fail(exitCode: number, message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = exitCode;
}
