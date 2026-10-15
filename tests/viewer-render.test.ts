import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InputRenderable, RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createViewerRefresh, makeShutdown, mountViewer, reduceKey, type ViewerState } from "../src/tui/mount-viewer.js";
import type { ViewerSource, ViewerSnapshot } from "../src/tui/data-source.js";
import { buildNode, buildRun, buildSnapshot, WAIT } from "./build-viewer-fixture.js";

const state = (): ViewerState => ({ workflowId: null, selectedId: "alpha", selectedStepId: null, expanded: [] });

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("viewer sources use terminal defaults and ANSI palette colors, not truecolor literals", () => {
  const colorLiteral = /#[\da-f]{3,8}\b|\brgba?\s*\(|\bRGBA\.from(?:Hex|Ints|Values)\s*\(/i;
  for (const file of ["src/tui", "src/views"].flatMap(sourceFiles)) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(colorLiteral);
  }
});

function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error("Deferred promise not initialized"); };
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test("fake service updates preserve workflow selection and back navigation", async () => {
  const selection = state();
  const snapshot = buildSnapshot([buildNode()]);
  const source: ViewerSource = { snapshot: async workflowId => ({ ...snapshot, detail: workflowId ? snapshot.detail : null }) };
  const frames: string[] = [];
  const refresh = createViewerRefresh({ source, state: selection, paint: model => frames.push(model.header) });
  await refresh.refresh();
  reduceKey(selection, { name: "j" }, ["alpha", "beta"], []);
  await refresh.refresh();
  expect(selection.selectedId).toBe("beta");
  snapshot.status.workflows.reverse();
  await refresh.refresh();
  expect(selection.selectedId).toBe("beta");
  reduceKey(selection, { name: "return" }, ["beta", "alpha"], []);
  await refresh.refresh();
  expect(selection.workflowId).toBe("beta");
  for (const key of ["escape", "backspace"]) {
    reduceKey(selection, { name: key }, ["beta", "alpha"], ["first"]);
    await refresh.refresh();
    expect(selection.workflowId).toBeNull();
    expect(selection.selectedId).toBe("beta");
    reduceKey(selection, { name: "enter" }, ["beta", "alpha"], []);
  }
  expect(frames).toContain("Workflows");
  expect(frames).toContain("beta");
  expect(reduceKey(selection, { name: "q" }, [], [])).toBe("quit");
});

test("rendered detail places previews beneath boxes and dims skipped steps", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  try {
    const mount = mountViewer(setup.renderer);
    const snapshot = buildSnapshot([
      { ...buildNode(), status: "succeeded", successfulOutput: "accepted result" },
      { ...buildNode("second"), status: "waiting", wait: { ...WAIT, nodeId: "second" } },
      { ...buildNode("third"), status: "skipped" },
    ]);
    const selection = { ...state(), workflowId: "alpha" };
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[ first · Completed ]");
    expect(frame).toContain("[ second · Needs input ]");
    expect(frame).toContain("[ third · Skipped ]");
    expect(frame.indexOf("accepted result")).toBeGreaterThan(frame.indexOf("[ first"));
    expect(frame.indexOf("accepted result")).toBeLessThan(frame.indexOf("[ second"));
    expect(frame).toContain(WAIT.waitId);
    expect(frame).toContain("Approve this proposal?");
    expect(frame).toContain("↓");
    expect(frame).not.toMatch(/activation|attempt|duration|hash|pid|history/i);
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    const skipped = spans.find(span => span.text.includes("third"));
    expect(skipped?.fg.equals(RGBA.fromIndex(8))).toBe(true);
    expect((skipped?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
    const arrows = spans.filter(span => span.text.includes("↓"));
    expect(arrows.some(span => span.fg.equals(RGBA.fromIndex(8)))).toBe(true);
  } finally { setup.renderer.destroy(); }
});

test("step states use ANSI palette colors and selected steps use inverse video", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  try {
    const mount = mountViewer(setup.renderer);
    const states = [
      ["failed", "failed", "Failed", 1],
      ["blocked", "blocked", "Blocked", 3],
      ["waiting", "waiting", "Needs input", 3],
      ["running", "running", "Running", 6],
      ["succeeded", "succeeded", "Completed", 2],
    ] as const;
    const snapshot = buildSnapshot(states.map(([id, status]) => ({ ...buildNode(id), status })));
    const selection = { ...state(), workflowId: "alpha" };
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    for (const [id, , label, colorIndex] of states) {
      const span = spans.find(candidate => candidate.text.includes("[ " + id + " · " + label + " ]"));
      expect(span?.fg.equals(RGBA.fromIndex(colorIndex))).toBe(true);
    }
    const marker = spans.find(span => span.text === "▶ ");
    expect((marker?.attributes ?? 0) & TextAttributes.INVERSE).toBe(TextAttributes.INVERSE);
  } finally { setup.renderer.destroy(); }
});

test("fake streaming service preserves detail scroll, bot scroll, and focused typing", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  try {
    const mount = mountViewer(setup.renderer);
    const input = new InputRenderable(setup.renderer, { width: 20 });
    setup.renderer.root.add(input);
    input.focus();
    let tick = 0;
    const selection = { ...state(), workflowId: "alpha" };
    const source: ViewerSource = { snapshot: async () => buildSnapshot(Array.from({ length: 40 }, (_, i) => ({ ...buildNode("step-" + i), status: "running", liveStderr: "stream " + tick }))) };
    const refresh = createViewerRefresh({ source, state: selection, paint: model => mount.paint(model) });
    await refresh.refresh(); await setup.renderOnce();
    expect(mount.bot.scrollTop).toBeGreaterThan(0);
    mount.content.scrollTo(15); mount.bot.scrollTo(12);
    await setup.renderOnce();
    const scroll = mount.content.scrollTop;
    const botScroll = mount.bot.scrollTop;
    for (const character of "reply") {
      tick++;
      await setup.mockInput.typeText(character);
      await refresh.refresh(); await setup.renderOnce();
      expect(mount.content.scrollTop).toBe(scroll);
      expect(mount.bot.scrollTop).toBe(botScroll);
      expect(selection.selectedStepId).toBe("step-0");
    }
    expect(input.value).toBe("reply");
    expect(input.focused).toBe(true);
  } finally { setup.renderer.destroy(); }
});

test("expansion re-reads the selected projection and shows retained evidence beyond 40 lines", async () => {
  const setup = await createTestRenderer({ width: 100, height: 65 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = { ...state(), workflowId: "alpha" };
    const calls: Array<readonly string[] | undefined> = [];
    const source: ViewerSource = { snapshot: async (_workflow, expanded) => {
      calls.push(expanded);
      return buildSnapshot([{ ...buildNode(), status: "succeeded", successfulOutput: Array.from({ length: 45 }, (_, i) => "result " + i).join("\n") }]);
    } };
    const refresh = createViewerRefresh({ source, state: selection, paint: model => mount.paint(model) });
    await refresh.refresh(); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("e expand retained evidence");
    expect(setup.captureCharFrame()).not.toContain("result 44");
    reduceKey(selection, { name: "e" }, ["alpha"], ["first"]);
    refresh.invalidate(); await refresh.refresh(); await setup.renderOnce();
    expect(calls).toEqual([[], ["first"]]);
    expect(setup.captureCharFrame()).toContain("result 44");
    expect(setup.captureCharFrame()).toContain("e collapse");
  } finally { setup.renderer.destroy(); }
});

test("narrow terminal uses stacked overview and wraps detail previews", async () => {
  const setup = await createTestRenderer({ width: 28, height: 22 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = state();
    const source: ViewerSource = { snapshot: async () => buildSnapshot([{ ...buildNode(), status: "succeeded", successfulOutput: "long output with enough words to wrap across the narrow viewport" }]) };
    const refresh = createViewerRefresh({ source, state: selection, paint: model => mount.paint(model) });
    await refresh.refresh(); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Title: alpha");
    expect(setup.captureCharFrame()).toContain("Status: Ready");
    expect(setup.captureCharFrame()).toContain("Next run: —");
    selection.workflowId = "alpha";
    refresh.invalidate(); await refresh.refresh(); await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("long output");
    expect(frame).toContain("narrow viewport");
  } finally { setup.renderer.destroy(); }
});

test("refresh serializes polls, coalesces ticks, and discards reads for an old selection", async () => {
  const first = deferred<ViewerSnapshot>();
  const started = deferred<void>();
  const selection = state();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const painted: string[] = [];
  const source: ViewerSource = { snapshot: async workflow => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    try { if (calls === 1) { started.resolve(); return await first.promise; } return buildSnapshot([buildNode()]); }
    finally { active--; }
  } };
  const refresh = createViewerRefresh({ source, state: selection, paint: model => painted.push(model.header) });
  const old = refresh.refresh();
  await started.promise;
  selection.workflowId = "alpha";
  refresh.invalidate();
  const current = refresh.refresh(); const coalesced = refresh.refresh();
  first.resolve(buildSnapshot());
  await Promise.all([old, current, coalesced]);
  expect(calls).toBe(2); expect(maxActive).toBe(1); expect(painted).toEqual(["alpha"]);
});

test("refresh errors mark the last frame stale and recover without clearing selection", async () => {
  const selection = state();
  let poll = 0;
  const errors: Array<string | null | undefined> = [];
  const source: ViewerSource = { snapshot: async () => { if (++poll === 1 || poll === 3) throw new Error("Read failed"); return buildSnapshot(); } };
  const refresh = createViewerRefresh({ source, state: selection, paint: (_model, error) => errors.push(error) });
  for (let i = 0; i < 4; i++) await refresh.refresh();
  expect(errors).toEqual(["Read failed", undefined, "Read failed", undefined]);
  expect(selection.selectedId).toBe("alpha");
});

test("shutdown clears polling and restores the terminal exactly once", async () => {
  const calls: string[] = [];
  const shutdown = makeShutdown({ clear: () => calls.push("clear"), detach: () => calls.push("detach"), stop: () => { calls.push("stop"); throw new Error("Already stopped"); }, destroy: () => calls.push("destroy"), exit: code => calls.push("exit:" + code) });
  shutdown(); shutdown();
  await new Promise(resolve => setTimeout(resolve, 1));
  expect(calls).toEqual(["clear", "detach", "stop", "destroy", "exit:0"]);
});

test("returning from a short detail keeps a deep overview selection visible", async () => {
  const setup = await createTestRenderer({ width: 100, height: 22 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = state();
    const snapshot = buildSnapshot([buildNode()]);
    const workflow = snapshot.status.workflows[0];
    if (!workflow) throw new Error("Missing fixture workflow");
    snapshot.status.workflows = Array.from({ length: 60 }, (_, i) => ({ ...workflow, workflowId: "workflow-" + String(i).padStart(2, "0") }));
    selection.selectedId = "workflow-55";
    const source: ViewerSource = { snapshot: async workflowId => ({ ...snapshot, detail: workflowId ? snapshot.detail : null }) };
    const refresh = createViewerRefresh({ source, state: selection, paint: model => mount.paint(model) });
    await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("▶ workflow-55");
    reduceKey(selection, { name: "enter" }, [], []);
    refresh.invalidate(); await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("[ first");
    reduceKey(selection, { name: "backspace" }, [], []);
    refresh.invalidate(); await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("▶ workflow-55");
    expect(selection.selectedId).toBe("workflow-55");
  } finally { setup.renderer.destroy(); }
});

test("a new displayed run removes the old frozen chain", async () => {
  const setup = await createTestRenderer({ width: 100, height: 22 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = { ...state(), workflowId: "alpha" };
    let snapshot = buildSnapshot([buildNode("old-first"), buildNode("old-second")]);
    const refresh = createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) });
    await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("old-first");
    snapshot = buildSnapshot([buildNode("new-first")]);
    if (!snapshot.detail) throw new Error("Missing fixture detail");
    snapshot = { ...snapshot, detail: { ...snapshot.detail, diagram: { ...snapshot.detail.diagram, runId: buildRun().runId } } };
    await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("new-first");
    expect(setup.captureCharFrame()).not.toContain("old-first");
    expect(setup.captureCharFrame()).not.toContain("old-second");
  } finally { setup.renderer.destroy(); }
});
