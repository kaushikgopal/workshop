import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { executeWorkflowAttempt, type ProcessExecutionRequest, type ProcessExecutionResult, type WorkflowAttemptRequest, type WorkflowAttemptResult, type WorkflowInterpreterInput } from "./interpret-workflow.ts";
import type { Workflow, WorkflowStep } from "./types.ts";


export const STEP_ATTEMPT_TASK_NAME = "workshop.step-attempt";

export type StepAttemptTaskInput = {
  projectRoot: string;
  workflow: Workflow;
  step: WorkflowStep;
  documents: Record<string, string>;
  files: Record<string, string>;
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
  const interpreter: WorkflowInterpreterInput = {
    workflow: input.workflow,
    documents: input.documents,
    files: input.files,
    workflowRunId: input.runId,
    profileCommands: input.profileCommands,
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
    waitForDecision: async () => { throw new Error("A step-attempt task cannot wait for a workflow decision"); },
  };
  return await executeWorkflowAttempt(interpreter, { ...input.request, step: input.step });
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
