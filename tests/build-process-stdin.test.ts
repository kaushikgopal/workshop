import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildProcessStdin } from "../src/attempt/build-process-stdin.js";
import { renderVerifierPromptV4, renderWorkerPromptV4 } from "../src/attempt/render-agent-prompt.js";

const promptIdentity = {
  workflowId: "workflow",
  runId: "run-123",
  stepId: "write",
  attemptNumber: 2,
  workflowInstructions: null,
  stepInstructions: "Make the result.",
  resultsPath: "/runs/results.md",
  logPath: "/runs/execution.log",
  previousOutput: { stepId: "draft", output: "Earlier output." },
};

function expectedHash(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

describe("buildProcessStdin", () => {
  test("gives a first command worker empty bytes and stable evidence metadata", () => {
    const first = buildProcessStdin({ role: "worker", kind: "command", previousOutput: null });
    const repeated = buildProcessStdin({ role: "worker", kind: "command", previousOutput: null });
    expect(first.bytes).toEqual(new Uint8Array());
    expect(first.byteCount).toBe(0);
    expect(first.sha256).toBe(expectedHash(first.bytes));
    expect(repeated).toEqual(first);
  });

  test("preserves exact accepted output bytes for command workers", () => {
    const previousOutput = "\uFEFFline one\r\nline two: é\n";
    const built = buildProcessStdin({ role: "worker", kind: "command", previousOutput });
    const expected = new TextEncoder().encode(previousOutput);
    expect(built.bytes).toEqual(expected);
    expect(built.byteCount).toBe(expected.byteLength);
    expect(built.sha256).toBe(expectedHash(expected));
  });

  test("builds command verifier stdin from the exact candidate", () => {
    const candidate = "candidate\r\n\u0000with exact bytes";
    const built = buildProcessStdin({ role: "verifier", kind: "command", candidateOutput: candidate });
    const expected = new TextEncoder().encode(candidate);
    expect(built.bytes).toEqual(expected);
    expect(built.byteCount).toBe(expected.byteLength);
    expect(built.sha256).toBe(expectedHash(expected));
  });

  test("builds worker agent stdin from the format 4 prompt", () => {
    const input = { role: "worker" as const, kind: "agent" as const, prompt: { ...promptIdentity, resultMode: "tagged" as const } };
    const built = buildProcessStdin(input);
    const expected = new TextEncoder().encode(renderWorkerPromptV4(input.prompt));
    expect(built.bytes).toEqual(expected);
    expect(built.byteCount).toBe(expected.byteLength);
    expect(built.sha256).toBe(expectedHash(expected));
    expect(buildProcessStdin(input)).toEqual(built);
  });

  test("builds verifier agent stdin from a tagged prompt with a full candidate", () => {
    const input = {
      role: "verifier" as const,
      kind: "agent" as const,
      prompt: {
        ...promptIdentity,
        candidateOutput: "candidate " + "x".repeat(70 * 1024),
        candidateStatus: "succeeded" as const,
        retriesRemaining: "unlimited" as const,
      },
    };
    const built = buildProcessStdin(input);
    const expected = new TextEncoder().encode(renderVerifierPromptV4(input.prompt));
    expect(built.bytes).toEqual(expected);
    expect(new TextDecoder().decode(built.bytes)).toContain(input.prompt.candidateOutput);
    expect(built.byteCount).toBe(expected.byteLength);
    expect(built.sha256).toBe(expectedHash(expected));
  });
});
