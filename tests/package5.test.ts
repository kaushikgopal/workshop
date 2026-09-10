import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeInstallation, runCli, mockAgentHarness, dbRuns } from "./helpers.js";
import type { StatusDto } from "../src/status/dto.js";

const MOCK = mockAgentHarness();

/** Replace volatile values so the live DTO compares equal to the golden shape. */
function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^[a-z0-9-]+-\d{8}-\d{3}$/.test(value)) return "<run-id>";
    if (/^sha256:[0-9a-f]{64}$/.test(value)) return "<sha256>";
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return "<iso>";
    if (/^node-[a-z0-9-]+$/.test(value)) return "<node-id>";
    if (value === "halfway done") return "<progress-or-null>";
    if (value === "clock-fixture") return "<workflow-id>";
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

describe("gate 25 — stable status JSON", () => {
  test("status --json matches the golden fixture and its versioned TypeScript type", async () => {
    const inst = makeInstallation({
      "clock-fixture": `version: 1
id: clock-fixture
description: Two-node chain for the status fixture.
schedule:
  every: 10m
  max_runs: 6
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-timestamp:
    run:
      command: echo stamp
    validator:
      command: 'test -s "$WORKSHOP_NODE_OUTPUT_FILE"'
    next: node-generate
  node-generate:
    run:
      agent:
        instructions: |
          MOCK:progress=halfway done
          MOCK:block
    next: null
`,
    });

    // Start run 1 (completes node-timestamp, parks on the sleeping agent node).
    const child = spawn("bun", [join(import.meta.dir, "..", "src/cli.ts"), "start", "clock-fixture"], {
      cwd: inst.root,
      stdio: "ignore",
    });
    const poll = (): Array<Record<string, unknown>> => {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      if (!existsSync(inst.dbPath)) return [];
      const db = new Database(inst.dbPath, { readonly: true });
      try {
        return db.query("SELECT * FROM node_attempts").all() as Array<Record<string, unknown>>;
      } finally {
        db.close();
      }
    };
    const waitFor = async (cond: () => boolean): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error("waitFor timeout");
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await waitFor(() => poll().some((r) => r.node_id === "node-generate" && r.status === "running"));

    // Progress must be visible before the run ends.
    await waitFor(() => poll().some((r) => r.status === "blocked"));

    const dto = JSON.parse(runCli(inst, "status --json").stdout) as StatusDto;

    // The DTO parses as its versioned TypeScript type (compile-time contract,
    // exercised at runtime here) and matches the golden shape after
    // normalizing volatile values.
    const golden = JSON.parse(require("node:fs").readFileSync(join(import.meta.dir, "fixtures/status-v1.golden.json"), "utf8")) as unknown;
    expect(normalize(dto)).toEqual(golden);

    child.kill("SIGKILL");
  }, 60_000);
});
