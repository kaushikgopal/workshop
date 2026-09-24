import type { Store, WorkflowRow, RunRow, AttemptRow } from "../store/store.js";
import { isTerminal } from "../store/store.js";
import { deriveNodeStatus } from "./node-status.js";
import { loadSnapshot } from "../recovery.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Tree status — the human view of the same truth the JSON DTO exposes.
 * Nodes render in chain order (from the run's definition snapshot), with
 * glyph status, attempt history, and progress. Older terminal runs collapse
 * into a count; unresolved runs and the most recent run always render.
 * Long lines word-wrap with hanging indents and a continuous spine.
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

/** Shared so every human surface renders status and local time the same way. */
export function glyph(status: string): string {
  return GLYPH[status] ?? "○";
}

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** Machine-local `HH:MM:SS`. Date getters, not `toLocaleTimeString`, so the
 *  output never varies with locale and never produces a `24:00` hour. */
export function localClock(iso: string): string {
  const d = new Date(iso);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`;
}

/** Machine-local `YYYY-MM-DD`. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`;
}

function clock(iso: string | null): string {
  if (!iso) return "";
  return localClock(iso);
}

/** `next <local clock> (in <relative>)` for the activation line. Shows the
 *  local date when the due time falls on another local calendar day. Overlap
 *  suppression may skip a due time while a run is unresolved, so this is the
 *  schedule's next admission, not a guaranteed start. */
function nextRunFragment(iso: string): string {
  const due = new Date(iso);
  const now = new Date();
  const sameDay = localDate(due) === localDate(now);
  const when = sameDay ? localClock(iso) : `${localDate(due)} ${localClock(iso)}`;
  return `next ${when} (${untilDue(due.getTime() - now.getTime())})`;
}

function untilDue(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Word-wrap one rendered line to the terminal width. `contIndent` is added to
 * every continuation line so wrapped text stays inside the tree.
 */
function wrap(text: string, contIndent: string): string[] {
  const width = Math.max(60, (process.stdout.columns ?? 100) - 1);
  const usable = Math.max(20, width - contIndent.length);
  const leadMatch = /^(\s*)(.*)$/.exec(text);
  const lead = leadMatch?.[1] ?? "";
  const words = (leadMatch?.[2] ?? "").split(/\s+/).filter(Boolean);

  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= usable) {
      line = candidate;
    } else {
      if (line) out.push(line);
      line = word;
    }
  }
  if (line || out.length === 0) out.push(line);
  return out.map((l, i) => (i === 0 ? lead + l : contIndent + l));
}

export function renderTreeStatus(store: Store, workflowId?: string): string {
  const lines: string[] = [];
  const workflows = store
    .listWorkflows()
    .filter((wf) => !workflowId || wf.workflow_id === workflowId);
  if (workflows.length === 0) {
    return workflowId
      ? `no workflow "${workflowId}" — list known ids with: workshop status\n`
      : "no workflows — start one with: workshop start <workflow-id>\n";
  }

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
  let activation = scheduled ? `${glyph(wf.activation_state)} ${wf.activation_state}${bound}` : "one-shot";
  if (scheduled && wf.activation_state === "active" && wf.next_run_at) {
    activation += ` · ${nextRunFragment(wf.next_run_at)}`;
  }
  lines.push(`${wf.workflow_id}  ${activation}`);

  if (runs.length === 0) {
    lines.push("   (no runs yet)");
    return lines;
  }

  // Collapse older terminal runs; render unresolved runs + the most recent.
  // The first/only run may still be unresolved — there is no terminal run to
  // show, and the collapse line disappears with it.
  const unresolved = runs.filter((r) => !isTerminal(r.status));
  const terminal = runs.filter((r) => isTerminal(r.status));
  const shown = new Set<string>(unresolved.map((r) => r.run_id));
  if (terminal.length > 0) shown.add(terminal[terminal.length - 1]!.run_id);
  const collapsed = runs.length - shown.size;
  if (collapsed > 0) {
    lines.push(`   · ${collapsed} earlier completed run${collapsed === 1 ? "" : "s"}`);
  }

  for (const run of runs) {
    if (!shown.has(run.run_id)) continue;
    lines.push(...renderRun(store, run, unresolved[unresolved.length - 1]?.run_id === run.run_id));
  }
  return lines;
}

function renderRun(store: Store, run: RunRow, isCurrent: boolean): string[] {
  const statusBits: string[] = [run.status];
  if (run.block_kind) statusBits.push(run.block_kind);
  const marker = isCurrent ? "└─" : "·";
  const lines = wrap(`${marker} run ${run.run_id}  ${glyph(run.status)} ${statusBits.join(" · ")}  ${clock(run.started_at)}`, "  ");

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
    const nodeStatus = deriveNodeStatus(nodeAttempts);
    const connector = isLastNode ? "└─" : "├─";
    // Children of a non-final node keep the spine (│); a final node's
    // children are plain-indented.
    const childPrefix = isLastNode ? "      " : "   │  ";
    lines.push(...wrap(`   ${connector} ${glyph(nodeStatus)} ${id}  ${nodeStatus}`, childPrefix));
    for (const a of nodeAttempts) {
      lines.push(...renderAttempt(a, childPrefix));
    }
  });
  return lines;
}

function renderAttempt(attempt: AttemptRow, childPrefix: string): string[] {
  const bullet = `${childPrefix}· `;
  const bits: string[] = [`#${attempt.attempt} ${attempt.status}`];
  if (attempt.validator_status) bits.push(`validator ${attempt.validator_status}`);
  if (attempt.failure_kind) bits.push(attempt.failure_kind);
  if (attempt.block_kind) bits.push(attempt.block_kind);
  const lines = wrap(`${bullet}${bits.join(" · ")}`, bullet);
  if (attempt.current_progress) {
    const label = `${childPrefix}  progress: `;
    lines.push(...wrap(`${label}${attempt.current_progress}`, " ".repeat(label.length)));
  }
  return lines;
}
