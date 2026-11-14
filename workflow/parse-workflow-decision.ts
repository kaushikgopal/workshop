import { z } from "zod";
import type { WorkflowDecision } from "./types.ts";

const decisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    hint: z.string().optional(),
    profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  }).strict(),
  z.object({ action: z.literal("skip") }).strict(),
  z.object({ action: z.literal("accept") }).strict(),
  z.object({ action: z.literal("fail") }).strict(),
]);

export function parseWorkflowDecision(value: unknown): WorkflowDecision {
  return decisionSchema.parse(value);
}
