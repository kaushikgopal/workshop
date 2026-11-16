import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { executeWorkflowAttempt, type WorkflowAttemptRequest, type WorkflowAttemptResult, type WorkflowInterpreterInput } from "./interpret-workflow.ts";
import type { Workflow, WorkflowStep } from "./types.ts";

export const STEP_ATTEMPT_TASK_NAME = "workshop.step-attempt";

export type StepAttemptTaskInput = {
  projectRoot: string;
  workflow: Workflow;
  step: WorkflowStep;
  documents: Record<string, string>;
  files: Record<string, string>;
  contents: Record<string, string>;
  profileCommands: Record<string, string[]>;
  runId: string;
  dataDirectory: string;
  stateDirectory: string;
  request: WorkflowAttemptRequest;
};

type StepAttemptCheckpoint = { phase: "execute" };
type StepAttemptRuntime = TaskRuntime<StepAttemptTaskInput, StepAttemptCheckpoint, WorkflowAttemptResult, object>;

async function executeAttemptTask(input: StepAttemptTaskInput, runtime: StepAttemptRuntime): Promise<WorkflowAttemptResult> {
  const interpreter: WorkflowInterpreterInput = {
    workflow: input.workflow,
    documents: input.documents,
    files: input.files,
    contents: input.contents,
    workflowRunId: input.runId,
    profileCommands: input.profileCommands,
    executeProcess: (request) => executeWorkflowProcess({
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

export const StepAttemptTask = defineTask<StepAttemptTaskInput, StepAttemptCheckpoint, WorkflowAttemptResult, object>({
  name: STEP_ATTEMPT_TASK_NAME,
  version: 1,
  initial: (): StepAttemptCheckpoint => ({ phase: "execute" }),
  phases: {
    execute: async (task, runtime, context) => {
      const result = await executeAttemptTask(task.input, runtime);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), context);
  },
});
