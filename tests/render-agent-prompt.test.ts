import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { renderVerifierPromptV4, renderWorkerPromptV4 } from "../src/attempt/render-agent-prompt.js";

const identity = {
  workflowId: "workflow",
  runId: "run-123",
  stepId: "write",
  attemptNumber: 2,
  workflowInstructions: "Shared workflow rules.",
  stepInstructions: "Write one result.",
  resultsPath: "/state/workflow/results.md",
  logPath: "/state/workflow/execution.log",
  previousOutput: { stepId: "draft", output: "Earlier approved text." },
};

const runTag = createHash("sha256").update(identity.runId, "utf8").digest("hex").slice(0, 8);

describe("format 4 agent prompts", () => {
  test("renders worker sections in order with identity, paths, lookup guidance, and tagged contract", () => {
    const prompt = renderWorkerPromptV4({ ...identity, resultMode: "tagged" });

    expect(prompt.indexOf("## 1. Workshop Agent Instructions")).toBeLessThan(prompt.indexOf("## 2. Workflow Instructions"));
    expect(prompt.indexOf("## 2. Workflow Instructions")).toBeLessThan(prompt.indexOf("## 3. Step Instructions"));
    expect(prompt.indexOf("## 3. Step Instructions")).toBeLessThan(prompt.indexOf("## 4. Labeled Data"));
    expect(prompt).toContain("Role: worker");
    expect(prompt).toContain("Workflow: workflow");
    expect(prompt).toContain("Run: run-123");
    expect(prompt).toContain("Run tag: " + runTag);
    expect(prompt).toContain("Step: write");
    expect(prompt).toContain("Attempt: 2");
    expect(prompt).toContain("WORKSHOP_RESULTS_PATH: /state/workflow/results.md");
    expect(prompt).toContain("WORKSHOP_LOG_PATH: /state/workflow/execution.log");
    expect(prompt).toContain("result-<step-id>-<run-tag>");
    expect(prompt).toContain("Older runs are in timestamped .gz files beside results.md.");
    expect(prompt).toContain("\n<status>succeeded|success_and_complete|needs_input</status>");
    expect(prompt).not.toContain("\n    <status>");
    expect(prompt).toContain("Send diagnostics to stderr");
    expect(prompt).toContain("never edit them");
    expect(prompt).toContain("Never mutate Workshop engine state");
    expect(prompt).toContain("Shared workflow rules.");
    expect(prompt).toContain("Write one result.");
    expect(prompt).toContain("Earlier approved text.");
  });

  test("renders text worker output without a tagged envelope", () => {
    const prompt = renderWorkerPromptV4({ ...identity, resultMode: "text" });
    expect(prompt).toContain("Worker stdout contract (text mode)");
    expect(prompt).toContain("complete proposed output as UTF-8 text to stdout");
    expect(prompt).not.toContain("<status>succeeded");
  });

  test("renders full verifier candidate and its status and retry state", () => {
    const candidate = "c".repeat(70 * 1024) + "candidate-tail";
    const prompt = renderVerifierPromptV4({
      ...identity,
      stepInstructions: "Check the candidate.",
      candidateOutput: candidate,
      candidateStatus: "success_and_complete",
      retriesRemaining: 3,
      feedback: "Earlier feedback.",
    });

    expect(prompt.indexOf("## 1. Workshop Agent Instructions")).toBeLessThan(prompt.indexOf("## 2. Workflow Instructions"));
    expect(prompt.indexOf("## 2. Workflow Instructions")).toBeLessThan(prompt.indexOf("## 3. Verifier Instructions"));
    expect(prompt.indexOf("## 3. Verifier Instructions")).toBeLessThan(prompt.indexOf("## 4. Labeled Data"));
    expect(prompt).toContain("Role: verifier");
    expect(prompt).toContain("\n<decision>accept|retry|block</decision>");
    expect(prompt).not.toContain("\n    <decision>");
    expect(prompt).toContain("Candidate output (data)\n\n" + candidate);
    expect(prompt).toContain("Candidate status: success_and_complete");
    expect(prompt).toContain("Retries remaining: 3");
    expect(prompt).toContain("Verifier feedback (data)\n\nEarlier feedback.");
  });

  test("omits empty answer and feedback sections", () => {
    const prompt = renderWorkerPromptV4({ ...identity, resultMode: "text", answer: null, feedback: null });
    expect(prompt).not.toContain("Human answer (data)");
    expect(prompt).not.toContain("Verifier feedback (data)");
  });

  test("truncates previous output to a UTF-8-safe 64 KiB prefix and names its result tag", () => {
    const prompt = renderWorkerPromptV4({
      ...identity,
      resultMode: "text",
      previousOutput: { stepId: "draft", output: "a".repeat(65_535) + "é" + "discarded-tail" },
    });
    const excerpt = "a".repeat(65_535);
    const note = "[Truncated after the first 64 KiB. Find the complete earlier result in WORKSHOP_RESULTS_PATH (results.md) by its tag: result-draft-" + runTag + ".]";
    expect(prompt).toContain(excerpt + "\n\n" + note);
    expect(prompt).not.toContain("discarded-tail");
    expect(new TextEncoder().encode(excerpt).byteLength).toBe(65_535);
  });

  test("includes answer and feedback only when data exists", () => {
    const prompt = renderWorkerPromptV4({
      ...identity,
      resultMode: "text",
      answer: "Continue.",
      feedback: "Keep the wording distinct.",
    });
    expect(prompt).toContain("Human answer (data)\n\nContinue.");
    expect(prompt).toContain("Verifier feedback (data)\n\nKeep the wording distinct.");
  });
});
