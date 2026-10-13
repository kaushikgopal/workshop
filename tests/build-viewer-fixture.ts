import { blockInfoSchema, humanWaitSchema } from "../src/run/schema.js";
import { nodeDetailDtoSchema, runSummaryDtoSchema, statusDtoSchema, type NodeDescriptionDto, type RunSummaryDto, type StatusDto } from "../src/views/schema.js";
import type { ViewerSnapshot } from "../src/tui/data-source.js";

export const TIME = "2026-10-10T12:00:00.000Z";
export const HASH = "sha256:" + "a".repeat(64);
export const WAIT = humanWaitSchema.parse({ waitId: "f2e2e4d8-a0e8-4b81-98c7-115530b1f91d", runId: "run-alpha", nodeId: "first", attemptId: "attempt-first",
  question: "Approve this proposal?", output: "saved proposal", createdAt: TIME, settlement: { kind: "pending" } });

export function buildBlock(kind: NonNullable<NodeDescriptionDto["node"]["block"]>["kind"], nodeId: string | null = "first") {
  return blockInfoSchema.parse({ blockId: "block-first", kind, reason: "Check external effects\nbefore retry", blockedAt: TIME, nodeId, attemptId: nodeId === null ? null : "attempt-first" });
}

export function buildRun(status: RunSummaryDto["status"] = "completed"): RunSummaryDto {
  return runSummaryDtoSchema.parse({ runId: "run-alpha", workflowId: "alpha", activationId: "activation-alpha", occurrenceId: "occurrence-alpha", definitionHash: HASH,
    status, desiredState: "running", waitingForCapacity: false, admittedAt: TIME, startedAt: TIME,
    finishedAt: ["completed", "failed"].includes(status) ? TIME : null, currentNodeId: "first", currentAttemptNumber: 1,
    block: status === "blocked" ? buildBlock("verifier_block") : null,
    failure: status === "failed" ? { kind: "process_error", message: "Worker failed", failedAt: TIME, nodeId: "first", attemptId: "attempt-first" } : null,
    terminalOutput: status === "completed" ? "accepted output" : null, wait: status === "waiting" ? WAIT : null });
}

export function buildStatus(): StatusDto {
  return statusDtoSchema.parse({ version: 2, generatedAt: TIME, installationId: "fixture", service: { state: "running", pid: 1234, bootId: "fixture-boot", startedAt: TIME, socketPath: "/tmp/fixture.sock", error: null },
    workflows: ["alpha", "beta"].map(workflowId => ({ workflowId, description: null, definitionHash: HASH, configurationError: null, activation: null, unresolvedRun: null, latestRun: null })) });
}

export function buildNode(id = "first"): NodeDescriptionDto["node"] {
  return nodeDetailDtoSchema.parse({ nodeId: id, position: 1, predecessorId: null, successorId: null, status: "pending", block: null, successfulOutput: null, attempts: [],
    resolvedSettings: { run: { kind: "command", command: "printf fixture", shell: "/bin/sh", cwd: "/tmp", timeoutMs: null, streamCapBytes: 256 * 1024, replay: "never" }, validator: null, retries: 0, result: "text" } });
}

export function buildSnapshot(nodes: readonly NodeDescriptionDto["node"][] = []): ViewerSnapshot {
  return { status: buildStatus(), detail: { diagram: { version: 2, workflowId: "alpha", definitionHash: HASH, runId: null,
    nodes: nodes.map((node, index) => ({ nodeId: node.nodeId, position: index + 1, successorId: nodes[index + 1]?.nodeId ?? null, status: null })) }, nodes }, botLines: Array.from({ length: 100 }, (_, i) => "bot message " + i) };
}
