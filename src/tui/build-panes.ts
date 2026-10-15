import { blockActions, renderStepPreview, statusRows, type StatusRow, type StepPreview } from "../views/render-status.js";
import type { ViewerSnapshot } from "./data-source.js";

export interface ViewerModel {
  readonly screen: "overview" | "detail";
  readonly runId: string | null;
  readonly header: string;
  readonly runStatus: string | null;
  readonly rows: readonly StatusRow[];
  readonly steps: readonly StepPreview[];
  readonly notice: readonly string[];
  readonly botLines: readonly string[];
  readonly selectedId: string | null;
  readonly selectedStepId: string | null;
}

export function buildViewerModel(input: {
  readonly snapshot: ViewerSnapshot;
  readonly workflowId: string | null;
  readonly selectedId: string | null;
  readonly selectedStepId: string | null;
  readonly expanded: readonly string[];
  readonly now?: Date;
}): ViewerModel {
  const workflow = input.snapshot.status.workflows.find(entry => entry.workflowId === input.workflowId);
  const run = workflow?.unresolvedRun ?? workflow?.latestRun;
  const notice: string[] = [];
  if (workflow?.configurationError) notice.push("Configuration error: " + workflow.configurationError);
  if (run?.block?.nodeId === null) notice.push("Block: " + run.block.kind, "Reason: " + run.block.reason, "Allowed actions: " + blockActions(run.block.kind));
  if (run?.failure?.kind === "operator") notice.push("Reason: " + run.failure.reason);
  if (run?.failure && run.failure.kind !== "operator" && run.failure.nodeId === null) notice.push("Reason: " + run.failure.message);
  return {
    screen: input.workflowId === null ? "overview" : "detail",
    runId: input.snapshot.detail?.diagram.runId ?? null,
    header: input.workflowId ?? "Workflows",
    runStatus: workflow ? (workflow.configurationError ? "Configuration error" : run?.status ?? "ready") : null,
    rows: statusRows(input.snapshot.status, input.now),
    steps: (input.snapshot.detail?.nodes ?? []).map(node => renderStepPreview(node, input.expanded.includes(node.nodeId))),
    notice,
    botLines: input.snapshot.botLines?.slice(-100) ?? ["Bot not configured"],
    selectedId: input.selectedId,
    selectedStepId: input.selectedStepId,
  };
}
