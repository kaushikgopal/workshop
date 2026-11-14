import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { changeWorkflowPause } from "../../workflow/change-workflow-pause.ts";
import { z } from "zod";

export function pauseWorkflow(workflow: string) {
  const stateRoot = resolve(process.cwd(), "state");
  return changeWorkflowPause({
    workflow,
    paused: true,
    pauseFile: resolve(stateRoot, "paused.json"),
    actionFile: resolve(stateRoot, "actions.jsonl"),
  });
}

export default defineTool({
  description: "Pause a workflow so future schedule ticks skip it and manual starts are refused.",
  inputSchema: z.object({ workflow: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }),
  execute({ workflow }) {
    return pauseWorkflow(workflow);
  },
});
