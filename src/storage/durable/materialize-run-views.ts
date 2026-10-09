import { join } from "node:path";
import { atomicWriteFileSync, removeFileSync } from "../disk/write-crash-safe.js";
import type { PersistedNode, WorkflowRunDocumentV1 } from "../../run/records.js";
import type { NodeResult, NodeAttemptOutcome } from "../../run/schema.js";
import { renderWorklog } from "./render-worklog.js";

export type RunViewKind = "definition" | "input" | "output" | "worklog";

export interface RunViewFailure {
  view: RunViewKind;
  nodeId: string | null;
  errorCode: string | null;
}

/** Rebuild every view that follows from the canonical run document. */
export function materializeRunViews(value: WorkflowRunDocumentV1): RunViewFailure[] {
  if (value.state !== "ready") throw new Error("cannot materialize views for an uninitialized run");
  const run = value;
  const failures: RunViewFailure[] = [];
  writeView("definition", null, run.paths.definitionSnapshot, run.sourceText);
  try {
    writeView("worklog", null, run.paths.worklog, renderWorklog(run));
  } catch (error) {
    failures.push({ view: "worklog", nodeId: null, errorCode: errorCode(error) });
  }

  for (const node of run.nodes) {
    const predecessor = run.chain.predecessors[node.nodeId];
    const inputPath = join(run.paths.inputDirectory, `${node.nodeId}.previous.txt`);
    if (predecessor === null) {
      writeView("input", node.nodeId, inputPath, "");
    } else if (predecessor !== undefined) {
      const input = successfulOutput(run.nodes.find((candidate) => candidate.nodeId === predecessor));
      if (input === null) removeView("input", node.nodeId, inputPath);
      else writeView("input", node.nodeId, inputPath, input);
    } else {
      failures.push({ view: "input", nodeId: node.nodeId, errorCode: "canonical_state_invalid" });
    }

    const candidate = latestCandidate(node.attempts.at(-1)?.result);
    const outputPath = join(run.paths.outputDirectory, `${node.nodeId}.output.txt`);
    if (candidate === null) removeView("output", node.nodeId, outputPath);
    else writeView("output", node.nodeId, outputPath, candidate.output);
  }

  return failures;

  function writeView(view: RunViewKind, nodeId: string | null, path: string, content: string): void {
    try {
      atomicWriteFileSync(path, content);
    } catch (error) {
      failures.push({ view, nodeId, errorCode: errorCode(error) });
    }
  }

  function removeView(view: RunViewKind, nodeId: string | null, path: string): void {
    try {
      removeFileSync(path);
    } catch (error) {
      failures.push({ view, nodeId, errorCode: errorCode(error) });
    }
  }
}

function successfulOutput(node: PersistedNode | undefined): string | null {
  if (node?.status !== "succeeded" || node.successfulAttemptId === null) return null;
  const attempt = node.attempts.at(-1);
  if (attempt?.attemptId !== node.successfulAttemptId) return null;
  if (attempt.result.kind !== "settled" || attempt.result.outcome.kind !== "succeeded") return null;
  return attempt.result.outcome.candidate.output;
}

function latestCandidate(result: PersistedNode["attempts"][number]["result"] | undefined): NodeResult | null {
  if (result === undefined || result.kind === "pending") return null;
  if (result.kind === "candidate_committed" || result.kind === "validation_committed") return result.candidate;
  const outcome: NodeAttemptOutcome = result.outcome;
  return outcome.kind === "cancelled" ? null : outcome.candidate;
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
