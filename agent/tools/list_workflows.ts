import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { listWorkflowStatus } from "../../workflow/list-workflow-status.ts";
import { loadWorkflows } from "../../workflow/load-workflows.ts";
import { readPausedWorkflows } from "../../workflow/read-paused-workflows.ts";
import { readConfig } from "../lib/read-config.ts";

export function listWorkflows(root = resolve(process.cwd(), "workflows"), stateRoot = resolve(process.cwd(), "state")) {
  const config = readConfig();
  const loaded = loadWorkflows(root, new Set(Object.keys(config.agent_profiles)));
  const paused = readPausedWorkflows(resolve(stateRoot, "paused.json"));
  return listWorkflowStatus(loaded, paused);
}

export default defineTool({
  description: "List workflows, including whether each is enabled or paused and any errors in broken workflows.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute() {
    return listWorkflows();
  },
});
