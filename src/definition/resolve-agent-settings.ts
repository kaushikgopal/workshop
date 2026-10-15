import { parseModel, type ParsedModel } from "./parse-model.js";
import type { AgentDefaults, AgentSettings } from "./schema.js";

export interface AgentResolution {
  model: ParsedModel | null;
}

/** Resolve the model independently: execution site, workflow, then machine. */
export function resolveAgent(input: {
  site?: Pick<AgentSettings, "model">;
  workflowDefault?: Pick<AgentDefaults, "model">;
  machine?: Pick<AgentDefaults, "model">;
}): AgentResolution {
  const modelRaw = input.site?.model ?? input.workflowDefault?.model ?? input.machine?.model ?? null;

  return {
    model: modelRaw ? parseModel(modelRaw) : null,
  };
}
