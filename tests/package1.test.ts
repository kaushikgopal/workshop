import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  makeInstallation,
  runCli,
  mockAgentHarness,
  readWorklog,
  dbAttempts,
  REPO_ROOT,
} from "./helpers.js";
import { loadAndValidateDefinition, startWorkflow } from "../src/execute.js";
import { findInstallation, ensureDirs } from "../src/config.js";
import { SystemClock } from "../src/util/clock.js";

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

function chainWorkflow(extra = ""): string {
  return `version: 1
id: mock-chain
description: Mock command then agent chain.
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
${extra}`;
}

describe("gate 1 — strict schema", () => {
  const badDefinitions: Record<string, string> = {
    "unknown-key": `version: 1
id: x
description: d
nodes:
  node-a:
    run:
      command: echo hi
    next: null
    bogus: 1
`,
    "duplicate-key": `version: 1
id: x
description: d
id: y
nodes:
  node-a:
    run:
      command: echo hi
    next: null
`,
    alias: `version: 1
id: x
description: &d hello
nodes:
  node-a:
    run:
      command: echo hi
    next: null
`,
    "merge-key": `base: &b {x: 1}
version: 1
id: x
description: d
nodes:
  node-a:
    run:
      command: echo hi
    next: null
junk:
  <<: *b
`,
    "both-exec-forms": `version: 1
id: x
description: d
nodes:
  node-a:
    run:
      agent:
        instructions: i
        model: "p/m:t"
      command: echo hi
    next: null
`,
    "missing-successor": `version: 1
id: x
description: d
nodes:
  node-a:
    run:
      command: echo hi
    next: node-ghost
`,
    cycle: `version: 1
id: x
description: d
nodes:
  node-a:
    run:
      command: echo hi
    next: node-b
  node-b:
    run:
      command: echo hi
    next: node-a
`,
    "multiple-starts": `version: 1
id: x
description: d
nodes:
  node-a:
    run:
      command: echo hi
    next: null
  node-b:
    run:
      command: echo hi
    next: null
`,
    unreachable: `version: 1
id: x
description: d
nodes:
  node-a:
    run:
      command: echo hi
    next: null
  node-orphan:
    run:
      command: echo hi
    next: null
`,
  };

  test("rejects unknown keys, duplicate keys, aliases, merge keys", () => {
    const inst = makeInstallation(badDefinitions);
    for (const id of ["unknown-key", "duplicate-key", "alias", "merge-key"]) {
      const r = runCli(inst, `validate ${id}`);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/unrecognized|invalid|must be unique|anchors|aliases|merge keys/i);
    }
  });

  test("rejects both execution forms, missing successors, cycles, multiple starts, unreachable nodes", () => {
    const inst = makeInstallation(badDefinitions);
    for (const id of ["both-exec-forms", "missing-successor", "cycle", "multiple-starts", "unreachable"]) {
      const r = runCli(inst, `validate ${id}`);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("error");
    }
  });
});

describe("gate 4 — scaffolding", () => {
  test("runtime creates every heading and marker before the first node, with no model call", async () => {
    const inst = makeInstallation({ "mock-chain": chainWorkflow() });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "mock-chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded, clock: new SystemClock() });
    expect(started.created).toBe(true);

    const log = readWorklog(inst, started.runId);
    for (const heading of [
      "# Workflow run: mock-chain",
      "## Goal",
      "## Environment",
      "## Global decision log",
      "## Work packets",
      "### Node: node-cmd",
      "## Run outcome",
    ]) {
      expect(log).toContain(heading);
    }
    expect(log).toContain("preflight"); // environment observation recorded

    // First packet scaffolded in the ordered-node layout: one-based chain
    // position prefixes the node folder, the one-based attempt the child.
    const firstPacket = join(
      inst.stateDir, "runs", started.runId, "nodes", "001-node-cmd", "attempt-001", "packet.md",
    );
    expect(existsSync(firstPacket)).toBe(true);
    const packet = readFileSync(firstPacket, "utf8");
    expect(packet).toContain("#### Attempt 1");
    expect(packet).toContain('<next-node-output id="node-agent">');
    expect(packet).toContain("</next-node-output>");
  });
});

describe("gates 2+3 — manual run, execution, idempotent start", () => {
  test("start without task payload runs command → agent to completion", () => {
    const inst = makeInstallation({ "mock-chain": chainWorkflow() });
    const r = runCli(inst, "start mock-chain");
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\S+-\d{8}-\d{3} → completed/);

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const log = readWorklog(inst, runId);
    expect(log).toContain("hello from node-cmd"); // gate 6: command stdout in first packet
    expect(log).toContain("### Node: node-agent");
    expect(log).toContain("Mock deterministic output from node-agent attempt 1.");
    expect(log).toContain("## Run outcome");
  }, 90_000);

  test("second start while unresolved is an idempotent no-op", () => {
    const inst = makeInstallation({
      "block-chain": `version: 1
id: block-chain
description: Agent requests a block; the run stays unresolved.
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
    const first = runCli(inst, "start block-chain");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("blocked");

    const second = runCli(inst, "start block-chain");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("no-op");
  }, 90_000);
});

describe("gate 9 — timeouts", () => {
  test("a node exceeding its deadline is killed with its process group and fails as typed timeout", () => {
    const inst = makeInstallation({
      "timeouts": `version: 1
id: timeouts
description: Agent sleeps past its deadline.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
${mockOrchestrator("fail")}
nodes:
  node-slow:
    run:
      agent:
        instructions: |
          MOCK:sleep=30s
    timeout: 2s
    next: null
`,
    });
    const began = Date.now();
    const r = runCli(inst, "start timeouts", 30_000);
    expect(r.code).toBe(0); // the chain ends as a failed run, not a CLI error
    expect(Date.now() - began).toBeLessThan(20_000); // killed well before the 30s sleep ends
    expect(r.stdout).toContain("failed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.failure_kind).toBe("timeout");
    expect(attempt.status).toBe("failed");
  }, 60_000);
});

describe("gate 5 — packet writes and worklog integrity", () => {
  test("a direct worklog edit by an agent fails the attempt", () => {
    const inst = makeInstallation({
      "tamper": `version: 1
id: tamper
description: Agent touches the worklog.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
${mockOrchestrator("fail")}
nodes:
  node-tamper:
    run:
      agent:
        instructions: |
          MOCK:touch-worklog
    max_attempts: 1
    next: null
`,
    });
    const r = runCli(inst, "start tamper");
    expect(r.stdout).toContain("failed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.failure_kind).toBe("worklog_integrity");
  }, 60_000);

  test("agent progress reaches the attempt row through the runtime command", () => {
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
          MOCK:progress=halfway done
    next: null
`,
    });
    const r = runCli(inst, "start progress");
    expect(r.code).toBe(0);
    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.current_progress).toBe("halfway done");
  }, 60_000);
});

describe("gate 5 — packet validation against real-model drift", () => {
  test("an agent that drops the scaffolded headings still merges (drift tolerated)", () => {
    const inst = makeInstallation({
      "drift": `version: 1
id: drift
description: Agent rewrites the packet without scaffold headings.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-drift:
    run:
      agent:
        instructions: |
          MOCK:drop-headings
    next: null
`,
    });
    const r = runCli(inst, "start drift");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("completed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const log = readWorklog(inst, runId);
    expect(log).toContain("#### Attempt 1"); // normalized at merge
    expect(log).toContain("Mock deterministic output from node-drift attempt 1.");
  }, 60_000);

  test("an agent that injects a runtime-owned heading fails the attempt", () => {
    const inst = makeInstallation({
      "hostile": `version: 1
id: hostile
description: Agent writes a runtime-owned heading.
defaults:
  max_attempts: 2
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-hostile:
    run:
      agent:
        instructions: |
          MOCK:bad-heading
    max_attempts: 1
    next: null
`,
    });
    const r = runCli(inst, "start hostile");
    // No orchestrator configured: the run blocks for the operator instead of failing.
    expect(r.stdout).toContain("blocked");
    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.failure_kind).toBe("worklog_integrity");
  }, 60_000);
});

describe("prompt hardening — marker preservation", () => {
  test("the injected prompt shows the verbatim packet scaffold and the never-delete rule", () => {
    const inst = makeInstallation({ "mock-chain": chainWorkflow() });
    const r = runCli(inst, "start mock-chain");
    expect(r.code).toBe(0);
    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];

    const prompt = readFileSync(
      join(inst.root, ".workshop/state/runs", runId, "nodes", "002-node-agent", "attempt-001", "prompt"),
      "utf8",
    );
    expect(prompt).toContain("never delete, rename, or move");
    expect(prompt).toContain("<workflow-output>"); // terminal node marker
    expect(prompt).toContain("#### Attempt 1"); // verbatim scaffold embedded
  }, 90_000);
});
