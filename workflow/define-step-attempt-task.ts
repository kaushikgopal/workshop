import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { executeWorkflowAttempt, type ProcessExecutionRequest, type ProcessExecutionResult, type WorkflowAttemptEnvironment, type WorkflowAttemptRequest, type WorkflowAttemptResult } from "./execute-workflow-attempt.ts";
import type { Workflow, WorkflowStep } from "./types.ts";


export const STEP_ATTEMPT_TASK_NAME = "workshop.step-attempt";

export type StepAttemptSource =
  | { documents: Record<string, string>; files: Record<string, string> }
  | { loadError: string };

export type StepAttemptTaskInput = StepAttemptSource & {
  projectRoot: string;
  workflow: Workflow;
  step: WorkflowStep;
  profileCommands: Record<string, string[]>;
  runId: string;
  dataDirectory: string;
  stateDirectory: string;
  request: WorkflowAttemptRequest;
};

type StepAttemptCheckpoint = { phase: "execute" };
type StepAttemptRuntime = TaskRuntime<StepAttemptTaskInput, StepAttemptCheckpoint, WorkflowAttemptResult, object>;
export type StepAttemptProcessRequest = ProcessExecutionRequest & {
  workflow: string;
  runId: string;
  projectRoot: string;
  dataDirectory: string;
  stateDirectory: string;
  cwd: string;
  signal: AbortSignal;
};
export type StepAttemptProcessExecutor = (request: StepAttemptProcessRequest) => Promise<ProcessExecutionResult>;

const unconfiguredProcessExecutor: StepAttemptProcessExecutor = async () => ({
  exitCode: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  error: "Step attempt task has no process executor",
});

async function executeAttemptTask(
  input: StepAttemptTaskInput,
  runtime: StepAttemptRuntime,
  executeProcess: StepAttemptProcessExecutor,
): Promise<WorkflowAttemptResult> {
  if ("loadError" in input) return { kind: "failed", output: "", reason: input.loadError };

  const attemptEnvironment: WorkflowAttemptEnvironment = {
    workflow: input.workflow,
    documents: input.documents,
    files: input.files,
    profileCommands: input.profileCommands,
    signal: runtime.signal,
    executeProcess: (request) => executeProcess({
      ...request,
      workflow: input.workflow.name,
      runId: input.runId,
      projectRoot: input.projectRoot,
      dataDirectory: input.dataDirectory,
      stateDirectory: input.stateDirectory,
      cwd: input.dataDirectory,
      signal: runtime.signal,
    }),
  };
  return await executeWorkflowAttempt(attemptEnvironment, { ...input.request, step: input.step });
}

export function createStepAttemptTask(executeProcess: StepAttemptProcessExecutor) {
  return defineTask<StepAttemptTaskInput, StepAttemptCheckpoint, WorkflowAttemptResult, object>({
    name: STEP_ATTEMPT_TASK_NAME,
    version: 1,
    initial: (): StepAttemptCheckpoint => ({ phase: "execute" }),
    phases: {
      execute: async (task, runtime, context) => {
        const result = await executeAttemptTask(task.input, runtime, executeProcess);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), context);
    },
  });
}

export const StepAttemptTask = createStepAttemptTask(unconfiguredProcessExecutor);
