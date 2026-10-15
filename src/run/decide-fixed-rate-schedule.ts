const MAX_DATE_MS = 8_640_000_000_000_000;

type ActivationState = "active" | "paused" | "stopped" | "exhausted";
type RunLimit = number | "unlimited";

export type FixedRateScheduleInput = {
  readonly state: ActivationState;
  readonly everyMs: number | null;
  readonly maxRuns: RunLimit;
  readonly admittedCount: number;
  readonly skippedSlots: number;
  readonly nextDueAt: string | null;
  readonly now: number;
  readonly hasOpenRun: boolean;
};

export type FixedRateScheduleDecision =
  | { readonly kind: "finished" }
  | { readonly kind: "wait" }
  | { readonly kind: "sleep"; readonly wakeAt: string }
  | {
      readonly kind: "skip";
      readonly firstSlotAt: string;
      readonly lastSlotAt: string;
      readonly skippedCount: number;
      readonly nextDueAt: string;
      readonly totalSkippedSlots: number;
    }
  | {
      readonly kind: "admit";
      readonly slotAt: string;
      readonly skippedCount: number;
      readonly firstSkippedSlotAt: string | null;
      readonly lastSkippedSlotAt: string | null;
      readonly nextDueAt: string | null;
      readonly admittedCount: number;
      readonly exhausted: boolean;
      readonly totalSkippedSlots: number;
    }
  | { readonly kind: "invalid"; readonly reason: string };

/** Advance a persisted fixed-rate cursor without completion-relative drift or catch-up bursts. */
export function decideFixedRateSchedule(input: FixedRateScheduleInput): FixedRateScheduleDecision {
  if (!Number.isSafeInteger(input.now) || Math.abs(input.now) > MAX_DATE_MS) {
    return { kind: "invalid", reason: "scheduler clock is outside the supported UTC timestamp range" };
  }
  if (input.state === "stopped" || input.state === "exhausted") return { kind: "finished" };
  if (input.state === "paused") return { kind: "wait" };
  if (input.everyMs === null || input.nextDueAt === null) return { kind: "finished" };
  if (!Number.isSafeInteger(input.everyMs) || input.everyMs <= 0) {
    return { kind: "invalid", reason: "persisted schedule interval is not a positive safe integer" };
  }
  if (!Number.isSafeInteger(input.admittedCount) || input.admittedCount < 0
    || !Number.isSafeInteger(input.skippedSlots) || input.skippedSlots < 0) {
    return { kind: "invalid", reason: "persisted schedule counters are outside the safe integer range" };
  }
  if (input.maxRuns !== "unlimited"
    && (!Number.isSafeInteger(input.maxRuns) || input.maxRuns <= 0 || input.admittedCount > input.maxRuns)) {
    return { kind: "invalid", reason: "persisted schedule limit is invalid" };
  }
  if (input.maxRuns !== "unlimited" && input.admittedCount >= input.maxRuns) return { kind: "finished" };

  const dueAt = parseUtcMillis(input.nextDueAt);
  if (dueAt === undefined) return { kind: "invalid", reason: "persisted schedule deadline is not a supported UTC timestamp" };
  if (input.now < dueAt) return { kind: "sleep", wakeAt: input.nextDueAt };

  const elapsedMs = input.now - dueAt;
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    return { kind: "invalid", reason: "elapsed schedule time exceeds the safe integer range" };
  }
  const dueSlots = Math.floor(elapsedMs / input.everyMs) + 1;
  if (!Number.isSafeInteger(dueSlots) || dueSlots < 1) {
    return { kind: "invalid", reason: "due schedule slot count exceeds the safe integer range" };
  }
  const latestSlotMs = dueAt + (dueSlots - 1) * input.everyMs;
  const followingSlotMs = latestSlotMs + input.everyMs;
  const latestSlotAt = formatUtcMillis(latestSlotMs);
  const followingSlotAt = formatUtcMillis(followingSlotMs);
  if (latestSlotAt === undefined || followingSlotAt === undefined) {
    return { kind: "invalid", reason: "next schedule deadline exceeds the supported UTC timestamp range" };
  }

  if (input.hasOpenRun) {
    const totalSkippedSlots = input.skippedSlots + dueSlots;
    if (!Number.isSafeInteger(totalSkippedSlots)) {
      return { kind: "invalid", reason: "skipped schedule slot count exceeds the safe integer range" };
    }
    return {
      kind: "skip",
      firstSlotAt: input.nextDueAt,
      lastSlotAt: latestSlotAt,
      skippedCount: dueSlots,
      nextDueAt: followingSlotAt,
      totalSkippedSlots,
    };
  }

  const admittedCount = input.admittedCount + 1;
  if (!Number.isSafeInteger(admittedCount)) {
    return { kind: "invalid", reason: "admitted schedule occurrence count exceeds the safe integer range" };
  }
  const exhausted = input.maxRuns !== "unlimited" && admittedCount === input.maxRuns;
  const missedSlots = dueSlots - 1;
  const totalSkippedSlots = input.skippedSlots + missedSlots;
  if (!Number.isSafeInteger(totalSkippedSlots)) {
    return { kind: "invalid", reason: "skipped schedule slot count exceeds the safe integer range" };
  }
  return {
    kind: "admit",
    slotAt: latestSlotAt,
    skippedCount: missedSlots,
    firstSkippedSlotAt: missedSlots === 0 ? null : input.nextDueAt,
    lastSkippedSlotAt: missedSlots === 0 ? null : formatUtcMillis(latestSlotMs - input.everyMs) ?? null,
    nextDueAt: exhausted ? null : followingSlotAt,
    admittedCount,
    exhausted,
    totalSkippedSlots,
  };
}

/** Compute the first fixed-rate deadline and reject overflow before the first occurrence is admitted. */
export function firstFixedRateDeadline(activatedAt: string, everyMs: number): string | null {
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) throw new Error("schedule interval must be a positive safe integer");
  const activatedAtMs = parseUtcMillis(activatedAt);
  if (activatedAtMs === undefined) throw new Error("activation time is not a supported UTC timestamp");
  const nextDueAt = formatUtcMillis(activatedAtMs + everyMs);
  if (nextDueAt === undefined) throw new Error("first schedule deadline exceeds the supported UTC timestamp range");
  return nextDueAt;
}

function parseUtcMillis(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= MAX_DATE_MS ? parsed : undefined;
}

function formatUtcMillis(value: number): string | undefined {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_MS) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
