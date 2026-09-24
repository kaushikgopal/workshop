import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseStrictYaml } from "./definition/parse.js";
import { machineConfigSchema, type MachineConfig } from "./definition/schema.js";
import { parseDuration } from "./util/duration.js";
import { DEFAULT_STREAM_CAP_BYTES, parseByteSize, type StreamCap } from "./util/retention.js";

export interface Installation {
  /** Directory containing .workshop/ */
  root: string;
  /** Directory commands run in; defaults to root. */
  projectDir: string;
  configDir: string;
  workflowsDir: string;
  stateDir: string;
  dbPath: string;
  runsDir: string;
  shell: string;
  maxConcurrentRuns: number;
  defaultTimeoutMs: number;
  /** Byte cap for one captured raw stream; "unlimited" opts out. */
  streamCapBytes: StreamCap;
  /** Raw machine agent block for agent resolution. */
  machineAgent: { harness?: { command: string }; model?: string } | undefined;
}

/** Walk up from cwd (or `from`) until a .workshop directory is found. */
export function findInstallation(from: string = process.cwd()): Installation {
  let dir = resolve(from);
  for (;;) {
    const ws = join(dir, ".workshop");
    if (existsSync(ws)) return loadInstallation(dir);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no Workshop installation found — expected .workshop/ in "${resolve(from)}" or an ancestor`,
      );
    }
    dir = parent;
  }
}

export function loadInstallation(root: string): Installation {
  const ws = join(root, ".workshop");
  const configDir = join(ws, "config");
  const workflowsDir = join(configDir, "workflows");
  const stateDir = join(ws, "state");
  const configPath = join(configDir, "workshop.yaml");

  let cfg: MachineConfig = {};
  if (existsSync(configPath)) {
    const raw = parseStrictYaml(readFileSync(configPath, "utf8"), configPath);
    cfg = machineConfigSchema.parse(raw);
  }

  // Relative paths resolve from the configuration file.
  const projectDir = cfg.project_dir ? resolve(configDir, cfg.project_dir) : root;

  return {
    root,
    projectDir,
    configDir,
    workflowsDir,
    stateDir,
    dbPath: join(stateDir, "workshop.db"),
    runsDir: join(stateDir, "runs"),
    shell: cfg.shell ?? "/bin/bash",
    maxConcurrentRuns: cfg.max_concurrent_runs ?? 1,
    defaultTimeoutMs: cfg.default_timeout ? parseDuration(cfg.default_timeout) : 10 * 60_000,
    streamCapBytes: cfg.stream_cap ? parseByteSize(cfg.stream_cap) : DEFAULT_STREAM_CAP_BYTES,
    machineAgent: cfg.agent,
  };
}

export function ensureDirs(inst: Installation): void {
  for (const dir of [inst.configDir, inst.workflowsDir, inst.stateDir, inst.runsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Resolve a workflow id to its YAML path in the installation. */
export function workflowPath(inst: Installation, workflowId: string): string {
  return join(inst.workflowsDir, `${workflowId}.yaml`);
}
