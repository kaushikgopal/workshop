import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWorkflowDecision } from "../workflow/apply-workflow-decision.ts";
import { buildOrchestratorBrief } from "../workflow/build-orchestrator-brief.ts";
import { computeRetryProfiles } from "../workflow/compute-retry-profiles.ts";
import { listWorkflowStatus } from "../workflow/list-workflow-status.ts";
import type { Workflow, WorkflowStep } from "../workflow/types.ts";

function commandWorkflow(): Workflow {
  return {
    name: "test-loop",
    directory: "test-loop",
    cron: "* * * * *",
    description: "A command workflow for orchestrator tests.",
    steps: [{ kind: "command", file: "10-check.sh", number: 10, name: "check", retries: 0 }],
  };
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

test("builds a single native-tool failure round with bounded evidence", () => {
  const step: WorkflowStep = { kind: "command", file: "10-check.sh", number: 10, name: "check" };
  const brief = buildOrchestratorBrief({
    workflow: commandWorkflow(),
    step,
    stepId: "10-check",
    runId: "run-1",
    decisionNumber: 2,
    stepSource: { content: "check a file" },
    lastOutput: "partial output",
    lastError: "exit 7",
    attemptHistory: [{ attempt: 1, output: "partial", error: "exit 7" }],
    allowedRetryProfiles: [],
  });
  assert.match(brief.prompt, /Workflow description/);
  assert.match(brief.prompt, /check a file/);
  assert.match(brief.prompt, /run_id run-1/);
  assert.match(brief.prompt, /decision_number 2/);
  assert.match(brief.prompt, /Allowed actions: retry, skip, accept, fail\./);
  assert.match(brief.prompt, /Workshop will record give_up and leave the run blocked/);
  assert.match(brief.prompt, /Allowed retry profiles: none/);
  assert.match(brief.prompt, /call consult/);
  assert.doesNotMatch(brief.prompt, /Return exactly one strict JSON/);
});

test("brief distinguishes the configured profile from the last attempted profile", () => {
  const step: WorkflowStep = { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer" };
  const brief = buildOrchestratorBrief({
    workflow: { ...commandWorkflow(), steps: [step] },
    step,
    stepId: "10-write",
    runId: "run-1",
    decisionNumber: 2,
    stepSource: { content: "Write a line." },
    lastOutput: "draft",
    lastError: "rejected",
    attemptHistory: [{ attempt: 1, profile: "fast", output: "draft", error: "rejected" }],
    allowedRetryProfiles: ["writer", "fast"],
  });

  assert.match(brief.prompt, /Configured step profile: writer/);
  assert.match(brief.prompt, /Attempt history[\s\S]*"profile": "fast"/);
  assert.doesNotMatch(brief.prompt, /Current profile:/);
});

test("automatic retry rules reject a different executable", () => {
  const step: WorkflowStep = { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "pi-local" };
  assert.throws(() => applyWorkflowDecision({
    decision: { action: "retry", profile: "claude" },
    step,
    currentProfile: "pi-local",
    profileCommands: { "pi-local": ["pi", "--model", "local"], claude: ["claude", "-p"] },
    lastError: "check failed",
  }), /same executable/);
});

test("automatic retry accepts a profile with the configured executable", () => {
  const step: WorkflowStep = { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "pi-local" };
  const applied = applyWorkflowDecision({
    decision: { action: "retry", profile: "pi-fast" },
    step,
    currentProfile: "pi-local",
    profileCommands: { "pi-local": ["pi", "--model", "local"], "pi-fast": ["pi", "--model", "fast"] },
    lastError: "check failed",
  });
  assert.deepEqual(applied, { action: "retry", profile: "pi-fast", feedback: "check failed" });
});

test("automatic retry keeps command-step and unknown-profile errors", () => {
  const step: WorkflowStep = { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "pi-local" };
  const profileCommands = { "pi-local": ["pi", "--model", "local"] };
  assert.throws(() => applyWorkflowDecision({
    decision: { action: "retry", profile: "unknown" },
    step,
    currentProfile: "pi-local",
    profileCommands,
    lastError: "check failed",
  }), /Unknown retry profile "unknown" for 10-write/);

  const commandStep: WorkflowStep = { kind: "command", file: "10-write.sh", number: 10, name: "write" };
  assert.throws(() => applyWorkflowDecision({
    decision: { action: "retry", profile: "pi-local" },
    step: commandStep,
    currentProfile: undefined,
    profileCommands,
    lastError: "check failed",
  }), /10-write cannot retry with a profile because it is a command step/);
});

test("retry listing and application handle a missing configured executable", () => {
  const step: WorkflowStep = { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "missing" };
  const profileCommands = { "pi-fast": ["pi", "--model", "fast"] };
  assert.deepEqual(computeRetryProfiles(step, profileCommands), []);
  assert.throws(() => applyWorkflowDecision({
    decision: { action: "retry", profile: "pi-fast" },
    step,
    currentProfile: "missing",
    profileCommands,
    lastError: "check failed",
  }), /same executable as missing/);
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
