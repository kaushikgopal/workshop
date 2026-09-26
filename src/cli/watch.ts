import { readFileSync } from "node:fs";
import { findInstallation, type Installation } from "../load-installation.js";
import { openDb } from "../storage/db/open-and-migrate.js";
import { Store } from "../storage/db/store.js";
import { buildNodesForRun, buildStatusDto } from "../views/build-status-json.js";
import { buildRunsFeed } from "../views/build-runs-json.js";
import type { ViewerSource } from "../tui/data-source.js";
import { die } from "./errors.js";

/**
 * The viewer's data source over the CLI's own projections. The viewer depends
 * on the projections, never on the store: `status --json` and `runs --json` are
 * the same builders this calls, and the log is the run's worklog.
 */
function viewerSourceFor(inst: Installation, store: Store): ViewerSource {
  return {
    async snapshot(workflowId) {
      return {
        // With no workflow chosen yet, every workflow is offered to the picker.
        status: buildStatusDto(store, new Date(), workflowId ?? undefined),
        // The picker draws only the workflow list, so an empty feed is honest
        // until a workflow is chosen. Per-workflow runs arrive after that.
        runs: buildRunsFeed({
          workflowId: workflowId ?? "",
          runs: workflowId ? store.listRuns(workflowId) : [],
          all: false,
          nodes: (runId) => buildNodesForRun(store, runId),
        }),
      };
    },
    async log(workflowId, runId) {
      if (runId === null) {
        const every = workflowId ? store.listRuns(workflowId) : [];
        return every.map((r) => `\n━━ run ${r.run_id} — ${r.status} ━━\n${readFileSync(r.worklog_path, "utf8")}`).join("");
      }
      const run = store.getRun(runId);
      return run ? readFileSync(run.worklog_path, "utf8") : "(run not found)";
    },
  };
}

/**
 * The live viewer. It reads the same projections the CLI publishes and never
 * touches SQLite itself, so a second viewer (HTML, web) can be built from the
 * same contract without this code changing.
 */
export async function cmdWatch(args: string[]): Promise<void> {
  // Omitting the workflow opens the picker instead of guessing which one.
  const workflowId = args.find((a) => !a.startsWith("--")) ?? null;
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  if (workflowId && !store.getWorkflow(workflowId)) die(`no workflow "${workflowId}"`);
  if (!workflowId && store.listWorkflows().length === 0) die("no workflows configured");
  const { openViewer } = await import("../tui/mount-viewer.js");
  await openViewer({ workflowId, source: viewerSourceFor(inst, store) });
}
