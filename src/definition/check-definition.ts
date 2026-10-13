import { DefinitionError, parseStrictYaml } from "./parse-yaml.js";
import { checkChain, type ChainInfo } from "./check-chain.js";
import {
  CURRENT_FORMAT_VERSION,
  MACHINE_FORMAT_VERSION,
  workflowFileSchema,
  workflowIdSchema,
  workflowSchema,
  type AgentSettings,
  type AuthoredStep,
  type AuthoredVerify,
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
  // Specific legacy-key messages come first; they tell a format 3 author exactly what to change.
  rejectLegacyWorkflowKeys(value, label);
  checkFormatVersion(value, label, "workflow");
  const file = workflowFileSchema.parse(value);
  const def = workflowSchema.parse(toChainDefinition(id, file, label));
  checkStepPolicies(def, label);
  return { def, chain: checkChain(def) };
}

const WORKFLOW_MIGRATION = "replace max_attempts: N with retries: N-1, replace check: with verify:,"
  + " remove orchestrator: and keep_files:, and set retries: and replay: on every step or in defaults:";

/** Workflow files must declare the current format; machine config may omit its own version. */
export function checkFormatVersion(value: unknown, label: string, kind: "workflow" | "machine config"): void {
  if (!isRecord(value)) return;
  if (kind === "machine config") {
    if (value.version === undefined || value.version === MACHINE_FORMAT_VERSION) return;
    throw new DefinitionError(
      `${label}: machine config version ${JSON.stringify(value.version)} is no longer supported; remove version:`
        + ` (or declare version: ${MACHINE_FORMAT_VERSION})`,
    );
  }
  if (value.version === CURRENT_FORMAT_VERSION) return;
  if (value.version === undefined) {
    throw new DefinitionError(`${label}: workflow files must declare version: ${CURRENT_FORMAT_VERSION}; to migrate, ${WORKFLOW_MIGRATION}`);
  }
  if (value.version === 1 || value.version === 2) {
    throw new DefinitionError(
      `${label}: workflow version ${JSON.stringify(value.version)} is no longer supported; remove id:, list steps: in order, declare version: ${CURRENT_FORMAT_VERSION}, ${WORKFLOW_MIGRATION}`,
    );
  }
  throw new DefinitionError(`${label}: workflow version ${JSON.stringify(value.version)} is no longer supported; declare version: ${CURRENT_FORMAT_VERSION}, ${WORKFLOW_MIGRATION}`);
}

function rejectLegacyWorkflowKeys(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  if ("id" in value) throw new DefinitionError(`${label}: id: is not accepted; the workflow id is the file name`);
  if ("orchestrator" in value) {
    throw new DefinitionError(`${label}: orchestrator: is removed in version ${CURRENT_FORMAT_VERSION}; step verifiers (verify:) replace the failure judge`);
  }
  if (isRecord(value.defaults)) {
    if ("max_attempts" in value.defaults) {
      throw new DefinitionError(`${label}: defaults.max_attempts: is replaced by defaults.retries:, the number of retries after the first attempt (max_attempts: N becomes retries: N-1)`);
    }
    if ("keep_files" in value.defaults) {
      throw new DefinitionError(`${label}: defaults.keep_files: is removed in version ${CURRENT_FORMAT_VERSION}; delete it`);
    }
  }
  if ("nodes" in value) {
    throw new DefinitionError(`${label}: nodes: is replaced by an ordered steps: list, e.g. steps: [ { timestamp: "date -u" } ]`);
  }
  if (!Array.isArray(value.steps)) return;
  for (const entry of value.steps) {
    if (!isRecord(entry)) continue;
    for (const [stepId, step] of Object.entries(entry)) {
      if (!isRecord(step)) continue;
      if ("next" in step) throw new DefinitionError(`${label}: step "${stepId}": next: is not accepted; steps run in list order`);
      if ("validator" in step || "check" in step) {
        throw new DefinitionError(`${label}: step "${stepId}": ${"check" in step ? "check" : "validator"}: is replaced by verify:, written like a step body (a command, run:, or agent:)`);
      }
      if ("max_attempts" in step) {
        throw new DefinitionError(`${label}: step "${stepId}": max_attempts: is replaced by retries:, the number of retries after the first attempt (max_attempts: N becomes retries: N-1)`);
      }
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
  const { verify, ...options } = step;
  const run: NodeDefinition["run"] = "agent" in options
    ? { agent: toAgent(options.agent) }
    : { command: options.run };
  const { agent: _agent, run: _run, ...limits } = options as typeof options & { agent?: unknown; run?: unknown };
  return {
    run,
    ...(verify === undefined ? {} : { validator: toValidator(verify) }),
    next,
    ...limits,
  };
}

function toValidator(verify: AuthoredVerify): NonNullable<NodeDefinition["validator"]> {
  if (typeof verify === "string") return { command: verify };
  return "agent" in verify ? { agent: toAgent(verify.agent) } : { command: verify.run };
}

/** Every step must resolve retry and replay policy from the file itself; the engine supplies no default. */
function checkStepPolicies(def: WorkflowDefinition, label: string): void {
  for (const [stepId, node] of Object.entries(def.nodes)) {
    const retries = node.retries ?? def.defaults?.retries;
    const replay = node.replay ?? def.defaults?.replay;
    if (retries === undefined) {
      throw new DefinitionError(`${label}: step "${stepId}": retries is not set; add retries: to the step or to defaults:`);
    }
    if (replay === undefined) {
      throw new DefinitionError(`${label}: step "${stepId}": replay is not set; add replay: safe or replay: never to the step or to defaults:`);
    }
    if (replay === "never" && retries !== 0) {
      throw new DefinitionError(`${label}: step "${stepId}": replay: never requires retries: 0 (found retries: ${retries})`);
    }
    if (node.validator !== undefined && "agent" in node.validator && node.validator.agent.instructions.trim().length === 0) {
      throw new DefinitionError(`${label}: step "${stepId}": an agent verifier needs nonempty instructions`);
    }
  }
}

function toAgent(agent: string | AgentSettings): AgentSettings {
  return typeof agent === "string" ? { instructions: agent } : agent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
