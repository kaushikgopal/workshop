import type { Store, WorkflowRow, RunRow, AttemptRow } from "../store/store.js";
import { isTerminal } from "../store/store.js";
import { loadSnapshot } from "../recovery.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tree status — the human view of the same truth the JSON DTO exposes.
 * Nodes render in chain order (from the run's definition snapshot), with
 * glyph status, attempt history, and progress. Older terminal runs collapse
 * into a count; unresolved runs and the most recent run always render.
 */

const GLYPH: Record<string, string> = {
  pending: "○",
  running: "◎",
  finishing: "◑",
  blocked: "⊘",
  failed: "✗",
  completed: "◉",
  cancelled: "·",
  queued: "○",
};

function glyph(status: string): string {
  return GLYPH[status] ?? "○";
}

function clock(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(11, 19); // HH:MM:SS UTC
}

export function renderTreeStatus(store: Store): string {
  const lines: string[] = [];
  const workflows = store.listWorkflows();
  if (workflows.length === 0) return "no workflows — start one with: workshop start <workflow-id>\n";

  for (const wf of workflows) {
    lines.push(...renderWorkflow(store, wf));
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function renderWorkflow(store: Store, wf: WorkflowRow): string[] {
  const lines: string[] = [];
  const runs = store.listRuns(wf.workflow_id);

  const scheduled = wf.schedule_every != null;
  const bound = wf.schedule_max_runs == null ? "" : ` ${wf.schedule_started_runs}/${wf.schedule_max_runs}`;
  const activation = scheduled ? `${glyph(wf.activation_state)} ${wf.activation_state}${bound}` : "one-shot";
  lines.push(`${wf.workflow_id}  ${activation}`);

  if (runs.length === 0) {
    lines.push("   (no runs yet)");
    return lines;
  }

  // Collapse older terminal runs; render unresolved runs + the most recent.
  const unresolved = runs.filter((r) => !isTerminal(r.status));
  const terminal = runs.filter((r) => isTerminal(r.status));
  const shown = new Set<string>([...unresolved.map((r) => r.run_id), terminal[terminal.length - 1]!.run_id]);
  const collapsed = runs.length - shown.size;
  if (collapsed > 0) {
    lines.push(`   · ${collapsed} earlier completed run${collapsed === 1 ? "" : "s"}`);
  }

  for (const run of runs) {
    if (!shown.has(run.run_id)) continue;
    lines.push(...renderRun(store, run, run.run_id === unresolved[unresolved.length - 1]?.run_id));
  }
  return lines;
}

function renderRun(store: Store, run: RunRow, isCurrent: boolean): string[] {
  const lines: string[] = [];
  const statusBits: string[] = [run.status];
  if (run.block_kind) statusBits.push(run.block_kind);
  const marker = isCurrent ? "└─" : "·";
  lines.push(`${marker} run ${run.run_id}  ${glyph(run.status)} ${statusBits.join(" · ")}  ${clock(run.started_at)}`);

  // Chain order from the run's own snapshot; fall back to row order.
  let order: string[] | null = null;
  const snapshotPath = join(run.run_dir, "definition.yaml");
  if (existsSync(snapshotPath)) {
    try {
      order = loadSnapshot(snapshotPath).chain.order;
    } catch {
      order = null;
    }
  }

  const attempts = store.listAttempts(run.run_id);
  const nodeIds: string[] = [];
  if (order) {
    for (const id of order) if (attempts.some((a) => a.node_id === id)) nodeIds.push(id);
  } else {
    for (const a of attempts.slice().sort((x, y) => x.chain_position - y.chain_position)) {
      if (!nodeIds.includes(a.node_id)) nodeIds.push(a.node_id);
    }
  }

  nodeIds.forEach((id, index) => {
    const isLastNode = index === nodeIds.length - 1;
    const nodeAttempts = attempts.filter((a) => a.node_id === id).sort((a, b) => a.attempt - b.attempt);
    const nodeStatus = nodeStatusOf(nodeAttempts);
    const connector = isLastNode ? "└─" : "├─";
    lines.push(`   ${connector} ${glyph(nodeStatus)} ${id}  ${nodeStatus}`);
    for (const a of nodeAttempts) {
      lines.push(...renderAttempt(a, isLastNode));
    }
  });
  return lines;
}

function renderAttempt(attempt: AttemptRow, isLastNode: boolean): string[] {
  const indent = isLastNode ? "        " : "        ";
  const bits: string[] = [`#${attempt.attempt} ${attempt.status}`];
  if (attempt.validator_status) bits.push(`validator ${attempt.validator_status}`);
  if (attempt.failure_kind) bits.push(attempt.failure_kind);
  if (attempt.block_kind) bits.push(attempt.block_kind);
  const lines = [`${indent}· ${bits.join(" · ")}`];
  if (attempt.current_progress) {
    lines.push(`${indent}  progress: ${attempt.current_progress}`);
  }
  return lines;
}

function nodeStatusOf(attempts: AttemptRow[]): string {
  const live = attempts.find((a) => ["pending", "running", "finishing"].includes(a.status));
  if (live) return live.status === "pending" ? "pending" : "running";
  for (const status of ["blocked", "failed", "cancelled", "completed"]) {
    if (attempts.some((a) => a.status === status)) return status;
  }
  return "pending";
}

/** Read-only helper for callers that want the raw worklog of the newest run. */
export function newestWorklogPath(run: RunRow): string {
  void readFileSync;
  return run.worklog_path;
}
