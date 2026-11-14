import assert from "node:assert/strict";
import { test } from "node:test";
import { decideWorkflowAdmission } from "../run/admit-workflow-run.ts";
import type { RunIndexEntry } from "../run/types.ts";

const slot = "2026-11-14T20:00:00.000Z";
const entries: RunIndexEntry[] = [{
  workflow: "clock",
  slot,
  run_id: "wrun_first",
  outcome: "started",
  at: "2026-11-14T20:00:00.000Z",
}];

test("scheduled admission resumes its own started slot and rejects duplicate or over-limit starts", () => {
  assert.deepEqual(decideWorkflowAdmission({
    entries,
    workflow: "clock",
    runId: "wrun_first",
    slot,
    maxRuns: 1,
  }), { kind: "resume" });

  assert.deepEqual(decideWorkflowAdmission({
    entries,
    workflow: "clock",
    runId: "wrun_duplicate",
    slot,
    maxRuns: 10,
  }), { kind: "skip", reason: "slot already indexed" });

  assert.deepEqual(decideWorkflowAdmission({
    entries,
    workflow: "clock",
    runId: "wrun_next",
    slot: "2026-11-14T20:01:00.000Z",
    maxRuns: 1,
  }), { kind: "skip", reason: "max_runs reached" });

  assert.deepEqual(decideWorkflowAdmission({
    entries,
    workflow: "clock",
    runId: "wrun_next",
    slot: "2026-11-14T20:01:00.000Z",
    maxRuns: 2,
  }), { kind: "start" });
});
