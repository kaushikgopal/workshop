import { isAbsolute } from "node:path";
import { DEFAULT_STREAM_CAP_BYTES, parseByteSize, parseDuration } from "../util/parse-units.js";
import { parseModel } from "./parse-model.js";
import { resolveAgent } from "./resolve-agent-settings.js";
import type { AgentDefaults, MachineConfig, NodeDefinition, WorkflowDefinition } from "./schema.js";
import { resolvedWorkflowSettingsSchema, type ResolvedExecutionSite, type ResolvedNodeSettings } from "./schema-resolved.js";

/** Resolve every execution setting once, before admission, from checked workflow and machine inputs. */
export function resolveWorkflowSettings(input: {
  definition: WorkflowDefinition;
  machine: MachineConfig;
  projectCwd: string;
}) {
  const { definition, machine } = input;
  if (!isAbsolute(input.projectCwd) || input.projectCwd.includes("\u0000")) {
    throw new Error("project working directory must be an absolute path without NUL");
  }
  const shell = machine.shell ?? "/bin/bash";
  const nodes: Record<string, ResolvedNodeSettings> = {};

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
    model: orchestratorModel === null ? null : parseModel(orchestratorModel).full,
    timeoutMs: orchestratorModel === null
      ? null
      : parseTimeout(definition.orchestrator?.timeout ?? machine.orchestrator?.timeout ?? "5m"),
  };

  return resolvedWorkflowSettingsSchema.parse({
    keepFiles: definition.defaults?.keep_files ?? machine.keep_files ?? "failed",
    nodes,
    preflight,
    orchestrator,
  });
}

function resolveExecutionSite(input: {
  site: NodeDefinition["run"] | NonNullable<NodeDefinition["validator"]>;
  timeout: string;
  streamCap: string | undefined;
  replay: "never" | "safe";
  shell: string;
  cwd: string;
  workflowDefault: AgentDefaults | undefined;
  machineDefault: AgentDefaults | undefined;
}): ResolvedExecutionSite {
  const common = {
    shell: input.shell,
    cwd: input.cwd,
    timeoutMs: parseTimeout(input.timeout),
    streamCapBytes: input.streamCap === undefined
      ? DEFAULT_STREAM_CAP_BYTES
      : parseByteSize(input.streamCap),
    replay: input.replay,
  };
  if ("command" in input.site) return { kind: "command", command: input.site.command, ...common };

  const resolved = resolveAgent({
    site: input.site.agent,
    workflowDefault: input.workflowDefault,
    machine: input.machineDefault,
  });
  if (resolved.model === null) {
    throw new Error("agent model is unresolved; set agent.model on the step, workflow defaults, or machine config");
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
  return raw === "unlimited" ? null : parseDuration(raw);
}
