import { describe, test, expect } from "bun:test";
import { makeInstallation, runCli, mockAgentHarness, readWorklog, dbAttempts, dbRuns } from "./helpers.js";

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

describe("gate 7 — validators", () => {
  test("a command validator passes a good output and retains its evidence", () => {
    const inst = makeInstallation({
      "cmd-validator": `version: 1
id: cmd-validator
description: Command validator passes.
nodes:
  node-out:
    run:
      command: echo "deterministic output"
    validator:
      command: 'grep -q deterministic "$WORKSHOP_NODE_OUTPUT_FILE"'
    next: null
`,
    });
    const r = runCli(inst, "start cmd-validator");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("completed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.validator_status).toBe("passed");
    expect(existsSync(validateDir(inst, runId, "node-out", 1))).toBe(true);
  }, 60_000);

  test("a failing output is rejected by a fresh agent validator; its reason is retained", () => {
    const inst = makeInstallation({
      "agent-validator": `version: 1
id: agent-validator
description: Agent validator rejects.
defaults:
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
${mockOrchestrator("fail")}
nodes:
  node-bad:
    run:
      agent:
        instructions: |
          Produce deliberately wrong output.
    validator:
      agent:
        model: "mock/mock-model:low"
        instructions: |
          MOCK:validator=fail
    max_attempts: 1
    next: null
`,
    });
    const r = runCli(inst, "start agent-validator");
    expect(r.stdout).toContain("failed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempt = dbAttempts(inst, runId)[0]!;
    expect(attempt.failure_kind).toBe("validator_rejection");
    expect(String(attempt.validator_reason)).toContain("mock validator rejected");
  }, 60_000);
});

describe("gate 8 — bounded retry through the orchestrator", () => {
  test("rejected output reruns the complete node once and appends Attempt 2 without rewriting Attempt 1", () => {
    const inst = makeInstallation({
      "retry-once": `version: 1
id: retry-once
description: First attempt fails validation, second passes.
defaults:
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
    next: null
`,
    });
    const r = runCli(inst, "start retry-once");
    if (r.code !== 0) console.error(r.stderr);
    expect(r.stdout).toContain("completed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    const attempts = dbAttempts(inst, runId);
    expect(attempts.length).toBe(2);
    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.failure_kind).toBe("validator_rejection");
    expect(attempts[1]!.status).toBe("completed");
    expect(attempts[1]!.validator_status).toBe("passed");

    const log = readWorklog(inst, runId);
    expect(log).toContain("#### Attempt 1");
    expect(log).toContain("#### Attempt 2");
    expect(log.indexOf("#### Attempt 1")).toBeLessThan(log.indexOf("#### Attempt 2"));
    // Attempt 1's rejection reason stays in its attempt record.
    expect(attempts[0]!.validator_reason).toContain("mock validator rejected");
    // The orchestrator decision reached the worklog through the runtime.
    expect(log).toContain("orchestrator retry");
  }, 90_000);

  test("the orchestrator cannot exceed the resolved attempt bound", () => {
    const inst = makeInstallation({
      "retry-bound": `version: 1
id: retry-bound
description: Always-failing node with a bound of one.
defaults:
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
${mockOrchestrator("retry")}
nodes:
  node-doomed:
    run:
      agent:
        instructions: |
          MOCK:exit=1
    max_attempts: 1
    next: null
`,
    });
    const r = runCli(inst, "start retry-bound");
    expect(r.stdout).toContain("failed");

    const runId = r.stdout.match(/\S+-\d{8}-\d{3}/)![0];
    expect(dbAttempts(inst, runId).length).toBe(1);
  }, 60_000);

  test("an unresolved orchestrator (no agent resolvable) blocks with orchestrator_unresolved", () => {
    const inst = makeInstallation({
      "no-orchestrator": `version: 1
id: no-orchestrator
description: Fails with no orchestrator configured.
defaults:
  timeout: 1m
  agent:
    harness:
      command: '${MOCK}'
    model: "mock/mock-model:low"
nodes:
  node-fail:
    run:
      agent:
        instructions: |
          MOCK:exit=1
    next: null
`,
    });
    const r = runCli(inst, "start no-orchestrator");
    expect(r.stdout).toContain("blocked");

    const runs = dbRuns(inst);
    expect(runs[0]!.block_kind).toBe("orchestrator_unresolved");
  }, 60_000);
});

// Imported late to keep the top of the file about behavior.
import { existsSync } from "node:fs";
import { join } from "node:path";

function validateDir(inst: ReturnType<typeof makeInstallation>, runId: string, nodeId: string, attempt: number): string {
  return join(inst.root, ".workshop/state/runs", runId, "validation", `${nodeId}-attempt-${attempt}`);
}
