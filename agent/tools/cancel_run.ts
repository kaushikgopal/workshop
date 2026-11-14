import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { getRun } from "eve/workflow/api";
import { recordActionLog } from "../../run/record-action-log.ts";
import { cancelWorkflowRun } from "../../run/cancel-workflow-run.ts";
import { readRunIndex } from "../../run/read-run-index.ts";
import { z } from "zod";

export async function cancelRun(runId: string) {
  const stateRoot = resolve(process.cwd(), "state");
  const entries = readRunIndex(resolve(stateRoot, "runs.jsonl"));
  return cancelWorkflowRun(runId, entries, {
    getStatus: async (id) => await getRun(id).status,
    cancel: async (id) => await getRun(id).cancel(),
    recordAction: ({ workflow, runId: cancelledRunId }) => {
      recordActionLog(resolve(stateRoot, "actions.jsonl"), {
        workflow,
        run_id: cancelledRunId,
        step: null,
        source: "chat",
        decision: { action: "cancel" },
        note: "Run cancellation requested from chat.",
      });
    },
  });
}

export default defineTool({
  description: "Cancel an active workflow run using Eve's workflow cancellation API.",
  inputSchema: z.object({ run_id: z.string().min(1) }),
  execute({ run_id }) {
    return cancelRun(run_id);
  },
});
