import { spawn } from "node:child_process";
import type { ProcessExecutionRequest, ProcessExecutionResult } from "../workflow/interpret-workflow.ts";

type ExecuteWorkflowProcessInput = ProcessExecutionRequest & {
  workflow: string;
  runId: string;
  projectRoot: string;
  dataDirectory: string;
  stateDirectory: string;
  cwd: string;
  signal?: AbortSignal;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function terminateGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

const terminationGraceMs = 250;

export type ProcessStopCause = { kind: "aborted" } | { kind: "timeout" };
type ProcessExitCause = ProcessStopCause | { kind: "completed" };
type ProcessCloseResult = { exitCode: number | null; signal: NodeJS.Signals | null };

export type WorkflowProcessState =
  | { kind: "spawning" }
  | { kind: "running" }
  | { kind: "stopping"; cause: ProcessStopCause; phase: "waiting-for-close-and-grace" }
  | { kind: "stopping"; cause: ProcessStopCause; phase: "waiting-for-grace"; closeResult: ProcessCloseResult }
  | { kind: "stopping"; cause: ProcessStopCause; phase: "waiting-for-close" }
  | { kind: "exited"; cause: ProcessExitCause; closeResult: ProcessCloseResult };

export type WorkflowProcessEvent =
  | { kind: "spawned" }
  | { kind: "stop-requested"; cause: ProcessStopCause }
  | { kind: "closed"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "grace-elapsed" };

export type WorkflowProcessEffect =
  | { kind: "signal"; signal: "SIGTERM" | "SIGKILL" }
  | { kind: "schedule-kill"; delayMs: number };

export type WorkflowProcessTransition =
  | { kind: "accepted"; state: WorkflowProcessState; effects: WorkflowProcessEffect[] }
  | { kind: "rejected"; code: "out-of-order" | "already-stopping" | "already-exited"; message: string };

export function createWorkflowProcessState(): WorkflowProcessState {
  return { kind: "spawning" };
}

function processAccepted(state: WorkflowProcessState, effects: WorkflowProcessEffect[] = []): WorkflowProcessTransition {
  return { kind: "accepted", state, effects };
}

function rejectProcessEvent(state: WorkflowProcessState, message: string): WorkflowProcessTransition {
  return state.kind === "exited"
    ? { kind: "rejected", code: "already-exited", message: "Process has already exited" }
    : { kind: "rejected", code: "out-of-order", message };
}

export function transitionWorkflowProcess(
  state: WorkflowProcessState,
  event: WorkflowProcessEvent,
 ): WorkflowProcessTransition {
  if (event.kind === "spawned") {
    return state.kind === "spawning"
      ? processAccepted({ kind: "running" })
      : rejectProcessEvent(state, `Cannot start a process while it is ${state.kind}`);
  }
  if (event.kind === "stop-requested") {
    if (state.kind === "running") {
      return processAccepted(
        { kind: "stopping", cause: event.cause, phase: "waiting-for-close-and-grace" },
        [{ kind: "signal", signal: "SIGTERM" }, { kind: "schedule-kill", delayMs: terminationGraceMs }],
      );
    }
    if (state.kind === "stopping") {
      return { kind: "rejected", code: "already-stopping", message: `Process is already stopping for ${state.cause.kind}` };
    }
    return rejectProcessEvent(state, `Cannot stop a process while it is ${state.kind}`);
  }
  if (event.kind === "closed") {
    const closeResult = { exitCode: event.exitCode, signal: event.signal };
    if (state.kind === "running") {
      return processAccepted({ kind: "exited", cause: { kind: "completed" }, closeResult });
    }
    if (state.kind !== "stopping") return rejectProcessEvent(state, `Cannot close a process while it is ${state.kind}`);
    if (state.phase === "waiting-for-close-and-grace") {
      return processAccepted({ kind: "stopping", cause: state.cause, phase: "waiting-for-grace", closeResult });
    }
    if (state.phase === "waiting-for-close") {
      return processAccepted({ kind: "exited", cause: state.cause, closeResult });
    }
    return { kind: "rejected", code: "out-of-order", message: "Process has already closed while waiting for termination grace" };
  }
  if (state.kind !== "stopping") return rejectProcessEvent(state, `Cannot finish termination grace while process is ${state.kind}`);
  if (state.phase === "waiting-for-close-and-grace") {
    return processAccepted(
      { kind: "stopping", cause: state.cause, phase: "waiting-for-close" },
      [{ kind: "signal", signal: "SIGKILL" }],
    );
  }
  if (state.phase === "waiting-for-grace") {
    return processAccepted(
      { kind: "exited", cause: state.cause, closeResult: state.closeResult },
      [{ kind: "signal", signal: "SIGKILL" }],
    );
  }
  return { kind: "rejected", code: "out-of-order", message: "Termination grace has already elapsed" };
}


export async function executeWorkflowProcess(input: ExecuteWorkflowProcessInput): Promise<ProcessExecutionResult> {
  if (input.signal?.aborted) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process cancelled before it started" };
  }
  const [executable, ...args] = input.command;
  if (!executable) return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process command is empty" };

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        WORKSHOP_WORKFLOW: input.workflow,
        WORKSHOP_RUN_ID: input.runId,
        WORKSHOP_STEP: input.step,
        WORKSHOP_DATA_DIR: input.dataDirectory,
        WORKSHOP_STATE_DIR: input.stateDirectory,
        WORKSHOP_PROJECT_ROOT: input.projectRoot,
        WORKSHOP_FEEDBACK: input.feedback,
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) };
  }

  const stdin = child.stdin;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdin || !stdoutStream || !stderrStream) {
    if (child.pid !== undefined) terminateGroup(child.pid, "SIGKILL");
    else child.kill("SIGKILL");
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process pipes could not be opened" };
  }

  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let state = createWorkflowProcessState();
    let processError: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (state.kind !== "exited") return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        ...state.closeResult,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: state.cause.kind === "timeout",
        ...(processError === undefined ? {} : { error: processError }),
      });
    };
    const dispatch = (event: WorkflowProcessEvent): void => {
      const transition = transitionWorkflowProcess(state, event);
      if (transition.kind !== "accepted") return;
      state = transition.state;
      for (const effect of transition.effects) {
        if (effect.kind === "signal") {
          try {
            if (child.pid !== undefined) terminateGroup(child.pid, effect.signal);
            else child.kill(effect.signal);
          } catch (error) {
            processError ??= error instanceof Error ? error.message : String(error);
          }
        } else {
          killTimer = setTimeout(() => dispatch({ kind: "grace-elapsed" }), effect.delayMs);
        }
      }
      finish();
    };
    const stopProcessGroup = (cause: ProcessStopCause) => dispatch({ kind: "stop-requested", cause });
    const onAbort = () => stopProcessGroup({ kind: "aborted" });

    stdoutStream.on("data", (chunk: Buffer) => stdout.push(chunk));
    stderrStream.on("data", (chunk: Buffer) => stderr.push(chunk));
    stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") processError = error.message;
    });
    child.once("error", (error) => { processError = error.message; });
    child.once("close", (exitCode, exitSignal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      dispatch({ kind: "closed", exitCode, signal: exitSignal });
    });
    dispatch({ kind: "spawned" });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => stopProcessGroup({ kind: "timeout" }), input.timeoutMs);
    }
    stdin.end(input.input);
  });
}
