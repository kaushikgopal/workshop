import { DefinitionError, parseStrictYaml } from "./parse-yaml.js";
import { checkChainV2, type ChainInfo } from "./check-chain.js";
import { workflowSchemaV2, type WorkflowDefinitionV2 } from "./schema-v2.js";
import { renderV3MigrationGuidance } from "./render-v3-migration-guidance.js";

export interface DefinitionBundleV2 {
  def: WorkflowDefinitionV2;
  chain: ChainInfo;
}

/** Parse v2 workflow text, apply its strict schema, then check its chain. */
export function checkV2DefinitionText(text: string, label: string): DefinitionBundleV2 {
  const value = parseStrictYaml(text, label);
  if (isRecord(value) && value.version === 1) {
    throw new DefinitionError(renderV3MigrationGuidance(
      `${label}: workflow version 1 is not supported by the v4 runtime; update the workflow to version: 2 before using it with v4.`,
    ));
  }

  const def = workflowSchemaV2.parse(value);
  return { def, chain: checkChainV2(def) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
