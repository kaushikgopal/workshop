import { describe, test, expect } from "bun:test";
import { buildRunsFeed, DEFAULT_RUNS_LIMIT, RUNS_DTO_VERSION } from "../src/status/runs-feed.js";
import { buildViewerModel } from "../src/viewer/panes.js";
import type { StatusDto } from "../src/status/dto.js";
import type { RunRow } from "../src/store/store.js";

/**
 * The viewer contract: the runs feed's shape, and the panes built from it.
 *
 * The panes are pure functions over the CLI's own surfaces, so the layout can
 * be asserted byte for byte here — no TTY, no terminal library, and nothing
 * reaching around the contract into SQLite or a run directory.
 */

const run = (over: Partial<RunRow> & { run_id: string; seq: number }): RunRow =>
  ({
    workflow_id: "wf",
    status: "completed",
    desired_state: "running",
    started_at: "2026-09-24T10:00:00.000Z",
    finished_at: "2026-09-24T10:01:00.000Z",
    block_kind: null,
    ...over,
  }) as RunRow;

describe("runs feed — the occurrences projection", () => {
  test("reverses runtime chronology so the newest occurrence leads", () => {
    const feed = buildRunsFeed({
      workflowId: "wf",
      runs: [run({ run_id: "wf-001", seq: 1 }), run({ run_id: "wf-002", seq: 2 }), run({ run_id: "wf-003", seq: 3 })],
    });
    expect(feed.runs.map((r) => r.id)).toEqual(["wf-003", "wf-002", "wf-001"]);
    expect(feed.total).toBe(3);
    expect(feed.version).toBe(RUNS_DTO_VERSION);
  });

  test("caps the shape but never the count, so a viewer can say what it hid", () => {
    const many = Array.from({ length: DEFAULT_RUNS_LIMIT + 7 }, (_, i) =>
      run({ run_id: `wf-${String(i + 1).padStart(3, "0")}`, seq: i + 1 }),
    );
    const capped = buildRunsFeed({ workflowId: "wf", runs: many });
    expect(capped.total).toBe(DEFAULT_RUNS_LIMIT + 7);
    expect(capped.runs.length).toBe(DEFAULT_RUNS_LIMIT);
    expect(capped.runs[0]!.id).toBe(`wf-${String(DEFAULT_RUNS_LIMIT + 7).padStart(3, "0")}`);

    const all = buildRunsFeed({ workflowId: "wf", runs: many, all: true });
    expect(all.runs.length).toBe(DEFAULT_RUNS_LIMIT + 7);
  });

  test("carries nullable fields explicitly rather than omitting them", () => {
    const feed = buildRunsFeed({
      workflowId: "wf",
      runs: [run({ run_id: "wf-001", seq: 1, finished_at: null, block_kind: "orchestrator_unresolved" })],
    });
    expect(feed.runs[0]).toEqual({
      id: "wf-001",
      status: "completed",
      desiredState: "running",
      startedAt: "2026-09-24T10:00:00.000Z",
      finishedAt: null,
      blocker: "orchestrator_unresolved",
    });
  });
});

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
        nodes: [
          { id: "node-a", status: "completed", attempts: [{ number: 1, status: "completed", progress: null, validator: "passed", failure: null, blocker: null, startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:01.000Z" }] },
          {
            id: "node-b",
            status: "running",
            attempts: [
              { number: 1, status: "failed", progress: null, validator: null, failure: "timeout", blocker: null, startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:02.000Z" },
              { number: 2, status: "running", progress: "generating line", validator: null, failure: null, blocker: null, startedAt: "2026-09-24T10:00:02.000Z", finishedAt: null },
            ],
          },
        ],
      },
      ...over,
    },
  ],
});

const feed = buildRunsFeed({
  workflowId: "wf",
  runs: [
    run({ run_id: "wf-001", seq: 1 }),
    run({ run_id: "wf-002", seq: 2, status: "running", finished_at: null }),
  ],
});

describe("viewer panes — pure layout over the CLI surfaces", () => {
  test("the header carries activation progress, not just a workflow name", () => {
    const model = buildViewerModel({ workflowId: "wf", dto: dto(), feed, logText: null });
    expect(model.header).toBe("wf  active 2/6");
  });

  test("a run-level blocker is surfaced in the header", () => {
    const blocked = dto();
    blocked.workflows[0]!.currentRun!.blocker = "orchestrator_unresolved";
    const model = buildViewerModel({ workflowId: "wf", dto: blocked, feed, logText: null });
    expect(model.header).toBe("wf  active 2/6  orchestrator_unresolved");
  });

  test("nodes render in chain order with glyph, retry count, and progress", () => {
    const model = buildViewerModel({ workflowId: "wf", dto: dto(), feed, logText: null });
    expect(model.nodes.title).toBe("chain · 002 · running");
    // Spine, glyph, retry count, duration for the finished attempt, and the
    // live detail for the running one.
    expect(model.nodes.lines).toEqual([
      "├─ ◉ node-a  1.0s — validator passed",
      "└─ ◎ node-b #2 — generating line",
    ]);
  });

  test("the runs pane marks which occurrence the stream is following", () => {
    const model = buildViewerModel({ workflowId: "wf", dto: dto(), feed, logText: null });
    expect(model.runs.title).toBe("runs · 2");
    expect(model.runs.lines[0]!.startsWith("▶")).toBe(true); // newest, selected
    expect(model.runs.lines[1]!.startsWith(" ")).toBe(true);
    // An unfinished run shows a continuing span rather than a fabricated end.
    expect(model.runs.lines[0]).toContain("→…");
    expect(model.runs.lines[1]).toContain("→");
  });

  test("the stream follows the selection and keeps the newest lines", () => {
    const logText = ["oldest", "middle", "newest"].join("\n");
    const model = buildViewerModel({
      workflowId: "wf",
      dto: dto(),
      feed,
      logText,
      selectedRunId: "wf-001",
      streamHeight: 2,
    });
    expect(model.selectedRunId).toBe("wf-001");
    expect(model.stream.title).toBe("log · 001");
    expect(model.stream.lines).toEqual(["middle", "newest"]);
  });

  test("an empty installation renders honest placeholders, not blanks", () => {
    const empty = buildViewerModel({
      workflowId: "wf",
      dto: { version: 1, workflows: [] },
      feed: null,
      logText: null,
    });
    expect(empty.header).toBe("wf  unknown workflow");
    expect(empty.nodes.lines).toEqual(["(no unresolved run)"]);
    expect(empty.runs.lines).toEqual(["(no runs yet)"]);
    expect(empty.stream.lines).toEqual(["(no log yet)"]);
    expect(empty.selectedRunId).toBeNull();
  });

  test("a one-shot workflow with no activation says so instead of showing 0/0", () => {
    const once = dto({ activation: null });
    const model = buildViewerModel({ workflowId: "wf", dto: once, feed, logText: null });
    expect(model.header).toBe("wf  one-shot");
  });
});
