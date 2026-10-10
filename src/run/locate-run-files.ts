import { join } from "node:path";

/** Identifies one process incarnation's files inside its run folder. */
export interface ProcessFileIdentity {
  readonly role: "preflight" | "worker" | "validator";
  readonly nodeId: string | null;
  readonly attemptNumber: number | null;
  readonly incarnationNumber: number;
}

/** Files one process reads or writes. Paths are computed; nothing touches disk. */
export interface ProcessFiles {
  readonly directory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly promptPath: string;
  readonly resultPath: string;
  readonly previousOutputPath: string;
  readonly candidateOutputPath: string;
  readonly worklogPath: string;
}

/**
 * Locates `runs/<run>/<step>.<attempt>/` or `runs/<run>/preflight/`.
 * A safe replay numbers its files (`worker.2.stdout`) so it never overwrites
 * the committed captures of an earlier incarnation.
 */
export function locateProcessFiles(runDirectory: string, identity: ProcessFileIdentity): ProcessFiles {
  const directory = identity.role === "preflight"
    ? join(runDirectory, "preflight")
    : join(runDirectory, `${requireValue(identity.nodeId)}.${requireValue(identity.attemptNumber)}`);
  const stem = identity.incarnationNumber === 1 ? identity.role : `${identity.role}.${identity.incarnationNumber}`;
  return {
    directory,
    stdoutPath: join(directory, `${stem}.stdout`),
    stderrPath: join(directory, `${stem}.stderr`),
    promptPath: join(directory, `${stem}.prompt.md`),
    resultPath: join(directory, `${stem}.result.json`),
    previousOutputPath: join(directory, "previous-output.txt"),
    candidateOutputPath: join(directory, "candidate-output.txt"),
    worklogPath: join(directory, "worklog.md"),
  };
}

function requireValue<T>(value: T | null): T {
  if (value === null) throw new Error("node process files require a node and attempt");
  return value;
}
