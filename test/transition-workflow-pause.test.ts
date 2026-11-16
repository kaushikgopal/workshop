import assert from "node:assert/strict";
import { test } from "node:test";
import { transitionWorkflowPause } from "../run/transition-workflow-pause.ts";

test("pause and resume change membership through explicit transitions", () => {
  const paused = transitionWorkflowPause("unpaused", "pause");
  assert.deepEqual(paused, { kind: "changed", state: "paused" });
  const resumed = transitionWorkflowPause(paused.state, "resume");
  assert.deepEqual(resumed, { kind: "changed", state: "unpaused" });
});

test("repeated pause and resume return named idempotent outcomes", () => {
  assert.deepEqual(transitionWorkflowPause("paused", "pause"), { kind: "already-paused", state: "paused" });
  assert.deepEqual(transitionWorkflowPause("unpaused", "resume"), { kind: "already-unpaused", state: "unpaused" });
});
