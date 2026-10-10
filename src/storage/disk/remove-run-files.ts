import { rmSync } from "node:fs";
import type { WorkflowRunDocumentV1 } from "../../run/records.js";

/**
 * Deletes a completed run's folder unless the run keeps files always. Safe to
 * repeat: completion means every process is confirmed dead and no judge needs it.
 */
export function removeRunFiles(run: WorkflowRunDocumentV1): void {
  if (run.state !== "ready" || run.status !== "completed" || run.resolvedSettings.keepFiles === "always") return;
  try {
    rmSync(run.paths.runDirectory, { recursive: true, force: true });
  } catch (error) {
    console.error(`could not remove files of completed run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
