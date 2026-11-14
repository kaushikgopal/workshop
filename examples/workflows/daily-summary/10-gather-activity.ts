import { readFileSync } from "node:fs";
import { join } from "node:path";

type ActivityEntry = Record<string, unknown> & { at: string };

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readRecentActivity(file: string, start: number, end: number): ActivityEntry[] {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }

  return contents.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file} line ${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${file} line ${index + 1}: expected a JSON object`);
    }
    const record = Object.fromEntries(Object.entries(value));
    const at = record["at"];
    if (typeof at !== "string") throw new Error(`${file} line ${index + 1}: missing activity timestamp`);
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) throw new Error(`${file} line ${index + 1}: invalid activity timestamp`);
    return timestamp >= start && timestamp <= end ? [{ ...record, at }] : [];
  });
}

const stateDirectory = process.env.WORKSHOP_STATE_DIR;
if (!stateDirectory) throw new Error("WORKSHOP_STATE_DIR is required");

const end = Date.now();
const start = end - 24 * 60 * 60 * 1_000;
const report = {
  window_start: new Date(start).toISOString(),
  window_end: new Date(end).toISOString(),
  runs: readRecentActivity(join(stateDirectory, "runs.jsonl"), start, end),
  actions: readRecentActivity(join(stateDirectory, "actions.jsonl"), start, end),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
