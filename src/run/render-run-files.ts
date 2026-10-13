import { createHash } from "node:crypto";
import { parseTaggedVerifierDecision, parseTaggedWorkerResult, parseTextResult } from "../attempt/parse-tagged-result.js";
import { readCaptureBytes, readRetainedCapture } from "../process/read-retained-capture.js";
import type { WorkflowRunDocumentV1, WorkshopEventV1, WorkshopProcessV1 } from "./records.js";

export interface RunFileSnapshot {
  readonly run: Extract<WorkflowRunDocumentV1, { state: "ready" }>;
  readonly processEvidence: readonly WorkshopProcessV1[];
  readonly events: readonly WorkshopEventV1[];
}

export interface ResultFileSlot {
  readonly stepId: string;
  readonly status: string;
  readonly output: string | null;
  /** WP7 supplies committed answers. Until then this slot stays empty. */
  readonly answer: null;
  readonly skipped: boolean;
}

/** Render the exact result block contract without reading a projection file. */
export function renderResultsFile(workflowId: string, runId: string, slots: readonly ResultFileSlot[]) {
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
  }
  return { text: "# Results: " + workflowId + " run " + runId + "\n\n" + blocks.join("\n\n") + (blocks.length === 0 ? "" : "\n"), diagnostics };
}

/** Derive accepted slots and labeled execution evidence from committed records. */
export function renderRunFiles(snapshot: RunFileSnapshot) {
  const { run } = snapshot;
  const slots: ResultFileSlot[] = run.nodes.map((node) => {
    const attempt = node.attempts.find((value) => value.attemptId === node.successfulAttemptId);
    const candidate = attempt?.result.kind === "settled" && attempt.result.outcome.kind === "succeeded"
      ? attempt.result.outcome.candidate : null;
    return { stepId: node.nodeId, status: candidate?.version === 2 ? candidate.stdioResult.status : "succeeded",
      output: candidate?.output ?? null, answer: null, skipped: false };
  });
  const results = renderResultsFile(run.workflowId, run.runId, slots);
  const sections = ["# Execution: " + run.workflowId + " run " + run.runId];
  for (const event of [...snapshot.events].reverse()) {
    const stepId = "nodeId" in event ? event.nodeId : event.type === "run_resolved" ? event.resolution.sourceBlock.nodeId : null;
    const attemptId = "attemptId" in event ? event.attemptId : event.type === "run_resolved" ? event.resolution.sourceBlock.attemptId : null;
    const attempt = run.nodes.flatMap((node) => node.attempts).find((value) => value.attemptId === attemptId);
    sections.push(label(stepId, attempt?.number ?? null, "engine", event.type) + "\n" + JSON.stringify(event));
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
        ? parseTaggedVerifierDecision(bytes)
        : process.role === "worker" && settings !== null && settings !== undefined && "result" in settings && settings.result === "tagged"
          ? parseTaggedWorkerResult(bytes) : parseTextResult(bytes);
      if (!parsed.ok || process.exit?.kind !== "code" || process.exit.code !== 0) {
        sections.push(prefix + " invalid stdout\n" + (text ?? "unavailable"));
      } else if ("preamble" in parsed.value) {
        if (parsed.value.preamble !== "") sections.push(prefix + " preamble\n" + parsed.value.preamble);
        if (parsed.value.trailer !== "") sections.push(prefix + " trailer\n" + parsed.value.trailer);
        if ("decision" in parsed.value) sections.push(prefix + " verifier feedback\n" + parsed.value.reason
          + (parsed.value.corrections === null ? "" : "\n" + parsed.value.corrections));
      } else if (process.role !== "worker") sections.push(prefix + " stdout\n" + (text ?? "unavailable"));
    }
  }
  for (const diagnostic of results.diagnostics) sections.push(label(diagnostic.stepId, null, "engine", "projection") + "\n" + diagnostic.message);
  return { results: results.text, executionLog: sections.join("\n\n") + "\n", diagnostics: results.diagnostics };
}

function label(stepId: string | null, attempt: number | null, role: string, detail: string): string {
  return "[step=" + (stepId ?? "run") + " attempt=" + (attempt ?? "-") + " role=" + role + "] " + detail;
}
