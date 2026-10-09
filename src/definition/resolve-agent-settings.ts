import { parseModel, type ParsedModel } from "./parse-model.js";
import type {
  AgentDefaults,
  AgentSettings,
  WorkflowDefinition,
} from "./schema.js";

export interface AgentResolution {
  harnessCommand: string | null;
  model: ParsedModel | null;
}

/** Resolve each agent field independently: execution site, workflow, then machine. */
export function resolveAgent(input: {
  site?: Pick<AgentSettings, "harness" | "model">;
  workflowDefault?: AgentDefaults;
  machine?: AgentDefaults;
}): AgentResolution {
  const harnessCommand =
    input.site?.harness?.command ??
    input.workflowDefault?.harness?.command ??
    input.machine?.harness?.command ??
    null;
  const modelRaw = input.site?.model ?? input.workflowDefault?.model ?? input.machine?.model ?? null;

  return {
    harnessCommand,
    model: modelRaw ? parseModel(modelRaw) : null,
  };
}

/** List agent execution sites whose harness or model remains unresolved. */
export function unresolvedAgentSites(
  def: WorkflowDefinition,
  machine: AgentDefaults | undefined,
): string[] {
  const unresolved: string[] = [];
  for (const [id, node] of Object.entries(def.nodes)) {
    if ("agent" in node.run) {
      const resolved = resolveAgent({
        site: node.run.agent,
        workflowDefault: def.defaults?.agent,
        machine,
      });
      if (!resolved.harnessCommand || !resolved.model) unresolved.push(`node "${id}" run`);
    }

    if (node.validator && "agent" in node.validator) {
      const resolved = resolveAgent({
        site: node.validator.agent,
        workflowDefault: def.defaults?.agent,
        machine,
      });
      if (!resolved.harnessCommand || !resolved.model) unresolved.push(`node "${id}" validator`);
    }
  }
  return unresolved;
}
