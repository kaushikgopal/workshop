import { BoxRenderable, RGBA, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable, createCliRenderer, type CliRenderer, type TextChunk } from "@opentui/core";
import { statusGlyph, statusLabel } from "../views/render-status.js";
import { buildViewerModel, type ViewerModel } from "./build-panes.js";
import type { ViewerChatEntry, ViewerSnapshot, ViewerSource } from "./data-source.js";

const ANSI = { red: 1, green: 2, yellow: 3, cyan: 6, brightBlack: 8 } as const;
const STATUS_COLORS: Record<string, number> = {
  skipped: ANSI.brightBlack, pending: ANSI.brightBlack, ready: ANSI.brightBlack, succeeded: ANSI.green, completed: ANSI.green,
  running: ANSI.cyan, waiting: ANSI.yellow, blocked: ANSI.yellow, failed: ANSI.red,
};
const DIM = RGBA.fromIndex(ANSI.brightBlack);
const SPLIT_WIDTH = 96;
const TABLE_MIN_WIDTH = 40;
const BOT_FEED_TITLE = "BOT FEED (all workflows)";

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
  if (width < TABLE_MIN_WIDTH) {
    rows.forEach((row, index) => {
      const selected = row[0] === selectedId;
      const rowAttributes = selected ? TextAttributes.BOLD : 0;
      const color = statusColor(row[1]) ?? RGBA.defaultForeground();
      const cellAttributes = rowAttributes | statusAttributes(row[1]);
      appendTableLine(chunks, [
        { text: selected ? "›" : " ", attributes: rowAttributes },
        { text: "Workflow:", color: DIM, attributes: rowAttributes | TextAttributes.DIM },
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

  const nextWidth = Math.min(19, width - 25, Math.max(8, ...rows.map(row => row[2].length)));
  const titleWidth = Math.max(12, Math.floor((width - nextWidth - 5) / 2));
  const statusWidth = Math.max(8, width - nextWidth - titleWidth - 5);
  const field = (value: string, fieldWidth: number) => clip(value, fieldWidth).padEnd(fieldWidth);
  const heading = TextAttributes.DIM;
  appendTableLine(chunks, [
    { text: " " },
    { text: field("Workflow", titleWidth), attributes: heading },
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

function feedLabel(entry: ViewerChatEntry): { text: string; color: RGBA } {
  if (entry.kind === "input") return { text: "INPUT", color: RGBA.fromIndex(ANSI.brightBlack) };
  if (entry.kind === "message") return { text: "BOT", color: RGBA.fromIndex(ANSI.cyan) };
  if (entry.kind === "tool_call") return { text: "TOOL", color: RGBA.fromIndex(ANSI.yellow) };
  if (entry.kind === "tool_result") return { text: "OUTPUT", color: RGBA.fromIndex(ANSI.green) };
  if (entry.kind === "error") return { text: "ERROR", color: RGBA.fromIndex(ANSI.red) };
  if (entry.role === "user") return { text: "INPUT", color: RGBA.fromIndex(ANSI.brightBlack) };
  if (entry.role === "assistant") return { text: "BOT", color: RGBA.fromIndex(ANSI.cyan) };
  return { text: "ACTIVITY", color: RGBA.fromIndex(ANSI.brightBlack) };
}

function previewToolOutput(value: string): { text: string; truncated: boolean } {
  const lines = value.split("\n");
  let text = lines.slice(0, 8).join("\n");
  let truncated = lines.length > 8;
  const characters = Array.from(text);
  if (characters.length > 1024) {
    text = characters.slice(0, 1023).join("") + "…";
    truncated = true;
  }
  return { text, truncated };
}

function renderBotFeed(entries: readonly ViewerChatEntry[], emptyMessage: string | null): StyledText {
  if (entries.length === 0) return new StyledText([chunk(emptyMessage ?? "No bot activity yet")]);
  const chunks: TextChunk[] = [];
  entries.forEach((entry, index) => {
    const label = feedLabel(entry);
    const preview = entry.kind === "tool_result" || entry.kind === "error"
      ? previewToolOutput(entry.text)
      : { text: entry.text, truncated: false };
    chunks.push(chunk(label.text + "\n", label.color, TextAttributes.BOLD), chunk(preview.text, label.color));
    if (preview.truncated) chunks.push(chunk("\n[output truncated in viewer]", label.color));
    if (index < entries.length - 1) chunks.push(chunk("\n\n"));
  });
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

export type ScrollTarget = "left" | "feed";

export interface ViewerMount {
  paint(model: ViewerModel, error?: string | null): void;
  readonly content: ScrollBoxRenderable;
  readonly bot: ScrollBoxRenderable;
  readonly scrollTarget: ScrollTarget;
  toggleScrollTarget(): void;
  scrollByPage(direction: -1 | 1): void;
}

/** Persistent pane containers retain independent scroll positions across projection updates. */
export function mountViewer(renderer: CliRenderer): ViewerMount {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", shouldFill: false });
  const header = new TextRenderable(renderer, { width: "100%", height: 1, content: "WORKSHOP", wrapMode: "none" });
  const middle = new BoxRenderable(renderer, { flexGrow: 1, width: "100%", flexDirection: "row", shouldFill: false });
  const leftPane = new BoxRenderable(renderer, { width: 1, flexGrow: 1, flexBasis: 0, flexDirection: "column", shouldFill: false });
  const rightPane = new BoxRenderable(renderer, { width: 1, flexGrow: 1, flexBasis: 0, flexDirection: "column", shouldFill: false });
  const content = new ScrollBoxRenderable(renderer, { flexGrow: 1, flexBasis: 0, width: "100%", scrollX: false,
    verticalScrollbarOptions: { visible: false } });
  content.verticalScrollBar.visible = false;
  const notice = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "word" });
  const table = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "none" });
  const chain = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
  const divider = new BoxRenderable(renderer, { width: 1, flexGrow: 0, border: ["left"], borderStyle: "single",
    borderColor: DIM, focusedBorderColor: DIM, shouldFill: false });
  const bot = new ScrollBoxRenderable(renderer, { flexGrow: 1, flexBasis: 0, width: "100%", scrollX: false, paddingX: 1, paddingY: 1,
    border: true, borderStyle: "rounded", borderColor: DIM, focusedBorderColor: DIM, shouldFill: false,
    title: " " + BOT_FEED_TITLE + " ", titleColor: DIM, verticalScrollbarOptions: { visible: false } });
  bot.verticalScrollBar.visible = false;
  const botText = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "word" });
  bot.add(botText);
  const footer = new TextRenderable(renderer, { width: "100%", height: 1, content: "", wrapMode: "none" });
  content.add(notice);
  content.add(table);
  content.add(chain);
  leftPane.add(content);
  rightPane.add(bot);
  middle.add(leftPane);
  middle.add(divider);
  middle.add(rightPane);
  root.add(header);
  root.add(middle);
  root.add(footer);
  renderer.root.add(root);
  const steps = new Map<string, { box: BoxRenderable; title: TextRenderable; status: TextRenderable; preview: TextRenderable }>();
  let screenKey = "";
  let selection: string | null = null;
  let width = renderer.terminalWidth;
  let activeScrollTarget: ScrollTarget = "left";
  let footerHint = "";
  const updateChrome = () => {
    const leftActive = activeScrollTarget === "left";
    const feedBorder = leftActive ? DIM : RGBA.defaultForeground();
    bot.borderColor = feedBorder;
    bot.focusedBorderColor = feedBorder;
    bot.titleColor = feedBorder;
    footer.content = clip(footerHint + " · scroll " + (activeScrollTarget === "left" ? "LEFT" : "FEED"), Math.max(1, renderer.terminalWidth));
  };
  let revealSelection: (() => void) | null = null;
  let stickFeedToBottom = false;
  const revealAfterLayout = () => {
    if (stickFeedToBottom) {
      bot.scrollTo(bot.scrollHeight);
      stickFeedToBottom = false;
    }
    const reveal = revealSelection;
    revealSelection = null;
    reveal?.();
  };
  renderer.addPostProcessFn(revealAfterLayout);
  renderer.once("destroy", () => renderer.removePostProcessFn(revealAfterLayout));
  return {
    content, bot,
    get scrollTarget() { return activeScrollTarget; },
    toggleScrollTarget() {
      activeScrollTarget = activeScrollTarget === "left" ? "feed" : "left";
      updateChrome();
    },
    scrollByPage(direction) { (activeScrollTarget === "left" ? content : bot).scrollBy(direction, "viewport"); },
    paint(model, error) {
      const terminalWidth = renderer.terminalWidth;
      const split = terminalWidth >= SPLIT_WIDTH;
      const key = model.screen + ":" + model.header + ":" + model.runId;
      if (key !== screenKey) {
        content.scrollTop = 0;
        selection = null;
        for (const step of steps.values()) step.box.destroyRecursively();
        steps.clear();
        screenKey = key;
      }
      middle.flexDirection = split ? "row" : "column";
      divider.visible = split;
      leftPane.flexBasis = split ? 0 : "auto";
      rightPane.flexBasis = split ? 0 : "auto";
      leftPane.width = split ? 0 : "100%";
      rightPane.width = split ? 0 : "100%";
      leftPane.flexGrow = 1;
      rightPane.flexGrow = split ? 1 : 0;
      const leftWidth = split ? Math.max(1, Math.floor((terminalWidth - 1) / 2)) : terminalWidth;
      const feedWidth = split ? terminalWidth - leftWidth - 1 : terminalWidth;
      // Native borders hide titles that exceed their four-cell title margin.
      bot.title = feedWidth >= BOT_FEED_TITLE.length + 6 ? " " + BOT_FEED_TITLE + " " : BOT_FEED_TITLE;
      if (split) {
        rightPane.height = "100%";
        bot.height = 1;
      } else {
        const botHeight = Math.max(6, Math.floor(renderer.terminalHeight * 0.4));
        rightPane.height = botHeight;
        bot.height = botHeight;
      }
      const headerParts: TextChunk[] = [chunk("WORKSHOP", RGBA.defaultForeground(), TextAttributes.BOLD)];
      if (error) headerParts.push(chunk(" • STALE: " + error, RGBA.fromIndex(ANSI.red), TextAttributes.BOLD));
      if (model.screen === "detail") headerParts.push(chunk(" • WORKFLOW [" + model.header + "]",
        RGBA.defaultForeground(), TextAttributes.BOLD));
      header.content = truncateChunks(headerParts, Math.max(1, terminalWidth));
      notice.content = model.notice.join("\n");
      notice.visible = model.notice.length > 0;
      table.visible = model.screen === "overview";
      chain.visible = model.screen === "detail";
      table.content = renderOverviewTable(model.rows, leftWidth, model.selectedId);
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
        const titleWidth = Math.max(1, Math.min(titleText.length, leftWidth - 4));
        mounted.title.width = titleWidth;
        mounted.title.content = new StyledText([chunk(clip(titleText, titleWidth), RGBA.defaultForeground(), TextAttributes.BOLD)]);
        mounted.title.visible = selected;
        mounted.status.content = new StyledText([chunk(statusGlyph(step.status) + " " + statusLabel(step.status),
          statusColor(step.status) ?? RGBA.defaultForeground(), statusAttributes(step.status))]);
        mounted.preview.content = step.lines.join("\n") + (step.expandable ? "\n" + (step.expanded ? "[e collapse]" : "[e expand retained evidence]") : "");
        mounted.preview.visible = step.lines.length > 0 || step.expandable;
      }
      stickFeedToBottom = bot.scrollTop + bot.viewport.height >= bot.scrollHeight;
      botText.content = renderBotFeed(model.botEntries, model.botEmptyMessage);
      footerHint = model.screen === "overview"
        ? "Tab pane · PgUp/Dn scroll active pane · ↑↓/j k select · Enter open · q quit"
        : "Tab pane · PgUp/Dn scroll active pane · ↑↓/j k step · e expand · Esc back · q quit";
      updateChrome();
      const selected = model.screen === "overview" ? model.selectedId : model.selectedStepId;
      if (selected !== selection || width !== terminalWidth) {
        revealSelection = () => {
          const row = model.rows.findIndex(entry => entry[0] === selected);
          const tableBase = table.y - content.viewport.y + content.scrollTop;
          const y = model.screen === "overview"
            ? tableBase + (leftWidth < TABLE_MIN_WIDTH ? 0 : 1) + row * (leftWidth < TABLE_MIN_WIDTH ? 4 : 1)
            : (steps.get(selected ?? "")?.box.y ?? content.viewport.y) - content.viewport.y + content.scrollTop;
          if (y < content.scrollTop || y >= content.scrollTop + content.viewport.height) content.scrollTo(Math.max(0, y));
        };
        selection = selected;
        width = terminalWidth;
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
    if (key.name === "tab") { mount.toggleScrollTarget(); return; }
    if (key.name === "pagedown" || key.name === "pageup") { mount.scrollByPage(key.name === "pagedown" ? 1 : -1); return; }
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
