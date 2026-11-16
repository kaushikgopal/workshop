import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { WORKFLOW_TASK_NAME } from "../workflow/define-workflow-task.ts";
import { checkpointOf, checkpointPhase, taskForRun } from "./read-workshop-status.ts";

type FailureRound = { runId: string; step: string; attempt: number; decisionNumber: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailureRoundRequestId(requestId: string | undefined): Omit<FailureRound, "decisionNumber"> | undefined {
  const match = requestId === undefined ? null : /^round:([^:]+):(.+):([1-9][0-9]*)$/.exec(requestId);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const attempt = Number(match[3]);
  if (!Number.isSafeInteger(attempt)) return undefined;
  return { runId: match[1], step: match[2], attempt };
}

export async function resolveFailureRound(harness: Harness, taskId: TaskId): Promise<FailureRound | undefined> {
  const tool = await harness.getTask(taskId, BACKGROUND_CONTEXT);
  if (!tool) throw new Error("Decision tool task is unavailable");
  const root = await harness.root(BACKGROUND_CONTEXT);
  if (tool.conversationId !== root.id) throw new Error("Blocked-run decisions are only available in the root conversation");

  const live = await harness.snapshot(LiveDoc, tool.conversationId, BACKGROUND_CONTEXT);
  if (!live?.run) throw new Error("Blocked-run decision has no active orchestrator turn");
  const rounds: Omit<FailureRound, "decisionNumber">[] = [];
  for (const submissionId of live.run.inputs) {
    const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
    const record = await submission?.status(BACKGROUND_CONTEXT);
    if (!record?.requestId?.startsWith("round:")) continue;
    const round = parseFailureRoundRequestId(record.requestId);
    if (!round) throw new Error("Automatic failure round has an invalid request ID");
    rounds.push(round);
  }
  if (rounds.length === 0) return undefined;
  if (rounds.length !== 1) throw new Error("This orchestrator turn contains multiple failure rounds; no blocked-run decision was applied");
  const round = rounds[0];
  if (!round) throw new Error("Automatic failure round context is unavailable");

  if (!isRecord(tool.input) || tool.input.kind !== "model" ||
    (typeof tool.input.assistant !== "string" && typeof tool.input.assistant !== "number") || tool.owner === undefined) {
    throw new Error("Automatic failure round tool context is unavailable");
  }
  const generation = await harness.getTask(tool.owner, BACKGROUND_CONTEXT);
  if (!generation || generation.kind !== "pi.generation" || !isRecord(generation.state)) {
    throw new Error("Automatic failure round generation is unavailable");
  }
  const generationCheckpoint = generation.state.checkpoint;
  if (!isRecord(generationCheckpoint) || generationCheckpoint.phase !== "tools" ||
    generationCheckpoint.assistant !== tool.input.assistant || !Array.isArray(generationCheckpoint.tools) ||
    !generationCheckpoint.tools.some((id) => String(id) === String(tool.id)) ||
    String(live.run.taskId) !== String(generation.id)) {
    throw new Error("Automatic failure round does not match the current tool call");
  }

  const record = await taskForRun(harness, round.runId);
  const checkpoint = record === undefined ? undefined : checkpointOf(record);
  if (!record || record.kind !== WORKFLOW_TASK_NAME || !checkpoint || checkpointPhase(record) !== "blocked" ||
    checkpoint.phase !== "blocked" || checkpoint.failure.step !== round.step ||
    checkpoint.failure.attemptHistory.at(-1)?.attempt !== round.attempt) {
    throw new Error("This failure round no longer matches its blocked step");
  }
  return { ...round, decisionNumber: checkpoint.failure.decisionNumber };
}
