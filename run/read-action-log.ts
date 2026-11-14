import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ActionLogEntry } from "./record-action-log.ts";

const decisionSchema = z.union([
  z.object({ action: z.literal("retry"), hint: z.string().optional(), profile: z.string().optional(), after: z.string().optional(), note: z.string().optional() }).strict(),
  z.object({ action: z.enum(["skip", "accept", "fail", "give_up"]), note: z.string().optional() }).strict(),
  z.object({ action: z.enum(["start", "cancel", "pause", "resume"]) }).strict(),
]);
const entrySchema = z.object({
  at: z.string().datetime({ offset: true }),
  workflow: z.string().min(1),
  run_id: z.string().min(1).nullable(),
  step: z.string().min(1).nullable(),
  source: z.enum(["round-1", "round-2", "chat"]),
  decision: decisionSchema,
  note: z.string(),
}).strict();

export function readActionLog(file: string, limit = 20): ActionLogEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("action log limit must be a nonnegative safe integer");
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries = contents.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file} line ${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`${file} line ${index + 1}: ${detail}`);
    }
    return [parsed.data];
  });
  return limit === 0 ? [] : entries.slice(-limit).reverse();
}
