import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { changeWorkflowPause } from "../../workflow/change-workflow-pause.ts";
import { z } from "zod";

export function resumeWorkflow(workflow: string) {
  const stateRoot = resolve(process.cwd(), "state");
  return changeWorkflowPause({
    workflow,
    paused: false,
    pauseFile: resolve(stateRoot, "paused.json"),
    actionFile: resolve(stateRoot, "actions.jsonl"),
  });
}

export default defineTool({
  description: "Resume a paused workflow so future schedule ticks can start it again.",
  inputSchema: z.object({ workflow: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }),
  execute({ workflow }) {
    return resumeWorkflow(workflow);
  },
});
