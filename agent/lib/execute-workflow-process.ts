import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export async function executeWorkflowProcess(input: ExecuteWorkflowProcessInput): Promise<ProcessExecutionResult> {
  "use step";

  const [executable, ...args] = input.command;
  if (!executable) return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process command is empty" };

  type ProcessRecord = { run_id: string; process_group_ids: number[] };
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error(`Invalid workflow run ID: ${input.runId}`);
  const processRecordPath = join(input.stateDirectory, "processes", `${input.runId}.json`);
  const readProcessGroupIds = (): number[] => {
    let text: string;
    try {
      text = readFileSync(processRecordPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("run_id" in value) || value.run_id !== input.runId || !("process_group_ids" in value) || !Array.isArray(value.process_group_ids)) {
      throw new Error(`Invalid process record for workflow run ${input.runId}`);
    }
    const processGroupIds: number[] = [];
    for (const pid of value.process_group_ids) {
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process group ID for workflow run ${input.runId}`);
      processGroupIds.push(pid);
    }
    return processGroupIds;
  };
  const writeProcessGroupIds = (processGroupIds: number[]): void => {
    if (processGroupIds.length === 0) {
      rmSync(processRecordPath, { force: true });
      return;
    }
    mkdirSync(join(input.stateDirectory, "processes"), { recursive: true });
    const record: ProcessRecord = { run_id: input.runId, process_group_ids: processGroupIds };
    writeFileSync(processRecordPath, `${JSON.stringify(record)}\n`);
  };
  const registerProcessGroup = (pid: number): (() => void) => {
    writeProcessGroupIds([...readProcessGroupIds(), pid]);
    return () => writeProcessGroupIds(readProcessGroupIds().filter((processGroupId) => processGroupId !== pid));
  };

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
  let unregister = () => {};
  let trackingError: string | undefined;
  if (child.pid !== undefined) {
    try {
      unregister = registerProcessGroup(child.pid);
    } catch (error) {
      trackingError = error instanceof Error ? error.message : String(error);
      try {
        terminateGroup(child.pid, "SIGKILL");
      } catch (killError) {
        trackingError += `; could not stop untracked process: ${killError instanceof Error ? killError.message : String(killError)}`;
      }
    }
  }
  if (!stdin || !stdoutStream || !stderrStream) {
    terminate(child, "SIGKILL");
    unregister();
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "process pipes could not be opened" };
  }

  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let processError: string | undefined = trackingError;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;
    let terminationComplete = false;
    let processClosed = false;
    let closeResult: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;

    const finish = () => {
      if (!processClosed || (terminationStarted && !terminationComplete) || !closeResult) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        unregister();
      } catch (error) {
        processError ??= error instanceof Error ? error.message : String(error);
      }
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
