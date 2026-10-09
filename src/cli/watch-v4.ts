import { readServiceWorklog, sendServiceRequest } from "../service/send-service-request.js";
import { serviceRunsPageV1Schema } from "../service/schema.js";
import type { ViewerSource } from "../tui/data-source.js";
import type { ActivationDto, NodeStatusDto, StatusDto } from "../views/build-status-json.js";
import { DEFAULT_RUNS_LIMIT, type RunsFeed, type RunsFeedEntry } from "../views/build-runs-json.js";
import {
  diagramDtoV2Schema,
  nodeDescriptionDtoV2Schema,
  statusDtoV2Schema,
  type RunSummaryDtoV2,
  type StatusDtoV2,
} from "../views/schema-v2.js";

export async function openV4Watch(socketPath: string, workflowId: string | null): Promise<void> {
  const source = createV4ViewerSource(socketPath);
  const status = await readStatus(socketPath);
  if (workflowId !== null && !status.workflows.some((workflow) => workflow.workflowId === workflowId)) {
    throw new Error(`no workflow ${JSON.stringify(workflowId)}`);
  }
  if (workflowId === null && status.workflows.length === 0) throw new Error("no workflows configured");
  const { openViewer } = await import("../tui/mount-viewer.js");
  await openViewer({ workflowId, source });
}

/** The v4 viewer consumes the service's public DTOs; it never reads run files or SQLite. */
export function createV4ViewerSource(socketPath: string): ViewerSource {
  let currentRuns: RunSummaryDtoV2[] = [];
  return {
    async snapshot(workflowId, selectedRunId) {
      const status = await readStatus(socketPath, workflowId ?? undefined);
      if (workflowId === null) {
        currentRuns = [];
        return { status: adaptStatus(status), runs: emptyFeed() };
      }

      const history = await readAllRunSummaries(socketPath, workflowId);
      currentRuns = history.runs;
      const selected = selectedRunId === null || selectedRunId === undefined
        ? history.runs[0]
        : history.runs.find((run) => run.runId === selectedRunId) ?? history.runs[0];
      const selectedNodes = selected === undefined
        ? []
        : await readSelectedRunNodes(socketPath, workflowId, selected.runId);
      return {
        status: adaptStatus(status, selected?.runId, selectedNodes),
        runs: adaptRuns(workflowId, history.total, history.runs, selected?.runId, selectedNodes),
      };
    },
    async log(workflowId, runId) {
      if (workflowId === null) return "";
      if (runId !== null) {
        const run = currentRuns.find((entry) => entry.runId === runId);
        return run === undefined ? "(run not found)" : await readWorklog(socketPath, workflowId, run.runId);
      }
      const oldestFirst = currentRuns.slice().reverse();
      const sections: string[] = [];
      for (const run of oldestFirst) {
        sections.push(`\n━━ run ${run.runId} — ${run.status} ━━\n`);
        sections.push(await readWorklog(socketPath, workflowId, run.runId));
      }
      return sections.join("");
    },
  };
}

async function readStatus(socketPath: string, workflowId?: string): Promise<StatusDtoV2> {
  const response = await sendServiceRequest(socketPath, {
    version: 1,
    method: "status",
    ...(workflowId === undefined ? {} : { workflowId }),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return statusDtoV2Schema.parse(response.result);
}

async function readAllRunSummaries(
  socketPath: string,
  workflowId: string,
): Promise<{ readonly total: number; readonly runs: RunSummaryDtoV2[] }> {
  const runs: RunSummaryDtoV2[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let total: number | undefined;
  let highWaterMark: number | undefined;
  do {
    const response = await sendServiceRequest(socketPath, {
      version: 1,
      method: "runs",
      workflowId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    const page = serviceRunsPageV1Schema.parse(response.result);
    if (total !== undefined && (page.total !== total || page.highWaterMark !== highWaterMark)) {
      throw new Error("run pages changed their admission snapshot");
    }
    total = page.total;
    highWaterMark = page.highWaterMark;
    runs.push(...page.runs);
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) throw new Error("service repeated a run-page cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  if (runs.length !== (total ?? 0)) throw new Error("service ended run history before its snapshot was complete");
  return { total: total ?? 0, runs };
}

async function readSelectedRunNodes(
  socketPath: string,
  workflowId: string,
  runId: RunSummaryDtoV2["runId"],
): Promise<NodeStatusDto[]> {
  const response = await sendServiceRequest(socketPath, { version: 1, method: "diagram", workflowId, runId });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const diagram = diagramDtoV2Schema.parse(response.result);
  if (diagram.runId !== runId) throw new Error("service returned a different run diagram");
  return Promise.all(diagram.nodes.map(async (diagramNode) => {
    const nodeResponse = await sendServiceRequest(socketPath, {
      version: 1,
      method: "node.describe",
      workflowId,
      nodeId: diagramNode.nodeId,
      runId,
    });
    if (!nodeResponse.ok) throw new Error(`${nodeResponse.error.code}: ${nodeResponse.error.message}`);
    const description = nodeDescriptionDtoV2Schema.parse(nodeResponse.result);
    if (description.runId !== runId || description.node.nodeId !== diagramNode.nodeId) {
      throw new Error("service returned node details for a different run or node");
    }
    return {
      id: description.node.nodeId,
      status: displayNodeStatus(description.node.status),
      attempts: description.node.attempts.map((attempt) => ({
        number: attempt.number,
        status: attempt.status,
        progress: attempt.phase,
        validator: attempt.verdict === null ? null : attempt.failure?.kind === "validator_rejection" ? "failed" : "passed",
        failure: attempt.failure?.kind ?? null,
        blocker: attempt.blocks.at(-1)?.kind ?? null,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      })),
    };
  }));
}

async function readWorklog(socketPath: string, workflowId: string, runId: RunSummaryDtoV2["runId"]): Promise<string> {
  return readServiceWorklog(socketPath, workflowId, runId);
}

function adaptStatus(status: StatusDtoV2, selectedRunId?: RunSummaryDtoV2["runId"], selectedNodes: NodeStatusDto[] = []): StatusDto {
  return {
    version: 1,
    workflows: status.workflows.map((workflow) => {
      const run = workflow.unresolvedRun;
      return {
        id: workflow.workflowId,
        definitionHash: workflow.definitionHash ?? "",
        activation: workflow.activation === null ? null : adaptActivation(workflow.activation),
        currentRun: run === null ? null : {
          id: run.runId,
          status: run.status,
          desiredState: run.desiredState,
          orchestratorPhase: "durable",
          startedAt: run.startedAt ?? run.admittedAt,
          blocker: run.block?.kind ?? run.failure?.kind ?? null,
          nodes: run.runId === selectedRunId ? selectedNodes : [],
        },
      };
    }),
  };
}

function adaptActivation(activation: NonNullable<StatusDtoV2["workflows"][number]["activation"]>): ActivationDto {
  return {
    state: activation.state,
    startedAt: activation.activatedAt,
    startedRuns: activation.admittedCount,
    maxRuns: activation.maxRuns === "unlimited" ? null : activation.maxRuns,
    nextRunAt: activation.nextDueAt,
  };
}

function adaptRuns(
  workflowId: string,
  total: number,
  runs: RunSummaryDtoV2[],
  selectedRunId: RunSummaryDtoV2["runId"] | undefined,
  selectedNodes: NodeStatusDto[],
): RunsFeed {
  return {
    version: 1,
    workflowId,
    total,
    runs: runs.slice(0, DEFAULT_RUNS_LIMIT).map((run) => adaptRun(run, run.runId === selectedRunId ? selectedNodes : [])),
  };
}

function adaptRun(run: RunSummaryDtoV2, nodes: NodeStatusDto[]): RunsFeedEntry {
  return {
    id: run.runId,
    status: run.status,
    desiredState: run.desiredState,
    startedAt: run.startedAt ?? run.admittedAt,
    finishedAt: run.finishedAt,
    blocker: run.block?.kind ?? run.failure?.kind ?? null,
    nodes,
  };
}

function displayNodeStatus(status: string): string {
  return status === "succeeded" ? "completed" : status;
}

function emptyFeed(): RunsFeed {
  return { version: 1, workflowId: "", total: 0, runs: [] };
}

