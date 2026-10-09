import { join } from "node:path";

/** Every path a proof run may touch; all of them live under the state dir. */
export interface ProofFiles {
  runDir: string;
  promptFile: string;
  previousOutputFile: string;
  resultFile: string;
  archiveDir: string;
  archiveFile: string;
  launchLog: string;
  pauseMarker: string;
  nodeOutputFile(nodeId: string): string;
  receiptFile(nodeId: string): string;
  stdoutFile(nodeId: string, startedAt: number): string;
  stderrFile(nodeId: string, startedAt: number): string;
}

export function locateProofFiles(stateDir: string, runId: string): ProofFiles {
  const runDir = join(stateDir, "runs", runId);
  return {
    runDir,
    promptFile: join(runDir, "prompt.md"),
    previousOutputFile: join(runDir, "previous-output.txt"),
    resultFile: join(runDir, "generated.json"),
    archiveDir: join(stateDir, "archive"),
    archiveFile: join(stateDir, "archive", `${runId}.md`),
    launchLog: join(stateDir, "launches.jsonl"),
    pauseMarker: join(runDir, "paused"),
    nodeOutputFile: (nodeId) => join(runDir, "outputs", `${nodeId}.txt`),
    receiptFile: (nodeId) => join(runDir, "receipts", `${nodeId}.json`),
    stdoutFile: (nodeId, startedAt) => join(runDir, "logs", `${nodeId}-${startedAt}.stdout.log`),
    stderrFile: (nodeId, startedAt) => join(runDir, "logs", `${nodeId}-${startedAt}.stderr.log`),
  };
}
