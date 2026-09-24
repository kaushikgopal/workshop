import type { NodeDefinition, WorkflowDefinition } from "../definition/schema.js";
import { resolveAgent, type AgentResolution } from "../definition/resolve.js";
import { parseTimeout } from "../util/duration.js";
import { parseByteSize, type StreamCap } from "../util/retention.js";

export type NodeRun =
  | { kind: "command"; command: string }
  | { kind: "agent"; agent: { harness?: { command: string }; model?: string; instructions: string }; resolution: AgentResolution };

export type NodeValidator =
  | { kind: "command"; command: string; timeoutMs: number | null }
  | { kind: "agent"; agent: { harness?: { command: string }; model?: string; instructions: string }; resolution: AgentResolution; timeoutMs: number | null };

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
  inst: { defaultTimeoutMs: number; streamCapBytes: StreamCap; machineAgent: { harness?: { command: string }; model?: string } | undefined },
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
