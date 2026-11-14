import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { getRun } from "eve/workflow/api";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { listWorkflowRuns } from "../../run/list-workflow-runs.ts";
import { readBlockedStep } from "../../run/read-blocked-step.ts";
import { readRunIndex } from "../../run/read-run-index.ts";
import { z } from "zod";

export async function listRuns(input: { workflow?: string; limit?: number }) {
  const stateRoot = resolve(process.cwd(), "state");
  const entries = readRunIndex(resolve(stateRoot, "runs.jsonl"));
  return listWorkflowRuns(entries, { workflow: input.workflow, limit: input.limit ?? 20 }, {
    getStatus: async (runId) => await getRun(runId).status,
    readBlocked: (runId) => readBlockedStep(locateBlockedStep(stateRoot, runId)),
  });
}

export default defineTool({
  description: "List recent workflow runs and every run currently waiting on a blocked-step decision.",
  inputSchema: z.object({ workflow: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
  execute(input) {
    return listRuns(input);
  },
});
