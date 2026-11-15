import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRunIndex } from "../run/append-run-index.ts";
import { lastSlotForWorkflow, readRunIndex, recentRuns, startedCountForWorkflow } from "../run/read-run-index.ts";
import { decideWorkflowSlot, latestCronSlot } from "../schedule/decide-workflow-slot.ts";

function withRoot(action: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "workshop-schedule-test-"));
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("chooses the latest cron slot at or before the current time", () => {
  assert.equal(latestCronSlot("*/5 * * * *", new Date("2026-11-14T12:03:42.000Z")), "2026-11-14T12:00:00.000Z");
  assert.equal(latestCronSlot("*/5 * * * *", new Date("2026-11-14T12:05:00.000Z")), "2026-11-14T12:05:00.000Z");
});

test("a new workflow starts on its first tick and downtime admits only the latest missed slot", () => {
  const first = decideWorkflowSlot({
    cron: "* * * * *",
    now: new Date("2026-11-14T12:00:40.000Z"),
    startedCount: 0,
  });
  assert.deepEqual(first, { kind: "start", slot: "2026-11-14T12:00:00.000Z" });

  const afterDowntime = decideWorkflowSlot({
    cron: "* * * * *",
    now: new Date("2026-11-14T12:05:40.000Z"),
    lastSlot: "2026-11-14T11:59:00.000Z",
    startedCount: 2,
  });
  assert.deepEqual(afterDowntime, { kind: "start", slot: "2026-11-14T12:05:00.000Z" });
});

test("skips and indexes a slot when max_runs has been reached", () => {
  assert.deepEqual(decideWorkflowSlot({
    cron: "* * * * *",
    now: new Date("2026-11-14T12:05:40.000Z"),
    startedCount: 3,
    maxRuns: 3,
  }), {
    kind: "skip",
    slot: "2026-11-14T12:05:00.000Z",
    reason: "max_runs reached",
  });
});

test("indexes a paused slot as skipped so resume starts only a later slot", () => {
  withRoot((root) => {
    const indexFile = join(root, "state", "runs.jsonl");
    const pausedSlot = decideWorkflowSlot({
      cron: "* * * * *",
      now: new Date("2026-11-14T12:27:40.000Z"),
      startedCount: 0,
      paused: true,
    });
    assert.deepEqual(pausedSlot, { kind: "skip", slot: "2026-11-14T12:27:00.000Z", reason: "paused" });
    if (pausedSlot.kind !== "skip") assert.fail("paused slot must be skipped");
    appendRunIndex(indexFile, {
      workflow: "clock",
      slot: pausedSlot.slot,
      run_id: null,
      outcome: "skipped",
      reason: pausedSlot.reason,
      at: "2026-11-14T12:27:40.000Z",
    });

    const resumed = decideWorkflowSlot({
      cron: "* * * * *",
      now: new Date("2026-11-14T12:29:40.000Z"),
      lastSlot: lastSlotForWorkflow(readRunIndex(indexFile), "clock"),
      startedCount: 0,
    });
    assert.deepEqual(resumed, { kind: "start", slot: "2026-11-14T12:29:00.000Z" });
    assert.equal(lastSlotForWorkflow(readRunIndex(indexFile), "clock"), pausedSlot.slot);
  });
});


test("a lock-conflict slot is indexed as skipped and is not retried for that slot", () => {
  withRoot((root) => {
    const indexFile = join(root, "state", "runs.jsonl");
    const now = new Date("2026-11-14T12:05:40.000Z");
    const slot = "2026-11-14T12:05:00.000Z";
    appendRunIndex(indexFile, {
      workflow: "clock",
      slot,
      run_id: "wrun-owner",
      outcome: "skipped",
      reason: "workflow lock held by wrun-active",
      at: now.toISOString(),
    });
    appendRunIndex(indexFile, {
      workflow: "clock",
      slot,
      run_id: "wrun-owner",
      outcome: "skipped",
      reason: "workflow lock held by wrun-active",
      at: now.toISOString(),
    });

    const entries = readRunIndex(indexFile);
    assert.equal(entries.length, 1);
    assert.equal(lastSlotForWorkflow(entries, "clock"), slot);
    assert.equal(startedCountForWorkflow(entries, "clock"), 0);
    assert.deepEqual(decideWorkflowSlot({
      cron: "* * * * *",
      now,
      lastSlot: lastSlotForWorkflow(entries, "clock"),
      startedCount: startedCountForWorkflow(entries, "clock"),
    }), { kind: "already-indexed", slot });
  });
});

test("run index helpers count starts, find each workflow's last slot, and return recent entries", () => {
  withRoot((root) => {
    const indexFile = join(root, "state", "runs.jsonl");
    appendRunIndex(indexFile, {
      workflow: "clock", slot: "2026-11-14T12:00:00.000Z", run_id: "wrun-a", outcome: "started", at: "2026-11-14T12:00:01.000Z",
    });
    appendRunIndex(indexFile, {
      workflow: "clock", slot: "2026-11-14T12:01:00.000Z", run_id: "wrun-b", outcome: "started", at: "2026-11-14T12:01:01.000Z",
    });
    appendRunIndex(indexFile, {
      workflow: "clock", slot: "2026-11-14T12:02:00.000Z", run_id: null, outcome: "skipped", reason: "max_runs reached", at: "2026-11-14T12:02:01.000Z",
    });
    appendRunIndex(indexFile, {
      workflow: "other", slot: "2026-11-14T12:03:00.000Z", run_id: "wrun-c", outcome: "started", at: "2026-11-14T12:03:01.000Z",
    });
    const entries = readRunIndex(indexFile);

    assert.equal(lastSlotForWorkflow(entries, "clock"), "2026-11-14T12:02:00.000Z");
    assert.equal(startedCountForWorkflow(entries, "clock"), 2);
    assert.deepEqual(recentRuns(entries, 2, "clock").map(({ slot }) => slot), [
      "2026-11-14T12:02:00.000Z",
      "2026-11-14T12:01:00.000Z",
    ]);
  });
});
