import { sendServiceRequest, streamServiceLogChunks } from "../service/send-service-request.js";
import type { ServiceRequestV1 } from "../service/schema.js";
import type { ViewerSource } from "../tui/data-source.js";
import { diagramDtoSchema, nodeDescriptionDtoSchema, statusDtoSchema } from "../views/schema.js";
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

/** Reads only overview and one displayed run. No history or worklog polling. */
export function createViewerSource(socketPath: string): ViewerSource {
  const read = async (request: ServiceRequestV1) => {
    const response = await sendServiceRequest(socketPath, request);
    if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
    return response.result;
  };
  return {
    async snapshot(workflowId, expanded = []) {
      const status = statusDtoSchema.parse(await read({ version: 1, method: "status" }));
      const bot = botChatViewV1Schema.parse(await read({ version: 1, method: "chat.view", limit: 100 }));
      const botLines = bot.entries.map(entry => (entry.role === "user" ? "You: " : entry.role === "assistant" ? "Bot: " : "Bot activity: ") + entry.text);
      if (botLines.length === 0) botLines.push(bot.configured ? "No bot activity yet" : "Bot not configured");
      if (workflowId === null) return { status, detail: null, botLines: botLines.slice(-100) };
      const workflow = status.workflows.find(entry => entry.workflowId === workflowId);
      if (!workflow) throw new Error("No workflow " + JSON.stringify(workflowId));
      const run = workflow.unresolvedRun ?? workflow.latestRun;
      if (workflow.configurationError && run == null) return { status, detail: null };
      const diagram = diagramDtoSchema.parse(await read({ version: 1, method: "diagram", workflowId,
        ...(run == null ? {} : { runId: run.runId }) }));
      const nodes = await Promise.all(diagram.nodes.map(async entry => {
        const description = nodeDescriptionDtoSchema.parse(await read({ version: 1, method: "node.describe", workflowId,
          nodeId: entry.nodeId, ...(diagram.runId === null ? {} : { runId: diagram.runId }) }));
        if (description.runId !== diagram.runId || description.node.nodeId !== entry.nodeId) throw new Error("Service changed the selected run or step");
        return description.node;
      }));
      if (diagram.runId !== null && nodes.some(node => expanded.includes(node.nodeId) && node.evidenceTruncated)) {
        const evidence = new Map<string, string>();
        await streamServiceLogChunks(socketPath, workflowId, diagram.runId, (section, _runId, chunk) => {
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
      return { status, detail: { diagram, nodes }, botLines: botLines.slice(-100) };
    },
  };
}
