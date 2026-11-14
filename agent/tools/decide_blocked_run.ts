import { defineTool } from "eve/tools";
import { sendWorkflowDecision } from "../lib/send-workflow-decision.ts";
import type { WorkflowDecision } from "../../workflow/types.ts";
import { z } from "zod";

const duration = z.string().refine((value) => {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  return Number.isSafeInteger(amount) && amount * factor <= 2_147_483_647;
}, "must be a positive duration supported by Node timers");

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    run_id: z.string().min(1),
    action: z.literal("retry"),
    hint: z.string().optional(),
    profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    after: duration.optional(),
  }).strict(),
  z.object({ run_id: z.string().min(1), action: z.literal("skip") }).strict(),
  z.object({ run_id: z.string().min(1), action: z.literal("accept") }).strict(),
  z.object({ run_id: z.string().min(1), action: z.literal("fail") }).strict(),
]);

type DecisionInput = z.infer<typeof inputSchema>;

export async function decideBlockedRun(
  runId: string,
  decision: WorkflowDecision,
  send: (id: string, value: WorkflowDecision) => Promise<void> = sendWorkflowDecision,
): Promise<{ run_id: string; decision: WorkflowDecision }> {
  await send(runId, decision);
  return { run_id: runId, decision };
}

function decisionFromInput(input: DecisionInput): { runId: string; decision: WorkflowDecision } {
  if (input.action !== "retry") return { runId: input.run_id, decision: { action: input.action } };
  return {
    runId: input.run_id,
    decision: {
      action: "retry",
      ...(input.hint === undefined ? {} : { hint: input.hint }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.after === undefined ? {} : { after: input.after }),
    },
  };
}

export default defineTool({
  description: "Apply a retry, skip, accept, or fail decision to a run waiting on a blocked step. Retry profiles must use the step's executable.",
  inputSchema,
  async execute(input) {
    const { runId, decision } = decisionFromInput(input);
    return decideBlockedRun(runId, decision);
  },
});
