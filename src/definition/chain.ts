import type { WorkflowDefinition, NodeDefinition } from "./schema.js";

/**
 * Chain topology: the graph invariant the runtime relies on.
 *
 * This is a *different* check from the schema's: zod establishes that every
 * field has the right shape, and this establishes that the shapes form one
 * finite forward chain. Neither implies the other, so they live apart.
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

