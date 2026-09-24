import type { StatusDto } from "../status/dto.js";
import type { RunsFeed } from "../status/runs-feed.js";

/**
 * Where the viewer gets its data.
 *
 * The viewer must stay disposable: it consumes the same projections the CLI
 * publishes, so swapping OpenTUI for HTML replaces the binding rather than the
 * data path. Depending on an interface — instead of reaching into SQLite or a
 * run directory — is what keeps that true, and it lets tests drive the binding
 * with a fake source: no database, no TTY.
 */
export interface ViewerSource {
  /** Both projections fetched together, so every pane agrees on one moment. */
  snapshot(): Promise<{ status: StatusDto; runs: RunsFeed }>;
  /** One run's worklog, or the collated view when the run id is null. */
  log(runId: string | null): Promise<string>;
}
