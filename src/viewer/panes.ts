import { glyph, localClock } from "../status/tree.js";
import type { StatusDto, NodeStatusDto, AttemptStatusDto } from "../status/dto.js";
import type { RunsFeed } from "../status/runs-feed.js";

/**
 * The viewer's panes as plain data.
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
  /** Node tally, in the five states a chain can be in. */
  tally: string;
  /** The full id of the run being streamed, for operators who need to look it up. */
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

/** One row per node in chain order, spine-drawn so the chain reads top to bottom. */
function nodeLines(workflow: StatusDto["workflows"][number] | undefined): string[] {
  const run = workflow?.currentRun ?? null;
  if (!run) return ["(no unresolved run)"];
  if (run.nodes.length === 0) return ["(no attempts yet)"];
  return run.nodes.map((node, i) => {
    const last = i === run.nodes.length - 1;
    const attempts = node.attempts;
    const latest = attempts[attempts.length - 1];
    const attemptNo = latest?.number ?? 1;
    const retry = attemptNo > 1 ? ` #${attemptNo}` : "";
    const timing = attemptTiming(latest);
    const detail = latest?.progress
      ? ` — ${latest.progress}`
      : latest?.validator === "passed"
        ? " — validator passed"
        : latest?.validator === "failed"
          ? " — validator rejected"
          : latest?.failure
            ? ` — ${latest.failure}`
            : "";
    return `${last ? "└─" : "├─"} ${glyph(node.status)} ${node.id}${retry}${timing ? `  ${timing}` : ""}${detail}`;
  });
}

const TALLY_GLYPH = { completed: "◉", running: "◎", blocked: "⊘", failed: "✗", pending: "○" } as const;

function tallyOf(nodes: NodeStatusDto[]): string {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const parts: string[] = [];
  for (const [status, mark] of Object.entries(TALLY_GLYPH)) {
    const n = counts.get(status) ?? 0;
    if (n > 0) parts.push(`${mark}${n}`);
  }
  return parts.join(" · ");
}

/** One row per occurrence, newest first; `▶` marks the run being streamed. */
function runLines(feed: RunsFeed | null, selectedRunId: string | null, now: Date): string[] {
  if (!feed || feed.total === 0) return ["(no runs yet)"];
  return feed.runs.map((run) => {
    const selected = run.id === selectedRunId;
    const ended = run.finishedAt ? localClock(run.finishedAt) : "…";
    const blocker = run.blocker ? `  (${run.blocker})` : "";
    const age = relativeAge(run.finishedAt ?? run.startedAt, now);
    return `${selected ? "▶" : " "} ${glyph(run.status)} ${shortRunId(run.id)}  ${localClock(run.startedAt)}→${ended}  ${age}${blocker}`;
  });
}

/** The tail of the stream, so the newest activity sits at the bottom. */
function streamLines(logText: string | null, height: number): string[] {
  if (!logText) return ["(no log yet)"];
  const lines = logText.replace(/\n+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - height));
}

export function buildViewerModel(input: {
  workflowId: string;
  dto: StatusDto;
  feed: RunsFeed | null;
  /** Log text for the run the stream follows: collated, or one run's worklog. */
  logText: string | null;
  selectedRunId?: string | null;
  /** Collated mode streams every run, so no single run is selected. */
  collated?: boolean;
  streamHeight?: number;
  limit?: number;
  /** Injectable so relative ages are testable. */
  now?: Date;
}): ViewerModel {
  const workflow = input.dto.workflows.find((w) => w.id === input.workflowId);
  const now = input.now ?? new Date();
  const limit = input.limit ?? 60;
  const selected = input.collated ? null : (input.selectedRunId ?? input.feed?.runs[0]?.id ?? null);

  const activation = workflow?.activation
    ? `${workflow.activation.state} ${workflow.activation.startedRuns}/${workflow.activation.maxRuns ?? "∞"}`
    : workflow
      ? "one-shot"
      : "unknown workflow";
  const run = workflow?.currentRun;
  const blocker = run?.blocker ? `  ${run.blocker}` : "";
  const nodes = run?.nodes ?? [];

  return {
    header: `${input.workflowId}  ${activation}${blocker}`,
    tally: tallyOf(nodes),
    selectedRunId: selected,
    nodes: {
      title: run ? `chain · ${shortRunId(run.id)} · ${run.status}` : "chain",
      lines: nodeLines(workflow),
    },
    runs: {
      title: `runs · ${input.feed?.total ?? 0}`,
      lines: runLines(input.feed, input.collated ? null : selected, now),
    },
    stream: {
      title: input.collated ? "log · all runs" : selected ? `log · ${shortRunId(selected)}` : "log",
      lines: streamLines(input.logText, input.streamHeight ?? Math.max(4, limit)),
    },
  };
}
