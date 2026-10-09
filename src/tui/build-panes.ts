import { glyph, localClock } from "../views/format-for-terminal.js";
import type { AttemptStatusDto, NodeStatusDto, RunsFeed, RunsFeedEntry, StatusDto } from "./data-source.js";

/**
 * TUI-only: the viewer's panes as plain data.
 *
 * Every pane is produced here from the CLI's own surfaces — the status DTO, the
 * runs feed, and log text — so the terminal binding stays a thin renderer and
 * the layout is testable without a TTY. That is what keeps the viewer
 * disposable: swapping OpenTUI for HTML replaces the binding, not this.
 *
 * It never reads SQLite or a run directory. If a pane needs data the CLI does
 * not expose, the fix is to expose it, not to reach around the contract.
 */
export interface ViewerPane {
  title: string;
  lines: string[];
}

export interface ViewerModel {
  header: string;
  /** Flex share of the two upper panes: left (chain/list) versus right (log/hint). */
  layout: { left: number; right: number };
  /** Node tally for the run on screen. */
  tally: string;
  selectedRunId: string | null;
  nodes: ViewerPane;
  runs: ViewerPane;
  stream: ViewerPane;
}

/** `hemingway-clock-20260924-012` → `012`. Enough to match the feed and log. */
export function shortRunId(runId: string): string {
  const match = /-(\d{3,})$/.exec(runId);
  return match ? match[1]! : runId;
}

/** Compact durations: `840ms`, `2.1s`, `4m08s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * How long an attempt took. Only finished attempts report a duration: an
 * in-flight elapsed time would need a clock here, and a pane that changes
 * without the runtime changing anything is a pane nobody can test.
 */
function attemptTiming(attempt: AttemptStatusDto | undefined): string | null {
  if (!attempt?.startedAt || !attempt.finishedAt) return null;
  const started = Date.parse(attempt.startedAt);
  const ended = Date.parse(attempt.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return formatDuration(ended - started);
}

/**
 * Failure kinds, said in fewer characters. The enum stays authoritative in
 * `status --json`; here the row has to fit next to a node id, and "rejected"
 * carries the same meaning as `validator_rejection` for a human scanning.
 */
const FAILURE_LABEL: Record<string, string> = {
  validator_rejection: "rejected",
  worklog_integrity: "worklog integrity",
  process_error: "process error",
  timeout: "timeout",
  interrupted: "interrupted",
};

export function failureLabel(kind: string): string {
  return FAILURE_LABEL[kind] ?? kind;
}

/** `2h ago`, `just now`, `3d ago` — the runs feed reads as a timeline. */
export function relativeAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * One row per node in chain order, spine-drawn so the chain reads top to
 * bottom. Works for any run: the feed carries each run's nodes, so a finished
 * failure inspects exactly like a live run.
 */
export function nodeLines(nodes: NodeStatusDto[] | undefined, width?: number): string[] {
  if (!nodes) return ["(no run selected)"];
  if (nodes.length === 0) return ["(this run has no node attempts yet)"];
  return nodes.map((node, i) => {
    const last = i === nodes.length - 1;
    const attempts = node.attempts;
    const latest = attempts[attempts.length - 1];
    const attemptNo = latest?.number ?? 1;
    const retry = attemptNo > 1 ? ` #${attemptNo}` : "";
    const timing = attemptTiming(latest);
    // A completed node that passed validation says nothing extra by repeating
    // it; the glyph and the duration already carry that. Details are reserved
    // for the states where they change what you would do next.
    const detail = latest?.progress
      ? ` — ${latest.progress}`
      : latest?.validator === "failed"
        ? " — validator rejected"
        : latest?.failure
          ? ` — ${failureLabel(latest.failure)}`
          : latest?.blocker
            ? ` — ${latest.blocker}`
            : "";
    const row = `${last ? "└─" : "├─"} ${glyph(node.status)} ${node.id}${retry}${timing ? `  ${timing}` : ""}`;
    // When space is short the detail goes before the id does: the id is what
    // you search for, the detail is what you go read the log for.
    if (detail && (width === undefined || row.length + detail.length <= width)) return `${row}${detail}`;
    return width === undefined ? row : row.slice(0, width);
  });
}

const TALLY_GLYPH = { completed: "◉", running: "◎", blocked: "⊘", failed: "✗", pending: "○" } as const;

export function tallyOf(nodes: NodeStatusDto[]): string {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const parts: string[] = [];
  for (const [status, mark] of Object.entries(TALLY_GLYPH)) {
    const n = counts.get(status) ?? 0;
    if (n > 0) parts.push(`${mark}${n}`);
  }
  return parts.join(" · ");
}

/** One row per occurrence: `▶` marks the one on screen. */
function runRow(run: RunsFeedEntry, selected: boolean, now: Date): string {
  const ended = run.finishedAt ? localClock(run.finishedAt) : "…";
  const blocker = run.blocker ? `  (${run.blocker})` : "";
  const age = relativeAge(run.finishedAt ?? run.startedAt, now);
  return `${selected ? "▶" : " "} ${glyph(run.status)} ${shortRunId(run.id)}  ${localClock(run.startedAt)}→${ended}  ${age}${blocker}`;
}

/**
 * The slice of the feed that fits, always containing the selection. Without
 * this, walking past the visible rows changes the log pane while the feed gives
 * no sign of which run is on screen.
 */
export function windowRuns(
  rows: string[],
  selectedIndex: number,
  height: number,
): { rows: string[]; from: number; to: number } {
  if (height <= 0) return { rows: [], from: 0, to: 0 };
  if (rows.length <= height) return { rows, from: 0, to: rows.length };
  const half = Math.floor(height / 2);
  const start = Math.max(0, Math.min(rows.length - height, selectedIndex - half));
  return { rows: rows.slice(start, start + height), from: start, to: start + height };
}

/** The tail of the stream, so the newest activity sits at the bottom. */
function streamLines(logText: string | null, height: number): string[] {
  if (!logText) return ["(no log yet)"];
  const lines = logText.replace(/\n+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - height));
}

/** Columns a pane actually gets, from the terminal width and the flex shares. */
export function paneColumns(terminalWidth: number, share: number, of: number): number {
  const gap = 3; // column gap between the two upper panes
  return Math.max(12, Math.floor((terminalWidth - gap) * (share / of)) - 4);
}

const LAYOUT = { left: 1, right: 1 } as const;

/** Chain-pane width when the caller knows the terminal, else unconstrained. */
function chainColumns(input: { chainWidth?: number; terminalWidth?: number }): number | undefined {
  if (input.chainWidth !== undefined) return input.chainWidth;
  if (input.terminalWidth !== undefined) return paneColumns(input.terminalWidth, LAYOUT.left, LAYOUT.left + LAYOUT.right);
  return undefined;
}

export function buildViewerModel(input: {
  /** Null only while the workflow picker is open. */
  workflowId: string | null;
  dto: StatusDto;
  feed: RunsFeed | null;
  /** Log text for the run the stream follows: collated, or one run's worklog. */
  logText: string | null;
  selectedRunId?: string | null;
  /** Collated mode streams every run, so no single run is selected. */
  collated?: boolean;
  streamHeight?: number;
  /** Rows the runs pane can show; the viewport scrolls to keep the selection. */
  runsHeight?: number;
  /** Usable columns in the chain pane, so details are dropped before ids. */
  chainWidth?: number;
  /** Given instead of chainWidth: the panes derive it from their own layout. */
  terminalWidth?: number;
  /** Injectable so relative ages are testable. */
  now?: Date;
}): ViewerModel {
  const workflow = input.workflowId ? input.dto.workflows.find((w) => w.id === input.workflowId) : undefined;
  const now = input.now ?? new Date();
  const runsHeight = input.runsHeight ?? 6;
  const selected = input.collated ? null : (input.selectedRunId ?? input.feed?.runs[0]?.id ?? null);
  const selectedEntry = input.feed?.runs.find((r) => r.id === selected) ?? null;

  if (!input.workflowId) return pickerModel(input);

  const activation = workflow?.activation
    ? `${workflow.activation.state} ${workflow.activation.startedRuns}/${workflow.activation.maxRuns ?? "∞"}`
    : workflow
      ? "one-shot"
      : "unknown workflow";
  const nodes = selectedEntry?.nodes ?? [];

  const allRows = (input.feed?.runs ?? []).map((run) =>
    runRow(run, run.id === selected && !input.collated, now),
  );
  const selectedIndex = Math.max(0, (input.feed?.runs ?? []).findIndex((r) => r.id === selected));
  const window = windowRuns(allRows, selectedIndex, runsHeight);
  const windowNote =
    allRows.length > window.rows.length ? ` · ${window.from + 1}–${window.to}/${allRows.length}` : "";

  return {
    layout: LAYOUT,
    header: `${input.workflowId}  ${activation}${
      selectedEntry ? `  ${shortRunId(selectedEntry.id)} ${selectedEntry.status}${selectedEntry.blocker ? ` · ${selectedEntry.blocker}` : ""}` : ""
    }`,
    tally: tallyOf(nodes),
    selectedRunId: selected,
    nodes: {
      title: selectedEntry ? `chain · ${shortRunId(selectedEntry.id)} · ${selectedEntry.status}` : "chain · no run",
      lines: selectedEntry ? nodeLines(nodes, chainColumns(input)) : ["(no runs yet)"],
    },
    runs: {
      title: `runs · ${input.feed?.total ?? 0}${windowNote}`,
      lines: window.rows.length > 0 ? window.rows : ["(no runs yet)"],
    },
    stream: {
      title: input.collated ? "log · all runs" : selected ? `log · ${shortRunId(selected)}` : "log",
      lines: streamLines(input.logText, input.streamHeight ?? 12),
    },
  };
}

/**
 * The workflow picker, rendered through the same panes: the list on the left,
 * the highlighted workflow's state on the right. Reusing the panes means the
 * picker inherits the layout, the colours, and the frame tests.
 */
export function pickerModel(input: {
  dto: StatusDto;
  cursor?: number;
  streamHeight?: number;
}): ViewerModel {
  const workflows = input.dto.workflows;
  const cursor = Math.max(0, Math.min(workflows.length - 1, input.cursor ?? 0));
  const current = workflows[cursor];

  const rows = workflows.map((wf, i) => {
    const state = wf.activation ? `${wf.activation.state} ${wf.activation.startedRuns}/${wf.activation.maxRuns ?? "∞"}` : "one-shot";
    const live = wf.currentRun ? `  ${wf.currentRun.status}` : "";
    return `${i === cursor ? "▶" : " "} ${wf.id}  ${state}${live}`;
  });

  const detail = current
    ? [
        `workflow   ${current.id}`,
        `activation ${current.activation ? `${current.activation.state} ${current.activation.startedRuns}/${current.activation.maxRuns ?? "∞"}` : "one-shot"}`,
        `live run   ${current.currentRun ? `${current.currentRun.id} (${current.currentRun.status})` : "none"}`,
        "",
        "enter  open this workflow",
        "j / k  move",
        "q      quit",
      ]
    : ["(no workflows configured)", "", "q  quit"];

  return {
    // A picker is a list first: an even split keeps ids readable.
    layout: { left: 2, right: 3 },
    header: `pick a workflow  ·  ${workflows.length} configured`,
    tally: "",
    selectedRunId: null,
    nodes: { title: "workflows", lines: rows.length > 0 ? rows : ["(none configured)"] },
    runs: { title: `detail · ${current?.id ?? "none"}`, lines: detail },
    stream: { title: "hint", lines: ["Choose a workflow to", "follow it live."] },
  };
}

/** Keys change state and nothing else; the reducer is pure so bindings are testable. */
export interface PickerKey {
  name: string;
  ctrl?: boolean;
}

/** Returns the chosen workflow id, or "quit", or null while still picking. */
export function reducePickerKey(key: PickerKey, workflowIds: string[], cursor: number): string | null {
  const name = key.name.toLowerCase();
  if (name === "q" || (key.ctrl && name === "c")) return "quit";
  if (name === "enter" || name === "return") return workflowIds[cursor] ?? null;
  return null;
}
