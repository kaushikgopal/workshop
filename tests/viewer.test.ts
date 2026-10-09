import { describe, test, expect } from "bun:test";
import { buildViewerModel, failureLabel, nodeLines, pickerModel, windowRuns } from "../src/tui/build-panes.js";
import type { NodeStatusDto, RunsFeed, RunsFeedEntry, StatusDto } from "../src/tui/data-source.js";
import { glyph } from "../src/views/format-for-terminal.js";

/**
 * The viewer contract: the panes built from the status and runs-feed shapes.
 *
 * The panes are pure functions over the CLI's own surfaces, so the layout can
 * be asserted byte for byte here — no TTY, no terminal library, and nothing
 * reaching around the contract into SQLite or a run directory.
 */
const NOW = new Date("2026-09-24T12:00:00.000Z");

const run = (over: Partial<RunsFeedEntry> & { id: string }): RunsFeedEntry => ({
  status: "completed",
  desiredState: "running",
  startedAt: "2026-09-24T10:00:00.000Z",
  finishedAt: "2026-09-24T10:01:00.000Z",
  blocker: null,
  nodes: [],
  ...over,
});

/** A feed holds its runs newest first, as the watch adapter delivers them. */
const feedOf = (runs: RunsFeedEntry[]): RunsFeed => ({ version: 1, workflowId: "wf", total: runs.length, runs });

const attempt = (over: Partial<NodeStatusDto["attempts"][number]> & { number: number }) => ({
  status: "completed",
  progress: null,
  validator: null,
  failure: null,
  blocker: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  finishedAt: "2026-09-24T10:00:01.000Z",
  ...over,
});

const CHAIN: NodeStatusDto[] = [
  { id: "node-a", status: "completed", attempts: [attempt({ number: 1, validator: "passed" })] },
  {
    id: "node-b",
    status: "running",
    attempts: [
      attempt({ number: 1, status: "failed", failure: "timeout", finishedAt: "2026-09-24T10:00:02.000Z" }),
      attempt({ number: 2, status: "running", progress: "generating line", startedAt: "2026-09-24T10:00:02.000Z", finishedAt: null }),
    ],
  },
];

const dto = (over: Partial<StatusDto["workflows"][number]> = {}): StatusDto => ({
  version: 1,
  workflows: [
    {
      id: "wf",
      definitionHash: "sha256:x",
      activation: { state: "active", startedAt: "2026-09-24T09:00:00.000Z", startedRuns: 2, maxRuns: 6, nextRunAt: null },
      currentRun: {
        id: "wf-002",
        status: "running",
        desiredState: "running",
        orchestratorPhase: "idle",
        startedAt: "2026-09-24T10:00:00.000Z",
        blocker: null,
        nodes: CHAIN,
      },
      ...over,
    },
  ],
});

/** Two occurrences; the newest is the live one whose chain is CHAIN. */
const feed = feedOf([run({ id: "wf-002", status: "running", finishedAt: null, nodes: CHAIN }), run({ id: "wf-001" })]);

const model = (over: Partial<Parameters<typeof buildViewerModel>[0]> = {}) =>
  buildViewerModel({ workflowId: "wf", dto: dto(), feed, logText: null, now: NOW, ...over });

describe("viewer panes — pure layout over the CLI surfaces", () => {
  test("a paused occurrence has its own glyph, distinct from pending work", () => {
    expect(glyph("paused")).toBe("‖");
  });

  test("the header names the workflow, its activation, and the run on screen", () => {
    expect(model().header).toBe("wf  active 2/6  002 running");
  });

  test("a run-level blocker is surfaced in the header", () => {
    const blocked = feedOf([run({ id: "wf-009", status: "blocked", finishedAt: null, blocker: "orchestrator_unresolved" })]);
    expect(model({ feed: blocked }).header).toBe("wf  active 2/6  009 blocked · orchestrator_unresolved");
  });

  test("the chain comes from the run on screen, with retry count and durations", () => {
    const m = model();
    expect(m.nodes.title).toBe("chain · 002 · running");
    // A passed validator is not repeated: the glyph and duration already say it.
    expect(m.nodes.lines).toEqual([
      "├─ ◉ node-a  1.0s",
      "└─ ◎ node-b #2 — generating line",
    ]);
    expect(m.tally).toBe("◉1 · ◎1");
  });

  test("a terminal run still renders its chain, which is the point of inspecting it", () => {
    // Same code path as the live run: the feed carries chains for finished runs.
    const failed = feedOf([
      run({ id: "wf-002", status: "running", finishedAt: null }),
      run({ id: "wf-001", status: "failed", blocker: "orchestrator_unresolved", nodes: CHAIN }),
    ]);
    const m = model({ feed: failed, selectedRunId: "wf-001" });
    expect(m.nodes.title).toBe("chain · 001 · failed");
    expect(m.nodes.lines[0]).toContain("node-a");
    expect(m.runs.lines[1]!.startsWith("▶")).toBe(true); // the selection is marked
  });

  test("the runs viewport keeps the selection on screen and says what it is showing", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      run({ id: `wf-${String(i + 1).padStart(3, "0")}`, status: i % 3 === 0 ? "failed" : "completed" }),
    );
    const long = feedOf(many.reverse());
    // Newest first: wf-030 is at index 0. Select the 20th row down.
    const m = model({ feed: long, selectedRunId: "wf-011", runsHeight: 6 });
    expect(m.runs.lines.length).toBe(6);
    // The selected row is inside the window, and the title reports the slice.
    expect(m.runs.lines.some((l) => l.startsWith("▶"))).toBe(true);
    expect(m.runs.lines.find((l) => l.startsWith("▶"))).toContain("011");
    expect(m.runs.title).toMatch(/runs · 30 · \d+–\d+\/30/);
  });

  test("a short feed is not windowed and claims no slice", () => {
    expect(model().runs.title).toBe("runs · 2");
    expect(model().runs.lines.length).toBe(2);
  });

  test("windowRuns centres the selection and clamps at both ends", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `row${i}`);
    expect(windowRuns(rows, 0, 4)).toEqual({ rows: ["row0", "row1", "row2", "row3"], from: 0, to: 4 });
    expect(windowRuns(rows, 9, 4)).toEqual({ rows: ["row6", "row7", "row8", "row9"], from: 6, to: 10 });
    expect(windowRuns(rows, 5, 3)).toEqual({ rows: ["row4", "row5", "row6"], from: 4, to: 7 });
    expect(windowRuns(rows, 3, 0)).toEqual({ rows: [], from: 0, to: 0 });
  });

  test("the stream follows the selection and keeps the newest lines", () => {
    const m = model({ logText: ["oldest", "middle", "newest"].join("\n"), selectedRunId: "wf-001", streamHeight: 2 });
    expect(m.selectedRunId).toBe("wf-001");
    expect(m.stream.title).toBe("log · 001");
    expect(m.stream.lines).toEqual(["middle", "newest"]);
  });

  test("an empty installation renders honest placeholders, not blanks", () => {
    const empty = buildViewerModel({
      workflowId: "wf",
      dto: { version: 1, workflows: [] },
      feed: null,
      logText: null,
      now: NOW,
    });
    expect(empty.header).toBe("wf  unknown workflow");
    expect(empty.tally).toBe("");
    expect(empty.runs.lines).toEqual(["(no runs yet)"]);
    expect(empty.stream.lines).toEqual(["(no log yet)"]);
    expect(empty.selectedRunId).toBeNull();
  });

  test("a workflow with no runs says so rather than showing an empty chain", () => {
    const m = model({ feed: feedOf([]) });
    expect(m.nodes.lines).toEqual(["(no runs yet)"]);
    expect(m.runs.lines).toEqual(["(no runs yet)"]);
  });

  test("a one-shot workflow with no activation says so instead of showing 0/0", () => {
    expect(model({ dto: dto({ activation: null }) }).header).toBe("wf  one-shot  002 running");
  });
});

describe("chain rows survive a narrow pane", () => {
  test("a detail is dropped before an id is ever cut", () => {
    const nodes: NodeStatusDto[] = [
      { id: "node-generate-line", status: "failed", attempts: [attempt({ number: 1, status: "failed", failure: "validator_rejection", finishedAt: "2026-09-24T10:00:31.000Z" })] },
    ];
    // Roomy: the failure is named.
    expect(nodeLines(nodes, 60)[0]).toBe("└─ ✗ node-generate-line  31.0s — rejected");
    // Tight: the id survives whole, the detail goes.
    expect(nodeLines(nodes, 32)[0]).toBe("└─ ✗ node-generate-line  31.0s");
    expect(nodeLines(nodes, 32)[0]).toContain("node-generate-line");
    // Unknown kinds still render as themselves rather than blank.
    expect(failureLabel("something_new")).toBe("something_new");
  });
});

describe("workflow picker — choosing before watching", () => {
  const twoWorkflows: StatusDto = {
    version: 1,
    workflows: [
      { id: "hemingway-clock", definitionHash: "x", activation: { state: "active", startedAt: "2026-09-24T09:00:00.000Z", startedRuns: 3, maxRuns: 6, nextRunAt: null }, currentRun: null },
      { id: "nightly-report", definitionHash: "y", activation: null, currentRun: null },
    ],
  };

  test("lists workflows and describes the highlighted one", () => {
    const m = pickerModel({ dto: twoWorkflows, cursor: 0 });
    expect(m.header).toContain("pick a workflow");
    expect(m.nodes.title).toBe("workflows");
    expect(m.nodes.lines[0]!.startsWith("▶")).toBe(true);
    expect(m.nodes.lines[0]).toContain("hemingway-clock  active 3/6");
    expect(m.nodes.lines[1]).toContain("nightly-report  one-shot");
    expect(m.runs.title).toBe("detail · hemingway-clock");
    expect(m.runs.lines.join("\n")).toContain("hemingway-clock");
  });

  test("the cursor moves the marker and the detail pane together", () => {
    const m = pickerModel({ dto: twoWorkflows, cursor: 1 });
    expect(m.nodes.lines[0]!.startsWith("▶")).toBe(false);
    expect(m.nodes.lines[1]!.startsWith("▶")).toBe(true);
    expect(m.runs.title).toBe("detail · nightly-report");
  });

  test("a cursor out of range is clamped rather than throwing", () => {
    expect(() => pickerModel({ dto: twoWorkflows, cursor: 99 })).not.toThrow();
    expect(pickerModel({ dto: twoWorkflows, cursor: 99 }).runs.title).toBe("detail · nightly-report");
    expect(pickerModel({ dto: { version: 1, workflows: [] } }).nodes.lines).toEqual(["(none configured)"]);
  });
});
