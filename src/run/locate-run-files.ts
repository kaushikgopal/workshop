import { basename, dirname, join } from "node:path";

/** Identifies one process incarnation's temporary capture files. */
export interface ProcessFileIdentity {
  readonly role: "preflight" | "worker" | "validator";
  readonly nodeId: string | null;
  readonly attemptNumber: number | null;
  readonly incarnationNumber: number;
  readonly executionId: string;
}

/** Capture paths are process-scoped; readable projections are run-scoped. */
export interface ProcessFiles {
  readonly directory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultsPath: string;
  readonly logPath: string;
}

/** Locate capture paths without creating files. */
export function locateProcessFiles(runDirectory: string, identity: ProcessFileIdentity): ProcessFiles {
  const captureDirectory = join(dirname(dirname(runDirectory)), "state", "captures", basename(runDirectory));
  const directory = identity.role === "preflight"
    ? join(captureDirectory, "preflight", identity.executionId)
    : join(captureDirectory, `${requireValue(identity.nodeId)}.${requireValue(identity.attemptNumber)}`);
  const stem = identity.incarnationNumber === 1 ? identity.role : `${identity.role}.${identity.incarnationNumber}`;
  return {
    directory,
    stdoutPath: join(directory, `${stem}.stdout`),
    stderrPath: join(directory, `${stem}.stderr`),
    resultsPath: join(runDirectory, "results.md"),
    logPath: join(runDirectory, "execution.log"),
  };
}

function requireValue<T>(value: T | null): T {
  if (value === null) throw new Error("node process files require a node and attempt");
  return value;
}
