import { isAbsolute } from "node:path";
import { DEFAULT_STREAM_CAP_BYTES, parseV2ByteSize, parseV2Duration } from "../util/parse-units.js";
import { parseV2Model } from "./parse-v2-model.js";
import { resolveV2Agent } from "./resolve-v2-agent-settings.js";
import type { AgentDefaultsV2, MachineConfigV2, NodeDefinitionV2, WorkflowDefinitionV2 } from "./schema-v2.js";
import { resolvedWorkflowSettingsV2Schema, type ResolvedExecutionSiteV2, type ResolvedNodeSettingsV2 } from "./schema-resolved-v2.js";

/** Resolve every execution setting once, before admission, from checked workflow and machine inputs. */
export function resolveV2WorkflowSettings(input: {
  definition: WorkflowDefinitionV2;
  machine: MachineConfigV2;
  projectCwd: string;
}) {
  const { definition, machine } = input;
  if (!isAbsolute(input.projectCwd) || input.projectCwd.includes("\u0000")) {
    throw new Error("project working directory must be an absolute path without NUL");
  }
  const shell = machine.shell ?? "/bin/bash";
  const nodes: Record<string, ResolvedNodeSettingsV2> = {};

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    const timeout = node.timeout ?? definition.defaults?.timeout ?? machine.default_timeout ?? "10m";
    const streamCap = node.stream_cap ?? definition.defaults?.stream_cap ?? machine.stream_cap;
    const run = resolveExecutionSite({
      site: node.run,
      timeout,
      streamCap,
      replay: node.replay ?? definition.defaults?.replay ?? "never",
      shell,
      cwd: input.projectCwd,
      workflowDefault: definition.defaults?.agent,
      machineDefault: machine.agent,
    });
    const validator = node.validator === undefined
      ? null
      : resolveExecutionSite({
          site: node.validator,
          timeout: node.validator.timeout ?? definition.defaults?.timeout ?? machine.default_timeout ?? "10m",
          streamCap,
          replay: node.validator.replay ?? definition.defaults?.replay ?? "never",
          shell,
          cwd: input.projectCwd,
          workflowDefault: definition.defaults?.agent,
          machineDefault: machine.agent,
        });
    nodes[nodeId] = {
      run,
      validator,
      maxAttempts: node.max_attempts ?? definition.defaults?.max_attempts ?? 2,
    };
  }

  const preflight = definition.environment === undefined
    ? null
    : {
        command: definition.environment.preflight.command,
        shell,
        cwd: input.projectCwd,
        timeoutMs: parseTimeout(definition.environment.preflight.timeout ?? "30s"),
      };
  const orchestratorModel = definition.orchestrator?.model ?? machine.orchestrator?.model ?? null;
  const orchestrator = {
    model: orchestratorModel === null ? null : parseV2Model(orchestratorModel).full,
    timeoutMs: orchestratorModel === null
      ? null
      : parseTimeout(definition.orchestrator?.timeout ?? machine.orchestrator?.timeout ?? "5m"),
  };

  return resolvedWorkflowSettingsV2Schema.parse({ nodes, preflight, orchestrator });
}

function resolveExecutionSite(input: {
  site: NodeDefinitionV2["run"] | NonNullable<NodeDefinitionV2["validator"]>;
  timeout: string;
  streamCap: string | undefined;
  replay: "never" | "safe";
  shell: string;
  cwd: string;
  workflowDefault: AgentDefaultsV2 | undefined;
  machineDefault: AgentDefaultsV2 | undefined;
}): ResolvedExecutionSiteV2 {
  const common = {
    shell: input.shell,
    cwd: input.cwd,
    timeoutMs: parseTimeout(input.timeout),
    streamCapBytes: input.streamCap === undefined
      ? DEFAULT_STREAM_CAP_BYTES
      : parseV2ByteSize(input.streamCap),
    replay: input.replay,
  };
  if ("command" in input.site) return { kind: "command", command: input.site.command, ...common };

  const resolved = resolveV2Agent({
    site: input.site.agent,
    workflowDefault: input.workflowDefault,
    machine: input.machineDefault,
  });
  if (resolved.harnessCommand === null || resolved.model === null) {
    throw new Error("agent execution settings remain unresolved");
  }
  return {
    kind: "agent",
    harnessCommand: resolved.harnessCommand,
    model: resolved.model.full,
    instructions: input.site.agent.instructions,
    ...common,
  };
}

function parseTimeout(raw: string): number | null {
  return raw === "unlimited" ? null : parseV2Duration(raw);
}
