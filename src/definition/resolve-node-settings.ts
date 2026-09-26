import { parseTimeout, parseByteSize, type StreamCap } from "../util/parse-units.js";
import { parseModel, type ParsedModel } from "./parse-model.js";
import type { NodeDefinition, WorkflowDefinition } from "./schema.js";

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
export type NodeRun = { kind: "command"; command: string; } |
{ kind: "agent"; agent: { harness?: { command: string; }; model?: string; instructions: string; }; resolution: AgentResolution; };
export type NodeValidator = { kind: "command"; command: string; timeoutMs: number | null; } |
{ kind: "agent"; agent: { harness?: { command: string; }; model?: string; instructions: string; }; resolution: AgentResolution; timeoutMs: number | null; };
export interface NodeResolved {
  maxAttempts: number;
  timeoutMs: number | null; // null = unlimited
  streamCapBytes: StreamCap;
  run: NodeRun;
  validator: NodeValidator | null;
}
/** Resolve one node's bounds and execution union. */
export function resolveNode(
  def: WorkflowDefinition,
  nodeId: string,
  inst: { defaultTimeoutMs: number; streamCapBytes: StreamCap; machineAgent: { harness?: { command: string; }; model?: string; } | undefined; }
): NodeResolved {
  const node: NodeDefinition = def.nodes[nodeId]!;
  if (!node) throw new Error(`no node "${nodeId}" in definition`);
  const maxAttempts = node.max_attempts ?? def.defaults?.max_attempts ?? 2;

  const timeout = parseTimeout(node.timeout);
  const defaultTimeout = def.defaults?.timeout ? parseTimeout(def.defaults.timeout) : null;
  let timeoutMs: number | null;
  if (timeout.kind === "unlimited") {
    timeoutMs = null;
  } else if (timeout.ms >= 0) {
    timeoutMs = timeout.ms;
  } else if (defaultTimeout && defaultTimeout.kind === "limited" && defaultTimeout.ms >= 0) {
    timeoutMs = defaultTimeout.ms;
  } else if (defaultTimeout?.kind === "unlimited") {
    timeoutMs = null;
  } else {
    timeoutMs = inst.defaultTimeoutMs;
  }

  let run: NodeRun;
  if ("command" in node.run) {
    run = { kind: "command", command: node.run.command };
  } else {
    const agent = node.run.agent;
    const resolution = resolveAgent({ node: agent, workflowDefault: def.defaults?.agent, machine: inst.machineAgent });
    run = { kind: "agent", agent, resolution };
  }

  let validator: NodeValidator | null = null;
  if (node.validator) {
    if ("command" in node.validator) {
      const vt = node.validator.timeout ? parseTimeout(node.validator.timeout) : null;
      validator = {
        kind: "command",
        command: node.validator.command,
        timeoutMs: vt ? (vt.kind === "unlimited" ? null : vt.ms) : inst.defaultTimeoutMs,
      };
    } else {
      const agent = node.validator.agent;
      const resolution = resolveAgent({ node: agent, workflowDefault: def.defaults?.agent, machine: inst.machineAgent });
      const vt = node.validator.timeout ? parseTimeout(node.validator.timeout) : null;
      validator = {
        kind: "agent",
        agent,
        resolution,
        timeoutMs: vt ? (vt.kind === "unlimited" ? null : vt.ms) : inst.defaultTimeoutMs,
      };
    }
  }

  return { maxAttempts, timeoutMs, streamCapBytes: node.stream_cap ? parseByteSize(node.stream_cap) : inst.streamCapBytes, run, validator };
}
