import type { StatusDto } from "../views/build-status-json.js";
import type { RunsFeed } from "../views/build-runs-json.js";

/**
 * TUI-only: where the viewer gets its data.
 *
 * The viewer must stay disposable: it consumes the same projections the CLI
 * publishes, so swapping OpenTUI for HTML replaces the binding rather than the
 * data path. Depending on an interface — instead of reaching into SQLite or a
 * run directory — is what keeps that true, and it lets tests drive the binding
 * with a fake source: no database, no TTY.
 */
export interface ViewerSource {
  /**
   * Both projections fetched together, so every pane agrees on one moment.
   *
   * The workflow is a parameter rather than something the source is built with:
   * the viewer starts on the picker, before a workflow is chosen, and its
   * selection changes afterwards. A source bound at construction keeps
   * answering for the workflow it was born with — which showed an empty viewer
   * the moment you picked one from the picker.
   */
  snapshot(workflowId: string | null, selectedRunId?: string | null): Promise<{ status: StatusDto; runs: RunsFeed }>;
  /**
   * One run's worklog, or the workflow's collated history when the run id is
   * null.
   */
  log(workflowId: string | null, runId: string | null): Promise<string>;
}
