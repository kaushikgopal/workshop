import { dirname, join } from "node:path";

/** Identifies one process incarnation's temporary capture files. */
export interface ProcessFileIdentity {
  readonly role: "preflight" | "worker" | "validator";
  readonly nodeId: string | null;
  readonly attemptNumber: number | null;
  readonly incarnationNumber: number;
  readonly executionId: string;
}

/** Capture paths are process-scoped; readable projections are workflow-scoped. */
export interface ProcessFiles {
  readonly directory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultsPath: string;
  readonly logPath: string;
}

/** Return the current workflow projection directory, including for stored pre-upgrade records. */
export function locateWorkflowDirectory(run: {
  readonly workflowId: string;
  readonly paths: { readonly workflowDirectory?: unknown; readonly runDirectory?: unknown };
}): string {
  if (typeof run.paths.workflowDirectory === "string") return run.paths.workflowDirectory;
  if (typeof run.paths.runDirectory === "string") {
    return join(dirname(dirname(run.paths.runDirectory)), "state-v5", run.workflowId);
  }
  throw new Error("run has no workflow projection directory");
}

/** Locate capture and shared projection paths without creating files. */
export function locateProcessFiles(
  workflowDirectory: string,
  runId: string,
  identity: ProcessFileIdentity,
): ProcessFiles {
  const captureDirectory = join(dirname(workflowDirectory), "captures", runId);
  const directory = identity.role === "preflight"
    ? join(captureDirectory, "preflight", identity.executionId)
    : join(captureDirectory, requireValue(identity.nodeId) + "." + requireValue(identity.attemptNumber), identity.executionId);
  const stem = identity.incarnationNumber === 1 ? identity.role : identity.role + "." + identity.incarnationNumber;
  return {
    directory,
    stdoutPath: join(directory, stem + ".stdout"),
    stderrPath: join(directory, stem + ".stderr"),
    resultsPath: join(workflowDirectory, "results.md"),
    logPath: join(workflowDirectory, "execution.log"),
  };
}

function requireValue<T>(value: T | null): T {
  if (value === null) throw new Error("node process files require a node and attempt");
  return value;
}
