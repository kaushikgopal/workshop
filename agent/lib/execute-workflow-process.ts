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

function terminateGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) terminateGroup(child.pid, signal);
  else child.kill(signal);
}

const terminationGraceMs = 250;
const activeProcessGroups = new Map<string, Set<number>>();

function registerProcessGroup(runId: string, pid: number): () => void {
  const groups = activeProcessGroups.get(runId) ?? new Set<number>();
  groups.add(pid);
  activeProcessGroups.set(runId, groups);
  return () => {
    groups.delete(pid);
    if (groups.size === 0) activeProcessGroups.delete(runId);
  };
}

export async function cancelWorkflowProcesses(runId: string): Promise<void> {
  const groups = [...(activeProcessGroups.get(runId) ?? [])];
  if (groups.length === 0) return;
  let firstError: unknown;
  for (const pid of groups) {
    try {
      terminateGroup(pid, "SIGTERM");
    } catch (error) {
      firstError ??= error;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, terminationGraceMs));
  for (const pid of groups) {
    try {
      terminateGroup(pid, "SIGKILL");
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
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
  const unregister = child.pid === undefined ? () => {} : registerProcessGroup(input.runId, child.pid);
  if (!stdin || !stdoutStream || !stderrStream) {
    terminate(child, "SIGKILL");
    unregister();
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process pipes could not be opened" };
  }

  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let processError: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;
    let terminationComplete = false;
    let processClosed = false;
    let closeResult: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;

    const finish = () => {
      if (!processClosed || (terminationStarted && !terminationComplete) || !closeResult) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      unregister();
      resolve({
        ...closeResult,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        ...(processError === undefined ? {} : { error: processError }),
      });
    };
    const stopProcessGroup = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      try {
        terminate(child, "SIGTERM");
      } catch (error) {
        processError = error instanceof Error ? error.message : String(error);
      }
      setTimeout(() => {
        try {
          terminate(child, "SIGKILL");
        } catch (error) {
          processError = error instanceof Error ? error.message : String(error);
        } finally {
          terminationComplete = true;
          finish();
        }
      }, terminationGraceMs);
    };

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

    if (input.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stopProcessGroup();
      }, input.timeoutMs);
    }
    stdin.end(input.input);
  });
}
