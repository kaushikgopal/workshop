import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readRunIndex } from "./read-run-index.ts";
import type { RunIndexEntry } from "./types.ts";

type AppendRunIndexInput = Omit<RunIndexEntry, "at"> & { at?: string };

export function appendRunIndex(file: string, input: AppendRunIndexInput): RunIndexEntry {
  const entry: RunIndexEntry = { ...input, at: input.at ?? new Date().toISOString() };
  const entries = readRunIndex(file);
  const alreadyWritten = entries.some((previous) =>
    previous.workflow === entry.workflow &&
    previous.slot === entry.slot &&
    previous.run_id === entry.run_id &&
    previous.outcome === entry.outcome,
  );
  if (!alreadyWritten) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  }
  return entry;
}
