import { BoxRenderable, RGBA, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable, createCliRenderer, type CliRenderer, type TextChunk } from "@opentui/core";
import { statusGlyph, statusLabel } from "../views/render-status.js";
import { buildViewerModel, type ViewerModel } from "./build-panes.js";
import type { ViewerSnapshot, ViewerSource } from "./data-source.js";

const ANSI = { red: 1, green: 2, yellow: 3, cyan: 6, brightBlack: 8 } as const;
const STATUS_COLORS: Record<string, number> = {
  skipped: ANSI.brightBlack, pending: ANSI.brightBlack, ready: ANSI.brightBlack, succeeded: ANSI.green, completed: ANSI.green,
  running: ANSI.cyan, waiting: ANSI.yellow, blocked: ANSI.yellow, failed: ANSI.red,
};
const DIM = RGBA.fromIndex(ANSI.brightBlack);

function chunk(text: string, color = RGBA.defaultForeground(), attributes = 0): TextChunk {
  return { __isChunk: true, text, fg: color, attributes };
}

function clip(value: string, width: number): string {
  return value.length <= width ? value : value.slice(0, Math.max(0, width - 1)) + "…";
}

function statusColor(status: string): RGBA | null {
  const normalized = status.toLowerCase();
  if (normalized.startsWith("configuration error")) return RGBA.fromIndex(ANSI.red);
  const key = normalized === "needs input" ? "waiting" : normalized;
  const index = STATUS_COLORS[key];
  return index === undefined ? null : RGBA.fromIndex(index);
}

function statusAttributes(status: string): number {
  const normalized = status.toLowerCase();
  return normalized === "skipped" || normalized === "pending" || normalized === "ready" ? TextAttributes.DIM : 0;
}

interface TablePart {
  text: string;
  color?: RGBA;
  attributes?: number;
}

function appendTableLine(chunks: TextChunk[], parts: readonly TablePart[], width: number): void {
  let remaining = width;
  for (const part of parts) {
    if (remaining <= 0) break;
    if (part.text.length <= remaining) {
      chunks.push(chunk(part.text, part.color, part.attributes));
      remaining -= part.text.length;
    } else {
      const clipped = remaining === 1 ? "…" : part.text.slice(0, remaining - 1) + "…";
      chunks.push(chunk(clipped, part.color, part.attributes));
      remaining = 0;
    }
  }
  chunks.push(chunk("\n"));
}

function renderOverviewTable(rows: readonly (readonly [string, string, string])[], width: number, selectedId: string | null): StyledText {
  const chunks: TextChunk[] = [];
  if (rows.length === 0) return new StyledText([chunk("No workflows configured")]);
  if (width < 60) {
    rows.forEach((row, index) => {
      const selected = row[0] === selectedId;
      const rowAttributes = selected ? TextAttributes.BOLD : 0;
      const color = statusColor(row[1]) ?? RGBA.defaultForeground();
      const cellAttributes = rowAttributes | statusAttributes(row[1]);
      appendTableLine(chunks, [
        { text: selected ? "›" : " ", attributes: rowAttributes },
        { text: "Title:", color: DIM, attributes: rowAttributes | TextAttributes.DIM },
        { text: " " + row[0], attributes: rowAttributes },
      ], width);
      appendTableLine(chunks, [
        { text: " ", attributes: rowAttributes },
        { text: "Status: ", color: DIM, attributes: rowAttributes | TextAttributes.DIM },
        { text: statusGlyph(row[1]) + " " + row[1], color, attributes: cellAttributes },
      ], width);
      appendTableLine(chunks, [
        { text: " ", attributes: rowAttributes },
        { text: "Next run: ", color: DIM, attributes: rowAttributes | TextAttributes.DIM },
        { text: row[2], attributes: rowAttributes },
      ], width);
      if (index < rows.length - 1) appendTableLine(chunks, [], width);
    });
    return new StyledText(chunks.slice(0, -1));
  }

  const nextWidth = Math.min(19, Math.max(8, ...rows.map(row => row[2].length)));
  const titleWidth = Math.max(12, Math.floor((width - nextWidth - 5) / 2));
  const statusWidth = Math.max(8, width - nextWidth - titleWidth - 5);
  const field = (value: string, fieldWidth: number) => clip(value, fieldWidth).padEnd(fieldWidth);
  const heading = TextAttributes.DIM;
  appendTableLine(chunks, [
    { text: " " },
    { text: field("Title", titleWidth), attributes: heading },
    { text: "  " },
    { text: field("Status", statusWidth), attributes: heading },
    { text: "  " },
    { text: field("Next run", nextWidth), attributes: heading },
  ], width);
  rows.forEach(row => {
    const selected = row[0] === selectedId;
    const rowAttributes = selected ? TextAttributes.BOLD : 0;
    const statusColorValue = statusColor(row[1]) ?? RGBA.defaultForeground();
    appendTableLine(chunks, [
      { text: selected ? "›" : " ", attributes: rowAttributes },
      { text: field(row[0], titleWidth), attributes: rowAttributes },
      { text: "  ", attributes: rowAttributes },
      { text: field(statusGlyph(row[1]) + " " + row[1], statusWidth), color: statusColorValue,
        attributes: rowAttributes | statusAttributes(row[1]) },
      { text: "  ", attributes: rowAttributes },
      { text: field(row[2], nextWidth), attributes: rowAttributes },
    ], width);
  });
  return new StyledText(chunks.slice(0, -1));
}

function truncateChunks(parts: readonly TextChunk[], width: number): StyledText {
  const chunks: TextChunk[] = [];
  let remaining = width;
  for (const part of parts) {
    if (remaining <= 0) break;
    if (part.text.length <= remaining) {
      chunks.push(part);
      remaining -= part.text.length;
    } else {
      chunks.push({ ...part, text: remaining === 1 ? "…" : part.text.slice(0, remaining - 1) + "…" });
      break;
    }
  }
  return new StyledText(chunks);
}

export interface ViewerState {
  workflowId: string | null;
  selectedId: string | null;
  selectedStepId: string | null;
  expanded: string[];
}

export function reduceKey(state: ViewerState, key: { name: string; ctrl?: boolean }, workflowIds: readonly string[], stepIds: readonly string[]): "quit" | "refresh" | null {
  const name = key.name.toLowerCase();
  if (name === "q" || (name === "c" && key.ctrl)) return "quit";
  if (name === "escape" || name === "backspace") {
    if (state.workflowId !== null) { state.workflowId = null; state.selectedStepId = null; state.expanded = []; return "refresh"; }
    return null;
  }
  if (name === "enter" || name === "return") {
    if (state.workflowId === null && state.selectedId) { state.workflowId = state.selectedId; return "refresh"; }
    return null;
  }
  if (name === "e" && state.workflowId && state.selectedStepId) {
    state.expanded = state.expanded.includes(state.selectedStepId)
      ? state.expanded.filter(id => id !== state.selectedStepId) : [...state.expanded, state.selectedStepId];
    return "refresh";
  }
  const direction = name === "j" || name === "down" ? 1 : name === "k" || name === "up" ? -1 : 0;
  if (!direction) return name === "r" ? "refresh" : null;
  const ids = state.workflowId === null ? workflowIds : stepIds;
  const selected = state.workflowId === null ? state.selectedId : state.selectedStepId;
  const index = Math.max(0, ids.indexOf(selected ?? ""));
  const next = ids[Math.max(0, Math.min(ids.length - 1, index + direction))] ?? null;
  if (state.workflowId === null) state.selectedId = next;
  else state.selectedStepId = next;
  return "refresh";
}

export interface ViewerMount {
  paint(model: ViewerModel, error?: string | null): void;
  readonly content: ScrollBoxRenderable;
  readonly bot: ScrollBoxRenderable;
}

/** Persistent containers preserve scroll and focus across projection updates. */
export function mountViewer(renderer: CliRenderer): ViewerMount {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", shouldFill: false });
  const header = new TextRenderable(renderer, { width: "100%", height: 1, content: "WORKSHOP", wrapMode: "none" });
  const content = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", scrollX: false,
    verticalScrollbarOptions: { visible: false } });
  // Lock both bars off after ScrollBox's automatic visibility pass.
  content.verticalScrollBar.visible = false;
  const notice = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "word" });
  const table = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "none" });
  const chain = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
  const bot = new ScrollBoxRenderable(renderer, { height: Math.max(6, Math.floor(renderer.terminalHeight * 0.4)),
    width: "100%", stickyScroll: true, stickyStart: "bottom", border: true, borderStyle: "rounded", borderColor: DIM,
    titleColor: DIM, focusedBorderColor: DIM, title: " Shared bot feed ", paddingX: 1,
    verticalScrollbarOptions: { visible: false } });
  bot.verticalScrollBar.visible = false;
  const botText = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "word" });
  bot.add(botText);
  const footer = new TextRenderable(renderer, { width: "100%", height: 1, content: "", wrapMode: "none" });
  content.add(notice);
  content.add(table);
  content.add(chain);
  root.add(header);
  root.add(content);
  root.add(bot);
  root.add(footer);
  renderer.root.add(root);
  const steps = new Map<string, { box: BoxRenderable; title: TextRenderable; status: TextRenderable; preview: TextRenderable }>();
  let screenKey = "";
  let selection: string | null = null;
  let width = renderer.terminalWidth;
  let revealSelection: (() => void) | null = null;
  // Scroll bounds exist only after layout. Do not re-reveal on streaming updates.
  const revealAfterLayout = () => {
    const reveal = revealSelection;
    revealSelection = null;
    reveal?.();
  };
  renderer.addPostProcessFn(revealAfterLayout);
  renderer.once("destroy", () => renderer.removePostProcessFn(revealAfterLayout));
  return {
    content, bot,
    paint(model, error) {
      const key = model.screen + ":" + model.header + ":" + model.runId;
      if (key !== screenKey) {
        content.scrollTop = 0;
        selection = null;
        for (const step of steps.values()) step.box.destroyRecursively();
        steps.clear();
        screenKey = key;
      }
      const available = Math.max(1, renderer.terminalWidth - 2);
      const headerParts: TextChunk[] = [
        chunk("WORKSHOP", DIM, TextAttributes.DIM),
        chunk(" · "),
        chunk(model.header, RGBA.defaultForeground(), TextAttributes.BOLD),
      ];
      if (model.runStatus !== null) {
        headerParts.push(chunk(" · "));
        const label = model.runStatus;
        headerParts.push(chunk(statusGlyph(label) + " " + statusLabel(label), statusColor(label) ?? RGBA.defaultForeground(), statusAttributes(label)));
      }
      if (error) headerParts.push(chunk(" · STALE: " + error));
      header.content = truncateChunks(headerParts, available);
      notice.content = model.notice.join("\n");
      notice.visible = model.notice.length > 0;
      table.visible = model.screen === "overview";
      chain.visible = model.screen === "detail";
      table.content = renderOverviewTable(model.rows, available, model.selectedId);
      for (const step of model.steps) {
        let mounted = steps.get(step.id);
        if (!mounted) {
          const box = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", border: true,
            borderStyle: "rounded", borderColor: DIM, focusedBorderColor: DIM, title: " " + step.id + " ", titleColor: DIM,
            paddingX: 1, shouldFill: false });
          const status = new TextRenderable(renderer, { width: "100%", height: 1, content: "", wrapMode: "none" });
          const preview = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "word" });
          const title = new TextRenderable(renderer, { content: "", position: "absolute", left: 1, top: -1,
            width: Math.max(1, step.id.length + 2), height: 1, wrapMode: "none" });
          box.add(status);
          box.add(preview);
          box.add(title);
          chain.add(box);
          mounted = { box, title, status, preview };
          steps.set(step.id, mounted);
        }
        const selected = step.id === model.selectedStepId;
        const borderColor = selected ? RGBA.defaultForeground() : DIM;
        mounted.box.borderColor = borderColor;
        mounted.box.focusedBorderColor = borderColor;
        mounted.box.titleColor = borderColor;
        const titleText = " " + step.id + " ";
        const titleWidth = Math.max(1, Math.min(titleText.length, renderer.terminalWidth - 4));
        mounted.title.width = titleWidth;
        mounted.title.content = new StyledText([chunk(clip(titleText, titleWidth), RGBA.defaultForeground(), TextAttributes.BOLD)]);
        mounted.title.visible = selected;
        mounted.status.content = new StyledText([chunk(statusGlyph(step.status) + " " + statusLabel(step.status),
          statusColor(step.status) ?? RGBA.defaultForeground(), statusAttributes(step.status))]);
        mounted.preview.content = step.lines.join("\n") + (step.expandable ? "\n" + (step.expanded ? "[e collapse]" : "[e expand retained evidence]") : "");
        mounted.preview.visible = step.lines.length > 0 || step.expandable;
      }
      botText.content = model.botLines.join("\n");
      bot.height = Math.max(6, Math.floor(renderer.terminalHeight * 0.4));
      footer.content = (model.screen === "overview" ? "↑↓ / j k select · Enter open · q quit" : "↑↓ / j k step · e expand · Esc back · q quit").slice(0, available);
      const selected = model.screen === "overview" ? model.selectedId : model.selectedStepId;
      if (selected !== selection || width !== renderer.terminalWidth) {
        revealSelection = () => {
          const row = model.rows.findIndex(entry => entry[0] === selected);
          const y = model.screen === "overview" ? (renderer.terminalWidth < 62 ? row * 4 : row + 1)
            : (steps.get(selected ?? "")?.box.y ?? content.viewport.y) - content.viewport.y + content.scrollTop;
          if (y < content.scrollTop || y >= content.scrollTop + content.viewport.height) content.scrollTo(Math.max(0, y));
        };
        selection = selected;
        width = renderer.terminalWidth;
      }
    },
  };
}

export function createViewerRefresh(input: {
  source: ViewerSource;
  state: ViewerState;
  paint: (model: ViewerModel, error?: string | null) => void;
  commit?: (snapshot: ViewerSnapshot) => void;
}): { refresh: () => Promise<void>; invalidate: () => void } {
  let generation = 0;
  let queued = false;
  let active: Promise<void> | null = null;
  let lastFrame: ViewerModel | null = null;
  const once = async () => {
    const requestGeneration = generation;
    const selection = { ...input.state, expanded: [...input.state.expanded] };
    try {
      const snapshot = await input.source.snapshot(selection.workflowId, selection.expanded);
      if (requestGeneration !== generation) return;
      const ids = snapshot.status.workflows.map(entry => entry.workflowId);
      if (!ids.includes(input.state.selectedId ?? "")) input.state.selectedId = ids[0] ?? null;
      const steps = snapshot.detail?.nodes.map(node => node.nodeId) ?? [];
      if (!steps.includes(input.state.selectedStepId ?? "")) input.state.selectedStepId = steps[0] ?? null;
      const model = buildViewerModel({ snapshot, ...input.state });
      input.commit?.(snapshot);
      input.paint(model);
      lastFrame = model;
    } catch (error) {
      if (requestGeneration !== generation) return;
      const empty: ViewerSnapshot = {
        status: { version: 2, generatedAt: new Date(0).toISOString(), installationId: "unavailable",
          service: { state: "unavailable", pid: null, bootId: null, startedAt: null, socketPath: null, error: null, bot: null }, workflows: [] },
        detail: null,
      };
      const frame = lastFrame?.header === (selection.workflowId ?? "Workflows") ? lastFrame
        : buildViewerModel({ snapshot: empty, ...selection });
      input.paint(frame, error instanceof Error ? error.message : String(error));
    }
  };
  return {
    invalidate: () => { generation++; },
    refresh: () => {
      queued = true;
      if (!active) {
        active = (async () => {
          while (queued) {
            queued = false;
            await once();
          }
        })().finally(() => { active = null; });
      }
      return active;
    },
  };
}

export async function openViewer(opts: { workflowId: string | null; source: ViewerSource; refreshMs?: number }): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const state: ViewerState = { workflowId: opts.workflowId, selectedId: opts.workflowId, selectedStepId: null, expanded: [] };
  let workflows: string[] = [];
  let steps: string[] = [];
  const mount = mountViewer(renderer);
  const refresh = createViewerRefresh({ source: opts.source, state, paint: (model, error) => mount.paint(model, error),
    commit: snapshot => { workflows = snapshot.status.workflows.map(entry => entry.workflowId); steps = snapshot.detail?.nodes.map(node => node.nodeId) ?? []; } });
  const timer = setInterval(() => void refresh.refresh(), opts.refreshMs ?? 1000);
  const shutdown = makeShutdown({ clear: () => clearInterval(timer), detach: () => {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  }, stop: () => renderer.stop(), destroy: () => renderer.destroy(), exit: code => process.exit(code) });
  function onSignal() { shutdown(); }
  renderer.keyInput.on("keypress", key => {
    if (key.name === "pagedown" || key.name === "pageup") { mount.content.scrollBy(key.name === "pagedown" ? 1 : -1, "viewport"); return; }
    const action = reduceKey(state, key, workflows, steps);
    if (action === "quit") return shutdown();
    if (action === "refresh") { refresh.invalidate(); void refresh.refresh(); }
  });
  renderer.on("resize", () => void refresh.refresh());
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  renderer.start();
  await refresh.refresh();
}

export function makeShutdown(deps: { clear: () => void; detach: () => void; stop: () => void; destroy: () => void; exit: (code: number) => void }): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    deps.clear();
    deps.detach();
    try { deps.stop(); } catch { /* The renderer may already be stopping. */ }
    deps.destroy();
    setTimeout(() => deps.exit(0), 0);
  };
}
