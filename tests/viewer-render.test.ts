import { describe, test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { makeShutdown, mountViewer, reduceKey, type ViewerState } from "../src/tui-app.js";
import { buildViewerModel, pickerModel } from "../src/tui-panes.js";
import type { StatusDto } from "../src/status/dto.js";
import { buildRunsFeed, type RunsFeed } from "../src/status/runs-feed.js";

/**
 * The binding, asserted against a real render.
 *
 * These drive the same `mountViewer` the app uses and read the captured frame,
 * so a layout regression fails here rather than in someone's terminal. A test
 * that rebuilt the tree itself would prove nothing about the binding.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");

const dto: StatusDto = {
  version: 1,
  workflows: [
    {
      id: "wf",
      definitionHash: "sha256:x",
      activation: { state: "active", startedAt: "2026-09-24T09:00:00.000Z", startedRuns: 3, maxRuns: 6, nextRunAt: null },
      currentRun: {
        id: "wf-20260924-003",
        status: "running",
        desiredState: "running",
        orchestratorPhase: "idle",
        startedAt: "2026-09-24T11:59:00.000Z",
        blocker: null,
        nodes: [
          {
            id: "node-timestamp",
            status: "completed",
            attempts: [{ number: 1, status: "completed", progress: null, validator: "passed", failure: null, blocker: null, startedAt: "2026-09-24T11:59:00.000Z", finishedAt: "2026-09-24T11:59:00.200Z" }],
          },
          {
            id: "node-generate-line",
            status: "running",
            attempts: [
              { number: 1, status: "failed", progress: null, validator: null, failure: "worklog_integrity", blocker: null, startedAt: "2026-09-24T11:59:00.000Z", finishedAt: "2026-09-24T11:59:00.500Z" },
              { number: 2, status: "running", progress: "drafting a line", validator: null, failure: null, blocker: null, startedAt: "2026-09-24T11:59:01.000Z", finishedAt: null },
            ],
          },
          { id: "node-append-quote", status: "pending", attempts: [] },
        ],
      },
    },
  ],
};

const feed: RunsFeed = {
  version: 1,
  workflowId: "wf",
  total: 3,
  runs: [
    { id: "wf-20260924-003", status: "running", desiredState: "running", startedAt: "2026-09-24T11:59:00.000Z", finishedAt: null, blocker: null, nodes: dto.workflows[0]!.currentRun!.nodes },
    {
      id: "wf-20260924-002",
      status: "failed",
      desiredState: "running",
      startedAt: "2026-09-24T11:00:00.000Z",
      finishedAt: "2026-09-24T11:02:00.000Z",
      blocker: "orchestrator_unresolved",
      nodes: [
        { id: "node-timestamp", status: "completed", attempts: [{ number: 1, status: "completed", progress: null, validator: "passed", failure: null, blocker: null, startedAt: "2026-09-24T11:00:00.000Z", finishedAt: "2026-09-24T11:00:00.100Z" }] },
        { id: "node-generate-line", status: "failed", attempts: [{ number: 1, status: "failed", progress: null, validator: "failed", failure: "validator_rejection", blocker: null, startedAt: "2026-09-24T11:00:01.000Z", finishedAt: "2026-09-24T11:00:30.000Z" }] },
      ],
    },
    { id: "wf-20260924-001", status: "completed", desiredState: "running", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:01:00.000Z", blocker: null, nodes: [] },
  ],
};

const model = buildViewerModel({
  workflowId: "wf",
  dto,
  feed,
  logText: "# Workflow run: wf\n\n## Goal\n\nGenerate one original line.\n",
  selectedRunId: "wf-20260924-003",
  streamHeight: 6,
  now: NOW,
});

describe("viewer frame — what an operator actually sees", () => {
  test("header, chain, runs, log, and keybindings all reach the screen", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    mountViewer(renderer, { rows: 6 }).paint(model);
    await renderOnce();
    const frame = captureCharFrame();

    // Header: a badged product name, the workflow, activation progress, tally.
    expect(frame).toContain("WORKSHOP");
    expect(frame).toContain("wf  active 3/6");
    expect(frame).toContain("◉1 · ◎1 · ○1");

    // Chain: spine, glyphs, the retry count, a finished duration, live detail.
    expect(frame).toContain("chain · 003 · running");
    expect(frame).toContain("├─ ◉ node-timestamp  200ms");
    expect(frame).toContain("├─ ◎ node-generate-line #2 — drafting a line");

    // Runs: the selected occurrence is marked, and ages read as a timeline.
    expect(frame).toContain("runs · 3");
    expect(frame).toContain("▶ ◎ 003");
    expect(frame).toContain("(orchestrator_unresolved)");

    // Log: titled with the run it follows, tail-first.
    expect(frame).toContain("log · 003");
    expect(frame).toContain("Generate one original line.");

    // Footer: what the keys do.
    expect(frame).toContain("q quit");
    expect(frame).toContain("f follow");
  });

  test("the feed sits above the detail panes, in reading order", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    mountViewer(renderer, { rows: 6, runsRows: 6 }).paint(model);
    await renderOnce();
    const rows = captureCharFrame().split("\n");
    const runsTitle = rows.findIndex((row) => row.includes("runs · 3"));
    const chainTitle = rows.findIndex((row) => row.includes("chain · "));
    const logTitle = rows.findIndex((row) => row.includes("log · "));
    const header = rows.findIndex((row) => row.includes("WORKSHOP"));
    const footer = rows.findIndex((row) => row.includes("q quit"));
    expect(header).toBeLessThan(runsTitle);
    expect(runsTitle).toBeLessThan(chainTitle);
    expect(chainTitle).toBe(logTitle); // side by side, below the feed
    expect(Math.max(chainTitle, logTitle)).toBeLessThan(footer);
  });

  test("a poll failure is reported in the header rather than blanking the panes", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    const mount = mountViewer(renderer, { rows: 6 });
    mount.paint(model, { pollError: "database is locked" });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("poll failed: database is locked");
    // The last good frame is still on screen: a viewer that blanks on a hiccup
    // is worse than one that shows slightly stale truth.
    expect(frame).toContain("node-timestamp");
  });

  test("collated mode says so in the log title and the footer", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    const collated = buildViewerModel({ workflowId: "wf", dto, feed, logText: "all runs", collated: true, now: NOW });
    mountViewer(renderer, { rows: 6 }).paint(collated, { collated: true });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("log · all runs");
    expect(frame).toContain("all runs  ·");
  });

  test("a narrow terminal degrades without losing the panes", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 56, height: 20 });
    mountViewer(renderer, { rows: 4 }).paint(model);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("WORKSHOP");
    expect(frame).toContain("runs · 3");
    // Chrome stays one row per element: a wrapping footer would eat the panes.
    // (The hints themselves may be clipped at this width, so assert on the
    // row count rather than on any particular hint surviving.)
    const footerRows = frame.split("\n").filter((row) => row.includes("↑↓ select run"));
    expect(footerRows.length).toBe(1);
  });

  test("one long log line cannot push the layout around", async () => {
    const long = `## Run outcome\n${"x".repeat(400)}\nshort tail line`;
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 90, height: 20 });
    const wide = buildViewerModel({ workflowId: "wf", dto, feed, logText: long, now: NOW });
    mountViewer(renderer, { rows: 4 }).paint(wide);
    await renderOnce();
    const frame = captureCharFrame();
    // Panes keep their positions: a wrapped log line would displace the runs
    // pane downwards and take the rows with it.
    expect(frame).toContain("chain · ");
    expect(frame).toContain("runs · 3");
    expect(frame).toContain("short tail line");
    for (const row of frame.split("\n")) expect(row.length).toBeLessThanOrEqual(90);
  });
});

describe("viewer keys — pure state transitions", () => {
  const ids = ["wf-003", "wf-002", "wf-001"]; // newest first, as the feed sorts
  const fresh = (): ViewerState => ({ selectedRunId: "wf-003", follow: true, collated: false });

  test("j walks back through occurrences and stops at the oldest", () => {
    const state = fresh();
    reduceKey(state, { name: "j" }, ids);
    expect(state.selectedRunId).toBe("wf-002");
    expect(state.follow).toBe(false); // manual navigation takes over from follow
    reduceKey(state, { name: "j" }, ids);
    reduceKey(state, { name: "j" }, ids);
    expect(state.selectedRunId).toBe("wf-001");
    reduceKey(state, { name: "down" }, ids);
    expect(state.selectedRunId).toBe("wf-001");
  });

  test("k walks forward and stops at the newest", () => {
    const state: ViewerState = { selectedRunId: "wf-002", follow: false, collated: false };
    reduceKey(state, { name: "k" }, ids);
    expect(state.selectedRunId).toBe("wf-003");
    reduceKey(state, { name: "up" }, ids);
    expect(state.selectedRunId).toBe("wf-003");
  });

  test("f re-enables follow and snaps to the newest occurrence", () => {
    const state: ViewerState = { selectedRunId: "wf-001", follow: false, collated: false };
    reduceKey(state, { name: "f" }, ids);
    expect(state.follow).toBe(true);
    expect(state.selectedRunId).toBe("wf-003");
  });

  test("a toggles the collated stream and leaves the selection alone", () => {
    const state = fresh();
    reduceKey(state, { name: "a" }, ids);
    expect(state.collated).toBe(true);
    expect(state.selectedRunId).toBe("wf-003");
    reduceKey(state, { name: "a" }, ids);
    expect(state.collated).toBe(false);
  });

  test("q and ctrl+c quit; r asks for a repaint; other keys are inert", () => {
    const state = fresh();
    expect(reduceKey(state, { name: "q" }, ids)).toBe("quit");
    expect(reduceKey(state, { name: "c", ctrl: true }, ids)).toBe("quit");
    expect(reduceKey(state, { name: "r" }, ids)).toBe("refresh");
    expect(reduceKey(state, { name: "z" }, ids)).toBeNull();
    expect(state.selectedRunId).toBe("wf-003");
  });
});

describe("viewer frame — picker and a scrolled feed", () => {
  const run = (over: { run_id: string; seq: number; status?: string }) => ({
    run_id: over.run_id,
    workflow_id: "wf",
    seq: over.seq,
    status: over.status ?? "completed",
    desired_state: "running",
    started_at: "2026-09-24T11:00:00.000Z",
    finished_at: "2026-09-24T11:01:00.000Z",
    block_kind: null,
  }) as never;

  test("no workflow given: the picker lists what is configured", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 22 });
    const dto2: StatusDto = {
      version: 1,
      workflows: [
        { id: "hemingway-clock", definitionHash: "x", activation: { state: "exhausted", startedAt: "2026-09-24T09:00:00.000Z", startedRuns: 6, maxRuns: 6, nextRunAt: null }, currentRun: null },
        { id: "nightly-report", definitionHash: "y", activation: null, currentRun: null },
      ],
    };
    mountViewer(renderer, { rows: 6 }).paint(pickerModel({ dto: dto2, cursor: 1 }), { picking: true });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("pick a workflow");
    expect(frame).toContain("hemingway-clock  exhausted 6/6");
    expect(frame).toContain("▶ nightly-report  one-shot");
    expect(frame).toContain("enter  open this workflow");
    // The footer advertises the picker's keys, not the viewer's run controls.
    expect(frame).toContain("↑↓ choose · enter open · q quit");
    expect(frame).not.toContain("a all runs");
  });

  test("with more runs than rows, the feed scrolls to keep the selection visible", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      run({ run_id: `wfy-${String(i + 1).padStart(3, "0")}`, seq: i + 1, status: i % 2 === 0 ? "failed" : "completed" }),
    );
    const long = buildRunsFeed({ workflowId: "wf", runs: many, nodes: () => [] });
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    mountViewer(renderer, { rows: 4, runsRows: 5 }).paint(
      buildViewerModel({ workflowId: "wf", dto, feed: long, logText: null, selectedRunId: "wfy-007", now: NOW, runsHeight: 5 }),
    );
    await renderOnce();
    const frame = captureCharFrame();
    // The selected occurrence is on screen even though it is deep in the feed.
    const selectedRow = frame.split("\n").find((row) => row.includes("▶"));
    expect(selectedRow).toBeDefined();
    expect(selectedRow).toContain("007");
    // And the title says which slice is shown, so the viewport is never a mystery.
    expect(frame).toMatch(/runs · 20 · \d+–\d+\/20/);
  });
});

describe("viewer shutdown — quitting must actually quit", () => {
  const spy = () => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        clear: () => calls.push("clear"),
        detach: () => calls.push("detach"),
        stop: () => calls.push("stop"),
        destroy: () => calls.push("destroy"),
        exit: (code: number) => calls.push(`exit:${code}`),
      },
    };
  };

  test("q takes down the poll loop, the renderer, and the process", async () => {
    const { calls, deps } = spy();
    makeShutdown(deps)();
    // The exit waits a tick so the terminal-restoring writes land first.
    expect(calls).toEqual(["clear", "detach", "stop", "destroy"]);
    await new Promise((r) => setTimeout(r, 1));
    expect(calls).toEqual(["clear", "detach", "stop", "destroy", "exit:0"]);
  });

  test("quitting twice does not exit twice mid-restore", async () => {
    const { calls, deps } = spy();
    const shutdown = makeShutdown(deps);
    shutdown();
    shutdown();
    await new Promise((r) => setTimeout(r, 1));
    expect(calls.filter((c) => c.startsWith("exit:"))).toEqual(["exit:0"]);
    expect(calls.filter((c) => c === "destroy")).toEqual(["destroy"]);
  });

  test("a renderer that is already stopping does not block the exit", async () => {
    const { calls, deps } = spy();
    makeShutdown({ ...deps, stop: () => { throw new Error("already stopped"); } })();
    await new Promise((r) => setTimeout(r, 1));
    expect(calls).toContain("destroy");
    expect(calls).toContain("exit:0");
  });
});
