import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RunIndexEntry } from "./types.ts";

const entrySchema = z.object({
  workflow: z.string().min(1),
  slot: z.string().datetime({ offset: true }).nullable(),
  run_id: z.string().min(1).nullable(),
  outcome: z.enum(["started", "skipped"]),
  reason: z.string().optional(),
  at: z.string().datetime({ offset: true }),
}).strict().refine((entry) => entry.outcome !== "started" || entry.run_id !== null, "started entries must include a run_id");

function parseEntry(line: string, lineNumber: number): RunIndexEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`state/runs.jsonl line ${lineNumber}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const result = entrySchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`state/runs.jsonl line ${lineNumber}: ${detail}`);
  }
  return result.data;
}

export function readRunIndex(file: string): RunIndexEntry[] {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return contents.split(/\r?\n/).flatMap((line, index) => line.trim().length === 0 ? [] : [parseEntry(line, index + 1)]);
}

export function lastSlotForWorkflow(entries: readonly RunIndexEntry[], workflow: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.workflow === workflow && entry.slot !== null) return entry.slot;
  }
  return undefined;
}

export function startedCountForWorkflow(entries: readonly RunIndexEntry[], workflow: string): number {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (entry.workflow === workflow && entry.outcome === "started" && entry.run_id !== null) runIds.add(entry.run_id);
  }
  return runIds.size;
}

export function recentRuns(entries: readonly RunIndexEntry[], limit: number, workflow?: string): RunIndexEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("recent run limit must be a nonnegative safe integer");
  if (limit === 0) return [];
  return entries.filter((entry) => workflow === undefined || entry.workflow === workflow).slice(-limit).reverse();
}
