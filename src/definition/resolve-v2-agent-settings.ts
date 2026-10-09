import { parseV2Model, type ParsedModelV2 } from "./parse-v2-model.js";
import type {
  AgentDefaultsV2,
  AgentSettingsV2,
  WorkflowDefinitionV2,
} from "./schema-v2.js";

export interface AgentResolutionV2 {
  harnessCommand: string | null;
  model: ParsedModelV2 | null;
}

/** Resolve each agent field independently: execution site, workflow, then machine. */
export function resolveV2Agent(input: {
  site?: Pick<AgentSettingsV2, "harness" | "model">;
  workflowDefault?: AgentDefaultsV2;
  machine?: AgentDefaultsV2;
}): AgentResolutionV2 {
  const harnessCommand =
    input.site?.harness?.command ??
    input.workflowDefault?.harness?.command ??
    input.machine?.harness?.command ??
    null;
  const modelRaw = input.site?.model ?? input.workflowDefault?.model ?? input.machine?.model ?? null;

  return {
    harnessCommand,
    model: modelRaw ? parseV2Model(modelRaw) : null,
  };
}

/** List agent execution sites whose harness or model remains unresolved. */
export function unresolvedV2AgentSites(
  def: WorkflowDefinitionV2,
  machine: AgentDefaultsV2 | undefined,
): string[] {
  const unresolved: string[] = [];
  for (const [id, node] of Object.entries(def.nodes)) {
    if ("agent" in node.run) {
      const resolved = resolveV2Agent({
        site: node.run.agent,
        workflowDefault: def.defaults?.agent,
        machine,
      });
      if (!resolved.harnessCommand || !resolved.model) unresolved.push(`node "${id}" run`);
    }

    if (node.validator && "agent" in node.validator) {
      const resolved = resolveV2Agent({
        site: node.validator.agent,
        workflowDefault: def.defaults?.agent,
        machine,
      });
      if (!resolved.harnessCommand || !resolved.model) unresolved.push(`node "${id}" validator`);
    }
  }
  return unresolved;
}
