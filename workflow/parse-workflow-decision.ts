import { z } from "zod";
import type { WorkflowDecision } from "./types.ts";

const duration = z.string().refine((value) => {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  return Number.isSafeInteger(amount) && amount * factor <= 2_147_483_647;
}, "must be a positive duration supported by Node timers");

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
