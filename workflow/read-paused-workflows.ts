import { readFileSync } from "node:fs";
import { z } from "zod";

const pausedSchema = z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

export function readPausedWorkflows(file: string): Set<string> {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = pausedSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`${file}: ${detail}`);
  }
  return new Set(parsed.data);
}
