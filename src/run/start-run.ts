import type { LoadedDefinition } from "../definition/load-definition.js";
import { resolveNode } from "../definition/resolve-node-settings.js";
import type { Installation } from "../load-installation.js";
import { openDb } from "../storage/db/open-and-migrate.js";
import { Store } from "../storage/db/store.js";
import { type Clock, SystemClock } from "../util/clock.js";
import { attemptDirOfPacket } from "../storage/disk/locate-run-files.js";
import { scaffoldPacket } from "../worklog/prepare-packet.js";
import { checkStartable, checkEnvironment } from "./check-environment.js";
import { admitManualRun } from "./create-run.js";

/**
 * Start a run: create or refresh the activation, admit the run (idempotent
 * while unresolved), scaffold worklog + first packet, snapshot the
 * definition, run preflight, and create the initial pending attempt.
 */
export async function startWorkflow(input: {
  inst: Installation;
  loaded: LoadedDefinition;
  clock?: Clock;
}): Promise<{ runId: string; created: boolean; warnings: string[]; }> {
  const clock = input.clock ?? new SystemClock();
  const { inst, loaded } = input;
  const store = new Store(openDb(inst.dbPath));
  const now = clock.now();
  const def = loaded.def;

  const warnings = checkStartable(def, inst);

  const admitted = admitManualRun({ store, inst, loaded, now });
  if (!admitted.created) return { runId: admitted.runId, created: false, warnings };

  // Preflight runs after replayable admission is fully prepared; a failure
  // blocks before any attempt exists.
  await checkEnvironment({ store, inst, loaded, runId: admitted.runId, clock });

  if (store.getRun(admitted.runId)!.status !== "blocked") {
    scaffoldFirstAttempt({ store, inst, loaded, runId: admitted.runId, now: clock.now() });
  }

  return { runId: admitted.runId, created: true, warnings };
}
/** The initial pending attempt for the run's start node. */
export function scaffoldFirstAttempt(input: {
  store: Store;
  inst: Installation;
  loaded: LoadedDefinition;
  runId: string;
  now: Date;
}): void {
  const { store, inst, loaded, runId, now } = input;
  const startNode = loaded.chain.order[0]!;
  const startResolved = resolveNode(loaded.def, startNode, inst);
  const fresh = store.createSuccessorAttempt({
    runId,
    nodeId: startNode,
    resolvedMaxAttempts: startResolved.maxAttempts,
    resolvedTimeoutMs: startResolved.timeoutMs,
    chainPosition: loaded.chain.order.indexOf(startNode),
    now,
  });
  // Scaffold from the fresh row's persisted path — the store minted it.
  scaffoldPacket(attemptDirOfPacket(fresh.packet_path), fresh.attempt, loaded.chain.next.get(startNode) ?? null);
}
