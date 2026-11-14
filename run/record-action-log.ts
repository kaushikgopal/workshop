import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readActionLog } from "./read-action-log.ts";

export type ActionLogDecision =
  | { action: "retry"; hint?: string; profile?: string; after?: string; note?: string }
  | { action: "skip" | "accept" | "fail" | "give_up"; note?: string }
  | { action: "start" | "cancel" | "pause" | "resume" };

export type ActionLogEntry = {
  at: string;
  workflow: string;
  run_id: string | null;
  step: string | null;
  source: "round-1" | "round-2" | "chat";
  decision: ActionLogDecision;
  note: string;
};

export type RecordActionLogInput = Omit<ActionLogEntry, "at"> & { at?: string };

export function recordActionLog(file: string, input: RecordActionLogInput): ActionLogEntry {
  const existing = input.source === "round-1" || input.source === "round-2"
    ? readActionLog(file, Number.MAX_SAFE_INTEGER).find((entry) =>
        entry.workflow === input.workflow &&
        entry.run_id === input.run_id &&
        entry.step === input.step &&
        entry.source === input.source,
      )
    : undefined;
  if (existing) return existing;

  const entry: ActionLogEntry = { ...input, at: input.at ?? new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}
