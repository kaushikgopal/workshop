import { localClock } from "./format-for-terminal.js";
import type { NodeDescriptionDto, StatusDto } from "./schema.js";

type Workflow = StatusDto["workflows"][number];
export type StatusRow = readonly [title: string, status: string, nextRun: string];

export function statusLabel(status: string): string {
  if (status === "waiting") return "Needs input";
  if (status === "succeeded" || status === "completed") return "Completed";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function statusGlyph(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.startsWith("configuration error")) return "✗";
  switch (normalized) {
    case "succeeded": case "completed": return "✓";
    case "running": return "●";
    case "waiting": case "needs input": return "◆";
    case "blocked": return "■";
    case "failed": return "✗";
    case "skipped": return "–";
    case "pending": case "ready": return "○";
    default: return "○";
  }
}

export function nextRunLabel(workflow: Workflow, now: Date): string {
  const due = workflow.activation?.nextDueAt;
  if (workflow.unresolvedRun || workflow.configurationError || workflow.activation?.state !== "active" || !due) return "—";
  const date = new Date(due);
  if (!Number.isFinite(date.getTime())) return "—";
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const day = sameDay ? "" : [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-") + " ";
  return day + localClock(due);
}

export function statusRows(status: StatusDto, now = new Date()): StatusRow[] {
  return status.workflows.map(workflow => [
    workflow.workflowId,
    workflow.configurationError ? "Configuration error: " + workflow.configurationError.replace(/\s+/g, " ")
      : statusLabel(workflow.unresolvedRun?.status ?? workflow.latestRun?.status ?? "ready"),
    nextRunLabel(workflow, now),
  ]);
}

function clip(value: string, width: number): string {
  return value.length <= width ? value : value.slice(0, Math.max(0, width - 1)) + "…";
}

/** Exactly three fields at every width; small terminals stack each row. */
export function renderStatusTable(rows: readonly StatusRow[], width: number, selectedId: string | null = null): string[] {
  if (width < 60) return rows.length === 0 ? ["No workflows configured"] : rows.flatMap(row => [
    clip((row[0] === selectedId ? "›" : " ") + "Title: " + row[0], width),
    clip(" Status: " + statusGlyph(row[1]) + " " + row[1], width),
    clip(" Next run: " + row[2], width),
    "",
  ]);
  const nextWidth = Math.min(19, Math.max(8, ...rows.map(row => row[2].length)));
  const titleWidth = Math.max(12, Math.floor((width - nextWidth - 5) / 2));
  const statusWidth = Math.max(8, width - nextWidth - titleWidth - 5);
  const line = (row: StatusRow, marker: string) => marker + clip(row[0], titleWidth).padEnd(titleWidth) + "  "
    + clip(statusGlyph(row[1]) + " " + row[1], statusWidth).padEnd(statusWidth) + "  " + clip(row[2], nextWidth);
  const heading = " " + clip("Title", titleWidth).padEnd(titleWidth) + "  "
    + clip("Status", statusWidth).padEnd(statusWidth) + "  " + clip("Next run", nextWidth);
  return [heading, ...rows.map(row => line(row, row[0] === selectedId ? "›" : " "))];
}

/** Presentation only. The service remains the authority for resolution. */
export function blockActions(kind: string): string {
  switch (kind) {
    case "verifier_block": case "verifier_failed": case "repeated_failure": case "preflight_failed": return "retry, fail";
    case "external_outcome_unknown": return "retry --allow-repeat, accept --result-file … --acknowledge-effects, fail";
    case "process_death_unconfirmed": return "retry --allow-repeat, fail";
    case "integrity_failed": case "runtime_incompatible": return "fail";
    default: return "Inspect with a compatible build";
  }
}

export interface StepPreview {
  readonly id: string;
  readonly status: string;
  readonly lines: readonly string[];
  readonly expandable: boolean;
  readonly expanded: boolean;
}

export function renderStepPreview(node: NodeDescriptionDto["node"], expanded = false): StepPreview {
  let evidence = "";
  const notes: string[] = [];
  const attempt = node.attempts.at(-1);
  switch (node.status) {
    case "running": evidence = node.liveStderr ?? "No stderr yet"; break;
    case "succeeded": evidence = node.successfulOutput ?? ""; break;
    case "waiting":
      evidence = node.wait?.output ?? "";
      notes.push("Question: " + (node.wait?.question ?? "Unavailable"), "waitId: " + (node.wait?.waitId ?? "Unavailable"));
      break;
    case "failed": case "blocked":
      evidence = node.failureEvidence ?? "Evidence unavailable";
      notes.push("Reason: " + (node.block?.reason ?? node.failureReason ?? attempt?.failure?.message ?? attempt?.workerFailure?.message ?? "Unavailable").replace(/\s+/g, " "));
      if (node.block) notes.push("Block: " + node.block.kind, "Allowed actions: " + blockActions(node.block.kind));
      break;
  }
  const lines = evidence === "" ? [] : evidence.replace(/\n$/, "").split("\n");
  const expandable = lines.length > 40 || node.evidenceTruncated === true;
  const visible = expanded ? lines : node.status === "running" ? lines.slice(-40) : lines.slice(0, 40);
  return { id: node.nodeId, status: node.status, lines: [...notes, ...visible], expandable, expanded };
}

export function renderStatusSnapshot(status: StatusDto, width = 100, now = new Date()): string {
  const lines = renderStatusTable(statusRows(status, now), width);
  for (const workflow of status.workflows) {
    const run = workflow.unresolvedRun;
    if (run?.wait) lines.push(workflow.workflowId, "waitId=" + run.wait.waitId, "Question: " + run.wait.question);
    if (run?.block) lines.push(workflow.workflowId + " — " + run.block.kind, "Reason: " + run.block.reason, "Allowed actions: " + blockActions(run.block.kind));
  }
  return lines.join("\n") + "\n";
}
