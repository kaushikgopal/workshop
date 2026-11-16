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

type ProcessStopCause = { kind: "aborted" } | { kind: "timeout" };


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
    let stopCause: ProcessStopCause | undefined;
    let processError: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let terminationComplete = true;
    let processClosed = false;
    let closeResult: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;

    const finish = () => {
      if (!processClosed || !terminationComplete || !closeResult) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        ...closeResult,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: stopCause?.kind === "timeout",
        ...(processError === undefined ? {} : { error: processError }),
      });
    };
    const stopProcessGroup = (cause: ProcessStopCause) => {
      if (stopCause !== undefined) return;
      stopCause = cause;
      terminationComplete = false;
      try {
        if (child.pid !== undefined) terminateGroup(child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch (error) {
        processError = error instanceof Error ? error.message : String(error);
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) terminateGroup(child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (error) {
          processError ??= error instanceof Error ? error.message : String(error);
        } finally {
          terminationComplete = true;
          finish();
        }
      }, terminationGraceMs);
    };
    const onAbort = () => stopProcessGroup({ kind: "aborted" });

    stdoutStream.on("data", (chunk: Buffer) => stdout.push(chunk));
    stderrStream.on("data", (chunk: Buffer) => stderr.push(chunk));
    stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") processError = error.message;
    });
    child.once("error", (error) => { processError = error.message; });
    child.once("close", (exitCode, exitSignal) => {
      processClosed = true;
      closeResult = { exitCode, signal: exitSignal };
      if (timeoutTimer) clearTimeout(timeoutTimer);
      finish();
    });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => stopProcessGroup({ kind: "timeout" }), input.timeoutMs);
    }
    stdin.end(input.input);
  });
}
