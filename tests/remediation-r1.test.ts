import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  makeInstallation,
  runCli,
  mockAgentHarness,
  dbAttempts,
  dbRuns,
  REPO_ROOT,
  type CliResult,
  type TestInstallation,
} from "./helpers.js";
import { openDb } from "../src/storage/db/open-and-migrate.js";
import { Store, GuardRejected, type AttemptRow } from "../src/storage/db/store.js";
import { advanceChain } from "../src/run/advance-chain.js";
import { startWorkflow } from "../src/run/start-run.js";
import { loadAndValidateDefinition } from "../src/definition/load-definition.js";
import { findInstallation, ensureDirs } from "../src/load-installation.js";
import { recoverInstallation } from "../src/run/recover-after-crash.js";
import { SystemClock } from "../src/util/clock.js";
import { deriveNodeStatus } from "../src/views/derive-node-status.js";
import { buildStatusDto } from "../src/views/build-status-json.js";
import { renderTreeStatus } from "../src/views/render-status-tree.js";
import { runtimeCliInvocation } from "../src/attempt/build-attempt-env.js";
import { sha256File } from "../src/util/hash-content.js";
import { locatePacket } from "../src/storage/disk/locate-run-files.js";
import { attemptDirOfPacket } from "../src/storage/disk/locate-run-files.js";
import { atomicWriteFileSync } from "../src/storage/disk/write-crash-safe.js";
import { mergePacket } from "../src/worklog/merge-packet.js";
import { RunLock } from "../src/storage/disk/lock-run.js";

const MOCK = mockAgentHarness();

/** A mock orchestrator that applies the given decision (sentinel rides argv). */
function mockOrchestrator(decision: "retry" | "block" | "fail"): string {
  return `orchestrator:
  agent:
    harness:
      command: '${MOCK} MOCK:orchestrator=${decision}'
    model: "mock/mock-model:low"
`;
}

function blockerWorkflow(id: string): string {
  return `version: 1
id: ${id}
description: Agent requests a block.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-blocker:
    run:
      agent:
        instructions: |
          MOCK:block
    next: null
`;
}

// ---------------------------------------------------------------------------
// S1 — atomic blocked-run resume
// ---------------------------------------------------------------------------

describe("S1 — blocked-run resume", () => {
  test("resume atomically unblocks the run and creates the fresh retry attempt", () => {
    const inst = makeInstallation({ "blocker": blockerWorkflow("blocker") });
    const started = runCli(inst, "start blocker");
    expect(started.code).toBe(0);
    const runId = String(dbRuns(inst)[0]!.run_id);
    expect(dbRuns(inst)[0]!.status).toBe("blocked");

    const resumed = runCli(inst, "resume blocker");
    expect(resumed.code).toBe(0);

    const runs = dbRuns(inst);
    expect(runs[0]!.status).toBe("running");
    expect(runs[0]!.block_kind).toBeNull();

    const attempts = dbAttempts(inst, runId);
    expect(attempts.length).toBe(2);
    const retry = attempts.find((a) => a.attempt === 2)!;
    expect(retry.node_id).toBe("node-blocker");
    expect(retry.status).toBe("pending");
    expect(retry.execution_seq).toBe(2); // chronological spine continues
  }, 90_000);

  test("the retry is created for the latest blocked attempt by execution sequence", async () => {
    const inst = makeInstallation({ "blocker": blockerWorkflow("blocker") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "blocker.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));

    // Craft two blocked attempts on different nodes; execution order (not
    // node id or attempt number) must pick the resume target. The scaffolded
    // pending attempt is cancelled first — a blocked run has no live attempt.
    store.tx(() => {
      store.db
        .query("UPDATE node_attempts SET status = 'cancelled' WHERE run_id = ?")
        .run(started.runId);
      store.db
        .query(
          `INSERT INTO node_attempts (run_id, node_id, attempt, status, resolved_max_attempts, resolved_timeout_ms,
             chain_position, execution_seq, packet_path, updated_at)
           VALUES (?, 'node-a', 1, 'blocked', 2, 1000, 0, 1, '/tmp/a.md', ?),
                  (?, 'node-b', 1, 'blocked', 2, 1000, 1, 2, '/tmp/b.md', ?)`,
        )
        .run(started.runId, new Date().toISOString(), started.runId, new Date().toISOString());
      store.db
        .query("UPDATE runs SET status = 'blocked', block_kind = 'agent_requested' WHERE run_id = ?")
        .run(started.runId);
    });

    const fresh = store.resumeBlockedRun({ runId: started.runId, now: new Date() });
    expect(fresh).not.toBeNull();
    expect(fresh!.node_id).toBe("node-b"); // execution_seq 2, the latest
    expect(fresh!.attempt).toBe(2);
    const run = store.getRun(started.runId)!;
    expect(run.status).toBe("running");
    expect(run.block_kind).toBeNull();
  }, 30_000);

  test("a stopped blocked run refuses resume atomically — no partial state", async () => {
    const inst = makeInstallation({ "blocker": blockerWorkflow("blocker") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "blocker.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    store.stopRun({ runId: started.runId, now: new Date() });

    expect(() => store.resumeBlockedRun({ runId: started.runId, now: new Date() })).toThrow(GuardRejected);
    // Nothing partial: no fresh attempt appeared and the run stays cancelled.
    const attempts = dbAttempts(inst, started.runId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.status).toBe("cancelled");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S4 — WORKSHOP_CLI is a safely quoted single executable path
// ---------------------------------------------------------------------------

describe("S4 — quoted runtime CLI invocation", () => {
  test("the source invocation is one absolute executable path", () => {
    const original = process.argv[1]!;
    process.argv[1] = "/tmp/obrien's work shop/src/cli/main.ts";
    try {
      expect(runtimeCliInvocation()).toBe("/tmp/obrien's work shop/src/cli/main.ts");
    } finally {
      process.argv[1] = original;
    }
  });

  test("the mock harness reports progress through the quoted WORKSHOP_CLI", () => {
    const inst = makeInstallation({
      "progress": `version: 1
id: progress
description: Agent reports progress.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-progress:
    run:
      agent:
        instructions: |
          MOCK:progress=quoted invocation works
    next: null
`,
    });
    const r = runCli(inst, "start progress");
    expect(r.code).toBe(0);
    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    expect(dbAttempts(inst, runId)[0]!.current_progress).toBe("quoted invocation works");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// S5 — persisted attempt provenance under owner fencing
// ---------------------------------------------------------------------------

describe("S5 — resolved execution provenance", () => {
  test("every attempt persists its harness template, command, and model before execution", () => {
    const inst = makeInstallation({
      "chain": `version: 1
id: chain
description: Command node then agent node.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-cmd:
    run:
      command: echo "hello from node-cmd"
    next: node-agent
  node-agent:
    run:
      agent:
        instructions: |
          Write one deterministic line.
    next: null
`,
    });
    const r = runCli(inst, "start chain");
    expect(r.code).toBe(0);
    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];

    const cmd = dbAttempts(inst, runId).find((a) => a.node_id === "node-cmd")!;
    expect(cmd.resolved_harness_template).toBe(`echo "hello from node-cmd"`);
    expect(cmd.resolved_harness_command).toBe(`echo "hello from node-cmd"`);
    expect(cmd.resolved_model).toBeNull();

    const agent = dbAttempts(inst, runId).find((a) => a.node_id === "node-agent")!;
    expect(agent.resolved_harness_template).toContain("tests/mock/harness.ts");
    expect(agent.resolved_harness_command).toBe(agent.resolved_harness_template);
    expect(agent.resolved_model).toBe("mock/mock-model:low");
  }, 90_000);

  test("provenance recording is owner-fenced", async () => {
    const inst = makeInstallation({ "blocker": blockerWorkflow("blocker") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "blocker.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const claim = store.claimAttempt({ runId: started.runId, nodeId: "node-blocker", attempt: 1, now: new Date(), maxConcurrentRuns: 99 });

    const base = {
      runId: started.runId,
      nodeId: "node-blocker",
      attempt: 1,
      harnessTemplate: "t",
      harnessCommand: "c",
      model: "m",
      now: new Date(),
    };
    // A superseded owner cannot write provenance.
    expect(store.recordResolvedExecution({ ...base, ownerToken: "not-the-owner" })).toBe(false);
    const untouched = store.getAttempt(started.runId, "node-blocker", 1)!;
    expect(untouched.resolved_harness_command).toBeNull();
    // The accepted owner can.
    expect(store.recordResolvedExecution({ ...base, ownerToken: claim.ownerToken })).toBe(true);
    const recorded = store.getAttempt(started.runId, "node-blocker", 1)!;
    expect(recorded.resolved_harness_template).toBe("t");
    expect(recorded.resolved_harness_command).toBe("c");
    expect(recorded.resolved_model).toBe("m");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S6 — status [workflow-id] filtering
// ---------------------------------------------------------------------------

describe("S6 — workflow-scoped status", () => {
  test("JSON and human output filter to the given workflow; unknown ids are rejected", () => {
    const inst = makeInstallation({
      "alpha": `version: 1
id: alpha
description: One-shot completes.
nodes:
  node-only:
    run:
      command: echo done
    next: null
`,
      "beta": `version: 1
id: beta
description: Started, unresolved.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-blocker:
    run:
      agent:
        instructions: |
          MOCK:block
    next: null
`,
    });
    expect(runCli(inst, "start alpha").code).toBe(0);
    expect(runCli(inst, "start beta").code).toBe(0);

    const scoped = JSON.parse(runCli(inst, "status --json beta").stdout) as {
      workflows: Array<{ id: string; currentRun: { id: string } | null }>;
    };
    expect(scoped.workflows.map((w) => w.id)).toEqual(["beta"]);
    expect(scoped.workflows[0]!.currentRun).not.toBeNull();

    const all = JSON.parse(runCli(inst, "status --json").stdout) as { workflows: Array<{ id: string }> };
    expect(all.workflows.map((w) => w.id)).toEqual(["alpha", "beta"]);

    const human = runCli(inst, "status beta");
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("beta");
    expect(human.stdout).not.toContain("alpha");

    const unknownJson = runCli(inst, "status --json ghost");
    expect(unknownJson.code).toBe(1);
    expect(unknownJson.stderr).toContain("no workflow");

    const unknownHuman = runCli(inst, "status ghost");
    expect(unknownHuman.code).toBe(1);
    expect(unknownHuman.stderr).toContain("no workflow");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Human status — absolute timestamps render in the machine's local timezone
// ---------------------------------------------------------------------------
const NY = "America/New_York";

/** Run the CLI in a subprocess with a controlled TZ; the test process
 *  environment itself is never mutated, so no state needs restoring. */
function runCliWithTz(inst: TestInstallation, args: string, tz: string): CliResult {
  const r = spawnSync("bun", [join(REPO_ROOT, "src/cli/main.ts"), ...args.split(" ").filter(Boolean)], {
    cwd: inst.root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, TZ: tz },
  });
  return { code: r.status ?? -1, stdout: (r.stdout as string) ?? "", stderr: (r.stderr as string) ?? "" };
}

/** Pin exact UTC instants for the schedule cursor and the run's start. */
function pinTimestamps(inst: TestInstallation, runId: string, nextIso: string, startedIso: string): void {
  const db = openDb(inst.dbPath);
  try {
    db.query("UPDATE workflows SET next_run_at = ? WHERE workflow_id = 'tzclock'").run(nextIso);
    db.query("UPDATE runs SET started_at = ? WHERE run_id = ?").run(startedIso, runId);
  } finally {
    db.close();
  }
}

function tzClockWorkflow(id: string): string {
  return `version: 1
id: ${id}
description: Scheduled workflow that blocks, for timezone rendering.
schedule:
  every: 10m
  max_runs: 5
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-blocker:
    run:
      agent:
        instructions: |
          MOCK:block
    next: null
`;
}

describe("human status renders absolute timestamps in the machine's local timezone", () => {
  test("a prior-local-day next shows the local date; run start shows the local clock; JSON keeps UTC", () => {
    const inst = makeInstallation({ "tzclock": tzClockWorkflow("tzclock") });
    expect(runCli(inst, "start tzclock").code).toBe(0);
    const runId = (dbRuns(inst)[0] as { run_id: string }).run_id;
    // 02:30Z on Jan 1 is 21:30 on Dec 31 in New York — the prior local day.
    pinTimestamps(inst, runId, "2031-01-01T02:30:00Z", "2026-09-10T15:55:57Z");

    const human = runCliWithTz(inst, "status tzclock", NY);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("next 2030-12-31 21:30:00"); // local date + clock
    expect(human.stdout).toContain("11:55:57"); // started_at as the local clock
    expect(human.stdout).not.toContain("15:55:57"); // raw UTC clock of started_at
    expect(human.stdout).not.toContain("02:30:00"); // raw UTC clock of next
    expect(human.stdout).not.toContain("2031-01-01"); // raw UTC date of next

    const json = JSON.parse(runCliWithTz(inst, "status --json tzclock", NY).stdout) as {
      workflows: Array<{ activation: { nextRunAt: string | null } | null; currentRun: { startedAt: string } | null }>;
    };
    expect(json.workflows[0]!.activation!.nextRunAt).toBe("2031-01-01T02:30:00Z");
    expect(json.workflows[0]!.currentRun!.startedAt).toBe("2026-09-10T15:55:57Z");
  }, 90_000);

  test("a next occurrence renders the New York local clock, with the local date only across local days", () => {
    const inst = makeInstallation({ "tzclock": tzClockWorkflow("tzclock") });
    expect(runCli(inst, "start tzclock").code).toBe(0);
    const runId = (dbRuns(inst)[0] as { run_id: string }).run_id;
    const dueIso = new Date(Date.now() + 5 * 60_000).toISOString();
    pinTimestamps(inst, runId, dueIso, "2026-09-10T15:55:57Z");

    // New York renderings of the due instant via Intl with an explicit zone:
    // the test process's own zone may differ from the CLI subprocess's, and
    // Intl is an independent formatting oracle for the source's Date getters.
    const nyDate = (d: Date): string =>
      new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const nyClock = (d: Date): string =>
      new Intl.DateTimeFormat("en-GB", { timeZone: NY, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d);
    const due = new Date(dueIso);
    const sameLocalDay = nyDate(due) === nyDate(new Date());
    const when = sameLocalDay ? nyClock(due) : `${nyDate(due)} ${nyClock(due)}`;

    const human = runCliWithTz(inst, "status tzclock", NY);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`next ${when} (`);
    if (sameLocalDay) {
      expect(human.stdout).not.toContain(`next ${nyDate(due)} ${nyClock(due)}`); // no date prefix
    } else {
      expect(human.stdout).not.toContain(`next ${nyClock(due)} (`); // not clock-only
    }
    expect(human.stdout).not.toContain(`next ${dueIso.slice(11, 19)} (`); // raw UTC clock
  }, 90_000);
});

// ---------------------------------------------------------------------------
// S7 — logs prints the worklog plus chronological attempt process logs
// ---------------------------------------------------------------------------

describe("S7 — logs includes process and validator streams", () => {
  test("default logs prints the worklog plus attempt and validator streams in execution order", () => {
    const inst = makeInstallation({
      "logged": `version: 1
id: logged
description: Command node then validated agent node.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-cmd:
    run:
      command: echo "cmd process log line"
    next: node-agent
  node-agent:
    run:
      agent:
        instructions: |
          Write one deterministic line.
    validator:
      command: 'echo validator-stream-evidence'
    next: null
`,
    });
    const r = runCli(inst, "start logged");
    expect(r.code).toBe(0);

    const logs = runCli(inst, "logs logged");
    expect(logs.code).toBe(0);
    // The worklog itself.
    expect(logs.stdout).toContain("## Run outcome");
    // Attempt process logs, in chronological execution order.
    expect(logs.stdout).toContain("── nodes/001-node-cmd/attempt-001/stdout ──");
    expect(logs.stdout).toContain("cmd process log line");
    expect(logs.stdout).toContain("── nodes/002-node-agent/attempt-001/stdout ──");
    // Validator streams are included when present.
    expect(logs.stdout).toContain("── nodes/002-node-agent/attempt-001/validation/stdout ──");
    expect(logs.stdout).toContain("validator-stream-evidence");
    // Chronological order across attempts.
    expect(logs.stdout.indexOf("001-node-cmd")).toBeLessThan(logs.stdout.indexOf("002-node-agent"));

    // --follow on a terminal run still terminates (no new public flag).
    const followed = runCli(inst, "logs logged --follow", 30_000);
    expect(followed.code).toBe(0);
    expect(followed.stdout).toContain("── nodes/001-node-cmd/attempt-001/stdout ──");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// S12 — validator timeout is a typed timeout, not a validator rejection
// ---------------------------------------------------------------------------

describe("S12 — validator timeout typing", () => {
  test("a validator that exceeds its deadline fails the attempt as timeout", () => {
    const inst = makeInstallation({
      "slow-validator": `version: 1
id: slow-validator
description: Validator sleeps past its deadline.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-ok:
    run:
      agent:
        instructions: |
          Write one deterministic line.
    validator:
      command: 'sleep 5'
      timeout: 1s
    next: null
`,
    });
    const r = runCli(inst, "start slow-validator", 30_000);
    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.failure_kind).toBe("timeout");
    expect(attempt.failure_kind).not.toBe("validator_rejection");
    expect(String(attempt.validator_reason)).toContain("timed out");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Q2 — human status survives a first/only unresolved run
// ---------------------------------------------------------------------------

describe("Q2 — human status with only an unresolved run", () => {
  test("status renders when the first and only run is unresolved", () => {
    const inst = makeInstallation({ "blocker": blockerWorkflow("blocker") });
    const started = runCli(inst, "start blocker");
    expect(started.code).toBe(0);

    const r = runCli(inst, "status");
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Cannot read"); // no crash
    expect(r.stdout).toContain("blocker");
    expect(r.stdout).toContain("blocked");
    expect(r.stdout).toContain("node-blocker");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Q3 — one shared node-status derivation
// ---------------------------------------------------------------------------

function row(attempt: number, status: string): AttemptRow {
  return { attempt, status } as unknown as AttemptRow;
}

describe("Q3 — shared node-status derivation", () => {
  test("the derivation matrix", () => {
    expect(deriveNodeStatus([])).toBe("pending");
    expect(deriveNodeStatus([row(1, "completed")])).toBe("completed");
    expect(deriveNodeStatus([row(1, "failed")])).toBe("failed");
    expect(deriveNodeStatus([row(1, "blocked")])).toBe("blocked");
    expect(deriveNodeStatus([row(1, "cancelled")])).toBe("cancelled");
    expect(deriveNodeStatus([row(1, "pending")])).toBe("pending");
    expect(deriveNodeStatus([row(1, "running")])).toBe("running");
    expect(deriveNodeStatus([row(1, "finishing")])).toBe("running");
    // A later successful retry makes the node completed.
    expect(deriveNodeStatus([row(1, "failed"), row(2, "completed")])).toBe("completed");
    expect(deriveNodeStatus([row(1, "blocked"), row(2, "completed")])).toBe("completed");
    // A live retry dominates a terminal history.
    expect(deriveNodeStatus([row(1, "failed"), row(2, "running")])).toBe("running");
  });

  test("JSON, tree, and diagram agree after a failed-then-completed retry", () => {
    const inst = makeInstallation({
      "flaky": `version: 1
id: flaky
description: Attempt 1 fails validation, attempt 2 passes, then the run blocks.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
${mockOrchestrator("retry")}
nodes:
  node-flaky:
    run:
      agent:
        instructions: |
          Produce a deterministic line for the validator to judge.
    validator:
      agent:
        model: "mock/mock-model:low"
        instructions: |
          MOCK:validator-until-attempt=2
    max_attempts: 2
    next: node-blocker
  node-blocker:
    run:
      agent:
        instructions: |
          MOCK:block
    next: null
`,
    });
    const r = runCli(inst, "start flaky");
    expect(r.stdout).toContain("blocked"); // run unresolved on node-blocker

    const inst_real = findInstallation(inst.root);
    const store = new Store(openDb(inst_real.dbPath));
    const dto = buildStatusDto(store, new Date());
    const wf = dto.workflows.find((w) => w.id === "flaky")!;
    const nodes = wf.currentRun!.nodes;
    expect(nodes.find((n) => n.id === "node-flaky")!.status).toBe("completed");
    expect(nodes.find((n) => n.id === "node-flaky")!.attempts.map((a) => a.status)).toEqual(["failed", "completed"]);
    expect(nodes.find((n) => n.id === "node-blocker")!.status).toBe("blocked");

    const tree = renderTreeStatus(store);
    expect(tree).toContain("node-flaky completed");
    expect(tree).not.toContain("node-flaky failed");

    const diagram = runCli(inst, "diagram flaky");
    expect(diagram.stdout).toContain("node-flaky (completed)");
    expect(diagram.stdout).not.toContain("node-flaky (failed)");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Q6 — merge-receipt validation and packet-digest verification
// ---------------------------------------------------------------------------

describe("Q6 — merge receipt validation", () => {
  /** Drive one attempt to a merged finishing state, then fake owner death. */
  async function mergedFinishingRun(inst: ReturnType<typeof makeInstallation>) {
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const run = store.getRun(started.runId)!;
    const claim = store.claimAttempt({ runId: run.run_id, nodeId: "node-a", attempt: 1, now: new Date(), maxConcurrentRuns: 99 });
    const folder = attemptDirOfPacket(store.getAttempt(run.run_id, "node-a", 1)!.packet_path);
    writeFileSync(
      locatePacket(folder),
      `#### Attempt 1\n\n##### Progress\n\nDone.\n\n<next-node-output id="node-b">\nhandoff text\n</next-node-output>\n`,
      "utf8",
    );
    const outputPath = join(folder, "node-output.md");
    atomicWriteFileSync(outputPath, "handoff text\n");
    store.claimFinishing({
      runId: run.run_id, nodeId: "node-a", attempt: 1, ownerToken: claim.ownerToken,
      nodeOutputPath: outputPath, validatorStatus: null, validatorReason: null, now: new Date(),
    });
    const lock = new RunLock(run.run_dir);
    await lock.acquire();
    try {
      mergePacket({
        runDir: run.run_dir,
        runId: run.run_id,
        nodeId: "node-a",
        attempt: 1,
        attemptFolder: folder,
        successorId: "node-b",
        now: new Date(),
      });
    } finally {
      lock.release();
    }
    // The owner is gone: a stale lease never authorizes anything by itself.
    store.tx(() => {
      store.db
        .query(
          "UPDATE node_attempts SET wrapper_pid = 999999, wrapper_process_start_id = 'gone', worker_pid = 999999, worker_process_group = 999999 WHERE run_id = ? AND node_id = 'node-a' AND attempt = 1",
        )
        .run(run.run_id);
    });
    return { store, real, runId: run.run_id, folder };
  }

  const chainYaml = (id: string): string => `version: 1
id: ${id}
description: Two command nodes.
nodes:
  node-a:
    run:
      command: echo A
    next: node-b
  node-b:
    run:
      command: echo B
    next: null
`;

  test("a valid receipt with the current packet digest completes without rerunning the node", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const { store, real, runId } = await mergedFinishingRun(inst);

    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.finishingRecovered).toContain(`${runId}/node-a #1`);

    const attempt = store.getAttempt(runId, "node-a", 1)!;
    expect(attempt.status).toBe("completed");
    // The successor was persisted for launch — no rerun of node-a.
    const successor = store.getAttempt(runId, "node-b", 1)!;
    expect(successor.status).toBe("pending");
  }, 30_000);

  test("a receipt whose packet digest no longer matches is not trusted", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const { store, real, runId, folder } = await mergedFinishingRun(inst);
    // The packet changed after the recorded merge — evidence is untrustworthy.
    writeFileSync(locatePacket(folder), readFileSync(locatePacket(folder), "utf8") + "tampered\n", "utf8");

    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.finishingRecovered).toEqual([]);
    const attempt = store.getAttempt(runId, "node-a", 1)!;
    expect(attempt.status).toBe("failed");
    expect(attempt.failure_kind).toBe("worklog_integrity");
  }, 30_000);

  test("a corrupt receipt fails the attempt as worklog_integrity instead of crashing recovery", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const { store, real, runId, folder } = await mergedFinishingRun(inst);
    writeFileSync(join(folder, "merge-receipt.json"), "{ not json", "utf8");

    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.finishingRecovered).toEqual([]);
    const attempt = store.getAttempt(runId, "node-a", 1)!;
    expect(attempt.status).toBe("failed");
    expect(attempt.failure_kind).toBe("worklog_integrity");
  }, 30_000);

  test("a receipt identifying a different merge key is rejected", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const { store, real, runId, folder } = await mergedFinishingRun(inst);
    const receipt = JSON.parse(readFileSync(join(folder, "merge-receipt.json"), "utf8")) as Record<string, unknown>;
    receipt.nodeId = "node-b";
    writeFileSync(join(folder, "merge-receipt.json"), JSON.stringify(receipt), "utf8");

    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.finishingRecovered).toEqual([]);
    const attempt = store.getAttempt(runId, "node-a", 1)!;
    expect(attempt.status).toBe("failed");
    expect(attempt.failure_kind).toBe("worklog_integrity");
  }, 30_000);

  test("the whole-node section digest is not re-verified against later retries", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const { store, real, runId, folder } = await mergedFinishingRun(inst);
    // Well-formed receipt, current packet digest, deliberately bogus section
    // digest: later retries mutate the whole-node section, so the section
    // digest is provenance only — it must not gate recovery.
    const receipt = JSON.parse(readFileSync(join(folder, "merge-receipt.json"), "utf8")) as Record<string, unknown>;
    receipt.sectionSha256 = `sha256:${"0".repeat(64)}`;
    writeFileSync(join(folder, "merge-receipt.json"), JSON.stringify(receipt), "utf8");
    expect(sha256File(locatePacket(folder))).toBe(receipt.packetSha256 as string);

    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.finishingRecovered).toContain(`${runId}/node-a #1`);
    expect(store.getAttempt(runId, "node-a", 1)!.status).toBe("completed");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A run paused mid-attempt: the completion must not crash the runner
// ---------------------------------------------------------------------------

describe("pause during an attempt", () => {
  test("the attempt completes, the run pauses, and no successor row is asserted into existence", async () => {
    // `completeAttempt` deliberately withholds the successor row while the run
    // is paused; the runner used to assert that row existed and threw a
    // TypeError *after* committing the completion, on the documented flow
    // "pause lets the current node finish, then stops before its successor".
    const inst = makeInstallation({
      "slow": `version: 1
id: slow
description: Two nodes, the first slow enough to pause during.
nodes:
  node-a:
    run:
      command: sleep 2
    next: node-b
  node-b:
    run:
      command: echo b
    next: null
`,
    });
    const real = findInstallation(inst.root);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "slow.yaml"));
    const store = new Store(openDb(real.dbPath));
    const started = await startWorkflow({ inst: real, loaded });

    // Pause while node-a is still running.
    const chain = advanceChain({ store, inst: real, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });
    await new Promise((r) => setTimeout(r, 400));
    const run = store.getRun(started.runId)!;
    store.setDesiredState(run.run_id, "paused", new Date());

    // The chain resolves rather than rejecting: the runner must not treat an
    // absent successor as an internal error.
    const outcome = await chain.then(() => "resolved").catch((e: unknown) => `threw: ${e instanceof Error ? e.message : String(e)}`);

    const after = store.getRun(started.runId)!;
    expect(after.status).toBe("paused");
    expect(store.getAttempt(started.runId, "node-a", 1)!.status).toBe("completed");
    // No successor was created, which is the pause contract.
    expect(store.getAttempt(started.runId, "node-b", 1)).toBeNull();
    expect(outcome).toBe("resolved");
  }, 30_000);
});
