import {
  BoxRenderable,
  TextRenderable,
  createCliRenderer,
  fg,
  t,
  type CliRenderer,
  type RenderContext,
  type StyledText,
} from "@opentui/core";
import { buildViewerModel, type ViewerModel } from "./panes.js";
import type { ViewerSource } from "./source.js";

/**
 * The terminal binding. Everything above this file (the projections, the pane
 * model) is transport-independent, so this is the only place that knows about a
 * terminal library — and the only part a swap to HTML would replace.
 *
 * Layout follows one rule: the panes answer the questions an operator actually
 * asks, in the order they ask them. What is happening now (chain + log) at the
 * top, what happened before (runs) below, and what I can press along the bottom.
 */

const STATUS_COLOR: Record<string, string> = {
  completed: "#7ee787",
  running: "#79c0ff",
  finishing: "#79c0ff",
  blocked: "#ffa657",
  failed: "#ff7b72",
  cancelled: "#6e7681",
  pending: "#8b949e",
  queued: "#8b949e",
};

const ACCENT = "#79c0ff";
const DIM = "#6e7681";
const TEXT = "#c9d1d9";

const color = (status: string): string => STATUS_COLOR[status] ?? TEXT;

export interface ViewerState {
  selectedRunId: string | null;
  /** Keep the newest occurrence selected as new ones appear. */
  follow: boolean;
  /** Stream every run's worklog instead of one run's. */
  collated: boolean;
}

export type ViewerAction = "quit" | "refresh" | null;

export interface KeyLike {
  name: string;
  ctrl?: boolean;
}

/**
 * Keys change state and nothing else; the reducer is pure so the bindings are
 * testable without a terminal. `runIds` is newest-first, matching the feed.
 */
export function reduceKey(state: ViewerState, key: KeyLike, runIds: string[]): ViewerAction {
  const at = state.selectedRunId ? runIds.indexOf(state.selectedRunId) : -1;
  const name = key.name.toLowerCase();

  if (name === "q" || (key.ctrl && name === "c")) return "quit";
  if (name === "r") return "refresh";
  if (name === "f") {
    state.follow = !state.follow;
    if (state.follow && runIds[0]) state.selectedRunId = runIds[0];
    return null;
  }
  if (name === "a") {
    state.collated = !state.collated;
    return null;
  }
  if (name === "j" || name === "down") {
    // Older: index grows as the feed goes back in time.
    const next = at < 0 ? 0 : Math.min(runIds.length - 1, at + 1);
    state.selectedRunId = runIds[next] ?? null;
    state.follow = false;
    return null;
  }
  if (name === "k" || name === "up") {
    const next = at <= 0 ? 0 : at - 1;
    state.selectedRunId = runIds[next] ?? null;
    state.follow = false;
    return null;
  }
  return null;
}

const FOOTER_HINTS = "↑↓ select run · a all runs · f follow · r refresh · q quit";

/** A pane: a titled box whose lines are pre-created and then rewritten. */
class Pane {
  readonly box: BoxRenderable;
  private readonly lines: TextRenderable[];

  constructor(ctx: RenderContext, title: string, rows: number, opts: { flexGrow?: number; width?: number } = {}) {
    this.box = new BoxRenderable(ctx, {
      border: true,
      borderStyle: "rounded",
      borderColor: DIM,
      title,
      titleColor: ACCENT,
      flexDirection: "column",
      overflow: "hidden",
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: opts.flexGrow ?? 0,
      width: opts.width,
    });
    this.lines = Array.from(
      { length: rows },
      () => new TextRenderable(ctx, { content: "", wrapMode: "none", truncate: true }),
    );
    for (const line of this.lines) this.box.add(line);
  }

  setTitle(title: string): void {
    this.box.title = title;
  }

  set(content: StyledText[]): void {
    for (let i = 0; i < this.lines.length; i++) {
      this.lines[i]!.content = content[i] ?? "";
    }
  }
}

export function renderRows(model: ViewerModel): {
  header: StyledText;
  chain: { title: string; rows: StyledText[] };
  log: { title: string; rows: StyledText[] };
  runs: { title: string; rows: StyledText[] };
} {
  return {
    header: t`${fg(ACCENT)("WORKSHOP")}  ${fg(TEXT)(model.header)}`,
    chain: {
      title: model.nodes.title,
      rows: model.nodes.lines.map((line) => {
        const mark = firstStatusGlyph(line);
        // Colour the leading spine dim and the row by the node's own status.
        return t`${fg(DIM)(line.slice(0, line.indexOf(mark)))}${fg(color(glyphStatus(mark)))(line.slice(line.indexOf(mark)))}`;
      }),
    },
    log: { title: model.stream.title, rows: model.stream.lines.map((line) => t`${fg(TEXT)(line)}`) },
    runs: {
      title: model.runs.title,
      rows: model.runs.lines.map((line) => {
        const selected = line.startsWith("▶");
        const [mark = " ", status = "", ...rest] = line.split(" ");
        return t`${fg(selected ? ACCENT : DIM)(mark)} ${fg(selected ? color(glyphStatus(status)) : DIM)(status)} ${fg(selected ? TEXT : DIM)(rest.join(" "))}`;
      }),
    },
  };
}

/** The first status mark on a row, wherever the spine or marker put it. */
function firstStatusGlyph(line: string): string {
  for (const ch of line) if ("◉◎◑⊘✗·○".includes(ch)) return ch;
  return "";
}

/** Map a glyph back to a status for colouring (the panes stay text-only). */
function glyphStatus(glyph: string): string {
  switch (glyph) {
    case "◉":
      return "completed";
    case "◎":
    case "◑":
      return "running";
    case "⊘":
      return "blocked";
    case "✗":
      return "failed";
    case "·":
      return "cancelled";
    default:
      return "pending";
  }
}

export interface RunViewerOptions {
  workflowId: string;
  source: ViewerSource;
  refreshMs?: number;
  rows?: number;
}

/**
 * Poll the projections and repaint. The viewer never blocks on the runtime's
 * own work: a failed poll reports itself in the header and the previous frame
 * stays legible.
 */
/**
 * The mounted tree. Exposed so the frame can be asserted against the real
 * binding — a test that rebuilds its own layout would prove nothing about this
 * one.
 */
export interface ViewerMount {
  paint(model: ViewerModel, extra?: { pollError?: string | null; collated?: boolean }): void;
}

/** One row of chrome: never allowed to wrap into a second. */
function clipToWidth(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}

export function mountViewer(renderer: CliRenderer, opts: { rows?: number } = {}): ViewerMount {
  const rows = opts.rows ?? 12;
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
  const header = new TextRenderable(renderer, { content: "" });
  const main = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, columnGap: 1 });
  const chain = new Pane(renderer, "chain", rows, { flexGrow: 1 });
  const log = new Pane(renderer, "log", rows, { flexGrow: 2 });
  const runs = new Pane(renderer, "runs", 8);
  const footer = new TextRenderable(renderer, { content: t`${fg(DIM)(FOOTER_HINTS)}` });

  main.add(chain.box);
  main.add(log.box);
  root.add(header);
  root.add(main);
  root.add(runs.box);
  root.add(footer);
  renderer.root.add(root);

  return {
    paint(model, extra = {}) {
      const paneRows = renderRows(model);
      const tally = model.tally ? `   ${model.tally}` : "";
      header.content = extra.pollError
        ? t`${fg(ACCENT)("WORKSHOP")}  ${fg(TEXT)(model.header)}${fg(DIM)(tally)}  ${fg("#ff7b72")(`poll failed: ${extra.pollError}`)}`
        : t`${fg(ACCENT)("WORKSHOP")}  ${fg(TEXT)(model.header)}${fg(DIM)(tally)}`;
      // The hints matter more than the run id when the terminal is narrow.
      const width = renderer.terminalWidth;
      const full = `${extra.collated ? "all runs" : (model.selectedRunId ?? "no run")}  ·  ${FOOTER_HINTS}`;
      footer.content = t`${fg(DIM)(clipToWidth(full, width))}`;
      chain.setTitle(paneRows.chain.title);
      chain.set(paneRows.chain.rows);
      log.setTitle(paneRows.log.title);
      log.set(paneRows.log.rows);
      runs.setTitle(paneRows.runs.title);
      runs.set(paneRows.runs.rows);
    },
  };
}

/**
 * Poll the projections and repaint. The viewer never blocks on the runtime's
 * own work: a failed poll reports itself in the header and the previous frame
 * stays legible.
 */
export async function runViewer(opts: RunViewerOptions): Promise<void> {
  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });
  const state: ViewerState = { selectedRunId: null, follow: true, collated: false };
  let pollError: string | null = null;
  let runIds: string[] = [];
  const mount = mountViewer(renderer, { rows: opts.rows ?? 12 });

  const refresh = async (): Promise<void> => {
    try {
      const { status, runs: feed } = await opts.source.snapshot();
      runIds = feed.runs.map((r) => r.id);
      if (state.follow && runIds[0]) state.selectedRunId = runIds[0];
      if (!state.selectedRunId && runIds[0]) state.selectedRunId = runIds[0];
      const logText = await opts.source.log(state.collated ? null : state.selectedRunId);
      pollError = null;
      mount.paint(
        buildViewerModel({
          workflowId: opts.workflowId,
          dto: status,
          feed,
          logText,
          selectedRunId: state.selectedRunId,
          collated: state.collated,
          streamHeight: opts.rows ?? 12,
        }),
        { pollError, collated: state.collated },
      );
    } catch (e) {
      pollError = e instanceof Error ? e.message : String(e);
      renderer.requestRender();
    }
  };

  renderer.keyInput.on("keypress", (key) => {
    const action = reduceKey(state, { name: key.name, ctrl: key.ctrl }, runIds);
    if (action === "quit") {
      renderer.destroy();
      return;
    }
    void refresh();
  });

  const timer = setInterval(() => void refresh(), opts.refreshMs ?? 1000);
  process.once("SIGINT", () => clearInterval(timer));
  process.once("SIGTERM", () => clearInterval(timer));
  renderer.start();
  await refresh();
}
