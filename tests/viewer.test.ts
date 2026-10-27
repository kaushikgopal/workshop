import { expect, test } from "bun:test";
import { buildViewerModel } from "../src/tui/build-panes.js";
import { blockActions, nextRunLabel, renderStatusSnapshot, renderStatusTable, renderStepPreview, statusRows } from "../src/views/render-status.js";
import { statusDtoSchema } from "../src/views/schema.js";
import { statusIsInteractive } from "../src/cli/watch.js";
import { buildBlock, buildNode, buildRun, buildSnapshot, buildStatus, TIME, WAIT } from "./build-viewer-fixture.js";

test("overview has exactly Title, Status, Next run and no old metadata", () => {
  const snapshot = buildSnapshot();
  const model = buildViewerModel({ snapshot, workflowId: null, selectedId: "beta", selectedStepId: null, expanded: [] });
  expect(model.rows.every(row => row.length === 3)).toBe(true);
  const table = renderStatusTable(model.rows, 100, "beta").join("\n");
  expect(table.split("\n")[0]?.trim().split(/\s{2,}/)).toEqual(["Title", "Status", "Next run"]);
  expect(table).toContain("›beta");
  expect(table).toContain("○ Ready");
  expect(table).not.toMatch(/hash|activation|pid|attempt|duration|tally|history/i);
});

test("overview uses open state before latest result and shows configuration errors", () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  expect(statusRows(status)[0]?.[1]).toBe("Ready");
  workflow.latestRun = buildRun();
  expect(statusRows(status)[0]?.[1]).toBe("Completed");
  for (const state of ["blocked", "waiting", "running", "failed"] as const) {
    // Failed runs are latest results, never unresolved runs.
    if (state === "failed") { workflow.unresolvedRun = null; workflow.latestRun = buildRun(state); }
    else workflow.unresolvedRun = buildRun(state);
    expect(statusRows(status)[0]?.[1]).toBe(state === "waiting" ? "Needs input" : state.charAt(0).toUpperCase() + state.slice(1));
  }
  workflow.configurationError = "Invalid settings\nCheck retries";
  expect(statusRows(status)[0]?.[1]).toBe("Configuration error: Invalid settings Check retries");
});

test("next run uses local clock and date only when needed, or a dash when suppressed", () => {
  const workflow = buildStatus().workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  const now = new Date(2026, 9, 10, 12);
  workflow.activation = { activationId: buildRun().activationId, state: "active", admittedCount: 1, maxRuns: 4, activatedAt: TIME,
    nextDueAt: new Date(2026, 9, 10, 13, 5, 2).toISOString(), skippedSlots: 0, lastSkippedSlotAt: null };
  expect(nextRunLabel(workflow, now)).toBe("13:05:02");
  workflow.activation.nextDueAt = new Date(2026, 9, 11, 13).toISOString();
  expect(nextRunLabel(workflow, now)).toBe("2026-10-11 13:00:00");
  workflow.unresolvedRun = buildRun("running");
  expect(nextRunLabel(workflow, now)).toBe("—");
  workflow.unresolvedRun = null;
  workflow.activation.state = "paused";
  expect(nextRunLabel(workflow, now)).toBe("—");
  workflow.activation.state = "active";
  workflow.activation.nextDueAt = null;
  expect(nextRunLabel(workflow, now)).toBe("—");
});

test("previews show running stderr tail, accepted output, wait identity, and no pending or skipped evidence", () => {
  const node = buildNode();
  const lines = Array.from({ length: 60 }, (_, i) => "line " + i).join("\n");
  expect(renderStepPreview(node).lines).toEqual([]);
  expect(renderStepPreview({ ...node, status: "skipped", successfulOutput: "must not appear" }).lines).toEqual([]);
  const running = renderStepPreview({ ...node, status: "running", liveStderr: lines });
  expect(running.lines).toHaveLength(40);
  expect(running.lines[0]).toBe("line 20");
  expect(running.expandable).toBe(true);
  const success = { ...node, status: "succeeded" as const, successfulOutput: lines };
  expect(renderStepPreview(success).lines[0]).toBe("line 0");
  expect(renderStepPreview(success).lines).toHaveLength(40);
  expect(renderStepPreview(success, true).lines).toHaveLength(60);
  const waiting = renderStepPreview({ ...node, status: "waiting", wait: WAIT });
  expect(waiting.lines).toEqual(["Question: Approve this proposal?", "waitId: " + WAIT.waitId, "saved proposal"]);
});

for (const [kind, actions] of Object.entries({ verifier_block: "retry, fail", verifier_failed: "retry, fail", repeated_failure: "retry, fail", preflight_failed: "retry, fail",
  external_outcome_unknown: "retry --allow-repeat, accept --result-file … --acknowledge-effects, fail", process_death_unconfirmed: "retry --allow-repeat, fail", integrity_failed: "fail", runtime_incompatible: "fail" })) {
  test("blocked preview shows " + kind + " authority", () => {
    expect(blockActions(kind)).toBe(actions);
  });
}

test("blocked and failed previews show failure evidence and a one-line reason", () => {
  const preview = renderStepPreview({ ...buildNode(), status: "blocked", block: buildBlock("external_outcome_unknown"), failureEvidence: "raw failure" });
  expect(preview.lines).toContain("Reason: Check external effects before retry");
  expect(preview.lines).toContain("Block: external_outcome_unknown");
  expect(preview.lines).toContain("Allowed actions: " + blockActions("external_outcome_unknown"));
  expect(preview.lines).toContain("raw failure");
  const failed = renderStepPreview({ ...buildNode(), status: "failed", failureReason: "Worker failed\nwith exit 1", failureEvidence: "stderr diagnostics" });
  expect(failed.lines).toContain("stderr diagnostics");
  expect(failed.lines).toContain("Reason: Worker failed with exit 1");
});

test("narrow snapshot stacks exactly three fields per workflow without horizontal overflow", () => {
  const lines = renderStatusTable(statusRows(buildStatus()), 24, "alpha");
  expect(lines.filter(line => line.includes("Title:"))).toHaveLength(2);
  expect(lines.filter(line => line.includes("Status:"))).toHaveLength(2);
  expect(lines.filter(line => line.includes("Next run:"))).toHaveLength(2);
  expect(lines.every(line => line.length <= 24)).toBe(true);
});

test("JSON and non-TTY routing stays noninteractive and snapshots show human waits", () => {
  for (const stdoutTTY of [true, false]) for (const stdinTTY of [true, false]) {
    expect(statusIsInteractive(true, stdoutTTY, stdinTTY)).toBe(false);
    expect(statusIsInteractive(false, stdoutTTY, stdinTTY)).toBe(stdoutTTY && stdinTTY);
  }
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  workflow.unresolvedRun = buildRun("waiting");
  expect(renderStatusSnapshot(status)).toContain("Needs input");
  expect(renderStatusSnapshot(status)).toContain("waitId=" + WAIT.waitId);
  expect(renderStatusSnapshot(status)).toContain("Question: Approve this proposal?");
});


test("shared bot feed retains the last 100 typed entries without substituting a worklog", () => {
  const snapshot = { ...buildSnapshot(), botEntries: Array.from({ length: 130 }, (_, i) => ({ id: "message-" + i, role: "assistant" as const, text: "message " + i })) };
  const model = buildViewerModel({ snapshot, workflowId: null, selectedId: "alpha", selectedStepId: null, expanded: [] });
  expect(model.botEntries).toHaveLength(100);
  expect(model.botEntries[0]?.text).toBe("message 30");
  expect(model.botEntries.at(-1)?.text).toBe("message 129");
  const absent = buildViewerModel({ snapshot: { ...snapshot, botEntries: undefined, botConfigured: false }, workflowId: null, selectedId: "alpha", selectedStepId: null, expanded: [] });
  expect(absent.botEmptyMessage).toBe("Bot not configured");
  const configuredEmpty = buildViewerModel({ snapshot: { ...snapshot, botEntries: [], botConfigured: true }, workflowId: null, selectedId: "alpha", selectedStepId: null, expanded: [] });
  expect(configuredEmpty.botEmptyMessage).toBe("No bot activity yet");
});

test("historical status projections remain readable and latest results require matching workflow identity", () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  delete workflow.latestRun;
  expect(statusDtoSchema.safeParse(status).success).toBe(true);
  workflow.latestRun = { ...buildRun(), workflowId: "different" };
  expect(statusDtoSchema.safeParse(status).success).toBe(false);
});
