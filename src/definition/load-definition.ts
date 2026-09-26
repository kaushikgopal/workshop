import { readFileSync } from "node:fs";
import { parseStrictYaml } from "./parse-yaml.js";
import { workflowSchema, type WorkflowDefinition } from "./schema.js";
import { validateChain, type ChainInfo } from "./check-chain.js";
import { canonicalHash } from "./hash-canonical-json.js";

/**
 * Load a workflow definition and return it checked: strict YAML, then the
 * schema, then the chain shape.
 *
 * Every loader goes through `checkDefinitionText`, whether the YAML comes from
 * an authored file, a run's frozen snapshot, or the admission copy in SQLite.
 */

/**
 * A run's definition, as persisted in its snapshot.
 *
 * A snapshot is a definition that was already validated at admission, so
 * loading one is parsing plus the chain invariant — nothing here re-checks the
 * schema's job. It lives in the definition layer rather than in recovery because
 * everything that needs a run's chain needs this: the daemon, the recovery pass,
 * and the human status renderer.
 */
export interface SnapshotBundle {
  def: WorkflowDefinition;
  chain: ChainInfo;
}

/** Parse and check YAML text; `label` names the source in error messages. */
export function checkDefinitionText(text: string, label: string): SnapshotBundle {
  const def = workflowSchema.parse(parseStrictYaml(text, label));
  return { def, chain: validateChain(def) };
}

export function loadSnapshot(snapshotPath: string): SnapshotBundle {
  return checkDefinitionText(readFileSync(snapshotPath, "utf8"), snapshotPath);
}
/** An authored definition, checked, with the hash and bytes a snapshot freezes. */
export interface LoadedDefinition {
  def: WorkflowDefinition;
  chain: ChainInfo;
  canonicalHash: string;
  sourcePath: string;
  sourceText: string;
}
export function loadAndValidateDefinition(sourcePath: string): LoadedDefinition {
  let src: string;
  try {
    src = readFileSync(sourcePath, "utf8");
  } catch (e) {
    throw new Error(`cannot read workflow definition at ${sourcePath}: ${(e as Error).message}`);
  }
  const { def, chain } = checkDefinitionText(src, sourcePath);
  return { def, chain, canonicalHash: canonicalHash(def), sourcePath, sourceText: src };
}
