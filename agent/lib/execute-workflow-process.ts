import { spawn } from "node:child_process";
import type { ProcessExecutionRequest, ProcessExecutionResult } from "../../workflow/interpret-workflow.ts";

type ExecuteWorkflowProcessInput = ProcessExecutionRequest & {
  workflow: string;
  runId: string;
  dataDirectory: string;
  stateDirectory: string;
  cwd: string;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

export async function executeWorkflowProcess(input: ExecuteWorkflowProcessInput): Promise<ProcessExecutionResult> {
  "use step";

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
        // State indexes belong to the service, outside a workflow's working folder.
        WORKSHOP_STATE_DIR: input.stateDirectory,
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
    terminate(child, "SIGKILL");
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process pipes could not be opened" };
  }

  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let processError: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    stdoutStream.on("data", (chunk: Buffer) => stdout.push(chunk));
    stderrStream.on("data", (chunk: Buffer) => stderr.push(chunk));
    stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") processError = error.message;
    });
    child.once("error", (error) => { processError = error.message; });
    child.once("close", (exitCode, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        signal,
        ...(processError === undefined ? {} : { error: processError }),
      });
    });

    if (input.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          terminate(child, "SIGTERM");
          killTimer = setTimeout(() => {
            try {
              terminate(child, "SIGKILL");
            } catch (error) {
              processError = error instanceof Error ? error.message : String(error);
            }
          }, 1_000);
        } catch (error) {
          processError = error instanceof Error ? error.message : String(error);
        }
      }, input.timeoutMs);
    }
    stdin.end(input.input);
  });
}
