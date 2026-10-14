import type { DiagramDto, NodeDescriptionDto, StatusDto } from "../views/schema.js";
import type { BotChatViewV1 } from "../bot/schema.js";

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
  /** Shared bot messages. Absence is not a run worklog. */
  readonly botLines?: readonly string[];
}


export interface ChatSource {
  view(cursor?: string, limit?: number): Promise<BotChatViewV1>;
  submit(text: string): Promise<void>;
  reply(input: { workflowId: string; runId: string; waitId: string; action: "continue" | "reject"; answer: string }): Promise<void>;
  resolve(input: { workflowId: string; runId: string; action: "retry" | "accept" | "fail"; reason: string; allowRepeat?: boolean; resultFile?: string }): Promise<void>;
}
