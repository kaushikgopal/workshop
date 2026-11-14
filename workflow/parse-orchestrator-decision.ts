import { z } from "zod";
import type { OrchestratorDecision } from "./types.ts";

const maximumDelayMs = 2_147_483_647;
const duration = z.string().refine((value) => {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  return Number.isSafeInteger(amount) && amount * factor <= maximumDelayMs;
}, "must be a positive duration supported by Node timers, such as 30s, 10m, or 2h");

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry"), hint: z.string().optional(), profile: z.string().optional(), after: duration.optional(), note: z.string() }).strict(),
  z.object({ action: z.literal("skip"), note: z.string() }).strict(),
  z.object({ action: z.literal("accept"), note: z.string() }).strict(),
  z.object({ action: z.literal("fail"), note: z.string() }).strict(),
  z.object({ action: z.literal("give_up"), note: z.string() }).strict(),
]);

export type OrchestratorDecisionContext = {
  allowedRetryProfiles: readonly string[];
  lastOutput: string;
};

export function parseOrchestratorDecision(raw: string, context: OrchestratorDecisionContext): OrchestratorDecision {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { action: "give_up", note: `Orchestrator output was not strict JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { action: "give_up", note: `Orchestrator decision was invalid: ${issue?.message ?? "unknown schema error"}` };
  }
  const decision = parsed.data;
  if (decision.action === "retry" && decision.profile !== undefined && !context.allowedRetryProfiles.includes(decision.profile)) {
    return { action: "give_up", note: `Orchestrator selected disallowed retry profile "${decision.profile}"` };
  }
  if (decision.action === "accept" && context.lastOutput.trim().length === 0) {
    return { action: "give_up", note: "Orchestrator tried to accept a failed attempt with no output" };
  }
  return decision;
}

export function failedOrchestratorDecision(reason: string): OrchestratorDecision {
  return { action: "give_up", note: `Orchestrator command failed: ${reason}` };
}
