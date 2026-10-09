import { locateProofFiles } from "./locate-proof-files.js";
import type { ProofInput, ProofNode, ProofOutputs, ProofResult, ProofSummaries } from "./types.js";

export function buildProofResult(input: {
  status: ProofResult["status"];
  proofInput: ProofInput;
  taskId: number;
  outputs: ProofOutputs;
  summaries: ProofSummaries;
  nodes: readonly ProofNode[];
  cleanup?: ProofResult["cleanup"];
  reason?: string;
}): ProofResult {
  const files = locateProofFiles(input.proofInput.stateDir, input.proofInput.runId);
  return {
    version: 1,
    status: input.status,
    runId: input.proofInput.runId,
    taskId: input.taskId,
    output: input.outputs["node-generate"] ?? "",
    summary: input.summaries["node-generate"] ?? "",
    timestamp: input.outputs["node-timestamp"] ?? "",
    artifacts: input.status === "completed" ? [{ kind: "archive", path: files.archiveFile }] : [],
    nodes: input.nodes.map((node) => ({ id: node.id, output: input.outputs[node.id] ?? "" })),
    ...(input.cleanup !== undefined ? { cleanup: input.cleanup } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}
