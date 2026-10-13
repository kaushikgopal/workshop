import type { DiagramDto, NodeDescriptionDto, StatusDto } from "../views/schema.js";

/** The viewer consumes public service projections, never files or storage. */
export interface ViewerSource {
  snapshot(workflowId: string | null, expanded?: readonly string[]): Promise<ViewerSnapshot>;
}

export interface ViewerSnapshot {
  readonly status: StatusDto;
  readonly detail: {
    readonly diagram: DiagramDto;
    readonly nodes: readonly NodeDescriptionDto["node"][];
  } | null;
  /** WP10 supplies shared bot messages. Absence is not a run worklog. */
  readonly botLines?: readonly string[];
}
