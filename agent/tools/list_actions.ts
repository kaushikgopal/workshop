import { resolve } from "node:path";
import { defineTool } from "eve/tools";
import { readActionLog } from "../../run/read-action-log.ts";
import { z } from "zod";

export function listActions(limit = 20) {
  return readActionLog(resolve(process.cwd(), "state", "actions.jsonl"), limit);
}

export default defineTool({
  description: "Read recent automatic and chat actions taken on workflow runs.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  execute({ limit }) {
    return listActions(limit ?? 20);
  },
});
