import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { getRun } from "eve/workflow/api";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { readBlockedStep } from "../../run/read-blocked-step.ts";
import { readRunIndex } from "../../run/read-run-index.ts";
import { readWorkflowRun, type WorkflowRunInspection } from "../../run/read-workflow-run.ts";
import { z } from "zod";

async function inspectEveRun(runId: string): Promise<WorkflowRunInspection> {
  const run = getRun(runId);
  const status = await run.status;
  if (status !== "completed" && status !== "failed") return { status };
  try {
    return { status, returnValue: await run.returnValue };
  } catch (error) {
    return { status, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readRun(runId: string) {
  const stateRoot = resolve(process.cwd(), "state");
  const entries = readRunIndex(resolve(stateRoot, "runs.jsonl"));
  return readWorkflowRun(runId, entries, {
    inspect: inspectEveRun,
    readBlocked: (id) => readBlockedStep(locateBlockedStep(stateRoot, id)),
  });
}

export default defineTool({
  description: "Read a workflow run's status, available step outputs and errors, and blocked-step attempt history.",
  inputSchema: z.object({ run_id: z.string().min(1) }),
  execute({ run_id }) {
    return readRun(run_id);
  },
});
