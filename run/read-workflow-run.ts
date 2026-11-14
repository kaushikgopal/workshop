import type { BlockedWorkflowStep, RunIndexEntry } from "./types.ts";

export type WorkflowRunInspection = {
  status: string;
  returnValue?: unknown;
  error?: string;
};

export type WorkflowRunDetails = {
  run_id: string;
  workflow: string;
  slot: string | null;
  started_at: string;
  status: string;
  steps?: unknown[];
  output?: unknown;
  error?: string;
  blocked_step?: {
    step: string;
    last_error: string;
    last_output?: string;
    attempt_history?: BlockedWorkflowStep["attempt_history"];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[truncated; showing last ${limit} characters]\n${value.slice(-limit)}`;
}

export async function readWorkflowRun(
  runId: string,
  entries: readonly RunIndexEntry[],
  ports: {
    inspect(runId: string): Promise<WorkflowRunInspection>;
    readBlocked(runId: string): BlockedWorkflowStep | undefined;
  },
): Promise<WorkflowRunDetails> {
  const entry = [...entries].reverse().find((candidate) => candidate.run_id === runId);
  if (!entry) throw new Error(`Workflow run ${runId} is not in the run index`);

  let inspection: WorkflowRunInspection;
  try {
    inspection = await ports.inspect(runId);
  } catch (error) {
    inspection = { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
  const result = isRecord(inspection.returnValue) ? inspection.returnValue : undefined;
  const blocked = ports.readBlocked(runId);
  return {
    run_id: runId,
    workflow: entry.workflow,
    slot: entry.slot,
    started_at: entry.at,
    status: inspection.status,
    ...(Array.isArray(result?.steps) ? { steps: result.steps } : {}),
    ...(result && Object.hasOwn(result, "output") ? { output: result.output } : {}),
    ...(inspection.error === undefined ? {} : { error: inspection.error }),
    ...(blocked === undefined ? {} : {
      blocked_step: {
        step: blocked.step,
        last_error: blocked.last_error,
        ...(blocked.last_output === undefined ? {} : { last_output: outputTail(blocked.last_output, 4_000) }),
        ...(blocked.attempt_history === undefined ? {} : {
          attempt_history: blocked.attempt_history.map((attempt) => ({
            ...attempt,
            output: outputTail(attempt.output, 2_000),
            ...(attempt.error === undefined ? {} : { error: outputTail(attempt.error, 2_000) }),
          })),
        }),
      },
    }),
  };
}
