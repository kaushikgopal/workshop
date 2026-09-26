import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export interface TestInstallation {
  root: string;
  workflowsDir: string;
  stateDir: string;
  dbPath: string;
}

/** Create a disposable Workshop installation with the given workflow YAML. */
export function makeInstallation(workflows: Record<string, string>): TestInstallation {
  const root = mkdtempSync(join(tmpdir(), "workshop-test-"));
  const configDir = join(root, ".workshop", "config");
  const workflowsDir = join(configDir, "workflows");
  const stateDir = join(root, ".workshop", "state");
  mkdirSync(workflowsDir, { recursive: true });
  for (const [id, yaml] of Object.entries(workflows)) {
    writeFileSync(join(workflowsDir, `${id}.yaml`), yaml, "utf8");
  }
  return { root, workflowsDir, stateDir, dbPath: join(stateDir, "workshop.db") };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the workshop CLI against an installation. */
export function runCli(inst: TestInstallation, args: string, timeoutMs = 60_000): CliResult {
  const r = spawnSync("bun", [join(REPO_ROOT, "src/cli/main.ts"), ...args.split(" ").filter(Boolean)], {
    cwd: inst.root,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env },
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
  };
}

export const MOCK_HARNESS = join(REPO_ROOT, "tests/mock/harness.ts");

export function mockAgentHarness(): string {
  return `bun ${MOCK_HARNESS}`;
}

export function readWorklog(inst: TestInstallation, runId: string): string {
  return readFileSync(join(inst.root, ".workshop/state/runs", runId, "WORKSHOP_LOG.md"), "utf8");
}

export function readRunDb(inst: TestInstallation): unknown[] {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(inst.dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM runs ORDER BY seq").all();
  } finally {
    db.close();
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function dbAttempts(inst: TestInstallation, runId: string): Array<Record<string, unknown>> {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(inst.dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM node_attempts WHERE run_id = ? ORDER BY node_id, attempt").all(runId) as Array<
      Record<string, unknown>
>;
  } finally {
    db.close();
  }
}

export function dbRuns(inst: TestInstallation): Array<Record<string, unknown>> {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(inst.dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM runs ORDER BY seq").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}
