import { CronExpressionParser } from "cron-parser";

export type WorkflowSlotDecision =
  | { kind: "start"; slot: string }
  | { kind: "already-indexed"; slot: string }
  | { kind: "skip"; slot: string; reason: string };

export function latestCronSlot(cron: string, now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("schedule time must be a valid date");
  // cron-parser's prev() is exclusive, so advance one millisecond to include an exact slot.
  const currentDate = new Date(now.getTime() + 1);
  return CronExpressionParser.parse(cron, { currentDate, tz: "UTC" }).prev().toDate().toISOString();
}

export function decideWorkflowSlot(input: {
  cron: string;
  now: Date;
  lastSlot?: string;
  startedCount: number;
  maxRuns?: number;
}): WorkflowSlotDecision {
  const slot = latestCronSlot(input.cron, input.now);
  if (input.lastSlot !== undefined && slot <= input.lastSlot) return { kind: "already-indexed", slot };
  if (input.maxRuns !== undefined && input.startedCount >= input.maxRuns) {
    return { kind: "skip", slot, reason: "max_runs reached" };
  }
  return { kind: "start", slot };
}
