import { describe, expect, test } from "bun:test";
import { decideFixedRateSchedule, firstFixedRateDeadline } from "../src/run/decide-fixed-rate-schedule.js";

const activatedAt = "2026-01-01T00:00:00.000Z";
const firstDueAt = "2026-01-01T00:00:01.000Z";
const at = (value: string): number => Date.parse(value);

function schedule(overrides: Partial<Parameters<typeof decideFixedRateSchedule>[0]> = {}) {
  return decideFixedRateSchedule({
    state: "active",
    everyMs: 1_000,
    maxRuns: "unlimited",
    admittedCount: 1,
    skippedSlots: 0,
    nextDueAt: firstDueAt,
    now: at(firstDueAt),
    hasOpenRun: false,
    ...overrides,
  });
}

describe("fixed-rate schedule decisions", () => {
  test("anchors the first due deadline to activation time", () => {
    expect(firstFixedRateDeadline(activatedAt, 1_000)).toBe(firstDueAt);
    expect(firstFixedRateDeadline(activatedAt, 1)).toBe("2026-01-01T00:00:00.001Z");
  });

  test("sleeps against the persisted absolute deadline", () => {
    expect(schedule({ now: at("2026-01-01T00:00:00.500Z") })).toEqual({
      kind: "sleep",
      wakeAt: firstDueAt,
    });
    expect(schedule({ now: at("2026-01-01T00:00:00.999Z") })).toEqual({
      kind: "sleep",
      wakeAt: firstDueAt,
    });
  });

  test("admits the latest eligible slot and records earlier missed slots", () => {
    expect(schedule({ now: at("2026-01-01T00:00:03.500Z") })).toEqual({
      kind: "admit",
      slotAt: "2026-01-01T00:00:03.000Z",
      skippedCount: 2,
      firstSkippedSlotAt: firstDueAt,
      lastSkippedSlotAt: "2026-01-01T00:00:02.000Z",
      nextDueAt: "2026-01-01T00:00:04.000Z",
      admittedCount: 2,
      exhausted: false,
      totalSkippedSlots: 2,
    });
  });

  test("skips every due slot while one run remains unresolved without spending admissions", () => {
    expect(schedule({
      now: at("2026-01-01T00:00:03.500Z"),
      hasOpenRun: true,
      admittedCount: 4,
    })).toEqual({
      kind: "skip",
      firstSlotAt: firstDueAt,
      lastSlotAt: "2026-01-01T00:00:03.000Z",
      skippedCount: 3,
      nextDueAt: "2026-01-01T00:00:04.000Z",
      totalSkippedSlots: 3,
    });
  });

  test("advances a finite limit and explicit unlimited recurrence", () => {
    expect(schedule({ maxRuns: 2, admittedCount: 1 })).toMatchObject({
      kind: "admit", admittedCount: 2, exhausted: true, nextDueAt: null,
    });
    expect(schedule({ maxRuns: "unlimited", admittedCount: Number.MAX_SAFE_INTEGER - 1 })).toMatchObject({
      kind: "admit", admittedCount: Number.MAX_SAFE_INTEGER, exhausted: false,
    });
  });

  test("waits for paused-state changes and finishes stopped, exhausted, or unscheduled activations", () => {
    expect(schedule({ state: "paused", now: at(firstDueAt) })).toEqual({ kind: "wait" });
    expect(schedule({ state: "paused", now: at("2026-01-01T00:00:03.000Z") })).toEqual({ kind: "wait" });
    expect(schedule({ state: "stopped" })).toEqual({ kind: "finished" });
    expect(schedule({ state: "exhausted" })).toEqual({ kind: "finished" });
    expect(schedule({ everyMs: null, nextDueAt: null })).toEqual({ kind: "finished" });
  });

  test("rejects unsafe deadlines, counters, and due-slot arithmetic", () => {
    expect(() => firstFixedRateDeadline("+275760-09-13T00:00:00.000Z", 1)).toThrow(/supported UTC timestamp range/);
    expect(schedule({ everyMs: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ kind: "invalid" });
    expect(schedule({ maxRuns: 1, admittedCount: 2 })).toMatchObject({ kind: "invalid" });
    expect(schedule({ admittedCount: Number.MAX_SAFE_INTEGER })).toMatchObject({ kind: "invalid" });
    expect(schedule({ skippedSlots: Number.MAX_SAFE_INTEGER, hasOpenRun: true })).toMatchObject({ kind: "invalid" });
    expect(schedule({
      nextDueAt: "-271821-04-20T00:00:00.000Z",
      now: at("+275760-09-13T00:00:00.000Z"),
      everyMs: 1,
    })).toMatchObject({ kind: "invalid" });
  });
});
