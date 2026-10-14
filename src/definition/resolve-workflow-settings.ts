import { isAbsolute } from "node:path";
import { DEFAULT_STREAM_CAP_BYTES, parseByteSize, parseDuration } from "../util/parse-units.js";
import { parseModel } from "./parse-model.js";
import { resolveAgent } from "./resolve-agent-settings.js";
import type { AgentDefaults, MachineConfig, NodeDefinition, WorkflowDefinition } from "./schema.js";
import { currentResolvedWorkflowSettingsSchema, type ResolvedExecutionSite } from "./schema-resolved.js";

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
  const nodes: Record<string, unknown> = {};

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    const timeout = node.timeout ?? definition.defaults?.timeout ?? machine.default_timeout ?? "10m";
    const streamCap = node.stream_cap ?? definition.defaults?.stream_cap ?? machine.stream_cap;
    const retries = node.retries ?? definition.defaults?.retries;
    const replay = node.replay ?? definition.defaults?.replay;
    if (retries === undefined || replay === undefined) {
      throw new Error(`step "${nodeId}" has no retries or replay policy; check the definition before resolving it`);
    }
    const run = resolveExecutionSite({
      site: node.run,
      role: "worker",
      stepId: nodeId,
      timeout,
      streamCap,
      replay,
      shell,
      cwd: input.projectCwd,
      workflowDefault: definition.defaults?.agent,
      machineDefault: machine.agent,
    });
    const validator = node.validator === undefined
      ? null
      : resolveExecutionSite({
          site: node.validator,
          role: "verifier",
          stepId: nodeId,
          timeout,
          streamCap,
          // Verifiers judge a committed candidate without external effects, so a crash always replays them.
          replay: "safe",
          shell,
          cwd: input.projectCwd,
          workflowDefault: definition.defaults?.agent,
          machineDefault: machine.agent,
        });
    nodes[nodeId] = {
      run,
      validator,
      retries,
      result: node.result ?? ("agent" in node.run ? "tagged" : "text"),
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
  const orchestrator = { model: null, timeoutMs: null };

  return currentResolvedWorkflowSettingsSchema.parse({
    formatVersion: 4,
    instructions: definition.instructions ?? null,
    keepFiles: machine.keep_files ?? "failed",
    nodes,
    preflight,
    orchestrator,
  });
}

function resolveExecutionSite(input: {
  site: NodeDefinition["run"] | NonNullable<NodeDefinition["validator"]>;
  role: "worker" | "verifier";
  stepId: string;
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
    context: { role: input.role, stepId: input.stepId },
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
