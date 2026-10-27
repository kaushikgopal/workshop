import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InputRenderable, RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createViewerRefresh, makeShutdown, mountViewer, reduceKey, type ViewerState } from "../src/tui/mount-viewer.js";
import type { ViewerChatEntry, ViewerSource, ViewerSnapshot } from "../src/tui/data-source.js";
import { buildViewerModel } from "../src/tui/build-panes.js";
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

test("rendered detail stacks rounded step boxes with aligned status and wrapped previews", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  try {
    const mount = mountViewer(setup.renderer);
    const snapshot = buildSnapshot([
      { ...buildNode(), status: "succeeded", successfulOutput: "accepted result" },
      { ...buildNode("second"), status: "waiting", wait: { ...WAIT, nodeId: "second" } },
      { ...buildNode("third"), status: "skipped" },
    ]);
    const workflow = snapshot.status.workflows[0];
    if (workflow) workflow.latestRun = buildRun("completed");
    const selection = { ...state(), workflowId: "alpha" };
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame.split("\n")[0]?.trim()).toBe("WORKSHOP • WORKFLOW [alpha]");
    expect(frame).toContain("╭─ first ─");
    expect(frame).toContain("✓ Completed");
    expect(frame).toContain("╭─ second ─");
    expect(frame).toContain("◆ Needs input");
    expect(frame).toContain("╭─ third ─");
    expect(frame).toContain("– Skipped");
    expect(frame.indexOf("accepted result")).toBeGreaterThan(frame.indexOf("✓ Completed"));
    expect(frame.indexOf("accepted result")).toBeLessThan(frame.indexOf("╭─ second ─"));
    expect(frame).toContain(WAIT.waitId);
    expect(frame).toContain("Approve this proposal?");
    expect(frame).not.toContain("  ↓");
    expect(frame).not.toContain("▶");
    expect(frame).not.toContain("█");
    expect(frame).not.toContain("▄");
    expect(frame).not.toMatch(/activation|attempt|duration|hash|pid|history/i);
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    const selectedTitle = spans.find(span => span.text.includes("first"));
    expect((selectedTitle?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    const skipped = spans.find(span => span.text.includes("– Skipped"));
    expect(skipped?.fg.equals(RGBA.fromIndex(8))).toBe(true);
    expect((skipped?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
    expect(spans.every(span => (span.attributes & TextAttributes.INVERSE) === 0)).toBe(true);
  } finally { setup.renderer.destroy(); }
});

test("step statuses use ANSI colors and selection changes only the border and bold title", async () => {
  const setup = await createTestRenderer({ width: 100, height: 50 });
  try {
    const mount = mountViewer(setup.renderer);
    const states = [
      ["failed", "failed", "✗ Failed", 1],
      ["blocked", "blocked", "■ Blocked", 3],
      ["waiting", "waiting", "◆ Needs input", 3],
      ["running", "running", "● Running", 6],
      ["succeeded", "succeeded", "✓ Completed", 2],
    ] as const;
    const snapshot = buildSnapshot(states.map(([id, status]) => ({ ...buildNode(id), status })));
    const selection = { ...state(), workflowId: "alpha" };
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    for (const [, , label, colorIndex] of states) {
      const span = spans.find(candidate => candidate.text.includes(label));
      expect(span?.fg.equals(RGBA.fromIndex(colorIndex))).toBe(true);
    }
    const selectedTitle = spans.find(span => span.text.includes("failed"));
    expect(selectedTitle?.fg.equals(RGBA.defaultForeground())).toBe(true);
    expect((selectedTitle?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    const unselectedTitle = spans.find(span => span.text.includes("blocked"));
    expect(unselectedTitle?.fg.equals(RGBA.fromIndex(8))).toBe(true);
    expect(spans.every(span => (span.attributes & TextAttributes.INVERSE) === 0)).toBe(true);
    expect(setup.captureCharFrame()).not.toContain("▶");
  } finally { setup.renderer.destroy(); }
});

test("overview selection uses a bold one-column gutter without inverse cells", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = state();
    const snapshot = buildSnapshot();
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    expect(frame.split("\n")[0]?.trim()).toBe("WORKSHOP");
    expect(frame).toContain("›alpha");
    expect(frame).toMatch(/│\s*Workflow\s*│\s*Status\s*│\s*Next run\s*│/);
    expect(frame).toContain("○ Ready");
    expect(frame).not.toContain("▶");
    expect(spans.every(span => (span.attributes & TextAttributes.INVERSE) === 0)).toBe(true);
    const selectedRow = spans.find(span => span.text.includes("›"));
    expect((selectedRow?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
  } finally { setup.renderer.destroy(); }
});

test("overview renders a complete three-column grid at wide and narrow widths", async () => {
  for (const width of [160, 100, 96, 95, 40, 39, 28]) {
    const setup = await createTestRenderer({ width, height: 30 });
    try {
      const mount = mountViewer(setup.renderer);
      const snapshot = buildSnapshot();
      const workflow = snapshot.status.workflows[0];
      if (!workflow) throw new Error("Missing fixture workflow");
      workflow.activation = { activationId: buildRun().activationId, state: "active", admittedCount: 1,
        maxRuns: 6, activatedAt: "2026-10-10T12:00:00.000Z", nextDueAt: "2100-12-31T23:59:59.000Z",
        skippedSlots: 0, lastSkippedSlotAt: null };
      await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: state(),
        paint: model => mount.paint(model) }).refresh();
      await setup.flush();
      const rows = setup.captureCharFrame().split("\n");
      expect(rows[0]?.trim()).toBe("WORKSHOP");
      const tableRows = rows.slice(1, 8).map(line => line.slice(0, mount.content.width));
      const heading = tableRows[1] ?? "";
      const value = tableRows[3] ?? "";
      expect(heading.split("│").slice(1, -1).map(cell => cell.trim())).toEqual(["Workflow", "Status", "Next run"]);
      expect(value.split("│").slice(1, -1).map(cell => cell.trim())).toEqual(["›alpha", "○ Ready", expect.stringContaining("2")]);
      const borders = Array.from(heading).flatMap((char, index) => char === "│" ? [index] : []);
      expect(borders).toHaveLength(4);
      for (const [index, line] of tableRows.entries()) {
        expect(line.length).toBe(mount.content.width);
        expect(line.at(-1)).toBe(index % 2 === 1 ? "│" : index === 0 ? "┐" : index === 6 ? "┘" : "┤");
        for (const border of borders) expect("│┌┬┐├┼┤└┴┘").toContain(line[border]!);
      }
      expect(tableRows[0]).toStartWith("┌");
      expect(tableRows[2]).toContain("┼");
      expect(tableRows[6]).toStartWith("└");
      expect(setup.captureCharFrame()).not.toContain("Workflow:");
      expect(setup.captureCharFrame()).not.toContain("[scroll]");
    } finally { setup.renderer.destroy(); }
  }
});

test("table selection reveals a middle row in a 60-workflow list at narrow and split widths", async () => {
  for (const width of [28, 100]) {
    const setup = await createTestRenderer({ width, height: 32 });
    try {
      const mount = mountViewer(setup.renderer);
      const snapshot = buildSnapshot();
      const workflow = snapshot.status.workflows[0];
      if (!workflow) throw new Error("Missing fixture workflow");
      snapshot.status.workflows = Array.from({ length: 60 }, (_, i) => ({
        ...workflow, workflowId: "workflow-" + String(i).padStart(2, "0"),
      }));
      const selection = { ...state(), selectedId: "workflow-30" };
      await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection,
        paint: model => mount.paint(model) }).refresh();
      await setup.flush();
      expect(mount.content.scrollTop).toBeGreaterThan(0);
      expect(selection.selectedId).toBe("workflow-30");
      expect(setup.captureCharFrame()).toContain(width === 28 ? "›workflo…" : "›workflow-30");
    } finally { setup.renderer.destroy(); }
  }
});

test("table clips long cells without hiding columns or splitting Unicode graphemes", async () => {
  const setup = await createTestRenderer({ width: 240, height: 24 });
  try {
    const mount = mountViewer(setup.renderer);
    const model = buildViewerModel({ snapshot: buildSnapshot(), ...state() });
    mount.paint({ ...model, rows: [["workflow-".repeat(10), "Configuration error: " + "界🧭".repeat(30), "2100-12-31 23:59:59"]] });
    await setup.flush();
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    const error = spans.find(span => span.text.includes("Configuration error:"));
    expect(error?.text).toContain("界🧭");
    expect(error?.text).toContain("…");
    expect(error?.fg.equals(RGBA.fromIndex(1))).toBe(true);
    const text = spans.map(span => span.text).join("");
    expect(text).toContain("2100-12-31 23:59:59");
    expect(text).toContain("Next run");
    expect(text).not.toContain("�");
    expect(Array.from(text).some(char => char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff)).toBe(false);
  } finally { setup.renderer.destroy(); }
});

test("empty overview keeps its empty state and the shared feed", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 });
  try {
    const mount = mountViewer(setup.renderer);
    const snapshot = buildSnapshot();
    snapshot.status.workflows = [];
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: state(),
      paint: model => mount.paint(model) }).refresh();
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("No workflows configured");
    expect(frame).toContain("BOT FEED (all workflows)");
    expect(frame).not.toContain("┬");
  } finally { setup.renderer.destroy(); }
});

test("shared feed colors complete entries and preserves recorded provenance", async () => {
  const setup = await createTestRenderer({ width: 160, height: 55 });
  try {
    const mount = mountViewer(setup.renderer);
    const utf8Text = "界".repeat(106) + "ab";
    expect(new TextEncoder().encode(utf8Text).byteLength).toBe(320);
    const entries: ViewerChatEntry[] = [
      { id: "input", role: "user", kind: "input", text: "Terminal output: this is input text, not stdout." },
      { id: "event", role: "user", text: "Automated event wake: this remains neutral input." },
      { id: "bot", role: "assistant", kind: "message", text: "Terminal output: **Markdown** stays plain.\n" + utf8Text },
      { id: "legacy-bot", role: "assistant", text: "Legacy assistant entry." },
      { id: "call", role: "assistant", kind: "tool_call", text: "read_file" },
      { id: "output", role: "activity", kind: "tool_result", text: Array.from({ length: 9 }, (_, i) => "{\"line\":" + i + "}").join("\n") },
      { id: "error", role: "activity", kind: "error", text: Array.from({ length: 200 }, (_, i) =>
        "error line " + i).join("\n") },
      { id: "legacy-activity", role: "activity", text: "worker state updated" },
    ];
    const snapshot = { ...buildSnapshot(), botEntries: entries };
    const selection = state();
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    mount.bot.scrollTo(0);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    for (const label of ["INPUT", "BOT", "TOOL", "OUTPUT", "ERROR", "ACTIVITY"]) expect(frame).toContain(label);
    expect(frame).toContain("Terminal output: this is input text");
    expect(frame).toContain("Automated event wake: this remains neutral input.");
    expect(frame).toContain("Terminal output: **Markdown** stays plain.");
    expect(frame).toContain("界界ab");
    expect(frame).toContain("Legacy assistant entry.");
    expect(frame.split("[output truncated in viewer]").length - 1).toBe(2);
    expect(frame).toContain("error line 0");
    expect(frame).toContain("error line 7");
    expect(frame).not.toContain("error line 8");
    expect(frame).not.toContain("error line 199");
    const colors = new Map([["INPUT", 8], ["BOT", 6], ["TOOL", 3], ["OUTPUT", 2], ["ERROR", 1], ["ACTIVITY", 8]]);
    for (const [label, color] of colors) {
      const span = spans.find(candidate => candidate.text.trim() === label);
      expect(span?.fg.equals(RGBA.fromIndex(color))).toBe(true);
      expect((span?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    }
    const bodies = new Map([
      ["Terminal output: this is input text", 8],
      ["Automated event wake: this remains neutral input.", 8],
      ["Terminal output: **Markdown** stays plain.", 6],
      ["Legacy assistant entry.", 6], ["read_file", 3], ["error line 0", 1],
      ["worker state updated", 8],
    ]);
    for (const [body, color] of bodies) {
      const span = spans.find(candidate => candidate.text.includes(body));
      expect(span?.fg.equals(RGBA.fromIndex(color))).toBe(true);
      expect((span?.attributes ?? 0) & (TextAttributes.DIM | TextAttributes.BOLD)).toBe(0);
    }
    const wrapped = spans.filter(span => span.text.includes("界"));
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every(span => span.fg.equals(RGBA.fromIndex(6)))).toBe(true);
    const notices = spans.filter(span => span.text.includes("[output truncated in viewer]"));
    expect(notices.map(span => span.fg.equals(RGBA.fromIndex(2)) ? "output"
      : span.fg.equals(RGBA.fromIndex(1)) ? "error" : "wrong color")).toEqual(["output", "error"]);
  } finally { setup.renderer.destroy(); }
});

test("shared feed groups headings and bodies with padding and a blank row between entries", async () => {
  for (const width of [160, 95, 28]) {
    const setup = await createTestRenderer({ width, height: 40 });
    try {
      const mount = mountViewer(setup.renderer);
      const snapshot = { ...buildSnapshot([buildNode()]), botEntries: [
        { id: "first", role: "user" as const, kind: "input" as const, text: "first message" },
        { id: "second", role: "assistant" as const, kind: "message" as const, text: "second message" },
      ] };
      await createViewerRefresh({ source: { snapshot: async () => snapshot },
        state: { ...state(), workflowId: "alpha" }, paint: model => mount.paint(model) }).refresh();
      await setup.renderOnce();
      const rows = setup.captureCharFrame().split("\n");
      const paneRows = rows.map(line => line.slice(mount.bot.x, mount.bot.x + mount.bot.width));
      const input = paneRows.findIndex(line => line.slice(1, -1).trim() === "INPUT");
      const bot = paneRows.findIndex(line => line.slice(1, -1).trim() === "BOT");
      expect(input).toBe(mount.bot.y + 2);
      expect(paneRows[input]?.indexOf("INPUT")).toBe(2);
      expect(paneRows[input + 1]?.slice(1, -1).trim()).toBe("first message");
      expect(paneRows[input + 2]?.slice(1, -1).trim()).toBe("");
      expect(bot).toBe(input + 3);
      expect(paneRows[bot + 1]?.slice(1, -1).trim()).toBe("second message");
      expect(paneRows[bot + 1]?.indexOf("second message")).toBe(2);
      expect(paneRows[mount.bot.y + mount.bot.height - 2]?.slice(1, -1).trim()).toBe("");
      const top = paneRows[mount.bot.y];
      const bottom = paneRows[mount.bot.y + mount.bot.height - 1];
      expect(top?.startsWith("╭")).toBe(true);
      expect(top?.endsWith("╮")).toBe(true);
      expect(bottom?.startsWith("╰")).toBe(true);
      expect(bottom?.endsWith("╯")).toBe(true);
      expect(top).toContain("BOT FEED (all workflows)");
      expect(paneRows.filter(line => line.includes("all workflows"))).toHaveLength(1);
      expect(mount.bot.borderColor.equals(RGBA.fromIndex(8))).toBe(true);
      mount.toggleScrollTarget();
      await setup.renderOnce();
      expect(mount.bot.borderColor.equals(RGBA.defaultForeground())).toBe(true);
      const activeRows = setup.captureCharFrame().split("\n");
      expect(activeRows[mount.bot.y]).toContain("BOT FEED (all workflows)");
      expect(activeRows[mount.bot.y + mount.bot.height - 1]).not.toContain("[scroll]");
      const headingSpan = setup.captureSpans().lines.flatMap(line => line.spans)
        .find(span => span.text.includes("BOT FEED (all workflows)"));
      expect(headingSpan?.fg.equals(RGBA.defaultForeground())).toBe(true);
      mount.toggleScrollTarget();
      await setup.renderOnce();
      expect(mount.bot.borderColor.equals(RGBA.fromIndex(8))).toBe(true);
      expect(setup.captureCharFrame().split("\n")[mount.bot.y + mount.bot.height - 1]).not.toContain("[scroll]");
    } finally { setup.renderer.destroy(); }
  }
});

test("feed border and single-line scope title stay fixed while scrolling", async () => {
  for (const width of [160, 95, 28]) {
    const setup = await createTestRenderer({ width, height: 32 });
    try {
      const mount = mountViewer(setup.renderer);
      const snapshot = buildSnapshot();
      await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: state(),
        paint: model => mount.paint(model) }).refresh();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("bot message 99");
      const title = setup.captureCharFrame().split("\n")[mount.bot.y];
      expect(title).toContain("BOT FEED (all workflows)");
      mount.bot.scrollTo(0);
      await setup.flush();
      const rows = setup.captureCharFrame().split("\n");
      expect(rows[mount.bot.y]).toBe(title);
      expect(setup.captureCharFrame()).toContain("bot message 0");
      expect(rows[mount.bot.y + mount.bot.height - 1]?.[mount.bot.x]).toBe("╰");
    } finally { setup.renderer.destroy(); }
  }
});

test("error feed previews cap long text at 1024 characters", async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 });
  try {
    const mount = mountViewer(setup.renderer);
    const snapshot = { ...buildSnapshot(), botEntries: [{
      id: "long-error", role: "activity" as const, kind: "error" as const, text: "z ".repeat(600),
    }] };
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: state(),
      paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("ERROR");
    expect(frame).toContain("[output truncated in viewer]");
    expect(frame.match(/z/g) ?? []).toHaveLength(512);
  } finally { setup.renderer.destroy(); }
});

test("empty and stale bot feeds keep a clear status and the last committed message", async () => {
  const setup = await createTestRenderer({ width: 160, height: 24 });
  try {
    const mount = mountViewer(setup.renderer);
    let poll = 0;
    const lastGood = { ...buildSnapshot(), botEntries: [{ id: "bot", role: "assistant" as const, kind: "message" as const, text: "last committed bot reply" }] };
    const source: ViewerSource = { snapshot: async () => {
      poll++;
      if (poll === 2) throw new Error("Temporary service read failure");
      return poll === 3 ? { ...lastGood, botEntries: [], botConfigured: false } : lastGood;
    } };
    const refresh = createViewerRefresh({ source, state: state(), paint: (model, error) => mount.paint(model, error) });
    await refresh.refresh(); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("last committed bot reply");
    await refresh.refresh(); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("STALE: Temporary service read failure");
    expect(setup.captureCharFrame()).toContain("last committed bot reply");
    await refresh.refresh(); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Bot not configured");
  } finally { setup.renderer.destroy(); }
});

test("narrow detail keeps stale-read warnings visible and restores the clean heading after recovery", async () => {
  const setup = await createTestRenderer({ width: 28, height: 32 });
  try {
    const mount = mountViewer(setup.renderer);
    let poll = 0;
    const snapshot = { ...buildSnapshot([buildNode()]), botEntries: [{
      id: "reply", role: "assistant" as const, kind: "message" as const, text: "last committed reply",
    }] };
    const source: ViewerSource = { snapshot: async () => {
      if (++poll === 2) throw new Error("Service read failed");
      return snapshot;
    } };
    const refresh = createViewerRefresh({ source, state: { ...state(), workflowId: "alpha" },
      paint: (model, error) => mount.paint(model, error) });
    await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame().split("\n")[0]?.trim()).toBe("WORKSHOP • WORKFLOW [alpha]");
    await refresh.refresh(); await setup.flush();
    const stale = setup.captureCharFrame();
    expect(stale.split("\n")[0]).toContain("WORKSHOP • STALE:");
    expect(stale).toContain("last committed reply");
    const warning = setup.captureSpans().lines[0]?.spans.find(span => span.text.includes("STALE:"));
    expect(warning?.fg.equals(RGBA.fromIndex(1))).toBe(true);
    await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame().split("\n")[0]?.trim()).toBe("WORKSHOP • WORKFLOW [alpha]");
  } finally { setup.renderer.destroy(); }
});

test("detail and feed stay in equal vertical panes above 95 columns and stack below", async () => {
  for (const width of [160, 100, 96, 95, 50, 28]) {
    const setup = await createTestRenderer({ width, height: 30 });
    try {
      const mount = mountViewer(setup.renderer);
      const snapshot = buildSnapshot([
        { ...buildNode("succeeded"), status: "succeeded", successfulOutput: "The rain came off the mountain before dawn." },
        { ...buildNode("running"), status: "running", liveStderr: "waiting for the next signal" },
        { ...buildNode("pending"), status: "pending" },
      ]);
      const workflow = snapshot.status.workflows[0];
      if (workflow) workflow.latestRun = buildRun("completed");
      const selection = { ...state(), workflowId: "alpha", selectedStepId: "succeeded" };
      await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      const frameLines = frame.split("\n");
      expect(frameLines[0]?.length).toBe(width);
      expect(frameLines.at(-2)?.length).toBe(width);
      expect(frame).toContain("╭─ succeeded ─");
      expect(frame).toContain("● Running");
      expect(frame).toContain("○ Pending");
      expect(frame).toContain("BOT FEED (all workflows)");
      expect(frame).not.toContain("  ↓");
      expect(frame).not.toContain("█");
      expect(frame).not.toContain("▄");
      expect(mount.content.verticalScrollBar.visible).toBe(false);
      expect(mount.bot.verticalScrollBar.visible).toBe(false);
      if (width >= 96) {
        expect(Math.abs(mount.content.width - mount.bot.width)).toBeLessThanOrEqual(1);
        expect(mount.bot.height).toBe(mount.content.height);
        expect(mount.bot.y).toBe(mount.content.y);
        expect(mount.bot.y + mount.bot.height).toBe(mount.content.y + mount.content.height);
        expect(mount.bot.x - (mount.content.x + mount.content.width)).toBe(1);
        const gapX = mount.content.width;
        expect(frame.split("\n").slice(1, -2).every(line => line[gapX] === " ")).toBe(true);
      } else {
        expect(mount.bot.width).toBe(mount.content.width);
        expect(mount.bot.y).toBeGreaterThanOrEqual(mount.content.y + mount.content.height);
      }
    } finally { setup.renderer.destroy(); }
  }
});

test("overview and detail separate their panes with blank space, not a vertical line", async () => {
  for (const workflowId of [null, "alpha"]) {
    const setup = await createTestRenderer({ width: 160, height: 30 });
    try {
      const mount = mountViewer(setup.renderer);
      await createViewerRefresh({ source: { snapshot: async () => buildSnapshot([buildNode()]) },
        state: { ...state(), workflowId }, paint: model => mount.paint(model) }).refresh();
      await setup.flush();
      const gapX = mount.content.x + mount.content.width;
      expect(mount.bot.x).toBe(gapX + 1);
      const middleRows = setup.captureCharFrame().split("\n").slice(1, -2);
      expect(middleRows.every(line => line[gapX] === " ")).toBe(true);
    } finally { setup.renderer.destroy(); }
  }
});

test("bot feed grows with terminal height and selection has no inverse marker", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = { ...state(), workflowId: "alpha" };
    let model: ReturnType<typeof import("../src/tui/build-panes.js").buildViewerModel> | null = null;
    const snapshot = buildSnapshot([{ ...buildNode(), status: "succeeded", successfulOutput: "accepted result" }]);
    const refresh = createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection,
      paint: next => { model = next; mount.paint(next); } });
    await refresh.refresh();
    await setup.renderOnce();
    const initialFeedHeight = mount.bot.height;
    expect(initialFeedHeight).toBeGreaterThan(10);
    setup.resize(100, 60);
    if (!model) throw new Error("Viewer model was not painted");
    mount.paint(model);
    await setup.renderOnce();
    expect(mount.bot.height).toBeGreaterThan(initialFeedHeight);
    const spans = setup.captureSpans().lines.flatMap(line => line.spans);
    expect(spans.every(span => (span.attributes & TextAttributes.INVERSE) === 0)).toBe(true);
    expect(setup.captureCharFrame()).not.toContain("▶");
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
    await setup.mockMouse.scroll(10, 5, "down"); await setup.renderOnce();
    expect(mount.content.scrollTop).toBeGreaterThan(0);
    const feedBottom = mount.bot.scrollTop;
    await setup.mockMouse.scroll(80, 20, "up"); await setup.renderOnce();
    expect(mount.bot.scrollTop).toBeLessThan(feedBottom);
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

test("resize keeps selected workflow visible while the viewer switches pane layout", async () => {
  const setup = await createTestRenderer({ width: 160, height: 32 });
  try {
    const mount = mountViewer(setup.renderer);
    const snapshot = buildSnapshot([buildNode()]);
    const workflow = snapshot.status.workflows[0];
    if (!workflow) throw new Error("Missing fixture workflow");
    snapshot.status.workflows = Array.from({ length: 60 }, (_, i) => ({ ...workflow, workflowId: "workflow-" + String(i).padStart(2, "0") }));
    const selection = { ...state(), selectedId: "workflow-55" };
    let model: ReturnType<typeof import("../src/tui/build-panes.js").buildViewerModel> | null = null;
    const refresh = createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: next => { model = next; mount.paint(next); } });
    await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("›workflow-55");
    expect(mount.content.scrollTop).toBeGreaterThan(0);
    setup.resize(95, 32);
    if (!model) throw new Error("Viewer model was not painted");
    mount.paint(model); await setup.flush();
    expect(mount.bot.width).toBe(mount.content.width);
    expect(setup.captureCharFrame()).toContain("›workflow-55");
    setup.resize(96, 32);
    mount.paint(model); await setup.flush();
    expect(mount.bot.x).toBeGreaterThan(mount.content.x + mount.content.width);
    expect(setup.captureCharFrame()).toContain("›workflow-55");
    expect(selection.selectedId).toBe("workflow-55");
  } finally { setup.renderer.destroy(); }
});

test("Tab changes the page-scroll target without changing workflow selection", async () => {
  const setup = await createTestRenderer({ width: 160, height: 24 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = { ...state(), workflowId: "alpha" };
    const snapshot = buildSnapshot(Array.from({ length: 20 }, (_, i) => ({ ...buildNode("step-" + i), status: "running", liveStderr: "line\n".repeat(5) })));
    await createViewerRefresh({ source: { snapshot: async () => snapshot }, state: selection, paint: model => mount.paint(model) }).refresh();
    await setup.renderOnce();
    expect(mount.scrollTarget).toBe("left");
    const leftBefore = mount.content.scrollTop;
    mount.scrollByPage(1);
    expect(mount.content.scrollTop).toBeGreaterThan(leftBefore);
    mount.toggleScrollTarget();
    expect(mount.scrollTarget).toBe("feed");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("scroll FEED");
    const feedBefore = mount.bot.scrollTop;
    mount.scrollByPage(-1);
    expect(mount.bot.scrollTop).toBeLessThan(feedBefore);
    expect(selection.workflowId).toBe("alpha");
  } finally { setup.renderer.destroy(); }
});

test("expansion re-reads the selected projection and shows retained evidence beyond 40 lines", async () => {
  const setup = await createTestRenderer({ width: 100, height: 90 });
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
    expect(setup.captureCharFrame()).not.toContain("result 44");
    mount.content.scrollTo(1000); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("e expand retained evidence");
    reduceKey(selection, { name: "e" }, ["alpha"], ["first"]);
    refresh.invalidate(); await refresh.refresh();
    mount.content.scrollTo(1000); await setup.renderOnce();
    expect(calls).toEqual([[], ["first"]]);
    expect(setup.captureCharFrame()).toContain("result 44");
    expect(setup.captureCharFrame()).toContain("e collapse");
  } finally { setup.renderer.destroy(); }
});

test("narrow terminal keeps the overview grid and wraps detail previews", async () => {
  const setup = await createTestRenderer({ width: 28, height: 22 });
  try {
    const mount = mountViewer(setup.renderer);
    const selection = state();
    const source: ViewerSource = { snapshot: async () => buildSnapshot([{ ...buildNode(), status: "succeeded", successfulOutput: "long output with enough words to wrap across the narrow viewport" }]) };
    const refresh = createViewerRefresh({ source, state: selection, paint: model => mount.paint(model) });
    await refresh.refresh(); await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("│ Workflow│Status │Next run│");
    expect(setup.captureCharFrame()).toContain("│›alpha   │○ Ready│—       │");
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
    expect(setup.captureCharFrame()).toContain("›workflow-55");
    reduceKey(selection, { name: "enter" }, [], []);
    refresh.invalidate(); await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("╭─ first ─");
    reduceKey(selection, { name: "backspace" }, [], []);
    refresh.invalidate(); await refresh.refresh(); await setup.flush();
    expect(setup.captureCharFrame()).toContain("›workflow-55");
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
