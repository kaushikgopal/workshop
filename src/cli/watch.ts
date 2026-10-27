import { sendServiceRequest, streamServiceLogChunks } from "../service/send-service-request.js";
import { serviceRunsPageV1Schema, type ServiceRequestV1, type ServiceResponseV1 } from "../service/schema.js";
import type { ViewerRunSelection, ViewerSource } from "../tui/data-source.js";
import { diagramDtoSchema, nodeDescriptionDtoSchema, statusDtoSchema, type RunSummaryDto } from "../views/schema.js";
import { botChatViewV1Schema } from "../bot/schema.js";
import { renderStatusSnapshot } from "../views/render-status.js";

export function statusIsInteractive(json: boolean, stdoutTTY: boolean, stdinTTY: boolean): boolean {
  return !json && stdoutTTY && stdinTTY;
}

export async function openWatch(socketPath: string, workflowId: string | null): Promise<void> {
  const source = createViewerSource(socketPath);
  const { openViewer } = await import("../tui/mount-viewer.js");
  await openViewer({ workflowId, source });
}

/** JSON and pipes never load OpenTUI. watch and status share this routing. */
export async function showStatus(socketPath: string, workflowId: string | null, json = false): Promise<void> {
  if (statusIsInteractive(json, process.stdout.isTTY === true, process.stdin.isTTY === true)) return openWatch(socketPath, workflowId);
  const result = await sendServiceRequest(socketPath, { version: 1, method: "status", ...(workflowId === null ? {} : { workflowId }) });
  if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
  const status = statusDtoSchema.parse(result.result);
  process.stdout.write(json ? JSON.stringify(status, null, 2) + "\n" : renderStatusSnapshot(status));
}

/** Reads overview, selected public run history, and that run's frozen node details. */
export function createViewerSource(socketPath: string): ViewerSource {
  const read = async (request: ServiceRequestV1) => {
    const response = await sendServiceRequest(socketPath, request);
    if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
    return response.result;
  };
  let includeKindsUnsupported = false;
  const readLegacyBotChat = async () => {
    const response = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 100 });
    if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
    return botChatViewV1Schema.parse(response.result);
  };
  const readBotChat = async () => {
    if (includeKindsUnsupported) return readLegacyBotChat();
    const response = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 100, includeKinds: true });
    if (!response.ok) {
      if (isUnsupportedIncludeKindsError(response.error)) {
        includeKindsUnsupported = true;
        return readLegacyBotChat();
      }
      throw new Error(response.error.code + ": " + response.error.message);
    }
    return botChatViewV1Schema.parse(response.result);
  };
  const readSelectedRun = async (workflowId: string, selection?: ViewerRunSelection) => {
    const requestedRunId = selection?.runId ?? null;
    const direction = selection?.direction;
    const runs: RunSummaryDto[] = [];
    const runIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let total: number | undefined;
    let highWaterMark: number | undefined;

    for (;;) {
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error("service repeated a run-page cursor");
        cursors.add(cursor);
      }
      const response = await sendServiceRequest(socketPath, {
        version: 1, method: "runs", workflowId, limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
      const page = serviceRunsPageV1Schema.parse(response.result);
      if (page.workflowId !== workflowId) throw new Error("service returned run history for a different workflow");
      if (total !== undefined && (page.total !== total || page.highWaterMark !== highWaterMark)) {
        throw new Error("run pages changed their admission snapshot");
      }
      total = page.total;
      highWaterMark = page.highWaterMark;
      for (const run of page.runs) {
        if (run.workflowId !== workflowId) throw new Error("service returned a run for a different workflow");
        if (runIds.has(run.runId)) throw new Error("service repeated a run in its history");
        const previous = runs.at(-1);
        if (previous !== undefined && (previous.admittedAt < run.admittedAt
          || (previous.admittedAt === run.admittedAt && previous.runId >= run.runId))) {
          throw new Error("service returned run history out of newest-first order");
        }
        runIds.add(run.runId);
        runs.push(run);
      }
      if (page.nextCursor === null) {
        if (runs.length !== page.total) throw new Error("service ended run history before its snapshot was complete");
      } else {
        if (page.runs.length === 0 || runs.length >= page.total) throw new Error("service returned a truncated run page");
        if (cursors.has(page.nextCursor)) throw new Error("service repeated a run-page cursor");
      }

      let baseIndex = requestedRunId === null ? 0 : runs.findIndex(run => run.runId === requestedRunId);
      if (requestedRunId === null && direction === "older") baseIndex = 1;
      if (baseIndex >= 0) {
        let selectedIndex = baseIndex;
        if (requestedRunId !== null && direction === "older") selectedIndex += 1;
        else if (requestedRunId !== null && direction === "newer") selectedIndex = Math.max(0, selectedIndex - 1);
        if (selectedIndex < runs.length) {
          return { selectedRun: runs[selectedIndex]!, index: selectedIndex, total: page.total, followingLatest: selectedIndex === 0 };
        }
        if (page.nextCursor === null) {
          const selectedIndexAtEdge = Math.max(0, page.total - 1);
          return { selectedRun: runs[selectedIndexAtEdge] ?? null, index: selectedIndexAtEdge, total: page.total,
            followingLatest: selectedIndexAtEdge === 0 };
        }
      } else if (page.nextCursor === null) {
        throw new Error(`service no longer lists admitted run ${requestedRunId}`);
      }

      if (page.nextCursor === null) {
        return { selectedRun: null, index: 0, total: 0, followingLatest: true };
      }
      cursor = page.nextCursor;
    }
  };
  return {
    async snapshot(workflowId, expanded = [], selection) {
      const status = statusDtoSchema.parse(await read({ version: 1, method: "status" }));
      const bot = await readBotChat();
      const botEntries = bot.entries;
      if (workflowId === null) return { status, detail: null, botEntries, botConfigured: bot.configured };
      const workflow = status.workflows.find(entry => entry.workflowId === workflowId);
      if (!workflow) throw new Error("No workflow " + JSON.stringify(workflowId));
      const runSelection = await readSelectedRun(workflowId, selection);
      if (workflow.configurationError && runSelection.selectedRun === null) {
        return { status, selectedRun: null,
          runPosition: { index: runSelection.index, total: runSelection.total, followingLatest: runSelection.followingLatest },
          detail: null, botEntries, botConfigured: bot.configured };
      }
      const selectedRunId = runSelection.selectedRun?.runId ?? null;
      const diagram = diagramDtoSchema.parse(await read({ version: 1, method: "diagram", workflowId,
        ...(selectedRunId === null ? {} : { runId: selectedRunId }) }));
      if (diagram.workflowId !== workflowId || diagram.runId !== selectedRunId
        || (runSelection.selectedRun !== null && diagram.definitionHash !== runSelection.selectedRun.definitionHash)) {
        throw new Error("Service changed the selected run, workflow, or frozen definition");
      }
      const nodes = await Promise.all(diagram.nodes.map(async entry => {
        const description = nodeDescriptionDtoSchema.parse(await read({ version: 1, method: "node.describe", workflowId,
          nodeId: entry.nodeId, ...(selectedRunId === null ? {} : { runId: selectedRunId }) }));
        if (description.workflowId !== workflowId || description.runId !== selectedRunId
          || description.definitionHash !== diagram.definitionHash || description.node.nodeId !== entry.nodeId) {
          throw new Error("Service changed the selected run, workflow, or frozen step");
        }
        return description.node;
      }));
      if (selectedRunId !== null && nodes.some(node => expanded.includes(node.nodeId) && node.evidenceTruncated)) {
        const evidence = new Map<string, string>();
        await streamServiceLogChunks(socketPath, workflowId, selectedRunId, (section, _runId, chunk) => {
          if (section.kind !== "capture") return;
          evidence.set(section.executionId, (evidence.get(section.executionId) ?? "") + (chunk.offsetBytes === 0 ? "\n" + section.label + "\n" : "") + (section.content ?? "Evidence unavailable"));
        });
        for (const [index, node] of nodes.entries()) {
          if (!expanded.includes(node.nodeId) || !node.evidenceTruncated) continue;
          const attempt = node.attempts.at(-1);
          const ids = [...new Set(attempt?.processes.map(process => process.executionId) ?? [])];
          nodes[index] = { ...node, failureEvidence: ids.map(id => evidence.get(id) ?? "Evidence unavailable").join("\n"), evidenceTruncated: false };
        }
      }
      return { status, selectedRun: runSelection.selectedRun,
        runPosition: { index: runSelection.index, total: runSelection.total, followingLatest: runSelection.followingLatest },
        detail: { diagram, nodes }, botEntries, botConfigured: bot.configured };
    },
  };
}

function isUnsupportedIncludeKindsError(error: Extract<ServiceResponseV1, { readonly ok: false }>["error"]): boolean {
  if (error.code !== "invalid_arguments") return false;
  const details = error.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return false;
  const issues = (details as { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) return false;
  return issues.some(issue => {
    if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return false;
    const record = issue as Record<string, unknown>;
    if (record.code !== "unrecognized_keys") return false;
    if (Array.isArray(record.keys)) return record.keys.length === 1 && record.keys[0] === "includeKinds";
    return record.message === 'Unrecognized key: "includeKinds"'
      || record.message === 'Unrecognized keys: "includeKinds"';
  });
}
