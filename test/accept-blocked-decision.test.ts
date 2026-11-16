import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptBlockedDecision } from "../workflow/accept-blocked-decision.ts";

const observation = {
  phase: "blocked" as const,
  decisionNumber: 2,
  mailboxOccupied: false,
  abortRequested: false,
  failure: {
    runId: "run-1",
    step: "10-task",
    attempt: 1,
    lastOutput: "ready",
    retryProfiles: ["writer"],
  },
};

const chatDecision = {
  source: "chat" as const,
  decisionNumber: 2,
  decision: { action: "skip" as const },
};

test("accepts a current decision for an empty mailbox", () => {
  assert.deepEqual(acceptBlockedDecision(observation, chatDecision), { kind: "accepted" });
});

test("names stale, occupied, and cancellation rejections", () => {
  assert.deepEqual(acceptBlockedDecision(observation, { ...chatDecision, decisionNumber: 1 }), {
    kind: "rejected", code: "stale_decision",
  });
  assert.deepEqual(acceptBlockedDecision({ ...observation, mailboxOccupied: true }, chatDecision), {
    kind: "rejected", code: "choice_already_recorded",
  });
  assert.deepEqual(acceptBlockedDecision({ ...observation, abortRequested: true }, chatDecision), {
    kind: "rejected", code: "cancellation_in_progress",
  });
});

test("rejects decisions outside the blocked phase and mismatched automatic rounds", () => {
  assert.deepEqual(acceptBlockedDecision({ ...observation, phase: "decision" }, chatDecision), {
    kind: "rejected", code: "choice_already_recorded",
  });
  assert.deepEqual(acceptBlockedDecision(observation, {
    ...chatDecision,
    source: "round",
    round: { runId: "run-1", step: "10-task", attempt: 2 },
  }), { kind: "rejected", code: "stale_decision" });
});

test("accepts output only when it is trim-nonempty and retries only captured profiles", () => {
  assert.deepEqual(acceptBlockedDecision({
    ...observation,
    failure: { ...observation.failure, lastOutput: " \n " },
  }, { ...chatDecision, decision: { action: "accept" } }), {
    kind: "rejected", code: "empty_output",
  });
  assert.deepEqual(acceptBlockedDecision(observation, {
    ...chatDecision,
    decision: { action: "retry", profile: "other" },
  }), { kind: "rejected", code: "incompatible_profile" });
});
