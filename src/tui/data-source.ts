/**
 * TUI-only: where the viewer gets its data, and the shapes it draws.
 *
 * The viewer must stay disposable: it consumes the same service projections the
 * CLI publishes, adapted by `cli/watch.ts` into the shapes below, so swapping
 * OpenTUI for HTML replaces the binding rather than the data path. Depending on
 * an interface — instead of reaching into SQLite or a run directory — is what
 * keeps that true, and it lets tests drive the binding with a fake source: no
 * service, no TTY.
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

/** Workflow state as the viewer draws it: workflow, activation, current run, node, attempt. */
export interface StatusDto {
  version: number;
  workflows: WorkflowStatusDto[];
}

export interface WorkflowStatusDto {
  id: string;
  definitionHash: string;
  activation: ActivationDto | null;
  currentRun: RunStatusDto | null;
}

export interface ActivationDto {
  state: string;
  startedAt: string;
  startedRuns: number;
  maxRuns: number | null;
  nextRunAt: string | null;
}

export interface RunStatusDto {
  id: string;
  status: string;
  desiredState: string;
  orchestratorPhase: string;
  startedAt: string;
  blocker: string | null;
  nodes: NodeStatusDto[];
}

export interface NodeStatusDto {
  id: string;
  status: string;
  attempts: AttemptStatusDto[];
}

export interface AttemptStatusDto {
  number: number;
  status: string;
  progress: string | null;
  validator: "passed" | "failed" | null;
  failure: string | null;
  blocker: string | null;
  /** Wall-clock bounds, so a viewer can show how long an attempt took. */
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * The runs feed — a workflow's occurrences, newest first.
 *
 * The status shape carries only the unresolved current run, so a viewer cannot
 * draw a recurring workflow as a stream of occurrences from it. The feed is the
 * second half: what happened, newest first.
 */
export interface RunsFeed {
  version: number;
  workflowId: string;
  /** Every occurrence this workflow has, regardless of how many `runs` holds. */
  total: number;
  /** Newest first, capped. */
  runs: RunsFeedEntry[];
}

export interface RunsFeedEntry {
  id: string;
  status: string;
  desiredState: string;
  startedAt: string;
  finishedAt: string | null;
  blocker: string | null;
  /**
   * The run's chain, so a viewer can still show a run that already finished —
   * which is exactly the run you inspect after a failure.
   */
  nodes: NodeStatusDto[];
}
