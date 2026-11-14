import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBlockedWorkflowStep } from "../agent/lib/read-blocked-workflow-step.ts";
import { sendWorkflowDecision } from "../agent/lib/send-workflow-decision.ts";
import { buildDecisionToken } from "../run/build-decision-token.ts";
import { locateBlockedStep } from "../run/locate-blocked-step.ts";
import { removeBlockedStep } from "../run/remove-blocked-step.ts";
import { writeBlockedStep } from "../run/write-blocked-step.ts";

function withState(action: (stateRoot: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workshop-decision-test-"));
  const stateRoot = join(root, "state");
  return action(stateRoot).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("blocked progress shows the waiting step and error without exposing the hook token", async () => {
  await withState(async (stateRoot) => {
    const runId = "wrun_blocked_1";
    const token = buildDecisionToken(runId, "20-write", 1);
    const file = locateBlockedStep(stateRoot, runId);
    writeBlockedStep(file, {
      workflow: "clock",
      run_id: runId,
      step: "20-write",
      step_kind: "agent",
      retry_profiles: ["writer"],
      last_error: "the check rejected the output",
      token,
    });

    const progress = readBlockedWorkflowStep(runId, stateRoot);
    assert.equal(progress?.workflow, "clock");
    assert.equal(progress?.step, "20-write");
    assert.equal(progress?.last_error, "the check rejected the output");
    assert.equal("token" in (progress ?? {}), false);
  });
});

test("sendWorkflowDecision resumes the blocked run with a checked payload", async () => {
  await withState(async (stateRoot) => {
    const runId = "wrun_blocked_2";
    const token = buildDecisionToken(runId, "10-write", 2);
    writeBlockedStep(locateBlockedStep(stateRoot, runId), {
      workflow: "clock",
      run_id: runId,
      step: "10-write",
      step_kind: "agent",
      retry_profiles: ["writer", "writer-fast"],
      last_error: "profile failed",
      token,
    });
    let received: { token: string; decision: unknown } | undefined;
    await sendWorkflowDecision(runId, { action: "retry", hint: "Try a shorter sentence.", profile: "writer-fast" }, {
      stateRoot,
      resume: async (resumedToken, decision) => { received = { token: resumedToken, decision }; },
    });

    assert.deepEqual(received, {
      token,
      decision: { action: "retry", hint: "Try a shorter sentence.", profile: "writer-fast" },
    });
    removeBlockedStep(locateBlockedStep(stateRoot, runId));
    await assert.rejects(sendWorkflowDecision(runId, { action: "skip" }, {
      stateRoot,
      resume: async () => {},
    }), /is not waiting on a decision/);
  });
});

test("rejects retry profiles outside the blocked step's allowed profiles", async () => {
  await withState(async (stateRoot) => {
    const runId = "wrun_blocked_invalid_profile";
    writeBlockedStep(locateBlockedStep(stateRoot, runId), {
      workflow: "clock",
      run_id: runId,
      step: "10-write",
      step_kind: "agent",
      retry_profiles: ["writer", "writer-fast"],
      last_error: "profile failed",
      token: buildDecisionToken(runId, "10-write", 1),
    });
    let resumed = false;

    await assert.rejects(sendWorkflowDecision(runId, { action: "retry", profile: "claude" }, {
      stateRoot,
      resume: async () => { resumed = true; },
    }), /cannot retry agent step 10-write/);

    assert.equal(resumed, false);
    assert.equal(readBlockedWorkflowStep(runId, stateRoot)?.step, "10-write");
  });
});

test("rejects profile overrides for blocked command steps", async () => {
  await withState(async (stateRoot) => {
    const runId = "wrun_blocked_command_profile";
    writeBlockedStep(locateBlockedStep(stateRoot, runId), {
      workflow: "clock",
      run_id: runId,
      step: "10-save",
      step_kind: "command",
      retry_profiles: [],
      last_error: "command failed",
      token: buildDecisionToken(runId, "10-save", 1),
    });

    await assert.rejects(sendWorkflowDecision(runId, { action: "retry", profile: "writer" }, {
      stateRoot,
      resume: async () => {},
    }), /cannot retry command step 10-save/);
  });
});
