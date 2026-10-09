import { DefinitionError, parseStrictYaml } from "./parse-yaml.js";
import { checkChain, type ChainInfo } from "./check-chain.js";
import { workflowSchema, type WorkflowDefinition } from "./schema.js";

export interface DefinitionBundle {
  def: WorkflowDefinition;
  chain: ChainInfo;
}

/** Parse workflow text, apply its strict schema, then check its chain. */
export function checkDefinitionText(text: string, label: string): DefinitionBundle {
  const value = parseStrictYaml(text, label);
  if (isRecord(value) && value.version !== 2) {
    throw new DefinitionError(value.version === undefined
      ? `${label}: workflow does not declare a version; add version: 2`
      : `${label}: unsupported workflow version ${JSON.stringify(value.version)}; expected version: 2`);
  }

  const def = workflowSchema.parse(value);
  return { def, chain: checkChain(def) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
