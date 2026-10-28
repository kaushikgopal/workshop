import { createHash } from "node:crypto";
import { parseTaggedWorkerResult, parseTextResult } from "../attempt/parse-tagged-result.js";
import { parseVerifierResult } from "../attempt/parse-verifier-result.js";
import { readCaptureBytes, readRetainedCapture } from "../process/read-retained-capture.js";
import type { WorkflowRunDocumentV1, WorkshopEventV1, WorkshopProcessV1 } from "./records.js";
import { nodeResultStatus } from "./schema.js";

export interface RunFileSnapshot {
  readonly run: Extract<WorkflowRunDocumentV1, { state: "ready" }>;
  readonly processEvidence: readonly WorkshopProcessV1[];
  readonly events: readonly WorkshopEventV1[];
}

export interface ResultFileSlot {
  readonly stepId: string;
  readonly status: string;
  readonly output: string | null;
  readonly answer: { readonly action: "continue" | "reject"; readonly text: string } | null;
  readonly skipped: boolean;
}

/** Render the exact result block contract without reading a projection file. */
export function renderResultsFile(workflowId: string, runId: string, slots: readonly ResultFileSlot[], admittedAt = "unknown", mutable = true, admissionSequence = 1) {
  const runTag = createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 8);
  const blocks: string[] = [];
  const diagnostics: { stepId: string; message: string }[] = [];
  for (const slot of slots) {
    if (slot.skipped) {
      blocks.push("<skipped-" + slot.stepId + "-" + runTag + " />");
      continue;
    }
    if (slot.output === null) continue;
    const tag = "result-" + slot.stepId + "-" + runTag;
    const closing = "</" + tag + ">";
    const collision = slot.output.split(/\r?\n/u).includes(closing);
    const output = collision ? "unavailable: delimiter collision" : slot.output;
    if (collision) diagnostics.push({ stepId: slot.stepId, message: "unavailable: delimiter collision" });
    blocks.push("<" + tag + ' status="' + slot.status + '">\n' + output + "\n" + closing);
    if (slot.answer !== null) {
      const answerTag = "answer-" + slot.stepId + "-" + runTag;
      const answerClosing = "</" + answerTag + ">";
      const collision = slot.answer.text.split(/\r?\n/u).includes(answerClosing);
      if (collision) diagnostics.push({ stepId: slot.stepId, message: "unavailable: answer delimiter collision" });
      const text = collision ? "unavailable: delimiter collision" : slot.answer.text;
      blocks[blocks.length - 1] += "\n<" + answerTag + ' action="' + slot.answer.action + '">\n' + text + "\n" + answerClosing;
    }
  }
  const body = "# Results: " + workflowId + " run " + runId + "\n"
    + "Run tag: " + runTag + "\nAdmission time: " + admittedAt + "\n\n"
    + blocks.join("\n\n") + (blocks.length === 0 ? "" : "\n");
  return { text: wrapRunSection(runId, runTag, admittedAt, body, mutable, admissionSequence), diagnostics };
}

/** Derive accepted slots and labeled execution evidence from committed records. */
export function renderRunFiles(snapshot: RunFileSnapshot, executionLog = true) {
  const { run } = snapshot;
  const slots: ResultFileSlot[] = run.nodes.map((node) => {
    const wait = run.waits?.find((value) => value.nodeId === node.nodeId);
    const attemptId = node.successfulAttemptId ?? wait?.attemptId;
    const attempt = node.attempts.find((value) => value.attemptId === attemptId);
    const candidate = attempt?.result.kind === "settled" && attempt.result.outcome.kind === "succeeded"
      ? attempt.result.outcome.candidate : null;
    const reply = wait?.settlement.kind === "replied" ? wait.settlement : null;
    return { stepId: node.nodeId, status: candidate === null ? "succeeded" : nodeResultStatus(candidate),
      output: candidate?.output ?? null, answer: reply === null ? null : { action: reply.action, text: reply.answer },
      skipped: node.status === "skipped" };
  });
  const results = renderResultsFile(run.workflowId, run.runId, slots, run.admittedAt, !["completed", "failed", "cancelled"].includes(run.status), run.admissionSequence);
  if (!executionLog) return { results: results.text, executionLog: "", diagnostics: results.diagnostics };
  const runTag = createHash("sha256").update(run.runId, "utf8").digest("hex").slice(0, 8);
  const sections = ["# Execution: " + run.workflowId + " run " + run.runId
    + "\nRun tag: " + runTag + "\nAdmission time: " + run.admittedAt];
  for (const event of [...snapshot.events].reverse()) {
    const stepId = "nodeId" in event ? event.nodeId : event.type === "run_resolved" ? event.resolution.sourceBlock.nodeId : null;
    const attemptId = "attemptId" in event ? event.attemptId : event.type === "run_resolved" ? event.resolution.sourceBlock.attemptId : null;
    const attempt = run.nodes.flatMap((node) => node.attempts).find((value) => value.attemptId === attemptId);
    sections.push(label(stepId, attempt?.number ?? null, "engine", event.type) + "\n" + JSON.stringify(event));
  }
  for (const node of run.nodes) {
    for (const attempt of node.attempts) {
      if (attempt.feedback !== undefined) sections.push(label(node.nodeId, attempt.number, "engine", "retry feedback") + "\n" + attempt.feedback.text);
    }
  }
  for (const wait of run.waits ?? []) {
    const attempt = run.nodes.find((node) => node.nodeId === wait.nodeId)?.attempts.find((value) => value.attemptId === wait.attemptId);
    sections.push(label(wait.nodeId, attempt?.number ?? null, "engine", "human wait " + wait.waitId) + "\n" + JSON.stringify(wait));
  }
  for (const record of snapshot.processEvidence) {
    const process = record.process;
    const attempt = run.nodes.flatMap((node) => node.attempts).find((value) => value.attemptId === record.attemptId);
    const prefix = label(record.nodeId, attempt?.number ?? null, process.role, "incarnation " + process.incarnationNumber);
    for (const capture of process.captures) {
      const text = readRetainedCapture(capture);
      const marker = capture.complete ? "" : "\n[incomplete; omitted " + capture.truncatedBytes + " bytes]";
      if (capture.stream === "stderr") {
        const head = capture.keptHeadBytes ?? capture.retainedBytes;
        const bytes = capture.retained === undefined ? null : Buffer.from(capture.retained.bytes, "base64");
        // The omission marker belongs between the retained head and tail, not in the raw evidence.
        const diagnostic = bytes !== null && capture.truncatedBytes > 0
          ? readCaptureBytes(bytes.subarray(0, head)) + "\n[omitted " + capture.truncatedBytes + " bytes]\n" + readCaptureBytes(bytes.subarray(head))
          : text;
        sections.push(prefix + " stderr\n" + (diagnostic ?? "unavailable") + marker);
        continue;
      }
      if (capture.retained === undefined || !capture.complete) {
        sections.push(prefix + " invalid stdout\n" + (text ?? "unavailable") + marker);
        continue;
      }
      const bytes = Buffer.from(capture.retained.bytes, "base64");
      const settings = record.nodeId === null ? null : run.resolvedSettings.nodes[record.nodeId];
      const parsed = process.role === "validator" && settings?.validator?.kind === "agent"
        ? parseVerifierResult(bytes)
        : process.role === "worker" && settings !== null && settings !== undefined && "result" in settings && settings.result === "tagged"
          ? parseTaggedWorkerResult(bytes) : parseTextResult(bytes);
      if (!parsed.ok || process.exit?.kind !== "code" || process.exit.code !== 0) {
        sections.push(prefix + " invalid stdout\n" + (text ?? "unavailable"));
      } else if ("decision" in parsed.value) {
        sections.push(prefix + " verifier feedback\n" + parsed.value.reason);
      } else if ("preamble" in parsed.value) {
        if (parsed.value.preamble !== "") sections.push(prefix + " preamble\n" + parsed.value.preamble);
        if (parsed.value.trailer !== "") sections.push(prefix + " trailer\n" + parsed.value.trailer);
      } else if (process.role !== "worker") sections.push(prefix + " stdout\n" + (text ?? "unavailable"));
    }
  }
  for (const diagnostic of results.diagnostics) sections.push(label(diagnostic.stepId, null, "engine", "projection") + "\n" + diagnostic.message);
  return { results: results.text, executionLog: wrapRunSection(run.runId, runTag, run.admittedAt, sections.join("\n\n") + "\n", !["completed", "failed", "cancelled"].includes(run.status), run.admissionSequence), diagnostics: results.diagnostics };
}

function label(stepId: string | null, attempt: number | null, role: string, detail: string): string {
  return "[step=" + (stepId ?? "run") + " attempt=" + (attempt ?? "-") + " role=" + role + "] " + detail;
}

function wrapRunSection(runId: string, runTag: string, admittedAt: string, content: string, mutable: boolean, admissionSequence: number): string {
  const safeContent = content.replace(/^<\/?workshop-run\b.*>$/gmu, (line) => line.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  return '<workshop-run id="' + runId + '" tag="' + runTag + '" admitted-at="' + admittedAt + '" mutable="' + String(mutable) + '" admission-sequence="' + String(admissionSequence) + '">\n'
    + safeContent + (safeContent.endsWith("\n") ? "" : "\n") + "</workshop-run>\n";
}
