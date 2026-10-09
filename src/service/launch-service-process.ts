import { spawn } from "node:child_process";
import { probeServiceHealth } from "./probe-service-health.js";
import { ServiceConnectionError } from "./send-service-request.js";
import type { ServiceMetadataV1 } from "./schema.js";

const DEFAULT_START_TIMEOUT_MS = 10_000;

export interface LaunchServiceInput {
  readonly root: string;
  readonly stateDirectory: string;
  /** Argument vector after the Bun executable that runs `service serve` in the foreground. */
  readonly serveArguments: readonly string[];
  readonly timeoutMs?: number;
}

export type LaunchServiceResult =
  | { readonly _tag: "already_running"; readonly metadata: ServiceMetadataV1 }
  | { readonly _tag: "started"; readonly metadata: ServiceMetadataV1 };

/** Reuse a healthy owner, or spawn a detached one and wait for health readiness. */
export async function launchServiceProcess(input: LaunchServiceInput): Promise<LaunchServiceResult> {
  const existing = await probeServiceHealth(input.stateDirectory);
  if (existing.kind === "ready") return { _tag: "already_running", metadata: existing.metadata };
  const child = spawn(process.execPath, [...input.serveArguments], {
    cwd: input.root,
    detached: true,
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  child.unref();

  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (spawnError !== undefined) throw new ServiceConnectionError("could not start the service", { cause: spawnError });
    if (child.exitCode !== null) throw new ServiceConnectionError(`service exited during startup with code ${child.exitCode}`);
    const probe = await probeServiceHealth(input.stateDirectory, 500);
    if (probe.kind === "ready") return { _tag: "started", metadata: probe.metadata };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const finalProbe = await probeServiceHealth(input.stateDirectory, 500);
  if (finalProbe.kind === "ready") return { _tag: "started", metadata: finalProbe.metadata };
  throw new ServiceConnectionError(`service did not become ready: ${finalProbe.reason}`);
}
