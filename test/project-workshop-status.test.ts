import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWorkflowRunStatus } from "../service/project-workshop-status.ts";

const attemptHistory = [{ attempt: 1, output: "result", error: "exit 7" }];
const failure = {
  workflow: "clock",
  runId: "run-1",
  step: "10-task",
  stepKind: "agent" as const,
  retryProfiles: ["writer"],
  lastError: "exit 7",
  lastOutput: "result",
  attemptHistory,
  decisionNumber: 1,
};
const blocked = {
  phase: "blocked" as const,
  stepIndex: 0,
  pipeInput: "",
  results: [],
  attemptHistory,
  localRetriesLeft: 0,
  profile: "writer",
  feedback: "",
  decisionNumber: 1,
  automaticRoundUsed: true,
  failure,
  roundStatus: "settled" as const,
};
const activeRecord = { abortRequested: false, state: { status: "running", checkpoint: blocked } };

test("projects blocked, recorded, and completing phases without changing legacy status", () => {
  const awaiting = projectWorkflowRunStatus({ record: activeRecord, checkpoint: blocked, mailboxOccupied: false });
  assert.equal(awaiting.status, "blocked");
  assert.equal(awaiting.phase, "awaiting-decision");
  assert.deepEqual(awaiting.allowed_actions, ["cancel_run", "decide_blocked_run"]);
  assert.deepEqual(awaiting.blocked_step?.allowed_actions, ["retry", "skip", "accept", "fail"]);
  assert.deepEqual(awaiting.blocked_step?.retry_profiles, ["writer"]);

  const recorded = projectWorkflowRunStatus({ record: activeRecord, checkpoint: blocked, mailboxOccupied: true });
  assert.equal(recorded.status, "blocked");
  assert.equal(recorded.phase, "decision-recorded");
  assert.deepEqual(recorded.blocked_step?.allowed_actions, []);

  const completing = projectWorkflowRunStatus({
    record: { abortRequested: false, state: { status: "completing", outcome: { status: "completed", result: { status: "completed" } } } },
    mailboxOccupied: false,
  });
  assert.equal(completing.status, "completed");
  assert.equal(completing.phase, "completing");
  assert.deepEqual(completing.allowed_actions, []);
});

test("keeps scheduler definition blockages and abort intent visible", () => {
  const unavailable = projectWorkflowRunStatus({
    record: { abortRequested: false, state: { status: "pending", checkpoint: {} } },
    availability: { kind: "blocked", reason: "migration_failed" },
    mailboxOccupied: false,
  });
  assert.equal(unavailable.status, "pending");
  assert.equal(unavailable.phase, "definition-unavailable");
  assert.match(unavailable.status_message, /migration_failed/);
  assert.deepEqual(unavailable.allowed_actions, []);

  const cancelling = projectWorkflowRunStatus({
    record: { ...activeRecord, abortRequested: true },
    checkpoint: blocked,
    mailboxOccupied: false,
  });
  assert.equal(cancelling.phase, "cancellation-requested");
  assert.deepEqual(cancelling.allowed_actions, []);
  assert.deepEqual(cancelling.blocked_step?.allowed_actions, []);
});

test("projects fault details and only advertises captured, useful blocked choices", () => {
  const faulted = projectWorkflowRunStatus({
    record: { abortRequested: false, state: { status: "terminal", outcome: { status: "faulted", error: { message: "database unavailable" } } } },
    mailboxOccupied: false,
  });
  assert.equal(faulted.status, "faulted");
  assert.equal(faulted.error, "database unavailable");
  assert.match(faulted.status_message, /database unavailable/);

  const emptyOutput = projectWorkflowRunStatus({
    record: activeRecord,
    checkpoint: { ...blocked, failure: { ...failure, lastOutput: " \n " } },
    mailboxOccupied: false,
  });
  assert.deepEqual(emptyOutput.blocked_step?.allowed_actions, ["retry", "skip", "fail"]);
  assert.deepEqual(emptyOutput.blocked_step?.retry_profiles, ["writer"]);
});
