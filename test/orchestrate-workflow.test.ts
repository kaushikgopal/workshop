import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { decideBlockedRun } from "../agent/tools/decide_blocked_run.ts";
import { startWorkflowForChat } from "../agent/tools/start_workflow.ts";
import { executeWorkflowProcess } from "../agent/lib/execute-workflow-process.ts";
import { advanceOrchestratorRound } from "../workflow/advance-orchestrator-round.ts";
import { applyWorkflowDecision } from "../workflow/apply-workflow-decision.ts";
import { buildOrchestratorBrief } from "../workflow/build-orchestrator-brief.ts";
import { changeWorkflowPause } from "../workflow/change-workflow-pause.ts";
import { computeRetryProfiles } from "../workflow/compute-retry-profiles.ts";
import { listWorkflowStatus } from "../workflow/list-workflow-status.ts";
import { readPausedWorkflows } from "../workflow/read-paused-workflows.ts";
import { parseOrchestratorDecision } from "../workflow/parse-orchestrator-decision.ts";
import { cancelWorkflowRun } from "../run/cancel-workflow-run.ts";
import { recordActionLog } from "../run/record-action-log.ts";
import { listWorkflowRuns } from "../run/list-workflow-runs.ts";
import { readActionLog } from "../run/read-action-log.ts";
import { readWorkflowRun } from "../run/read-workflow-run.ts";
import { interpretWorkflow, type ProcessExecutionRequest, type ProcessExecutionResult, type WorkflowInterpreterInput } from "../workflow/interpret-workflow.ts";
import type { AttemptHistoryEntry, Workflow, WorkflowStep } from "../workflow/types.ts";
import type { BlockedWorkflowStep, RunIndexEntry } from "../run/types.ts";

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
    files: { "10-check.sh": "/snapshot/test-loop/10-check.sh" },
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
    dataDirectory: root,
    cwd: root,
  });
}

function blockedStep(overrides: Partial<BlockedWorkflowStep> = {}): BlockedWorkflowStep {
  return {
    workflow: "clock",
    run_id: "wrun_1",
    step: "10-write",
    step_kind: "agent",
    retry_profiles: ["pi-fast"],
    last_error: "profile failed",
    last_output: "partial",
    attempt_history: [{ attempt: 1, profile: "pi-local", output: "partial", error: "profile failed" }],
    token: "hook-token",
    at: "2026-11-14T12:00:00.000Z",
    ...overrides,
  };
}

function runEntry(runId: string, workflow = "clock"): RunIndexEntry {
  return { workflow, slot: "2026-11-14T12:00:00.000Z", run_id: runId, outcome: "started", at: "2026-11-14T12:00:01.000Z" };
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
  assert.match(brief.prompt, /Allowed actions: retry, skip, accept, fail, give_up/);
  assert.match(brief.prompt, /Allowed retry profiles: none/);
});

test("advances round decisions to retry, escalate, apply, or wait", () => {
  const giveUp = { action: "give_up", note: "uncertain" } as const;
  const retry = { action: "retry", note: "try" } as const;
  const skip = { action: "skip", note: "safe" } as const;
  assert.deepEqual(advanceOrchestratorRound(1, retry), { kind: "retry" });
  assert.deepEqual(advanceOrchestratorRound(1, retry, "retry-succeeded"), { kind: "apply" });
  assert.deepEqual(advanceOrchestratorRound(1, retry, "retry-failed"), { kind: "escalate", nextRound: 2 });
  assert.deepEqual(advanceOrchestratorRound(1, giveUp), { kind: "escalate", nextRound: 2 });
  assert.deepEqual(advanceOrchestratorRound(2, giveUp), { kind: "wait-for-user" });
  assert.deepEqual(advanceOrchestratorRound(1, { action: "fail", note: "cannot fix" }), { kind: "escalate", nextRound: 2 });
  assert.deepEqual(advanceOrchestratorRound(2, { action: "fail", note: "cannot fix" }), { kind: "wait-for-user" });
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
test("two automatic fail decisions also leave the run waiting for the user", async () => {
  await withRoot(async (root) => {
    let release: ((decision: { action: "skip" }) => void) | undefined;
    let signalBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolveBlocked) => { signalBlocked = resolveBlocked; });
    const userDecision = new Promise<{ action: "skip" }>((resolveDecision) => { release = resolveDecision; });
    const decisions: { round: number; action: string }[] = [];
    const input = orchestratedInput(async (request) => {
      if (request.kind === "orchestrator") return executeFakeOrchestrator(request, root);
      return failed("partial", "step still fails");
    }, async ({ round, decision }) => { decisions.push({ round, action: decision.action }); }, { first: "fail", escalation: "fail" }, async () => {
      signalBlocked?.();
      return userDecision;
    });
    const pending = interpretWorkflow(input);

    await blocked;
    assert.deepEqual(decisions, [{ round: 1, action: "fail" }, { round: 2, action: "fail" }]);
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

test("action log appends validated JSON lines and reads the newest entries", async () => {
  await withRoot((root) => {
    const file = join(root, "state", "actions.jsonl");
    recordActionLog(file, {
      at: "2026-11-14T12:00:00.000Z", workflow: "clock", run_id: "wrun_1", step: "10-write",
      source: "round-1", decision: { action: "retry", hint: "try once", note: "safe" }, note: "retry succeeded",
    });
    recordActionLog(file, {
      at: "2026-11-14T12:00:00.000Z", workflow: "clock", run_id: "wrun_1", step: "10-write",
      source: "round-1", decision: { action: "retry", hint: "try once", note: "safe" }, note: "retry succeeded",
    });
    recordActionLog(file, {
      at: "2026-11-14T12:01:00.000Z", workflow: "clock", run_id: "wrun_1", step: "10-write",
      source: "chat", decision: { action: "skip" }, note: "step skipped",
    });
    assert.equal(readActionLog(file, 1)[0]?.source, "chat");
    assert.equal(readActionLog(file, 2)[1]?.decision.action, "retry");
    assert.deepEqual(readActionLog(file, 0), []);
    assert.equal(readActionLog(file, 10).filter(({ source }) => source === "round-1").length, 1);
  });
});


test("pause and resume update the state file and record chat actions", async () => {
  await withRoot((root) => {
    const pauseFile = join(root, "state", "paused.json");
    const actionFile = join(root, "state", "actions.jsonl");
    const paused = changeWorkflowPause({ workflow: "clock", paused: true, pauseFile, actionFile, at: "2026-11-14T12:00:00.000Z" });
    assert.deepEqual(paused.pausedWorkflows, ["clock"]);
    assert.equal(readPausedWorkflows(pauseFile).has("clock"), true);
    const resumed = changeWorkflowPause({ workflow: "clock", paused: false, pauseFile, actionFile, at: "2026-11-14T12:01:00.000Z" });
    assert.deepEqual(resumed.pausedWorkflows, []);
    assert.equal(readPausedWorkflows(pauseFile).has("clock"), false);
    assert.deepEqual(readActionLog(actionFile).map(({ decision }) => decision.action), ["resume", "pause"]);
  });
});

test("manual starts refuse paused workflows and log a successful start through the supplied port", async () => {
  let starts = 0;
  const startsLogged: string[] = [];
  await assert.rejects(startWorkflowForChat("clock", {
    isPaused: () => true,
    start: async () => { starts += 1; return "wrun_never"; },
  }), /paused; resume it before starting manually/);
  assert.equal(starts, 0);
  const started = await startWorkflowForChat("clock", {
    isPaused: () => false,
    start: async () => "wrun_started",
    recordStart: (name, runId) => { startsLogged.push(`${name}:${runId}`); },
  });
  assert.deepEqual(started, { status: "started", workflow: "clock", runId: "wrun_started" });
  assert.deepEqual(startsLogged, ["clock:wrun_started"]);
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

test("run listing uses fake Eve status and blocked-step readers", async () => {
  const entries: RunIndexEntry[] = [runEntry("wrun_1"), { ...runEntry("wrun_skip"), run_id: null, outcome: "skipped", reason: "max runs" }];
  const result = await listWorkflowRuns(entries, { limit: 10 }, {
    getStatus: async (id) => id === "wrun_1" ? "running" : "failed",
    readBlocked: (id) => id === "wrun_1" ? blockedStep() : undefined,
  });
  assert.deepEqual(result.map(({ status }) => status), ["running", "skipped"]);
  assert.equal(result[0]?.blocked_step, "10-write");
  assert.equal(result[0]?.last_error, "profile failed");
});
test("run listing keeps an older blocked run visible beyond the recent-history limit", async () => {
  const entries: RunIndexEntry[] = [runEntry("wrun_old")];
  for (let index = 0; index < 25; index += 1) {
    entries.push({ ...runEntry(`wrun_skip_${index}`), run_id: null, outcome: "skipped", reason: "workflow lock held" });
  }
  const result = await listWorkflowRuns(entries, { limit: 2 }, {
    getStatus: async () => "running",
    readBlocked: (id) => id === "wrun_old" ? blockedStep({ run_id: id }) : undefined,
  });
  assert.equal(result.length, 3);
  assert.equal(result[0]?.run_id, "wrun_old");
  assert.equal(result[0]?.blocked_step, "10-write");
});


test("run reading returns Eve-exposed step output and blocked attempts", async () => {
  const entries = [runEntry("wrun_1")];
  const completed = await readWorkflowRun("wrun_1", entries, {
    inspect: async () => ({ status: "completed", returnValue: { output: "done", steps: [{ step: "10-save", output: "done" }] } }),
    readBlocked: () => undefined,
  });
  assert.equal(completed.output, "done");
  assert.deepEqual(completed.steps, [{ step: "10-save", output: "done" }]);
  const blocked = await readWorkflowRun("wrun_1", entries, {
    inspect: async () => ({ status: "running" }),
    readBlocked: () => blockedStep(),
  });
  assert.equal(blocked.status, "running");
  assert.equal(blocked.blocked_step?.last_error, "profile failed");
  assert.equal(blocked.blocked_step?.attempt_history?.[0]?.output, "partial");
  await assert.rejects(readWorkflowRun("missing", entries, { inspect: async () => ({ status: "failed" }), readBlocked: () => undefined }), /not in the run index/);
});

test("chat decision tool applies a checked user action through its injected sender", async () => {
  let sent: { runId: string; action: string } | undefined;
  const result = await decideBlockedRun("wrun_1", { action: "skip" }, async (runId, decision) => {
    sent = { runId, action: decision.action };
  });
  assert.deepEqual(sent, { runId: "wrun_1", action: "skip" });
  assert.deepEqual(result, { run_id: "wrun_1", decision: { action: "skip" } });
});

test("cancel tool cancels an active run and leaves completed runs unchanged", async () => {
  const entries = [runEntry("wrun_active"), runEntry("wrun_done")];
  const cancelled: string[] = [];
  const actions: string[] = [];
  const active = await cancelWorkflowRun("wrun_active", entries, {
    getStatus: async () => "running",
    cancel: async (id) => { cancelled.push(id); },
    recordAction: ({ workflow, runId }) => { actions.push(`${workflow}:${runId}`); },
  });
  const completed = await cancelWorkflowRun("wrun_done", entries, {
    getStatus: async () => "completed",
    cancel: async () => { assert.fail("terminal run must not be cancelled"); },
    recordAction: () => { assert.fail("terminal run must not be logged as cancelled"); },
  });
  assert.deepEqual(active, { run_id: "wrun_active", workflow: "clock", status: "cancellation-requested", cancelled: true });
  assert.deepEqual(completed, { run_id: "wrun_done", workflow: "clock", status: "completed", cancelled: false });
  assert.deepEqual(cancelled, ["wrun_active"]);
  assert.deepEqual(actions, ["clock:wrun_active"]);
});
