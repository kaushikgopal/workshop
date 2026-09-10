import type { WorkflowDefinition, NodeDefinition } from "./schema.js";

/**
 * Chain validation on the already-schema-checked definition:
 * exactly one start, no cycles, no missing successors, no unreachable nodes,
 * and one terminal end.
 */

export interface ChainInfo {
  /** Node ids in chain order from the start node. */
  order: string[];
  /** node id -> successor node id, or null for the terminal node. */
  next: Map<string, string | null>;
  /** node id -> predecessor node id (derived, never authored). */
  prev: Map<string, string | null>;
}

export function validateChain(def: WorkflowDefinition): ChainInfo {
  const nodes = def.nodes;
  const ids = Object.keys(nodes);

  const referenced = new Set<string>();
  for (const id of ids) {
    const next = nodes[id]!.next;
    if (next !== undefined && next !== null) {
      if (!(next in nodes)) {
        throw new Error(`node "${id}" has next "${next}", but no such node exists`);
      }
      referenced.add(next);
    }
  }

  const starts = ids.filter((id) => !referenced.has(id));
  if (starts.length === 0) throw new Error("chain has no start node (every node is a successor)");
  if (starts.length > 1) {
    throw new Error(`chain has multiple start nodes (${starts.join(", ")}) — exactly one node may have no predecessor`);
  }

  // Walk the single forward chain; any revisit is a cycle, any unvisited node
  // is unreachable.
  const order: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = starts[0]!;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error(`chain has a cycle at node "${cursor}"`);
    seen.add(cursor);
    order.push(cursor);
    const node: NodeDefinition = nodes[cursor]!;
    if (node.next === undefined || node.next === null) break;
    cursor = node.next;
  }
  const unreachable = ids.filter((id) => !seen.has(id));
  if (unreachable.length > 0) {
    throw new Error(`unreachable nodes rejected (not on the start chain): ${unreachable.join(", ")}`);
  }

  const next = new Map<string, string | null>();
  const prev = new Map<string, string | null>();
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    next.set(id, i + 1 < order.length ? order[i + 1]! : null);
    prev.set(id, i > 0 ? order[i - 1]! : null);
  }
  return { order, next, prev };
}

export interface ParsedModel {
  provider: string;
  modelId: string;
  thinking: string;
  full: string;
}

/** `<provider>/<model-id>:<thinking-level>` — first slash, last colon. */
export function parseModel(full: string): ParsedModel {
  const slash = full.indexOf("/");
  const colon = full.lastIndexOf(":");
  if (slash <= 0 || colon <= slash + 1 || colon === full.length - 1) {
    throw new Error(`invalid model string "${full}" — expected <provider>/<model-id>:<thinking-level>`);
  }
  return {
    provider: full.slice(0, slash),
    modelId: full.slice(slash + 1, colon),
    thinking: full.slice(colon + 1),
    full,
  };
}

export interface AgentResolution {
  harnessCommand: string | null;
  harnessTemplate: string | null;
  model: ParsedModel | null;
}

export interface ResolutionInputs {
  node?: { harness?: { command?: string }; model?: string } | undefined;
  workflowDefault?: { harness?: { command?: string }; model?: string } | undefined;
  machine?: { harness?: { command?: string }; model?: string } | undefined;
}

/**
 * One precedence chain for every agent site:
 * site override → workflow default → machine default.
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

export function describeNode(node: NodeDefinition): string {
  return "agent" in node.run ? "agent" : "command";
}
