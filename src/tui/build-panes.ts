import { blockActions, renderStepPreview, statusRows, type StatusRow, type StepPreview } from "../views/render-status.js";
import type { ViewerChatEntry, ViewerSnapshot } from "./data-source.js";

export interface ViewerModel {
  readonly screen: "overview" | "detail";
  readonly runId: string | null;
  readonly header: string;
  readonly runStatus: string | null;
  readonly runLabel: string | null;
  readonly runAdmittedAt: string | null;
  readonly rows: readonly StatusRow[];
  readonly steps: readonly StepPreview[];
  readonly notice: readonly string[];
  readonly botEntries: readonly ViewerChatEntry[];
  readonly botEmptyMessage: string | null;
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
  const run = input.snapshot.selectedRun === undefined ? workflow?.unresolvedRun ?? workflow?.latestRun : input.snapshot.selectedRun;
  const position = input.snapshot.runPosition;
  const displaysRun = run != null && input.snapshot.detail?.diagram.runId === run.runId;
  const notice: string[] = [];
  if (workflow?.configurationError) notice.push("Configuration error: " + workflow.configurationError);
  if (run?.block?.nodeId === null) notice.push("Block: " + run.block.kind, "Reason: " + run.block.reason, "Allowed actions: " + blockActions(run.block.kind));
  if (run?.failure?.kind === "operator") notice.push("Reason: " + run.failure.reason);
  if (run?.failure && run.failure.kind !== "operator" && run.failure.nodeId === null) notice.push("Reason: " + run.failure.message);
  const botEntries = input.snapshot.botEntries?.slice(-100) ?? [];
  const botEmptyMessage = botEntries.length > 0 ? null : input.snapshot.botConfigured ? "No bot activity yet" : "Bot not configured";
  return {
    screen: input.workflowId === null ? "overview" : "detail",
    runId: input.snapshot.detail?.diagram.runId ?? null,
    header: input.workflowId ?? "Workflows",
    runStatus: workflow ? run?.status ?? (workflow.configurationError ? "Configuration error" : "ready") : null,
    runLabel: !displaysRun ? null : position
      ? "Run " + (position.total - position.index) + "/" + position.total + (position.followingLatest ? " (latest)" : "")
      : "Run " + run.runId,
    runAdmittedAt: displaysRun ? run.admittedAt : null,
    rows: statusRows(input.snapshot.status, input.now),
    steps: (input.snapshot.detail?.nodes ?? []).map(node => renderStepPreview(node, input.expanded.includes(node.nodeId))),
    notice,
    botEntries,
    botEmptyMessage,
    selectedId: input.selectedId,
    selectedStepId: input.selectedStepId,
  };
}
