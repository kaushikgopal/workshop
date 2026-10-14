import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewerSource } from "../src/cli/watch.js";
import { parseServiceRequestLine, serviceSuccess, encodeServiceResponseFrames } from "../src/service/parse-service-protocol.js";
import { buildNode, buildRun, buildStatus, HASH, TIME } from "./build-viewer-fixture.js";
import type { ServiceRequestV1 } from "../src/service/schema.js";

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
      let result: unknown;
      try { result = reply(parsed.request); }
      catch (error) {
        if (parsed.request.method !== "chat.view") throw error;
        result = { configured: false, entries: [], nextCursor: null, pending: [] };
      }
      for (const frame of encodeServiceResponseFrames(serviceSuccess(requestId, result))) socket.write(frame);
      socket.end();
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try { await execute(path, requests); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
}


test("viewer source projects the shared bot transcript into its feed", async () => {
  const status = buildStatus();
  const entries = [
    { id: "user-1", role: "user", text: "Check the latest run." },
    { id: "assistant-1", role: "assistant", text: "The run is complete." },
  ];
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "chat.view") return { configured: true, entries, nextCursor: null, pending: [] };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const snapshot = await createViewerSource(socket).snapshot(null);
    expect(snapshot.botLines).toEqual(["You: Check the latest run.", "Bot: The run is complete."]);
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
  });
});

test("status adapter reads only the overview and selected open run through a fake service", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  workflow.unresolvedRun = buildRun("running");
  workflow.latestRun = buildRun();
  workflow.activation = { activationId: workflow.unresolvedRun.activationId, state: "active", admittedCount: 2, maxRuns: 3, activatedAt: TIME, nextDueAt: TIME, skippedSlots: 0, lastSkippedSlotAt: null };
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.unresolvedRun?.runId,
      nodes: [{ nodeId: "frozen-first", position: 1, successorId: null, status: "pending" }] };
    if (request.method === "node.describe") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.unresolvedRun?.runId, runStatus: "running", runFailure: null, node: buildNode("frozen-first") };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    expect((await source.snapshot(null)).detail).toBeNull();
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view"]);
    const snapshot = await source.snapshot("alpha");
    expect(snapshot.detail?.nodes.map(node => node.nodeId)).toEqual(["frozen-first"]);
    expect(requests.map(request => request.method)).toEqual(["status", "chat.view", "status", "chat.view", "diagram", "node.describe"]);
    const diagramRequest = requests.find(request => request.method === "diagram");
    expect(diagramRequest).toMatchObject({ workflowId: "alpha", runId: workflow.unresolvedRun?.runId });
    expect(requests.some(request => request.method === "runs" || request.method === "logs.page")).toBe(false);
  });
});

test("status adapter uses latest frozen run, otherwise the configured chain without output", async () => {
  const status = buildStatus();
  const workflow = status.workflows[0];
  if (!workflow) throw new Error("Missing fixture workflow");
  workflow.latestRun = buildRun();
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.latestRun?.runId ?? null,
      nodes: [{ nodeId: "first", position: 1, successorId: null, status: workflow.latestRun ? "skipped" : null }] };
    if (request.method === "node.describe") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.latestRun?.runId ?? null,
      runStatus: workflow.latestRun ? "completed" : null, runFailure: null, node: { ...buildNode(), status: workflow.latestRun ? "skipped" : "pending" } };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    expect((await source.snapshot("alpha")).detail?.diagram.runId).toBe(buildRun().runId);
    expect(requests[2]).toMatchObject({ method: "diagram", runId: "run-alpha" });
    workflow.latestRun = null;
    const configured = await source.snapshot("alpha");
    expect(configured.detail?.diagram.runId).toBeNull();
    expect(configured.detail?.nodes[0]?.successfulOutput).toBeNull();
    expect(requests[6]).toEqual({ version: 1, method: "diagram", workflowId: "alpha" });
    workflow.configurationError = "Invalid configuration";
    expect((await source.snapshot("alpha")).detail).toBeNull();
    expect(requests.slice(-2).map(request => request.method)).toEqual(["status", "chat.view"]);
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
  workflow.latestRun = buildRun("failed");
  const content = "failure line\n".repeat(6000) + "last retained diagnostic";
  const capture = { stream: "stderr", path: "/tmp/worker.stderr", totalBytes: content.length, retainedBytes: content.length, truncatedBytes: 0, sha256: HASH, complete: true };
  const failedNode = { ...buildNode(), status: "failed", failureEvidence: content.slice(0, 65536), evidenceTruncated: true, attempts: [{
    attemptId: "attempt-first", number: 1, status: "failed", phase: null, startedAt: TIME, finishedAt: TIME, elapsedMs: 0,
    workerExecutionId: "execution-first", validatorExecutionId: null, candidate: null, verdict: null, judgments: [], operatorAcceptances: [], blocks: [], failure: workflow.latestRun.failure,
    processes: [{ executionId: "execution-first", incarnationId: "incarnation-first", incarnationNumber: 1, role: "worker", status: "exited", replay: "never", commandHash: HASH,
      launchIntentAt: TIME, startedAt: TIME, finishedAt: TIME, deadlineAt: null, identity: { pid: 1234, pgid: 1234, startIdentity: "fixture", serviceBootId: "fixture" }, exit: { kind: "code", code: 1 }, cleanupState: "confirmed_dead", captures: [capture] }],
  }] };
  await fakeService(request => {
    if (request.method === "status") return status;
    if (request.method === "diagram") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.latestRun?.runId,
      nodes: [{ nodeId: "first", position: 1, successorId: null, status: "failed" }] };
    if (request.method === "node.describe") return { version: 2, workflowId: "alpha", definitionHash: HASH, runId: workflow.latestRun?.runId, runStatus: "failed", runFailure: workflow.latestRun?.failure, node: failedNode };
    if (request.method === "logs.page") return { version: 1, runId: workflow.latestRun?.runId, sectionIndex: 0, totalSections: 1, nextCursor: null,
      section: { kind: "capture", sectionId: "capture-first", order: 0, label: "first worker stderr", executionId: "execution-first", incarnationNumber: 1, capture, content }, chunk: { offsetBytes: 0, totalBytes: content.length, complete: true } };
    throw new Error("Unexpected request " + request.method);
  }, async (socket, requests) => {
    const source = createViewerSource(socket);
    const compact = await source.snapshot("alpha");
    expect(compact.detail?.nodes[0]?.failureEvidence).not.toContain("last retained diagnostic");
    expect(requests.some(request => request.method === "logs.page")).toBe(false);
    const expanded = await source.snapshot("alpha", ["first"]);
    expect(expanded.detail?.nodes[0]?.failureEvidence).toContain("last retained diagnostic");
    expect(expanded.detail?.nodes[0]?.failureEvidence).toContain("first worker stderr");
    expect(expanded.detail?.nodes[0]?.evidenceTruncated).toBe(false);
    expect(requests.filter(request => request.method === "logs.page")).toHaveLength(1);
  });
});
