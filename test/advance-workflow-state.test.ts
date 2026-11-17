import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceWorkflowState,
  decodeWorkflowTaskCheckpoint,
  retryLimit,
  WorkflowCheckpointIntegrityError,
  type WorkflowStateContext,
  type WorkflowStateTransition,
} from "../workflow/advance-workflow-state.ts";
import { decodeStepAttemptOutcome } from "../workflow/define-workflow-task.ts";
import type { Workflow } from "../workflow/types.ts";

function makeWorkflow(stepCount = 2, retries = 1): Workflow {
  return {
    name: "clock",
    directory: "clock",
    cron: "* * * * *",
    description: "Transition fixture.",
    retries,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      kind: "command" as const,
      file: `${(index + 1) * 10}-step.sh`,
      number: (index + 1) * 10,
      name: `step-${index + 1}`,
    })),
  };
}

function makeContext(workflow = makeWorkflow()): WorkflowStateContext {
  return { workflow, workflowName: workflow.name, runId: "run-1", profileCommands: {} };
}

function stepCheckpoint(retries = 1): Record<string, unknown> {
  return {
    phase: "step",
    stepIndex: 0,
    pipeInput: "",
    results: [],
    attemptHistory: [],
    localRetriesLeft: retries,
    feedback: "",
    decisionNumber: 0,
    automaticRoundUsed: false,
  };
}

function attemptCheckpoint(context: WorkflowStateContext, retries = 1): Extract<ReturnType<typeof decodeWorkflowTaskCheckpoint>, { phase: "attempt" }> {
  const step = context.workflow.steps[0];
  assert.ok(step);
  const decoded = decodeWorkflowTaskCheckpoint({
    ...stepCheckpoint(retries),
    phase: "attempt",
    activeAttempt: {
      taskId: 7,
      request: { step, pipeInput: "", feedback: "", attempt: 1 },
    },
    waitUntil: 1_700_000_000_000,
  }, context);
  assert.equal(decoded.phase, "attempt");
  if (decoded.phase !== "attempt") throw new Error("Expected an attempt checkpoint");
  return decoded;
}

function accepted(transition: WorkflowStateTransition): Extract<WorkflowStateTransition, { kind: "accepted" }> {
  assert.equal(transition.kind, "accepted");
  if (transition.kind !== "accepted") throw new Error("Expected an accepted transition");
  return transition;
}

test("workflow transitions accept ordered attempts and reject stale or repeated events", () => {
  const context = makeContext();
  const ready = decodeWorkflowTaskCheckpoint(stepCheckpoint(), context);
  const attempt = attemptCheckpoint(context);
  assert.equal(ready.phase, "step");
  assert.equal(attempt.phase, "attempt");
  if (ready.phase !== "step" || attempt.phase !== "attempt") throw new Error("Invalid transition fixture");

  const started = accepted(advanceWorkflowState(ready, { kind: "attempt-started", activeAttempt: attempt.activeAttempt }, context));
  assert.equal(started.state.phase, "attempt");
  assert.deepEqual(advanceWorkflowState(started.state, { kind: "attempt-started", activeAttempt: attempt.activeAttempt }, context), {
    kind: "rejected",
    code: "out-of-order",
    message: "Cannot start an attempt while workflow phase is attempt",
  });
  assert.deepEqual(advanceWorkflowState(started.state, {
    kind: "attempt-settled", attempt: 2, result: { kind: "accepted", output: "stale" },
  }, context), {
    kind: "rejected",
    code: "stale-attempt",
    message: "Attempt result does not match the active attempt",
  });

  const advanced = accepted(advanceWorkflowState(started.state, {
    kind: "attempt-settled", attempt: 1, result: { kind: "accepted", output: "upstream\n" },
  }, context));
  assert.deepEqual(advanced.state, {
    phase: "step",
    stepIndex: 1,
    pipeInput: "upstream\n",
    results: [{ step: "10-step-1", status: "completed", output: "upstream\n", attempts: [{ attempt: 1, output: "upstream\n" }] }],
    attemptHistory: [],
    localRetriesLeft: 1,
    feedback: "",
    decisionNumber: 0,
    automaticRoundUsed: false,
  });
  assert.deepEqual(advanceWorkflowState(advanced.state, {
    kind: "attempt-settled", attempt: 1, result: { kind: "accepted", output: "duplicate" },
  }, context), {
    kind: "rejected",
    code: "out-of-order",
    message: "Cannot settle an attempt while workflow phase is step",
  });
});

test("workflow transitions reject stale decisions and terminal events", () => {
  const context = makeContext(makeWorkflow(1, 0));
  const attempt = attemptCheckpoint(context, 0);
  const blocked = accepted(advanceWorkflowState(attempt, {
    kind: "attempt-settled", attempt: 1, result: { kind: "failed", output: "partial", reason: "exit 7" },
  }, context)).state;
  assert.equal(blocked.phase, "blocked");
  if (blocked.phase !== "blocked") throw new Error("Expected a blocked state");

  assert.deepEqual(advanceWorkflowState(blocked, {
    kind: "decision-recorded", decisionNumber: 2, decision: { action: "skip" }, source: "chat",
  }, context), {
    kind: "rejected",
    code: "stale-decision",
    message: "Decision number does not match the blocked occurrence",
  });
  const decision = accepted(advanceWorkflowState(blocked, {
    kind: "decision-recorded", decisionNumber: 1, decision: { action: "skip" }, source: "chat",
  }, context)).state;
  assert.equal(decision.phase, "decision");
  assert.deepEqual(advanceWorkflowState(decision, {
    kind: "decision-recorded", decisionNumber: 1, decision: { action: "skip" }, source: "chat",
  }, context), {
    kind: "rejected",
    code: "out-of-order",
    message: "Cannot record a decision while workflow phase is decision",
  });

  const finished = accepted(advanceWorkflowState(decision, { kind: "decision-applied", decisionNumber: 1, now: 0 }, context));
  assert.deepEqual(finished.state, {
    phase: "finished",
    outcome: {
      status: "completed",
      result: {
        status: "completed",
        output: "",
        completedSteps: 1,
        steps: [{ step: "10-step-1", status: "skipped", output: "", attempts: [{ attempt: 1, output: "partial", error: "exit 7" }] }],
      },
    },
  });
  assert.deepEqual(advanceWorkflowState(finished.state, { kind: "round-settled" }, context), {
    kind: "rejected",
    code: "out-of-order",
    message: "Workflow execution is already finished",
  });
});

test("attempt failures consume local retry budget before blocking", () => {
  const context = makeContext(makeWorkflow(1, 1));
  const attempt = attemptCheckpoint(context, 1);
  const retry = accepted(advanceWorkflowState(attempt, {
    kind: "attempt-settled", attempt: 1, result: { kind: "failed", output: "first", reason: "try again" },
  }, context));
  assert.deepEqual(retry.state, {
    phase: "step",
    stepIndex: 0,
    pipeInput: "",
    results: [],
    attemptHistory: [{ attempt: 1, output: "first", error: "try again" }],
    localRetriesLeft: 0,
    feedback: "try again",
    decisionNumber: 0,
    automaticRoundUsed: false,
  });
});

test("command attempt history omits a resumed profile", () => {
  const context = makeContext(makeWorkflow(1, 0));
  const step = context.workflow.steps[0];
  assert.ok(step);
  const decoded = decodeWorkflowTaskCheckpoint({
    ...stepCheckpoint(0),
    phase: "attempt",
    profile: "writer",
    activeAttempt: {
      taskId: 7,
      request: { step, profile: "writer", pipeInput: "", feedback: "", attempt: 1 },
    },
  }, context);
  assert.equal(decoded.phase, "attempt");
  if (decoded.phase !== "attempt") throw new Error("Expected an active attempt");

  const blocked = accepted(advanceWorkflowState(decoded, {
    kind: "attempt-settled", attempt: 1, result: { kind: "failed", output: "partial", reason: "exit 7" },
  }, context));
  assert.equal(blocked.state.phase, "blocked");
  if (blocked.state.phase !== "blocked") throw new Error("Expected a blocked workflow");
  const expectedHistory = [{ attempt: 1, output: "partial", error: "exit 7" }];
  assert.deepEqual(blocked.state.attemptHistory, expectedHistory);
  assert.deepEqual(blocked.state.failure.attemptHistory, expectedHistory);
});

test("retry limits prefer step, check, then workflow, including explicit zero", () => {
  const workflow = makeWorkflow(1, 3);
  const step = workflow.steps[0];
  assert.ok(step);
  const check = { kind: "command" as const, file: "10-step.check.sh" };

  assert.equal(retryLimit({ ...step, retries: 2, check: { ...check, retries: 1 } }, workflow), 2);
  assert.equal(retryLimit({ ...step, check: { ...check, retries: 1 } }, workflow), 1);
  assert.equal(retryLimit(step, workflow), 3);
  assert.equal(retryLimit({ ...step, retries: 0, check: { ...check, retries: 1 } }, workflow), 0);
  assert.equal(retryLimit({ ...step, check: { ...check, retries: 0 } }, workflow), 0);

  const withoutWorkflowRetries = { ...workflow };
  delete withoutWorkflowRetries.retries;
  assert.equal(retryLimit(step, withoutWorkflowRetries), 0);
});

test("checkpoint decoding rejects invalid step bounds and counters with field context", () => {
  const context = makeContext();
  for (const [checkpoint, field] of [
    [{ ...stepCheckpoint(), stepIndex: -1 }, "checkpoint.stepIndex"],
    [{ ...stepCheckpoint(), stepIndex: 2 }, "checkpoint.stepIndex"],
    [{ ...stepCheckpoint(), localRetriesLeft: -1 }, "checkpoint.localRetriesLeft"],
    [{ ...stepCheckpoint(), localRetriesLeft: 2 }, "checkpoint.localRetriesLeft"],
    [{ ...stepCheckpoint(), decisionNumber: -1 }, "checkpoint.decisionNumber"],
    [{ ...stepCheckpoint(), attemptHistory: [{ attempt: 0, output: "bad" }] }, "checkpoint.attemptHistory[0].attempt"],
  ] as const) {
    assert.throws(() => decodeWorkflowTaskCheckpoint(checkpoint, context), (error: unknown) => {
      assert.ok(error instanceof WorkflowCheckpointIntegrityError);
      assert.ok(error.message.includes(field), `expected the integrity error to name ${field}`);
      return true;
    });
  }
});

test("checkpoint decoding accepts the saved attempt waitUntil residue and legacy roundStatus omission", () => {
  const context = makeContext(makeWorkflow(1, 0));
  const attempt = attemptCheckpoint(context, 0);
  assert.equal(attempt.waitUntil, 1_700_000_000_000);

  const blocked = accepted(advanceWorkflowState(attempt, {
    kind: "attempt-settled", attempt: 1, result: { kind: "failed", output: "partial", reason: "exit 7" },
  }, context)).state;
  assert.equal(blocked.phase, "blocked");
  if (blocked.phase !== "blocked") throw new Error("Expected blocked state");
  const legacyBlocked = { ...blocked };
  delete legacyBlocked.roundStatus;
  const decoded = decodeWorkflowTaskCheckpoint(legacyBlocked, context);
  assert.equal(decoded.phase, "blocked");
});

test("child task faults and orphan reasons remain visible in the attempt result", () => {
  assert.deepEqual(decodeStepAttemptOutcome({ status: "faulted", error: { message: "worker threw" } }), {
    kind: "failed", output: "", reason: "worker threw",
  });
  assert.deepEqual(decodeStepAttemptOutcome({ status: "orphaned", reason: "definition is unavailable" }), {
    kind: "failed", output: "", reason: "definition is unavailable",
  });
});

test("nothing-to-do finishes a command workflow instead of advancing", () => {
  const context = makeContext(makeWorkflow(2, 0));
  const attempt = attemptCheckpoint(context, 0);
  const finished = accepted(advanceWorkflowState(attempt, {
    kind: "attempt-settled", attempt: 1, result: { kind: "nothing-to-do", output: "already done" },
  }, context));

  assert.deepEqual(finished.state, {
    phase: "finished",
    outcome: {
      status: "completed",
      result: {
        status: "nothing-to-do",
        output: "already done",
        completedSteps: 0,
        steps: [{ step: "10-step-1", status: "nothing-to-do", output: "already done", attempts: [{ attempt: 1, output: "already done" }] }],
      },
    },
  });
});

test("blocked decisions accept output, fail with the cause, and preserve scheduled retries", () => {
  const context = makeContext(makeWorkflow(1, 2));
  const attempt = attemptCheckpoint(context, 0);
  const blocked = accepted(advanceWorkflowState(attempt, {
    kind: "attempt-settled", attempt: 1, result: { kind: "failed", output: "last output", reason: "exit 7" },
  }, context)).state;
  if (blocked.phase !== "blocked") throw new Error("Expected blocked state");

  const acceptedDecision = accepted(advanceWorkflowState(blocked, {
    kind: "decision-recorded", decisionNumber: 1, decision: { action: "accept" }, source: "chat",
  }, context)).state;
  const acceptedRun = accepted(advanceWorkflowState(acceptedDecision, { kind: "decision-applied", decisionNumber: 1, now: 0 }, context));
  assert.equal(acceptedRun.state.phase, "finished");
  if (acceptedRun.state.phase !== "finished" || acceptedRun.state.outcome.status !== "completed") throw new Error("Expected an accepted completed run");
  assert.equal(acceptedRun.state.outcome.result.output, "last output");

  const failedDecision = accepted(advanceWorkflowState(blocked, {
    kind: "decision-recorded", decisionNumber: 1, decision: { action: "fail" }, source: "chat",
  }, context)).state;
  const failedRun = accepted(advanceWorkflowState(failedDecision, { kind: "decision-applied", decisionNumber: 1, now: 0 }, context));
  assert.deepEqual(failedRun.state, {
    phase: "finished", outcome: { status: "failed", error: { message: "10-step-1 failed: exit 7" } },
  });

  const retryDecision = accepted(advanceWorkflowState(blocked, {
    kind: "decision-recorded", decisionNumber: 1,
    decision: { action: "retry", hint: "wait and retry", after: "30s" }, source: "chat",
  }, context)).state;
  const scheduled = accepted(advanceWorkflowState(retryDecision, { kind: "decision-applied", decisionNumber: 1, now: 1_000 }, context));
  assert.deepEqual(scheduled.state, {
    phase: "step",
    stepIndex: 0,
    pipeInput: "",
    results: [],
    attemptHistory: [{ attempt: 1, output: "last output", error: "exit 7" }],
    localRetriesLeft: 2,
    feedback: "exit 7\n\nHint: wait and retry",
    decisionNumber: 1,
    automaticRoundUsed: true,
    waitUntil: 31_000,
  });
});
