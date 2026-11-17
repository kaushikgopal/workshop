import { z } from "zod";
import { parseWorkflowDuration } from "./parse-workflow-duration.ts";
import type { WorkflowDecision } from "./types.ts";

const duration = z.string().refine(
  (value) => parseWorkflowDuration(value).kind === "valid",
  "must be a positive duration supported by Node timers",
);

const decisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    hint: z.string().optional(),
    profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    after: duration.optional(),
  }).strict(),
  z.object({ action: z.literal("skip") }).strict(),
  z.object({ action: z.literal("accept") }).strict(),
  z.object({ action: z.literal("fail") }).strict(),
]);

export function parseWorkflowDecision(value: unknown): WorkflowDecision {
  return decisionSchema.parse(value);
}
