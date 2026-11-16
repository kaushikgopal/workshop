import assert from "node:assert/strict";
import { test } from "node:test";
import { decideWorkflowAdmission } from "../run/decide-workflow-admission.ts";

const request = { workflow: "clock", kind: "manual" as const };

test("receipt lookup distinguishes unseen, replayed, and conflicting requests", () => {
  const receipt = { request_id: "request-1", fingerprint: "same", response: { ok: true, run_id: "run-1" } };
  assert.deepEqual(decideWorkflowAdmission({
    phase: "receipt-lookup", requestId: "request-1", fingerprint: "same",
  }), { kind: "unseen-receipt" });
  assert.deepEqual(decideWorkflowAdmission({
    phase: "receipt-lookup", requestId: "request-1", fingerprint: "same", receipt,
  }), { kind: "replayed-receipt", response: receipt.response });
  assert.deepEqual(decideWorkflowAdmission({
    phase: "receipt-lookup", requestId: "request-1", fingerprint: "different", receipt,
  }), { kind: "receipt-conflict", reason: "Request ID was already used for a different request" });
});

test("scheduled admission rejects stale, disabled, paused, exhausted, and already-indexed slots", () => {
  const facts = {
    phase: "admit" as const,
    command: { kind: "scheduled" as const, workflow: "clock", slot: "2026-11-16T12:00:00.000Z", dueSlot: "2026-11-16T12:00:00.000Z" },
    availability: { kind: "loaded", enabled: true } as const,
    paused: false,
    startedCount: 0,
    maxRuns: 1,
    hasOpenRun: false,
  };
  assert.deepEqual(decideWorkflowAdmission({ ...facts, command: { ...facts.command, dueSlot: "2026-11-16T11:55:00.000Z" } }), {
    kind: "skipped", reason: "schedule slot is no longer due",
  });
  assert.deepEqual(decideWorkflowAdmission({ ...facts, availability: { kind: "loaded", enabled: false } }), { kind: "skipped", reason: "workflow is disabled" });
  assert.deepEqual(decideWorkflowAdmission({ ...facts, paused: true }), { kind: "skipped", reason: "paused" });
  assert.deepEqual(decideWorkflowAdmission({ ...facts, startedCount: 1 }), { kind: "skipped", reason: "max_runs reached" });
  assert.deepEqual(decideWorkflowAdmission({ ...facts, lastSlot: "2026-11-16T12:00:00.000Z" }), { kind: "already-indexed" });
});

test("manual admission bypasses max_runs but rejects disabled and paused workflows", () => {
  const facts = {
    phase: "admit" as const,
    command: request,
    availability: { kind: "loaded", enabled: true } as const,
    paused: false,
    startedCount: 3,
    maxRuns: 1,
    hasOpenRun: false,
  };
  assert.deepEqual(decideWorkflowAdmission(facts), { kind: "admitted" });
  assert.deepEqual(decideWorkflowAdmission({ ...facts, availability: { kind: "loaded", enabled: false } }), {
    kind: "rejected", reason: 'Workflow "clock" is disabled and cannot be started manually.',
  });
  assert.deepEqual(decideWorkflowAdmission({ ...facts, paused: true }), {
    kind: "rejected", reason: 'Workflow "clock" is paused; resume it before starting manually.',
  });
});

test("an open run locks manual admission and records a scheduled skip", () => {
  const manual = {
    phase: "admit" as const,
    command: request,
    availability: { kind: "loaded", enabled: true } as const,
    startedCount: 0,
    paused: false,
    hasOpenRun: true,
  };
  assert.deepEqual(decideWorkflowAdmission(manual), { kind: "locked", reason: "workflow already has an open run" });
  assert.deepEqual(decideWorkflowAdmission({
    ...manual,
    command: { kind: "scheduled", workflow: "clock", slot: "slot", dueSlot: "slot" },
  }), { kind: "skipped", reason: "workflow lock held" });
});

test("unavailable scheduled workflows become recorded admission skips", () => {
  assert.deepEqual(decideWorkflowAdmission({
    phase: "admit",
    command: { kind: "scheduled", workflow: "clock", slot: "slot", dueSlot: "slot" },
    availability: { kind: "failed" },
    paused: false,
    startedCount: 0,
    hasOpenRun: false,
  }), { kind: "skipped", reason: "admission failed" });
});
