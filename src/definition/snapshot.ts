import { readFileSync } from "node:fs";
import { parseStrictYaml } from "./parse.js";
import { workflowSchema, type WorkflowDefinition } from "./schema.js";
import { validateChain, type ChainInfo } from "./chain.js";

/**
 * A run's definition, as persisted in its snapshot.
 *
 * A snapshot is a definition that was already validated at admission, so
 * loading one is parsing plus the chain invariant — nothing here re-checks the
 * schema's job. It lives in the definition layer rather than in recovery because
 * everything that needs a run's chain needs this: the daemon, the recovery pass,
 * and the human status renderer, which previously reached into `recovery.ts` for
 * a loader that has nothing to do with recovering anything.
 */

export interface SnapshotBundle {
  def: WorkflowDefinition;
  chain: ChainInfo;
}

export function loadSnapshot(snapshotPath: string): SnapshotBundle {
  const raw = parseStrictYaml(readFileSync(snapshotPath, "utf8"), snapshotPath);
  const def = workflowSchema.parse(raw);
  return { def, chain: validateChain(def) };
}
