import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { advanceOrchestratorRound } from "../workflow/advance-orchestrator-round.ts";
import { applyWorkflowDecision } from "../workflow/apply-workflow-decision.ts";
import { buildOrchestratorBrief } from "../workflow/build-orchestrator-brief.ts";
import { computeRetryProfiles } from "../workflow/compute-retry-profiles.ts";
import { listWorkflowStatus } from "../workflow/list-workflow-status.ts";
import { parseOrchestratorDecision } from "../workflow/parse-orchestrator-decision.ts";
import { interpretWorkflow, type ProcessExecutionRequest, type ProcessExecutionResult, type WorkflowInterpreterInput } from "../workflow/interpret-workflow.ts";
import type { AttemptHistoryEntry, Workflow, WorkflowStep } from "../workflow/types.ts";

const profileFixture = resolve("test/fixtures/orchestrator-profile.mjs");

function withRoot(action: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workshop-orchestrator-test-"));
  return Promise.resolve(action(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function failed(output = "partial output", error = "fixture failed"): ProcessExecutionResult {
  return { exitCode: 7, stdout: output, stderr: error, timedOut: false };
}

function successful(output = "accepted output"): ProcessExecutionResult {
  return { exitCode: 0, stdout: output, stderr: "", timedOut: false };
}

function commandWorkflow(): Workflow {
  return {
    name: "test-loop",
    directory: "test-loop",
    cron: "* * * * *",
    description: "A command workflow for orchestrator tests.",
    steps: [{ kind: "command", file: "10-check.sh", number: 10, name: "check", retries: 0 }],
  };
}

function orchestratedInput(
  executeProcess: WorkflowInterpreterInput["executeProcess"],
  recordDecision: NonNullable<WorkflowInterpreterInput["orchestrator"]>["recordDecision"],
  modes: { first: string; escalation: string } = { first: "retry", escalation: "give-up" },
  waitForDecision: WorkflowInterpreterInput["waitForDecision"] = async () => ({ action: "fail" }),
): WorkflowInterpreterInput {
  return {
    workflow: commandWorkflow(),
    documents: {},
    files: { "10-check.sh": "/workflows/test-loop/10-check.sh" },
    contents: { "10-check.sh": "test command source" },
    workflowRunId: "wrun_orchestrator_test",
    profileCommands: {
      "orchestrator-small": [process.execPath, profileFixture, modes.first],
      "orchestrator-large": [process.execPath, profileFixture, modes.escalation],
    },
    orchestrator: { profile: "orchestrator-small", escalationProfile: "orchestrator-large", recordDecision },
    executeProcess,
    waitForDecision,
  };
}

async function executeFakeOrchestrator(request: ProcessExecutionRequest, root: string): Promise<ProcessExecutionResult> {
  return executeWorkflowProcess({
    ...request,
    workflow: "test-loop",
    runId: "wrun_orchestrator_test",
    projectRoot: root,
    dataDirectory: root,
    stateDirectory: root,
    cwd: root,
  });
}

test("computes allowed retry profiles from the step executable only", () => {
  const profiles = {
    "pi-local": ["pi", "--model", "local"],
    "pi-fast": ["pi", "--model", "fast"],
    claude: ["claude", "-p"],
  };
  assert.deepEqual(computeRetryProfiles({ kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "pi-local" }, profiles), ["pi-local", "pi-fast"]);
  assert.deepEqual(computeRetryProfiles({ kind: "command", file: "10-save.sh", number: 10, name: "save" }, profiles), []);
});

test("parses strict orchestrator decisions and treats unsafe or invalid output as give_up", () => {
  const context = { allowedRetryProfiles: ["pi-fast"], lastOutput: "a candidate" };
  assert.deepEqual(parseOrchestratorDecision('{"action":"retry","profile":"pi-fast","after":"30s","note":"one more try"}', context), {
    action: "retry", profile: "pi-fast", after: "30s", note: "one more try",
  });
  assert.equal(parseOrchestratorDecision('{"action":"retry","profile":"claude","note":"switch"}', context).action, "give_up");
  assert.equal(parseOrchestratorDecision('{"action":"unknown","note":"bad"}', context).action, "give_up");
  assert.equal(parseOrchestratorDecision('{"action":"retry","after":"tomorrow","note":"wait"}', context).action, "give_up");
  assert.equal(parseOrchestratorDecision('{"action":"retry","note":"bad","extra":true}', context).action, "give_up");
  assert.equal(parseOrchestratorDecision("not JSON", context).action, "give_up");
  const noOutput = parseOrchestratorDecision('{"action":"accept","note":"accept it"}', { ...context, lastOutput: "  " });
  assert.deepEqual(noOutput, { action: "give_up", note: "Orchestrator tried to accept a failed attempt with no output" });
});

test("builds a failure brief with workflow, step, output, error, history, and allowed actions", () => {
  const step: WorkflowStep = { kind: "command", file: "10-check.sh", number: 10, name: "check" };
  const history: AttemptHistoryEntry[] = [{ attempt: 1, output: "partial", error: "exit 7" }];
  const brief = buildOrchestratorBrief({
    round: 1,
    workflow: commandWorkflow(),
    step,
    stepId: "10-check",
    stepContent: "check a file",
    lastOutput: "partial",
    lastError: "exit 7",
    attemptHistory: history,
    allowedRetryProfiles: [],
  });
  assert.match(brief.prompt, /Workflow description/);
  assert.match(brief.prompt, /check a file/);
  assert.match(brief.prompt, /partial/);
  assert.match(brief.prompt, /exit 7/);
  assert.match(brief.prompt, /Fail ends the workflow immediately/);
  assert.match(brief.prompt, /Allowed actions: retry, skip, accept, fail, give_up/);
  assert.match(brief.prompt, /Allowed retry profiles: none/);
});

test("advances round decisions to retry, apply, fail, escalate, or wait", () => {
  const giveUp = { action: "give_up", note: "uncertain" } as const;
  const retry = { action: "retry", note: "try" } as const;
  const skip = { action: "skip", note: "safe" } as const;
  const fail = { action: "fail", note: "cannot fix" } as const;
  assert.deepEqual(advanceOrchestratorRound(1, retry), { kind: "retry" });
  assert.deepEqual(advanceOrchestratorRound(1, retry, "retry-succeeded"), { kind: "apply" });
  assert.deepEqual(advanceOrchestratorRound(1, retry, "retry-failed"), { kind: "escalate", nextRound: 2 });
  assert.deepEqual(advanceOrchestratorRound(1, giveUp), { kind: "escalate", nextRound: 2 });
  assert.deepEqual(advanceOrchestratorRound(2, giveUp), { kind: "wait-for-user" });
  assert.deepEqual(advanceOrchestratorRound(1, fail), { kind: "fail" });
  assert.deepEqual(advanceOrchestratorRound(2, fail), { kind: "fail" });
  assert.deepEqual(advanceOrchestratorRound(2, retry, "retry-failed"), { kind: "wait-for-user" });
  assert.deepEqual(advanceOrchestratorRound(2, skip), { kind: "apply" });
});

test("automatic round one can retry once and complete using a fake profile command", async () => {
  await withRoot(async (root) => {
    const calls: ProcessExecutionRequest[] = [];
    const decisions: { round: number; note: string }[] = [];
    const events: string[] = [];
    let stepAttempts = 0;
    const input = orchestratedInput(async (request) => {
      calls.push(request);
      if (request.kind === "orchestrator") {
        events.push("orchestrator");
        return executeFakeOrchestrator(request, root);
      }
      events.push("step-attempt");
      stepAttempts += 1;
      return stepAttempts === 1 ? failed() : successful("saved");
    }, async ({ round, note }) => { events.push("decision"); decisions.push({ round, note }); });

    const result = await interpretWorkflow(input);
    assert.equal(result.status, "completed");
    assert.equal(result.output, "saved");
    assert.deepEqual(calls.map(({ kind, attempt }) => [kind, attempt]), [["command", 1], ["orchestrator", 1], ["command", 2]]);
    assert.equal(decisions.length, 1);
    assert.deepEqual(events, ["step-attempt", "orchestrator", "decision", "step-attempt"]);
    assert.equal(decisions[0]?.round, 1);
    assert.match(decisions[0]?.note ?? "", /command may pass/);
    assert.deepEqual(result.steps[0]?.attempts.map(({ error }) => error ?? "ok"), ["10-check failed with exit code 7: fixture failed\npartial output", "ok"]);
  });
});

test("round one giving up escalates to round two, whose skip is applied", async () => {
  await withRoot(async (root) => {
    const decisions: { round: number; action: string }[] = [];
    const input = orchestratedInput(async (request) => {
      if (request.kind === "orchestrator") return executeFakeOrchestrator(request, root);
      return failed("no result", "still broken");
    }, async ({ round, decision }) => { decisions.push({ round, action: decision.action }); }, { first: "give-up", escalation: "skip" });

    const result = await interpretWorkflow(input);
    assert.equal(result.status, "completed");
    assert.equal(result.steps[0]?.status, "skipped");
    assert.deepEqual(decisions, [{ round: 1, action: "give_up" }, { round: 2, action: "skip" }]);
  });
});

test("two automatic give_up decisions leave the run waiting for the user", async () => {
  await withRoot(async (root) => {
    let release: ((decision: { action: "skip" }) => void) | undefined;
    let signalBlocked: (() => void) | undefined;
    let settled = false;
    let blockedInput: Parameters<WorkflowInterpreterInput["waitForDecision"]>[0] | undefined;
    const blocked = new Promise<void>((resolveBlocked) => { signalBlocked = resolveBlocked; });
    const userDecision = new Promise<{ action: "skip" }>((resolveDecision) => { release = resolveDecision; });
    const decisions: { round: number; action: string }[] = [];
    const input = orchestratedInput(async (request) => {
      if (request.kind === "orchestrator") return executeFakeOrchestrator(request, root);
      return failed("partial", "step still fails");
    }, async ({ round, decision }) => { decisions.push({ round, action: decision.action }); }, { first: "give-up", escalation: "give-up" }, async (details) => {
      blockedInput = details;
      signalBlocked?.();
      return userDecision;
    });
    const pending = interpretWorkflow(input).then((result) => {
      settled = true;
      return result;
    });

    await blocked;
    assert.equal(settled, false);
    assert.deepEqual(decisions, [{ round: 1, action: "give_up" }, { round: 2, action: "give_up" }]);
    assert.equal(blockedInput?.step, "10-check");
    assert.equal(blockedInput?.lastOutput, "partial");
    assert.equal(blockedInput?.attemptHistory.length, 1);
    release?.({ action: "skip" });
    assert.equal((await pending).steps[0]?.status, "skipped");
  });
});

test("a failed round-one retry counts as the round failure and escalates without replaying it", async () => {
  await withRoot(async (root) => {
    let stepAttempts = 0;
    const decisions: { round: number; action: string }[] = [];
    const input = orchestratedInput(async (request) => {
      if (request.kind === "orchestrator") return executeFakeOrchestrator(request, root);
      stepAttempts += 1;
      return failed(`attempt ${stepAttempts}`, "still failing");
    }, async ({ round, decision }) => { decisions.push({ round, action: decision.action }); }, { first: "retry", escalation: "skip" });

    const result = await interpretWorkflow(input);
    assert.equal(result.steps[0]?.status, "skipped");
    assert.equal(stepAttempts, 2);
    assert.deepEqual(decisions.map(({ round }) => round), [1, 2]);
    assert.equal(result.steps[0]?.attempts.length, 2);
  });
});

test("applies user retry decisions through the same profile and feedback rules", () => {
  const applied = applyWorkflowDecision({
    decision: { action: "retry", hint: "shorten it", profile: "pi-fast", after: "30s" },
    step: { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "pi-local" },
    currentProfile: "pi-local",
    profileCommands: { "pi-local": ["pi", "--local"], "pi-fast": ["pi", "--fast"], claude: ["claude"] },
    lastError: "check rejected it",
  });
  assert.deepEqual(applied, { action: "retry", profile: "pi-fast", feedback: "check rejected it\n\nHint: shorten it", after: "30s" });
});

test("workflow listing reports enabled, paused, and broken workflows", () => {
  const result = listWorkflowStatus({
    workflows: [
      { name: "clock", directory: "clock", cron: "* * * * *", description: "A clock.", steps: [] },
      { name: "disabled", directory: "disabled", cron: "0 * * * *", enabled: false, description: "Off.", steps: [] },
    ],
    errors: [{ file: "broken/workflow.md", reason: "missing cron" }],
  }, new Set(["clock"]));
  assert.deepEqual(result.workflows.map(({ name, enabled, paused }) => [name, enabled, paused]), [
    ["clock", true, true], ["disabled", false, false],
  ]);
  assert.deepEqual(result.broken_workflows, [{ name: "broken", errors: [{ file: "broken/workflow.md", reason: "missing cron" }] }]);
});
