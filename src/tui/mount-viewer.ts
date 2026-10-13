import { BoxRenderable, ScrollBoxRenderable, TextRenderable, createCliRenderer, fg, t, type CliRenderer } from "@opentui/core";
import { renderStatusTable, statusLabel } from "../views/render-status.js";
import { buildViewerModel, type ViewerModel } from "./build-panes.js";
import type { ViewerSnapshot, ViewerSource } from "./data-source.js";

const DIM = "#6e7681";
const TEXT = "#c9d1d9";
const ACCENT = "#79c0ff";
const COLORS: Record<string, string> = { skipped: DIM, pending: DIM, succeeded: "#7ee787", completed: "#7ee787",
  running: ACCENT, waiting: "#ffa657", blocked: "#ffa657", failed: "#ff7b72" };

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
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
  const header = new TextRenderable(renderer, { height: 1, content: "WORKSHOP" });
  const content = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", scrollX: false });
  const notice = new TextRenderable(renderer, { content: "" });
  const table = new TextRenderable(renderer, { content: "", wrapMode: "none" });
  const chain = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
  const bot = new ScrollBoxRenderable(renderer, { height: Math.max(2, Math.min(8, Math.floor(renderer.terminalHeight / 4))),
    width: "100%", stickyScroll: true, stickyStart: "bottom", border: true, title: "Shared bot feed" });
  const botText = new TextRenderable(renderer, { content: "" });
  bot.add(botText);
  const footer = new TextRenderable(renderer, { height: 1, content: "" });
  content.add(notice);
  content.add(table);
  content.add(chain);
  root.add(header);
  root.add(content);
  root.add(bot);
  root.add(footer);
  renderer.root.add(root);
  const steps = new Map<string, { box: BoxRenderable; title: TextRenderable; preview: TextRenderable; arrow: TextRenderable }>();
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
      header.content = ("WORKSHOP · " + model.header + (error ? " · STALE: " + error : "")).slice(0, available);
      notice.content = model.notice.join("\n");
      notice.visible = model.notice.length > 0;
      table.visible = model.screen === "overview";
      chain.visible = model.screen === "detail";
      table.content = renderStatusTable(model.rows, available, model.selectedId).join("\n");
      for (const [index, step] of model.steps.entries()) {
        let mounted = steps.get(step.id);
        if (!mounted) {
          const box = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
          const title = new TextRenderable(renderer, { content: "" });
          const preview = new TextRenderable(renderer, { content: "" });
          const arrow = new TextRenderable(renderer, { content: "" });
          box.add(title);
          box.add(preview);
          box.add(arrow);
          chain.add(box);
          mounted = { box, title, preview, arrow };
          steps.set(step.id, mounted);
        }
        const selected = step.id === model.selectedStepId;
        const label = (selected ? "▶ " : "  ") + "[ " + step.id + " · " + statusLabel(step.status) + " ]";
        mounted.title.content = t`${fg(COLORS[step.status] ?? TEXT)(label)}`;
        mounted.preview.content = step.lines.join("\n") + (step.expandable ? "\n" + (step.expanded ? "[e collapse]" : "[e expand retained evidence]") : "");
        mounted.preview.visible = step.lines.length > 0 || step.expandable;
        mounted.arrow.content = index === model.steps.length - 1 ? "" : t`${fg((step.status === "skipped" || model.steps[index + 1]?.status === "skipped") ? DIM : ACCENT)("  ↓")}`;
        mounted.arrow.visible = index !== model.steps.length - 1;
      }
      botText.content = model.botLines.join("\n");
      bot.height = Math.max(2, Math.min(8, Math.floor(renderer.terminalHeight / 4)));
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
          service: { state: "unavailable", pid: null, bootId: null, startedAt: null, socketPath: null, error: null }, workflows: [] },
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
