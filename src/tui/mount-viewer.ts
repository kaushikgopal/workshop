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
import { buildViewerModel, pickerModel, type ViewerModel } from "./build-panes.js";
import type { ViewerSource } from "./data-source.js";
import type { StatusDto } from "../views/build-status-json.js";

/**
 * TUI-only: the terminal binding. Nothing in the runtime imports this — the
 * `watch` command loads it lazily — and it must stay that way, so the runtime
 * never depends on a terminal library.
 *
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
  paused: "#a371f7",
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

  constructor(
    ctx: RenderContext,
    title: string,
    rows: number,
    opts: { flexGrow?: number; width?: number; flexBasis?: number | "auto" } = {},
  ) {
    this.box = new BoxRenderable(ctx, {
      flexBasis: opts.flexBasis ?? "auto",
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
  for (const ch of line) if ("◉◎◑⊘✗·○‖".includes(ch)) return ch;
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
    case "‖":
      return "paused";
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

export interface OpenViewerOptions {
  /** Omit to choose from the configured workflows first. */
  workflowId?: string | null;
  source: ViewerSource;
  refreshMs?: number;
  rows?: number;
  /** Rows the runs pane shows; the viewport scrolls to keep the selection. */
  runsRows?: number;
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
export interface ViewerPaintOptions {
  pollError?: string | null;
  collated?: boolean;
  picking?: boolean;
}

export interface ViewerMount {
  paint(model: ViewerModel, extra?: ViewerPaintOptions): void;
}

/** One row of chrome: never allowed to wrap into a second. */
function clipToWidth(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}

export function mountViewer(renderer: CliRenderer, opts: { rows?: number; runsRows?: number } = {}): ViewerMount {
  const rows = opts.rows ?? 12;
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
  const header = new TextRenderable(renderer, { content: "" });
  const main = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, columnGap: 1 });
  // flexBasis 0 makes the shares real: with a content-based basis the pane
  // holding longer text wins the row, which squeezed the chain pane.
  const chain = new Pane(renderer, "chain", rows, { flexGrow: 1, flexBasis: 0 });
  const log = new Pane(renderer, "log", rows, { flexGrow: 2, flexBasis: 0 });
  const runs = new Pane(renderer, "runs", opts.runsRows ?? 8);
  const footer = new TextRenderable(renderer, { content: t`${fg(DIM)(FOOTER_HINTS)}` });

  main.add(chain.box);
  main.add(log.box);
  // Order is the reading order: what happened (the feed), then the detail of
  // the run you picked from it.
  root.add(header);
  root.add(runs.box);
  root.add(main);
  root.add(footer);
  renderer.root.add(root);

  return {
    paint(model, extra = {}) {
      const paneRows = renderRows(model);
      const tally = model.tally ? `   ${model.tally}` : "";
      header.content = extra.pollError
        ? t`${fg(ACCENT)("WORKSHOP")}  ${fg(TEXT)(model.header)}${fg(DIM)(tally)}  ${fg("#ff7b72")(`STALE · poll failed: ${extra.pollError}`)}`
        : t`${fg(ACCENT)("WORKSHOP")}  ${fg(TEXT)(model.header)}${fg(DIM)(tally)}`;
      // The hints matter more than the run id when the terminal is narrow.
      const width = renderer.terminalWidth;
      const full = extra.picking
        ? `↑↓ choose · enter open · q quit`
        : `${extra.collated ? "all runs" : (model.selectedRunId ?? "no run")}  ·  ${FOOTER_HINTS}`;
      footer.content = t`${fg(DIM)(clipToWidth(full, width))}`;
      // Panes share width by mode: a list needs room for ids, a log needs room
      // for text. Without this the picker squeezed ids into a third.
      chain.box.flexGrow = model.layout.left;
      log.box.flexGrow = model.layout.right;
      chain.setTitle(paneRows.chain.title);
      chain.set(paneRows.chain.rows);
      log.setTitle(paneRows.log.title);
      log.set(paneRows.log.rows);
      runs.setTitle(paneRows.runs.title);
      runs.set(paneRows.runs.rows);
    },
  };
}

export interface ViewerRefreshSelection {
  readonly workflowId: string | null;
  readonly selectedRunId: string | null;
  readonly follow: boolean;
  readonly collated: boolean;
  readonly cursor: number;
}

export interface ViewerRefreshCommit {
  status: StatusDto;
  runIds: string[];
  selectedRunId: string | null;
}

/**
 * Refresh one immutable viewer selection at a time. Input changes invalidate
 * an in-flight read and queue one read for the newest selection; timer ticks
 * coalesce behind the same serial queue.
 */
export function createViewerRefresh(input: {
  source: ViewerSource;
  selection: () => ViewerRefreshSelection;
  commit: (result: ViewerRefreshCommit) => void;
  paint: (model: ViewerModel, extra?: ViewerPaintOptions) => void;
  terminalWidth: () => number;
  rows: number;
  runsRows: number;
}): { refresh: () => Promise<void>; invalidate: () => void } {
  const emptyStatus: StatusDto = { version: 1, workflows: [] };
  let generation = 0;
  let queued = false;
  let active: Promise<void> | null = null;
  let lastFrame: { model: ViewerModel; extra: ViewerPaintOptions } | null = null;

  const initialFrame = (selection: ViewerRefreshSelection): { model: ViewerModel; extra: ViewerPaintOptions } => {
    if (!selection.workflowId) {
      return { model: pickerModel({ dto: emptyStatus, cursor: selection.cursor }), extra: { picking: true } };
    }
    return {
      model: buildViewerModel({
        workflowId: selection.workflowId,
        dto: emptyStatus,
        feed: null,
        logText: null,
        selectedRunId: selection.selectedRunId,
        collated: selection.collated,
        streamHeight: input.rows,
        runsHeight: input.runsRows,
        terminalWidth: input.terminalWidth(),
      }),
      extra: { collated: selection.collated },
    };
  };

  const showError = (selection: ViewerRefreshSelection, error: unknown): void => {
    const frame = lastFrame ?? initialFrame(selection);
    input.paint(frame.model, { ...frame.extra, pollError: error instanceof Error ? error.message : String(error) });
  };

  const refreshOnce = async (): Promise<void> => {
    const requestGeneration = generation;
    const selection = Object.freeze({ ...input.selection() });
    const isCurrent = (): boolean => requestGeneration === generation;
    let snapshot: Awaited<ReturnType<ViewerSource["snapshot"]>>;

    try {
      snapshot = await input.source.snapshot(
        selection.workflowId,
        selection.follow ? null : selection.selectedRunId,
      );
    } catch (error) {
      if (isCurrent()) showError(selection, error);
      return;
    }
    if (!isCurrent()) return;

    if (!selection.workflowId) {
      const ids = snapshot.status.workflows.map((workflow) => workflow.id);
      const cursor = Math.max(0, Math.min(ids.length - 1, selection.cursor));
      const model = pickerModel({ dto: snapshot.status, cursor });
      input.commit({ status: snapshot.status, runIds: [], selectedRunId: null });
      const extra = { picking: true };
      input.paint(model, extra);
      lastFrame = { model, extra };
      return;
    }

    const feed = { ...snapshot.runs, workflowId: selection.workflowId };
    const runIds = feed.runs.map((run) => run.id);
    const selectedRunId = selection.follow && runIds[0]
      ? runIds[0]
      : selection.selectedRunId ?? runIds[0] ?? null;
    let logText: string;
    try {
      logText = await input.source.log(selection.workflowId, selection.collated ? null : selectedRunId);
    } catch (error) {
      if (isCurrent()) showError(selection, error);
      return;
    }
    if (!isCurrent()) return;

    const model = buildViewerModel({
      workflowId: selection.workflowId,
      dto: snapshot.status,
      feed,
      logText,
      selectedRunId,
      collated: selection.collated,
      streamHeight: input.rows,
      runsHeight: input.runsRows,
      terminalWidth: input.terminalWidth(),
    });
    const extra = { collated: selection.collated };
    input.commit({ status: snapshot.status, runIds, selectedRunId });
    input.paint(model, extra);
    lastFrame = { model, extra };
  };

  const refresh = (): Promise<void> => {
    queued = true;
    if (!active) {
      active = (async () => {
        while (queued) {
          queued = false;
          await refreshOnce();
        }
      })().finally(() => {
        active = null;
      });
    }
    return active;
  };

  return {
    refresh,
    invalidate: () => {
      generation++;
    },
  };
}

/**
 * Poll the projections and repaint. A poll failure explicitly marks the last
 * good frame stale; overlapping reads serialize and state changes supersede
 * their in-flight result.
 */
export async function openViewer(opts: OpenViewerOptions): Promise<void> {
  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });
  const state: ViewerState = { selectedRunId: null, follow: true, collated: false };
  let runIds: string[] = [];
  let workflowId = opts.workflowId ?? null;
  let cursor = 0;
  let lastStatus: StatusDto | null = null;
  const mount = mountViewer(renderer, { rows: opts.rows ?? 12, runsRows: opts.runsRows ?? 8 });

  const refresh = createViewerRefresh({
    source: opts.source,
    selection: () => ({ workflowId, ...state, cursor }),
    commit: ({ status, runIds: ids, selectedRunId }) => {
      lastStatus = status;
      runIds = ids;
      if (workflowId) state.selectedRunId = selectedRunId;
    },
    paint: (model, extra) => {
      mount.paint(model, extra);
      renderer.requestRender();
    },
    terminalWidth: () => renderer.terminalWidth,
    rows: opts.rows ?? 12,
    runsRows: opts.runsRows ?? 8,
  });

  const timer = setInterval(() => void refresh.refresh(), opts.refreshMs ?? 1000);


  const shutdown = makeShutdown({
    clear: () => clearInterval(timer),
    detach: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
    stop: () => renderer.stop(),
    destroy: () => renderer.destroy(),
    exit: (code) => process.exit(code),
  });
  function onSignal(): void {
    shutdown();
  }

  renderer.keyInput.on("keypress", (key) => {
    if (!workflowId) {
      const ids = lastStatus?.workflows.map((w) => w.id) ?? [];
      const name = key.name.toLowerCase();
      if (name === "q" || (key.ctrl && name === "c")) return shutdown();
      if ((name === "j" || name === "down") && ids.length > 0) cursor = Math.min(ids.length - 1, cursor + 1);
      else if ((name === "k" || name === "up") && ids.length > 0) cursor = Math.max(0, cursor - 1);
      else if (name === "enter" || name === "return") {
        workflowId = ids[cursor] ?? null;
        // A fresh workflow starts with a fresh selection rather than carrying
        // the previous one's run id into a feed that never had it.
        state.selectedRunId = null;
        state.follow = true;
        state.collated = false;
      }
      refresh.invalidate();
      void refresh.refresh();
      return;
    }
    const action = reduceKey(state, { name: key.name, ctrl: key.ctrl }, runIds);
    if (action === "quit") return shutdown();
    refresh.invalidate();
    void refresh.refresh();
  });

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  renderer.start();
  await refresh.refresh();
}

/**
 * One shutdown path for every way out: a keypress, a signal, or Ctrl+C handled
 * by the renderer.
 *
 * Quitting is not just destroying the renderer — the poll timer keeps the
 * event loop alive, so the process outlives the interface and the operator has
 * to interrupt it a second time. The once-guard matters too: quitting twice is
 * easy to do, and a second exit would land while the terminal is restoring.
 */
export function makeShutdown(deps: {
  clear: () => void;
  detach: () => void;
  stop: () => void;
  destroy: () => void;
  exit: (code: number) => void;
}): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    deps.clear();
    deps.detach();
    try {
      deps.stop();
    } catch {
      /* the renderer may already be stopping */
    }
    deps.destroy();
    // Let the terminal-restoring writes reach the tty before the process goes.
    setTimeout(() => deps.exit(0), 0);
  };
}
