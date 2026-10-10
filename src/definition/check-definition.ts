import { DefinitionError, parseStrictYaml } from "./parse-yaml.js";
import { checkChain, type ChainInfo } from "./check-chain.js";
import {
  CURRENT_FORMAT_VERSION,
  workflowFileSchema,
  workflowIdSchema,
  workflowSchema,
  type AgentSettings,
  type AuthoredStep,
  type NodeDefinition,
  type WorkflowDefinition,
  type WorkflowFile,
} from "./schema.js";

export interface DefinitionBundle {
  def: WorkflowDefinition;
  chain: ChainInfo;
}

/**
 * Parse workflow text into the frozen chain the runtime stores. The workflow id
 * comes from the file name, and the ordered `steps:` list becomes the chain.
 */
export function checkDefinitionText(text: string, label: string, workflowId: string): DefinitionBundle {
  const id = workflowIdSchema.parse(workflowId);
  const value = parseStrictYaml(text, label);
  checkFormatVersion(value, label, "workflow");
  rejectLegacyWorkflowKeys(value, label);
  const file = workflowFileSchema.parse(value);
  const def = workflowSchema.parse(toChainDefinition(id, file, label));
  return { def, chain: checkChain(def) };
}

/** Reject an older `version:` with a message that names the current format. */
export function checkFormatVersion(value: unknown, label: string, kind: "workflow" | "machine config"): void {
  if (!isRecord(value) || value.version === undefined || value.version === CURRENT_FORMAT_VERSION) return;
  const fix = kind === "workflow" ? "remove version: and id:, and list steps: in order" : "remove version:";
  throw new DefinitionError(
    `${label}: ${kind} version ${JSON.stringify(value.version)} is no longer supported; ${fix}`
      + ` (or declare version: ${CURRENT_FORMAT_VERSION})`,
  );
}

function rejectLegacyWorkflowKeys(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  if ("id" in value) throw new DefinitionError(`${label}: id: is not accepted; the workflow id is the file name`);
  if ("nodes" in value) {
    throw new DefinitionError(`${label}: nodes: is replaced by an ordered steps: list, e.g. steps: [ { timestamp: "date -u" } ]`);
  }
  if (!Array.isArray(value.steps)) return;
  for (const entry of value.steps) {
    if (!isRecord(entry)) continue;
    for (const [stepId, step] of Object.entries(entry)) {
      if (!isRecord(step)) continue;
      if ("next" in step) throw new DefinitionError(`${label}: step "${stepId}": next: is not accepted; steps run in list order`);
      if ("validator" in step) throw new DefinitionError(`${label}: step "${stepId}": validator: is replaced by check:`);
      if (isRecord(step.run)) {
        throw new DefinitionError(
          `${label}: step "${stepId}": run: takes a command string; write agent: for an agent step`,
        );
      }
    }
  }
}

function toChainDefinition(id: string, file: WorkflowFile, label: string): unknown {
  const { version: _version, steps, ...settings } = file;
  const order = steps.map((entry) => Object.keys(entry)[0]!);
  const nodes: Record<string, NodeDefinition> = {};
  steps.forEach((entry, index) => {
    const stepId = order[index]!;
    if (Object.hasOwn(nodes, stepId)) throw new DefinitionError(`${label}: step id "${stepId}" appears more than once`);
    nodes[stepId] = toNode(entry[stepId]!, order[index + 1] ?? null);
  });
  return { id, ...settings, nodes };
}

function toNode(step: AuthoredStep, next: string | null): NodeDefinition {
  if (typeof step === "string") return { run: { command: step }, next };
  const { check, ...options } = step;
  const isAgent = "agent" in options;
  const run: NodeDefinition["run"] = isAgent
    ? { agent: toAgent(options.agent) }
    : { command: options.run };
  const { agent: _agent, run: _run, ...limits } = options as typeof options & { agent?: unknown; run?: unknown };
  return {
    run,
    ...(check === undefined ? {} : { validator: toValidator(check, isAgent) }),
    next,
    ...limits,
  };
}

function toValidator(check: NonNullable<Exclude<AuthoredStep, string>["check"]>, sameKindIsAgent: boolean): NonNullable<NodeDefinition["validator"]> {
  if (typeof check === "string") return sameKindIsAgent ? { agent: { instructions: check } } : { command: check };
  const { timeout, replay } = check;
  const limits = { ...(timeout === undefined ? {} : { timeout }), ...(replay === undefined ? {} : { replay }) };
  return "agent" in check ? { agent: toAgent(check.agent), ...limits } : { command: check.run, ...limits };
}

function toAgent(agent: string | AgentSettings): AgentSettings {
  return typeof agent === "string" ? { instructions: agent } : agent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
