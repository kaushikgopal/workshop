import { parseModel, type ParsedModel } from "./model.js";
import type { WorkflowDefinition } from "./schema.js";

export interface AgentResolution {
  harnessCommand: string | null;
  harnessTemplate: string | null;
  model: ParsedModel | null;
}

/** The agent settings offered to one site, before precedence is applied. */
export interface ResolutionInputs {
  node?: { harness?: { command?: string }; model?: string } | undefined;
  workflowDefault?: { harness?: { command?: string }; model?: string } | undefined;
  machine?: { harness?: { command?: string }; model?: string } | undefined;
}

/**
 * One precedence chain for every agent site: site override, then workflow
 * default, then machine default — resolved **per field**, so a node that sets
 * only a model keeps the harness it would otherwise inherit.
 */

export function resolveAgent(inputs: ResolutionInputs): AgentResolution {
  const harnessCommand =
    inputs.node?.harness?.command ?? inputs.workflowDefault?.harness?.command ?? inputs.machine?.harness?.command ?? null;
  const modelRaw = inputs.node?.model ?? inputs.workflowDefault?.model ?? inputs.machine?.model ?? null;
  return {
    harnessCommand,
    harnessTemplate: harnessCommand,
    model: modelRaw ? parseModel(modelRaw) : null,
  };
}

export function unresolvedAgentSites(def: WorkflowDefinition, machine: ResolutionInputs["machine"]): string[] {
  const unresolved: string[] = [];
  for (const [id, node] of Object.entries(def.nodes)) {
    const runAgent = "agent" in node.run ? node.run.agent : undefined;
    if (runAgent) {
      const r = resolveAgent({ node: runAgent, workflowDefault: def.defaults?.agent, machine });
      if (!r.harnessCommand || !r.model) {
        unresolved.push(`node "${id}" run`);
      }
    }
    if (node.validator && "agent" in node.validator) {
      const r = resolveAgent({ node: node.validator.agent, workflowDefault: def.defaults?.agent, machine });
      if (!r.harnessCommand || !r.model) {
        unresolved.push(`node "${id}" validator`);
      }
    }
  }
  return unresolved;
}
