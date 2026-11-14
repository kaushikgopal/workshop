import { readFileSync } from "node:fs";
import { z } from "zod";
import type { BlockedWorkflowStep } from "./types.ts";

const blockedStepSchema = z.object({
  workflow: z.string().min(1),
  run_id: z.string().min(1),
  step: z.string().min(1),
  step_kind: z.enum(["agent", "command"]),
  retry_profiles: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  last_error: z.string(),
  last_output: z.string().optional(),
  attempt_history: z.array(z.object({
    attempt: z.number().int().positive(),
    profile: z.string().optional(),
    output: z.string(),
    error: z.string().optional(),
  }).strict()).optional(),
  token: z.string().min(1),
  at: z.string().datetime({ offset: true }),
}).strict();

export function readBlockedStep(file: string): BlockedWorkflowStep | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const result = blockedStepSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`${file}: ${detail}`);
  }
  return result.data;
}
