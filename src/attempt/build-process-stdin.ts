import { createHash } from "node:crypto";
import { join } from "node:path";
import { locateWorkflowDirectory } from "../run/locate-run-files.js";
import { buildFailureFeedback } from "./build-failure-feedback.js";
import { workflowRunDocumentV1Schema, type WorkflowRunDocumentV1 } from "../run/records.js";
import type { persistedNodeAttemptSchema } from "../run/records.js";
import {
  renderVerifierPromptV4,
  renderWorkerPromptV4,
  type VerifierPromptV4Input,
  type WorkerPromptV4Input,
} from "./render-agent-prompt.js";

export type ProcessStdinInput =
  | { role: "worker"; kind: "command"; previousOutput: string | null }
  | { role: "worker"; kind: "agent"; prompt: WorkerPromptV4Input }
  | { role: "verifier"; kind: "command"; candidateOutput: string }
  | { role: "verifier"; kind: "agent"; prompt: VerifierPromptV4Input };

export interface ProcessStdin {
  bytes: Uint8Array;
  sha256: string;
  byteCount: number;
}

/** Build exact process stdin bytes and their identity without reading or writing state. */
export function buildProcessStdin(input: ProcessStdinInput): ProcessStdin {
  const text = input.kind === "command"
    ? input.role === "worker" ? input.previousOutput ?? "" : input.candidateOutput
    : input.role === "worker" ? renderWorkerPromptV4(input.prompt) : renderVerifierPromptV4(input.prompt);
  const bytes = new TextEncoder().encode(text);
  const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, byteCount: bytes.byteLength };
}

type PersistedNodeAttempt = ReturnType<typeof persistedNodeAttemptSchema.parse>;
type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;
type Format4Settings = Extract<ReadyRun["resolvedSettings"], { formatVersion: 4 }>;

export interface ProcessStdinIdentity {
  readonly role: "preflight" | "worker" | "validator";
  readonly nodeId: string | null;
  readonly attemptId: string | null;
  readonly executionId: string;
}

/** Rebuild exact format 4 stdin from frozen settings and committed run evidence. */
export function reconstructProcessStdin(input: ProcessStdinIdentity, runDocument: WorkflowRunDocumentV1): ProcessStdin {
  const parsed = workflowRunDocumentV1Schema.parse(runDocument);
  if (parsed.state !== "ready" || !("formatVersion" in parsed.resolvedSettings) || parsed.resolvedSettings.formatVersion !== 4) {
    throw new Error("process stdin requires a ready format 4 run");
  }
  const settings: Format4Settings = parsed.resolvedSettings;
  if (input.role === "preflight") {
    if (input.nodeId !== null || input.attemptId !== null || parsed.preflight.kind === "not_configured") {
      throw new Error("preflight stdin identity differs from committed run state");
    }
    return buildProcessStdin({ role: "worker", kind: "command", previousOutput: null });
  }
  if (input.nodeId === null || input.attemptId === null) throw new Error("node stdin identity is incomplete");

  const node = parsed.nodes.find((value) => value.nodeId === input.nodeId);
  const attempt = node?.attempts.find((value) => value.attemptId === input.attemptId);
  const nodeSettings = settings.nodes[input.nodeId];
  if (node === undefined || attempt === undefined || nodeSettings === undefined) {
    throw new Error("process stdin identity is missing from committed run state");
  }

  const previousOutput = committedPreviousOutput(parsed, input.nodeId);
  if (input.role === "worker") {
    if (nodeSettings.run.kind === "command") {
      return buildProcessStdin({ role: "worker", kind: "command", previousOutput: previousOutput?.output ?? null });
    }
    const prompt: WorkerPromptV4Input = {
      workflowId: parsed.workflowId,
      runId: parsed.runId,
      stepId: input.nodeId,
      attemptNumber: attempt.number,
      workflowInstructions: settings.instructions,
      stepInstructions: nodeSettings.run.instructions,
      resultsPath: join(locateWorkflowDirectory(parsed), "results.md"),
      logPath: join(locateWorkflowDirectory(parsed), "execution.log"),
      previousOutput,
      resultMode: nodeSettings.result,
      answer: committedHumanAnswer(parsed, input.nodeId),
      feedback: workerFeedback(parsed, input.nodeId, attempt),
    };
    return buildProcessStdin({ role: "worker", kind: "agent", prompt });
  }

  if (nodeSettings.validator === null) throw new Error("validator stdin has no frozen validator settings");
  if (attempt.result.kind !== "candidate_committed" && attempt.result.kind !== "validation_committed" && attempt.result.kind !== "worker_failure_committed") {
    throw new Error("verifier stdin requires committed worker evidence");
  }
  const candidate = attempt.result.kind === "worker_failure_committed" ? null : attempt.result.candidate;
  const candidateStatus = candidate === null ? "failed" : candidate.version === 2 ? candidate.stdioResult.status : "succeeded";
  const retriesRemaining = nodeSettings.retries === "unlimited"
    ? "unlimited"
    : Math.max(0, nodeSettings.retries + 1 - attempt.number);
  if (nodeSettings.validator.kind === "command") {
    if (candidate === null) throw new Error("command verifier requires a valid candidate");
    return buildProcessStdin({ role: "verifier", kind: "command", candidateOutput: candidate.output });
  }
  const prompt: VerifierPromptV4Input = {
    workflowId: parsed.workflowId,
    runId: parsed.runId,
    stepId: input.nodeId,
    attemptNumber: attempt.number,
    workflowInstructions: settings.instructions,
    stepInstructions: nodeSettings.validator.instructions,
    resultsPath: join(locateWorkflowDirectory(parsed), "results.md"),
    logPath: join(locateWorkflowDirectory(parsed), "execution.log"),
    previousOutput,
    candidateOutput: candidate?.output ?? "",
    answer: committedHumanAnswer(parsed, input.nodeId),
    failureEvidence: candidate === null ? attempt.feedback?.text ?? "Failure evidence unavailable." : null,
    feedback: earlierFeedback(node.attempts, attempt.number),
    candidateStatus,
    workerFailureKind: candidate === null && attempt.result.kind === "worker_failure_committed"
      && attempt.result.failure.kind === "result_invalid" ? "result_invalid" : null,
    retriesRemaining,
  };
  return buildProcessStdin({ role: "verifier", kind: "agent", prompt });
}

function committedPreviousOutput(run: ReadyRun, nodeId: string): { stepId: string; output: string } | null {
  const predecessorId = run.chain.predecessors[nodeId];
  if (predecessorId === undefined) throw new Error("process stdin node is absent from the frozen chain");
  if (predecessorId === null) return null;
  const predecessor = run.nodes.find((value) => value.nodeId === predecessorId);
  const successfulAttemptId = predecessor?.successfulAttemptId;
  const previousAttempt = successfulAttemptId === null || successfulAttemptId === undefined
    ? undefined
    : predecessor?.attempts.find((value: PersistedNodeAttempt) => value.attemptId === successfulAttemptId);
  if (predecessor === undefined || previousAttempt?.result.kind !== "settled" || previousAttempt.result.outcome.kind !== "succeeded") {
    throw new Error("process stdin predecessor has no committed successful output");
  }
  return { stepId: predecessorId, output: previousAttempt.result.outcome.candidate.output };
}

function earlierFeedback(attempts: readonly PersistedNodeAttempt[], number: number): string | null {
  const source = attempts.filter((attempt) => attempt.number < number && attempt.feedback !== undefined).at(-1)?.feedback;
  return source === undefined ? null : "Source step: " + source.nodeId + "\nSource attempt: " + source.attemptNumber + "\n\n" + source.text;
}

function workerFeedback(run: ReadyRun, nodeId: string, attempt: PersistedNodeAttempt): string | null {
  const node = run.nodes.find((value) => value.nodeId === nodeId);
  const previousAttempt = node?.attempts.find((value) => value.number === attempt.number - 1);
  const previousOutcome = previousAttempt?.result.kind === "settled" ? previousAttempt.result.outcome : null;
  const parseFailure = previousOutcome?.kind === "failed"
    && (previousOutcome.failure.kind === "result_invalid" || previousOutcome.failure.kind === "result_too_large")
    ? previousOutcome.failure
    : null;
  const botResolution = run.resolutions.find((resolution) => resolution.provenance === "bot" && resolution.action === "retry"
    && (resolution.sourceBlock.nodeId === nodeId && resolution.sourceBlock.attemptId === previousAttempt?.attemptId
      || resolution.sourceBlock.nodeId === null && run.chain.order[0] === nodeId && attempt.number === 1));
  const verifierFeedback = earlierFeedback(node?.attempts ?? [], attempt.number);
  if (parseFailure !== null) {
    const parts = [
      "Workshop parse error: " + parseFailure.message,
      "Write the result in the tagged format shown in the worker contract.",
    ];
    if (botResolution !== undefined) parts.push("Bot resolution: " + botResolution.reason);
    if (verifierFeedback !== null) parts.push("Verifier feedback:\n" + verifierFeedback);
    return buildFailureFeedback(parts.join("\n\n"));
  }
  if (botResolution === undefined) return verifierFeedback;
  return buildFailureFeedback("Bot resolution: " + botResolution.reason + (verifierFeedback === null ? "" : "\n\n" + verifierFeedback));
}

/** A reply is input only for the immediate successor of its immutable proposal. */
export function committedHumanAnswer(run: ReadyRun, nodeId: string): string | null {
  const predecessorId = run.chain.predecessors[nodeId];
  const wait = run.waits?.find((value) => value.nodeId === predecessorId && value.settlement.kind === "replied");
  return wait?.settlement.kind === "replied" && wait.settlement.action === "continue" ? wait.settlement.answer : null;
}
