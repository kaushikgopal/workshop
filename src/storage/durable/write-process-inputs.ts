import type { WorkflowRunDocumentV1 } from "../../run/records.js";
import type { NodeResult } from "../../run/schema.js";
import type { ProcessFiles } from "../../run/locate-run-files.js";
import { atomicWriteFileSync } from "../disk/write-crash-safe.js";
import { renderWorklog } from "./render-worklog.js";

type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;

/**
 * Writes the files a node process reads, from committed state, just before launch:
 * the predecessor's output, the candidate under validation, and a compact worklog.
 */
export function writeProcessInputs(run: ReadyRun, nodeId: string, files: ProcessFiles, candidate: NodeResult | null): void {
  const predecessor = run.chain.predecessors[nodeId];
  if (predecessor === undefined) throw new Error("frozen node has no predecessor snapshot");
  atomicWriteFileSync(files.previousOutputPath, predecessor === null ? "" : successfulOutput(run, predecessor));
  if (candidate !== null) atomicWriteFileSync(files.candidateOutputPath, candidate.output);
  atomicWriteFileSync(files.worklogPath, renderWorklog(run));
}

function successfulOutput(run: ReadyRun, nodeId: string): string {
  const node = run.nodes.find((value) => value.nodeId === nodeId);
  const attempt = node?.attempts.at(-1);
  if (node?.status !== "succeeded" || attempt?.attemptId !== node.successfulAttemptId
    || attempt.result.kind !== "settled" || attempt.result.outcome.kind !== "succeeded") {
    throw new Error("predecessor has no successful canonical output");
  }
  return attempt.result.outcome.candidate.output;
}
