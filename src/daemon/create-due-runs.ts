import type { Store } from "../storage/db/store.js";
import { GuardRejected } from "../storage/db/store.js";
import type { Clock } from "../util/clock.js";

/**
 * Schedule admission: fixed-rate cadence from the activation's scheduled
 * times, not from completion; overlap suppression; per-activation counter.
 * The clock is injectable; nothing here waits in real time.
 */
export interface ScheduleAdmission {
  admitted: string | null; // run id when a run was created
  skipped: string | null; // reason when suppressed
}

/** Due occurrences: activation active, cadence due, no unresolved run. */
export function admitDueOccurrences(input: {
  store: Store;
  workflowIds: string[];
  clock: Clock;
  createRun: (workflowId: string, now: Date) => { runId: string; created: boolean } | null;
}): ScheduleAdmission[] {
  const { store, clock } = input;
  const out: ScheduleAdmission[] = [];
  for (const workflowId of input.workflowIds) {
    const wf = store.getWorkflow(workflowId);
    if (!wf || !wf.schedule_every || wf.schedule_max_runs == null) continue;
    const now = clock.now();

    if (wf.activation_state !== "active") {
      out.push({ admitted: null, skipped: `${workflowId}: activation ${wf.activation_state}` });
      continue;
    }
    if (wf.schedule_max_runs > 0 && wf.schedule_started_runs >= wf.schedule_max_runs) {
      store.setActivationState(workflowId, "exhausted");
      out.push({ admitted: null, skipped: `${workflowId}: exhausted (${wf.schedule_max_runs} runs)` });
      continue;
    }
    if (wf.next_run_at && new Date(wf.next_run_at) > now) {
      out.push({ admitted: null, skipped: `${workflowId}: not due until ${wf.next_run_at}` });
      continue;
    }

    // The admission transaction owns overlap suppression. A suppressed due
    // slot is still consumed there, atomically advancing the cursor.

    try {
      const created = input.createRun(workflowId, now);
      out.push({ admitted: created?.created ? created.runId : null, skipped: created?.created ? null : `${workflowId}: overlap suppressed` });
    } catch (e) {
      if (e instanceof GuardRejected) {
        out.push({ admitted: null, skipped: `${workflowId}: ${e.message}` });
        continue;
      }
      throw e;
    }
  }
  return out;
}
