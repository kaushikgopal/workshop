import type { Installation } from "../load-installation.js";
import { Store, isTerminal, type RunRow } from "../storage/db/store.js";
import { appendRuntimeNote } from "../worklog/edit-sections.js";
import { executeAttempt } from "../attempt/execute-attempt.js";
import { SystemClock, type Clock } from "../util/clock.js";
import { invokeOrchestrator } from "./orchestrate-failure.js";
import type { LoadedDefinition } from "../definition/load-definition.js";

/**
 * Execute all pending attempts of one run until the chain ends, fails, or
 * pauses. Uses the same guarded claims the daemon uses.
 */
export async function advanceChain(input: {
  store: Store;
  inst: Installation;
  loaded: LoadedDefinition;
  runId: string;
  clock?: Clock;
  cliPath: string;
}): Promise<RunRow> {
  const clock = input.clock ?? new SystemClock();
  const { store, inst, loaded, runId } = input;

  for (;;) {
    const run = store.getRun(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    if (isTerminal(run.status) || run.status === "paused" || run.status === "blocked") return run;

    const live = store.getLiveAttempt(runId);
    if (!live || live.status !== "pending") return store.getRun(runId)!;

    const prevNode = loaded.chain.prev.get(live.node_id) ?? null;
    const prevOutput = prevNode ? latestSuccessfulOutput(store, runId, prevNode) : null;

    const outcome = await executeAttempt({
      store,
      inst,
      def: loaded.def,
      chain: loaded.chain,
      run,
      nodeId: live.node_id,
      attemptNo: live.attempt,
      previousOutputFile: prevOutput,
      clock,
      cliPath: input.cliPath,
    });

    if (outcome.status === "failed") {
      // Exception judgment: the same transaction that failed the attempt
      // moved the run into the protected phase; a fresh orchestrator decides.
      await invokeOrchestrator({ store, inst, def: loaded.def, chain: loaded.chain, run: store.getRun(runId)!, clock, cliPath: input.cliPath });
      const judged = store.getRun(runId)!;
      if (judged.status === "failed") appendRuntimeNote(judged.worklog_path, "Run outcome", "run failed (orchestrator decision)");
      // A retry decision leaves the run running with a pending attempt —
      // keep looping; blocked/failed terminal states return via the head.
      if (judged.status !== "running") return judged;
      continue;
    }
    if (outcome.status === "completed" && !loaded.chain.next.get(live.node_id)) {
      appendRuntimeNote(store.getRun(runId)!.worklog_path, "Run outcome", "run completed: chain finished");
    }
    if (outcome.status !== "completed") {
      return store.getRun(runId)!;
    }
    // Loop: the completed attempt persisted its successor.
  }
}

function latestSuccessfulOutput(store: Store, runId: string, nodeId: string): string | null {
  const attempts = store
    .listAttempts(runId)
    .filter((a) => a.node_id === nodeId && a.status === "completed" && a.node_output_path)
    .sort((a, b) => b.attempt - a.attempt);
  return attempts[0]?.node_output_path ?? null;
}
