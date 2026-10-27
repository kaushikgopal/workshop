import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewerSource } from "../src/cli/watch.js";
import type { ViewerChatEntry } from "../src/tui/data-source.js";
import { parseServiceRequestLine, serviceError, serviceSuccess, encodeServiceResponseFrames } from "../src/service/parse-service-protocol.js";
import { buildNode, buildRun, buildStatus, HASH, TIME } from "./build-viewer-fixture.js";
import { runSummaryDtoSchema, type RunSummaryDto } from "../src/views/schema.js";
import type { ServiceRequestV1, ServiceResponseV1 } from "../src/service/schema.js";

interface FakeProtocolResponse {
  readonly fakeProtocolResponse: ServiceResponseV1;
}

function fakeProtocolResponse(response: ServiceResponseV1): FakeProtocolResponse {
  return { fakeProtocolResponse: response };
}

function isFakeProtocolResponse(value: unknown): value is FakeProtocolResponse {
  return typeof value === "object" && value !== null && "fakeProtocolResponse" in value;
}

function makeRun(runId: string, admittedAt: string, status: RunSummaryDto["status"] = "completed"): RunSummaryDto {
  const summary = buildRun(status);
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  return runSummaryDtoSchema.parse({ ...summary, runId, admittedAt,
    startedAt: status === "queued" ? null : admittedAt, finishedAt: terminal ? admittedAt : null,
    failure: summary.failure === null ? null : { ...summary.failure, failedAt: admittedAt },
    activationId: "activation-" + runId, occurrenceId: "occurrence-" + runId });
}

function makeRunsPage(runs: readonly RunSummaryDto[], total = runs.length, nextCursor: string | null = null, highWaterMark = total) {
  return { version: 1, workflowId: "alpha", total, highWaterMark, nextCursor, runs };
}

function viewerDetailResponse(request: ServiceRequestV1, runs: readonly RunSummaryDto[]): unknown {
  if (request.method === "diagram") {
    const run = request.runId === undefined ? null : runs.find(item => item.runId === request.runId) ?? null;
    return { version: 2, workflowId: request.workflowId, definitionHash: run?.definitionHash ?? HASH, runId: run?.runId ?? null,
      nodes: [{ nodeId: "first", position: 1, successorId: null, status: run === null ? null : "skipped" }] };
  }
  if (request.method === "node.describe") {
    const run = request.runId === undefined ? null : runs.find(item => item.runId === request.runId) ?? null;
    return { version: 2, workflowId: request.workflowId, definitionHash: run?.definitionHash ?? HASH, runId: run?.runId ?? null,
      runStatus: run?.status ?? null, runFailure: run?.failure ?? null,
      node: { ...buildNode(), status: run === null ? "pending" : "skipped" } };
  }
  throw new Error("Unexpected detail request " + request.method);
}

async function fakeService(reply: (request: ServiceRequestV1) => unknown, execute: (socket: string, requests: ServiceRequestV1[]) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "workshop-status-fake-"));
  const path = join(directory, "service.sock");
  const requests: ServiceRequestV1[] = [];
  const server = createServer(socket => {
    socket.once("data", bytes => {
      const parsed = parseServiceRequestLine(bytes.toString().trimEnd());
      if (!parsed.ok) { socket.destroy(); return; }
      requests.push(parsed.request);
      const requestId = "requestId" in parsed.request ? parsed.request.requestId : null;
      let response: ServiceResponseV1;
      try {
        const result = reply(parsed.request);
        response = isFakeProtocolResponse(result) ? result.fakeProtocolResponse : serviceSuccess(requestId, result);
      } catch (error) {
        if (parsed.request.method !== "chat.view") throw error;
        response = serviceSuccess(requestId, { configured: false, entries: [], nextCursor: null, pending: [] });
      }
      for (const frame of encodeServiceResponseFrames(response)) socket.write(frame);
      socket.end();
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try { await execute(path, requests); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
}


test("viewer source preserves typed shared bot entries without guessing provenance", async () => {
  const status = buildStatus();
  const entries: ViewerChatEntry[] = [
    { id: "user-1", role: "user", kind: "input", text: "Automated event wake: inspect the run." },
    { id: "assistant-1", role: "assistant", kind: "message", text: "Terminal output: this is bot prose, not stdout." },
    { id: "activity-1", role: "activity", text: "Tool execution details." },
  ];
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "chat.view") return { configured: true, entries, nextCursor: null, pending: [] };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const snapshot = await createViewerSource(socket).snapshot(null);
    expect(snapshot.botEntries).toEqual(entries);
    expect(snapshot.botConfigured).toBe(true);
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
  });
});

test("viewer retries only an explicit unsupported includeKinds field and caches the legacy path", async () => {
  const status = buildStatus();
  const entries: ViewerChatEntry[] = [
    { id: "legacy-user", role: "user", text: "Error: a human quoted this text." },
    { id: "legacy-assistant", role: "assistant", text: "Terminal output: this is bot prose." },
    { id: "legacy-activity", role: "activity", text: "Completed workshop_logs" },
  ];
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "chat.view" && request.includeKinds === true) {
      return fakeProtocolResponse(serviceError(null, "invalid_arguments", "Request arguments do not match the method schema", {
        issues: [{ path: [], code: "unrecognized_keys", message: 'Unrecognized key: "includeKinds"' }],
      }));
    }
    if (request.method === "chat.view") return { configured: true, entries, nextCursor: "legacy-cursor", pending: [] };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    const first = await source.snapshot(null);
    const second = await source.snapshot(null);
    expect(first.botEntries).toEqual(entries);
    expect(second.botEntries).toEqual(entries);
    expect(first.botEntries?.map(entry => entry.role)).toEqual(["user", "assistant", "activity"]);
    expect(first.botEntries?.every(entry => !("kind" in entry))).toBe(true);
    const chatRequests = requests.filter(request => request.method === "chat.view");
    expect(chatRequests.map(request => request.method === "chat.view" && request.includeKinds === true)).toEqual([true, false, false]);
    expect(chatRequests).toHaveLength(3);
  });
});

test("viewer does not retry includeKinds after an unrelated service error", async () => {
  await fakeService(request => {
    if (request.method === "status") return buildStatus();
    if (request.method === "chat.view") {
      return fakeProtocolResponse(serviceError(null, "request_failed", "Service request failed"));
    }
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    await expect(createViewerSource(socket).snapshot(null)).rejects.toThrow("request_failed: Service request failed");
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
    const chatRequest = requests[1];
    expect(chatRequest).toMatchObject({ method: "chat.view", includeKinds: true });
  });
});

test("viewer does not retry an unrelated invalid_arguments response", async () => {
  await fakeService(request => {
    if (request.method === "status") return buildStatus();
    if (request.method === "chat.view") {
      return fakeProtocolResponse(serviceError(null, "invalid_arguments", "Request arguments do not match the method schema", {
        issues: [{ path: [], code: "unrecognized_keys", message: 'Unrecognized key: "cursor"' }],
      }));
    }
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    await expect(createViewerSource(socket).snapshot(null)).rejects.toThrow("invalid_arguments:");
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
  });
});

test("viewer propagates an invalid chat response without retrying", async () => {
  await fakeService(request => {
    if (request.method === "status") return buildStatus();
    if (request.method === "chat.view") return { configured: true, entries: "invalid", nextCursor: null, pending: [] };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    await expect(createViewerSource(socket).snapshot(null)).rejects.toThrow();
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
  });
});

test("viewer selects the newest admitted run instead of an older unresolved run", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  workflow.unresolvedRun = makeRun("unresolved-older", TIME, "running");
  workflow.latestRun = makeRun("completed-newer", "2026-10-10T12:00:01.000Z");
  workflow.activation = { activationId: workflow.unresolvedRun.activationId, state: "active", admittedCount: 2, maxRuns: 3, activatedAt: TIME, nextDueAt: TIME, skippedSlots: 0, lastSkippedSlotAt: null };
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "runs") return makeRunsPage([workflow.latestRun!, workflow.unresolvedRun!], 2, null, 2);
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: request.runId ?? null,
      nodes: [{ nodeId: "frozen-first", position: 1, successorId: null, status: request.runId === workflow.latestRun?.runId ? "skipped" : "pending" }] };
    if (request.method === "node.describe") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: request.runId ?? null,
      runStatus: request.runId === workflow.latestRun?.runId ? "completed" : "running", runFailure: null,
      node: { ...buildNode("frozen-first"), status: request.runId === workflow.latestRun?.runId ? "skipped" : "pending" } };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    expect((await source.snapshot(null)).detail).toBeNull();
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
    const snapshot = await source.snapshot("alpha");
    expect(snapshot.detail?.nodes.map(node => node.nodeId)).toEqual(["frozen-first"]);
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view", "status", "chat.view", "runs", "diagram", "node.describe"]);
    const diagramRequest = requests.find(request => request.method === "diagram");
    expect(diagramRequest).toMatchObject({ workflowId: "alpha", runId: workflow.latestRun?.runId });
    expect(requests.some(request => request.method === "logs.page")).toBe(false);
    expect(String(snapshot.selectedRun?.runId)).toBe("completed-newer");
    expect(snapshot.runPosition).toEqual({ index: 0, total: 2, followingLatest: true });
  });
});

test("status adapter uses latest frozen run, otherwise the configured chain without output", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  workflow.latestRun = buildRun();
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "runs") return makeRunsPage(workflow.latestRun ? [workflow.latestRun] : []);
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.latestRun?.runId ?? null,
      nodes: [{ nodeId: "first", position: 1, successorId: null, status: workflow.latestRun ? "skipped" : null }] };
    if (request.method === "node.describe") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.latestRun?.runId ?? null,
      runStatus: workflow.latestRun ? "completed" : null, runFailure: null, node: { ...buildNode(), status: workflow.latestRun ? "skipped" : "pending" } };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    expect((await source.snapshot("alpha")).detail?.diagram.runId).toBe(buildRun().runId);
    expect(requests[3]).toMatchObject({ method: "diagram", runId: "run-alpha" });
    workflow.latestRun = null;
    const configured = await source.snapshot("alpha");
    expect(configured.detail?.diagram.runId).toBeNull();
    expect(configured.selectedRun).toBeNull();
    expect(configured.runPosition).toEqual({ index: 0, total: 0, followingLatest: true });
    expect(configured.detail?.nodes[0]?.successfulOutput).toBeNull();
    expect(requests[8]).toEqual({ version: 1, method: "diagram", workflowId: "alpha" });
    workflow.configurationError = "Invalid configuration";
    expect((await source.snapshot("alpha")).detail).toBeNull();
    expect(requests.slice(-3).map(request => request.method)).toEqual(["status", "chat.view", "runs"]);
  });
});

test("non-TTY status and JSON snapshots use only status projections without OpenTUI", async () => {
  const status = buildStatus();
  await fakeService(request => {
    if (request.method !== "status") throw new Error("Unexpected request " + request.method);
    return status;
  }, async (socket, requests) => {
    for (const json of [false, true]) {
      const child = Bun.spawn(["bun", "-e", "import {showStatus} from './src/cli/watch.ts'; await showStatus(" + JSON.stringify(socket) + ", null, " + json + ");"], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      if (json) expect(JSON.parse(output)).toEqual(status);
      else { expect(output).toContain("Title"); expect(output).toContain("Next run"); expect(output).toContain("Ready"); }
    }
    expect(requests.map(request => request.method)).toEqual(["status", "status"]);
  });
});

test("expanding a byte-capped failed preview reads full retained evidence from the fake service", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  const failedRun = makeRun("historical-failure", TIME, "failed");
  workflow.latestRun = makeRun("current-latest", "2026-10-10T12:00:01.000Z", "failed");
  const content = "failure line\n".repeat(6000) + "last retained diagnostic";
  const capture = { stream: "stderr", path: "/tmp/worker.stderr", totalBytes: content.length, retainedBytes: content.length, truncatedBytes: 0, sha256: HASH, complete: true };
  const failedNode = { ...buildNode(), status: "failed", failureEvidence: content.slice(0, 65536), evidenceTruncated: true, attempts: [{
    attemptId: "attempt-first", number: 1, status: "failed", phase: null, startedAt: TIME, finishedAt: TIME, elapsedMs: 0,
    workerExecutionId: "execution-first", validatorExecutionId: null, candidate: null, verdict: null, judgments: [], operatorAcceptances: [], blocks: [], failure: failedRun.failure,
    processes: [{ executionId: "execution-first", incarnationId: "incarnation-first", incarnationNumber: 1, role: "worker", status: "exited", replay: "never", commandHash: HASH,
      launchIntentAt: TIME, startedAt: TIME, finishedAt: TIME, deadlineAt: null, identity: { pid: 1234, pgid: 1234, startIdentity: "fixture", serviceBootId: "fixture" }, exit: { kind: "code", code: 1 }, cleanupState: "confirmed_dead", captures: [capture] }],
  }] };
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "runs") return makeRunsPage([workflow.latestRun!, failedRun]);
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: request.runId ?? null,
      nodes: [{ nodeId: "first", position: 1, successorId: null, status: "failed" }] };
    if (request.method === "node.describe") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: request.runId ?? null, runStatus: "failed", runFailure: failedRun.failure, node: failedNode };
    if (request.method === "logs.page") return { version: 1, runId: failedRun.runId, sectionIndex: 0, totalSections: 1, nextCursor: null,
      section: { kind: "capture", sectionId: "capture-first", order: 0, label: "first worker stderr", executionId: "execution-first", incarnationNumber: 1, capture, content }, chunk: { offsetBytes: 0, totalBytes: content.length, complete: true } };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    const compact = await source.snapshot("alpha", [], { runId: failedRun.runId });
    expect(compact.detail?.nodes[0]?.failureEvidence).not.toContain("last retained diagnostic");
    expect(requests.some(request => request.method === "logs.page")).toBe(false);
    const expanded = await source.snapshot("alpha", ["first"], { runId: failedRun.runId });
    expect(expanded.detail?.nodes[0]?.failureEvidence).toContain("last retained diagnostic");
    expect(expanded.detail?.nodes[0]?.failureEvidence).toContain("first worker stderr");
    expect(expanded.detail?.nodes[0]?.evidenceTruncated).toBe(false);
    expect(requests.filter(request => request.method === "logs.page")).toHaveLength(1);
    for (const request of requests.filter(request => request.method === "diagram" || request.method === "node.describe" || request.method === "logs.page")) {
      expect(request).toMatchObject({ runId: failedRun.runId });
    }
    expect(expanded.selectedRun).toEqual(failedRun);
  });
});


test("viewer steps through run history, clamps at both edges, and pins an older run after admission", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  const newest = makeRun("run-newest", "2026-10-10T12:00:03.000Z");
  const middle = makeRun("run-middle", "2026-10-10T12:00:02.000Z");
  const oldest = makeRun("run-oldest", "2026-10-10T12:00:01.000Z");
  let history = [newest, middle, oldest];
  workflow.latestRun = newest;
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "chat.view") return { configured: false, entries: [], nextCursor: null, pending: [] };
    if (request.method === "runs") return makeRunsPage(history);
    return viewerDetailResponse(request, history);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    const latest = await source.snapshot("alpha");
    expect(latest.selectedRun?.runId).toBe(newest.runId);
    expect(latest.runPosition).toEqual({ index: 0, total: 3, followingLatest: true });
    const older = await source.snapshot("alpha", [], { runId: newest.runId, direction: "older" });
    expect(older.selectedRun?.runId).toBe(middle.runId);
    expect(older.runPosition).toEqual({ index: 1, total: 3, followingLatest: false });
    const oldestEdge = await source.snapshot("alpha", [], { runId: oldest.runId, direction: "older" });
    expect(oldestEdge.selectedRun?.runId).toBe(oldest.runId);
    expect(oldestEdge.runPosition).toEqual({ index: 2, total: 3, followingLatest: false });
    const latestEdge = await source.snapshot("alpha", [], { runId: newest.runId, direction: "newer" });
    expect(latestEdge.selectedRun?.runId).toBe(newest.runId);
    expect(latestEdge.runPosition?.followingLatest).toBe(true);
    const newer = await source.snapshot("alpha", [], { runId: oldest.runId, direction: "newer" });
    expect(newer.selectedRun?.runId).toBe(middle.runId);

    const arrival = makeRun("run-arrival", "2026-10-10T12:00:04.000Z");
    history = [arrival, newest, middle, oldest];
    workflow.latestRun = arrival;
    const pinned = await source.snapshot("alpha", [], { runId: middle.runId });
    expect(pinned.selectedRun?.runId).toBe(middle.runId);
    expect(pinned.runPosition).toEqual({ index: 2, total: 4, followingLatest: false });
    expect(requests.filter(request => request.method === "runs").every(request => request.limit === 100)).toBe(true);
  });
});

test("viewer paginates only far enough to resolve the selected run and its older neighbor", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  const history = Array.from({ length: 230 }, (_, index) => makeRun(
    "page-run-" + String(index).padStart(3, "0"), new Date(Date.parse(TIME) - index * 60_000).toISOString()));
  workflow.latestRun = history[0]!;
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "chat.view") return { configured: false, entries: [], nextCursor: null, pending: [] };
    if (request.method === "runs") {
      const start = request.cursor === undefined ? 0 : request.cursor === "page-100" ? 100 : 200;
      const pageRuns = history.slice(start, start + 100);
      const nextCursor = start + pageRuns.length < history.length ? "page-" + String(start + pageRuns.length) : null;
      return makeRunsPage(pageRuns, history.length, nextCursor, history.length);
    }
    return viewerDetailResponse(request, history);
  }, async (socket, requests) => {
    const snapshot = await createViewerSource(socket).snapshot("alpha", [], { runId: history[99]!.runId, direction: "older" });
    expect(snapshot.selectedRun?.runId).toBe(history[100]!.runId);
    expect(snapshot.runPosition).toEqual({ index: 100, total: 230, followingLatest: false });
    const pages = requests.filter(request => request.method === "runs");
    expect(pages).toHaveLength(2);
    expect(pages.map(request => request.method === "runs" ? request.cursor : null)).toEqual([undefined, "page-100"]);
    expect(pages.every(request => request.method === "runs" && request.limit === 100)).toBe(true);

    const source = createViewerSource(socket);
    const pinned = await source.snapshot("alpha", [], { runId: history[205]!.runId });
    expect(pinned.selectedRun).toEqual(history[205]);
    expect(pinned.runPosition).toEqual({ index: 205, total: 230, followingLatest: false });
    expect(requests.filter(request => request.method === "runs")).toHaveLength(5);
    await expect(source.snapshot("alpha", [], { runId: "missing" }))
      .rejects.toThrow("service no longer lists admitted run missing");
    expect(requests.filter(request => request.method === "runs")).toHaveLength(8);
  });
});

test("viewer checks complete pages before selecting a run and preserves validation precedence", async () => {
  const newest = makeRun("page-newest", "2026-10-10T12:00:03.000Z");
  const middle = makeRun("page-middle", "2026-10-10T12:00:02.000Z");
  const oldest = makeRun("page-oldest", "2026-10-10T12:00:01.000Z");
  const wrongWorkflow = runSummaryDtoSchema.parse({ ...newest, workflowId: "beta" });
  const scenarios: { pages: ReturnType<typeof makeRunsPage>[]; error: string; runId?: string }[] = [
    { pages: [makeRunsPage([newest], 3)], error: "service ended run history before its snapshot was complete" },
    { pages: [makeRunsPage([], 3, "next")], error: "service returned a truncated run page" },
    { pages: [makeRunsPage([newest], 1, "next")], error: "service returned a truncated run page" },
    { pages: [makeRunsPage([newest], 2, "next"), makeRunsPage([middle, oldest], 2, "last")],
      error: "service returned a truncated run page" },
    { pages: [makeRunsPage([newest], 3, "cycle"), makeRunsPage([middle], 3, "cycle")],
      error: "service repeated a run-page cursor", runId: middle.runId },
    { pages: [makeRunsPage([newest], 3, "next"), makeRunsPage([middle], 2, "last", 3)],
      error: "run pages changed their admission snapshot" },
    { pages: [makeRunsPage([newest], 3, "next"), makeRunsPage([newest], 3, "last", 4)],
      error: "run pages changed their admission snapshot" },
    { pages: [makeRunsPage([newest], 3, "next"), { ...makeRunsPage([wrongWorkflow], 3, "next", 4), workflowId: "beta" }],
      error: "service returned run history for a different workflow" },
    { pages: [makeRunsPage([newest], 3, "next"), makeRunsPage([wrongWorkflow], 3, "last")],
      error: "service returned a run for a different workflow" },
    { pages: [makeRunsPage([newest, newest])], error: "service repeated a run in its history" },
    { pages: [makeRunsPage([middle, newest])], error: "service returned run history out of newest-first order" },
    { pages: [makeRunsPage([middle], 3, "next"), makeRunsPage([newest], 3, "last")],
      error: "service returned run history out of newest-first order" },
    { pages: [makeRunsPage([makeRun("tie-z", TIME), makeRun("tie-a", TIME)])],
      error: "service returned run history out of newest-first order" },
  ];
  for (const { pages, error, runId = "not-listed" } of scenarios) {
    let pageIndex = 0;
    await fakeService(request => {
      if (request.method === "status") return buildStatus();
      if (request.method === "runs") return pages[pageIndex++]
        ?? fakeProtocolResponse(serviceError(null, "request_failed", "unexpected history page"));
      return viewerDetailResponse(request, pages.flatMap(page => page.runs));
    }, async (socket, requests) => {
      // A selectable first run must not bypass checks on the rest of its page.
      const selection = pages.length === 1 ? undefined : { runId };
      await expect(createViewerSource(socket).snapshot("alpha", [], selection)).rejects.toThrow(error);
      expect(requests.filter(request => request.method === "runs")).toHaveLength(pages.length);
      expect(requests.some(request => request.method === "diagram" || request.method === "node.describe")).toBe(false);
    });
  }
});

test("viewer preserves service and schema errors before run-page identity checks", async () => {
  const scenarios = [
    { result: fakeProtocolResponse(serviceError(null, "request_failed", "history unavailable")), error: "request_failed: history unavailable" },
    { result: { ...makeRunsPage([], 1, null, 0), workflowId: "beta" }, error: "page total fits within its admission high-water mark" },
  ];
  for (const { result, error } of scenarios) {
    await fakeService(request => {
      if (request.method === "status") return buildStatus();
      if (request.method === "runs") return result;
      return viewerDetailResponse(request, []);
    }, async (socket, requests) => {
      await expect(createViewerSource(socket).snapshot("alpha")).rejects.toThrow(error);
      expect(requests.map(request => request.method)).toEqual(["status", "chat.view", "runs"]);
    });
  }
});

test("viewer handles unpinned directions, empty history, ties, and a missing pinned run", async () => {
  const history = [makeRun("tie-a", TIME), makeRun("tie-z", TIME)];
  for (const runs of [history, history.slice(0, 1), []]) {
    await fakeService(request => {
      if (request.method === "status") return buildStatus();
      if (request.method === "runs") return makeRunsPage(runs);
      return viewerDetailResponse(request, runs);
    }, async socket => {
      const source = createViewerSource(socket);
      for (const direction of [undefined, "older", "newer"] as const) {
        const snapshot = await source.snapshot("alpha", [], { runId: null, direction });
        const index = direction === "older" && runs.length > 1 ? 1 : 0;
        expect(snapshot.selectedRun).toEqual(runs[index] ?? null);
        expect(snapshot.runPosition).toEqual({ index, total: runs.length, followingLatest: index === 0 });
      }
      await expect(source.snapshot("alpha", [], { runId: "missing", direction: "older" }))
        .rejects.toThrow("service no longer lists admitted run missing");
    });
  }
});

test("viewer binds historical details to their frozen run, definition, and workflow", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  const current = makeRun("current-failed", "2026-10-10T12:00:02.000Z", "failed");
  const historical = runSummaryDtoSchema.parse({ ...makeRun("historical-complete", "2026-10-10T12:00:01.000Z"), definitionHash: "sha256:" + "b".repeat(64) });
  workflow.latestRun = current;
  const history = [current, historical];
  let wrongDefinition = false;
  let wrongWorkflow = false;
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "chat.view") return { configured: false, entries: [], nextCursor: null, pending: [] };
    if (request.method === "runs") return makeRunsPage(history);
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: wrongDefinition ? current.definitionHash : historical.definitionHash,
      runId: request.runId, nodes: [{ nodeId: "first", position: 1, successorId: null, status: "skipped" }] };
    if (request.method === "node.describe") return { version: 2, workflowId: wrongWorkflow ? "beta" : "alpha", definitionHash: historical.definitionHash,
      runId: request.runId, runStatus: "completed", runFailure: null, node: { ...buildNode(), status: "skipped" } };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    const snapshot = await source.snapshot("alpha", [], { runId: historical.runId });
    expect(snapshot.selectedRun).toEqual(historical);
    expect(snapshot.status.workflows.find(item => item.workflowId === "alpha")?.latestRun?.failure).not.toBeNull();
    expect(snapshot.runPosition).toEqual({ index: 1, total: 2, followingLatest: false });
    expect(snapshot.detail?.diagram.definitionHash).toBe(historical.definitionHash);
    for (const request of requests.filter(item => item.method === "diagram" || item.method === "node.describe")) {
      expect(request).toMatchObject({ runId: historical.runId });
    }

    wrongDefinition = true;
    await expect(source.snapshot("alpha", [], { runId: historical.runId })).rejects.toThrow("frozen definition");
    wrongDefinition = false;
    wrongWorkflow = true;
    await expect(source.snapshot("alpha", [], { runId: historical.runId })).rejects.toThrow("frozen step");
  });
});
