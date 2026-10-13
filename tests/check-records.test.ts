import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  parseValidatorVerdictBytes,
  parseWorkerResultBytes,
  validatorVerdictSchema,
  workerResultSchema,
} from "../src/attempt/parse-result.js";
import {
  processCaptureSchema,
  processIncarnationSchema,
} from "../src/process/schema.js";
import {
  blockInfoSchema,
  failureInfoSchema,
  nodeAttemptOutcomeSchema,
  nodeResultSchema,
  operatorAcceptanceSchema,
  operatorResolutionSchema,
  resultArtifactSchema,
  runOutcomeSchema,
  validatorOutcomePasses,
  validatorOutcomeSchema,
} from "../src/run/schema.js";
import {
  nodeDetailDtoSchema,
  attemptDetailDtoSchema,
  logsDtoSchema,
  nodeDescriptionDtoSchema,
  runSummaryDtoSchema,
  runsDtoSchema,
  statusDtoSchema,
} from "../src/views/schema.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const ADMITTED_AT = "2026-10-05T12:00:00.000Z";
const STARTED_AT = "2026-10-05T12:00:01.000Z";
const FINISHED_AT = "2026-10-05T12:00:02.000Z";

function failureInfo(overrides: Record<string, unknown> = {}) {
  return {
    kind: "validator_rejection",
    message: "candidate was rejected",
    failedAt: FINISHED_AT,
    nodeId: "node-a",
    attemptId: "attempt-a",
    ...overrides,
  };
}

function blockInfo(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "block-a",
    kind: "process_death_unconfirmed",
    reason: "the process group may still be alive",
    blockedAt: FINISHED_AT,
    nodeId: "node-a",
    attemptId: "attempt-a",
    ...overrides,
  };
}

function runSummary(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-a",
    workflowId: "clock",
    activationId: "activation-a",
    occurrenceId: "occurrence-a",
    definitionHash: HASH_A,
    status: "running",
    desiredState: "running",
    waitingForCapacity: false,
    admittedAt: ADMITTED_AT,
    startedAt: STARTED_AT,
    finishedAt: null,
    currentNodeId: "node-a",
    currentAttemptNumber: 1,
    block: null,
    failure: null,
    terminalOutput: null,
    ...overrides,
  };
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    stream: "stdout",
    path: "/tmp/workshop/run-a/attempt-a/stdout",
    totalBytes: 0,
    retainedBytes: 0,
    truncatedBytes: 0,
    sha256: HASH_A,
    complete: true,
    ...overrides,
  };
}

function processIncarnation(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "execution-worker-a",
    incarnationId: "incarnation-worker-a-1",
    incarnationNumber: 1,
    role: "worker",
    status: "exited",
    replay: "never",
    commandHash: HASH_A,
    launchIntentAt: STARTED_AT,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    deadlineAt: null,
    identity: {
      pid: 101,
      pgid: 101,
      startIdentity: "pid-start-identity",
      serviceBootId: "boot-a",
    },
    exit: { kind: "code", code: 0 },
    cleanupState: "confirmed_dead",
    captures: [capture()],
    ...overrides,
  };
}

function evidence(
  kind: "candidate" | "verdict" | "judgment",
  evidenceId: string,
  sourceBytesHash: string | null = kind === "judgment" ? null : HASH_A,
  decisionAction: "retry" | "block" | "fail" = "block",
) {
  return {
    evidenceId,
    kind,
    sha256: HASH_A,
    sourceBytesHash: kind === "judgment" ? null : sourceBytesHash,
    ...(kind === "judgment" ? { decision: { action: decisionAction, reason: "Checked judge decision." } } : {}),
    byteCount: 12,
    recordedAt: FINISHED_AT,
  };
}

function roundTrip(schema: { parse(value: unknown): unknown }, value: unknown): unknown {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

function succeededAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-a",
    number: 1,
    status: "succeeded",
    phase: null,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    elapsedMs: 1_000,
    workerExecutionId: "execution-worker-a",
    validatorExecutionId: null,
    candidate: evidence("candidate", "evidence-candidate-a"),
    verdict: null,
    judgments: [],
    operatorAcceptances: [],
    blocks: [],
    failure: null,
    processes: [processIncarnation()],
    ...overrides,
  };
}

function commandSettings() {
  return {
    run: {
      kind: "command",
      command: "printf result",
      shell: "/bin/bash",
      cwd: "/tmp/project",
      timeoutMs: null,
      streamCapBytes: "unlimited",
      replay: "never",
    },
    validator: null,
    maxAttempts: 2,
  };
}

function nodeDetail(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "node-a",
    position: 1,
    predecessorId: null,
    successorId: null,
    status: "pending",
    block: null,
    resolvedSettings: commandSettings(),
    successfulOutput: null,
    attempts: [],
    ...overrides,
  };
}

describe("worker and verdict contracts", () => {
  test("accepts the strict worker envelope, including empty summary and artifacts", () => {
    const value = {
      version: 1 as const,
      output: "The river took the last light.",
      summary: "",
      artifacts: [{ kind: "draft", path: "out/draft.txt" }],
    };
    const parsed = parseWorkerResultBytes(new TextEncoder().encode(JSON.stringify(value)));
    expect(parsed).toMatchObject({ ok: true, value });
    if (parsed.ok) expect(parsed.sourceBytesHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => workerResultSchema.parse({ ...value, extra: true })).toThrow();
    expect(() => workerResultSchema.parse({ ...value, artifacts: [{ kind: "draft", path: "bad\u0000path" }] })).toThrow();
    expect(() => workerResultSchema.parse({ ...value, output: "" })).toThrow();
  });

  test("rejects unpaired surrogates without changing well-formed output bytes", () => {
    const validOutput = "🌕e\u0301\uFEFF";
    const value = { version: 1 as const, output: validOutput, summary: "valid pair: 😀", artifacts: [] };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const parsed = parseWorkerResultBytes(bytes);
    expect(parsed).toMatchObject({ ok: true, value });
    if (parsed.ok) expect(parsed.sourceBytesHash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(value.output.isWellFormed()).toBe(true);

    const malformed = JSON.stringify({ version: 1, output: "\uD800", summary: "", artifacts: [] });
    expect(parseWorkerResultBytes(new TextEncoder().encode(malformed))).toMatchObject({
      ok: false, failure: { kind: "result_invalid" },
    });
    expect(parseWorkerResultBytes(new TextEncoder().encode(JSON.stringify({ ...value, summary: "\uD800" })))).toMatchObject({
      ok: false, failure: { kind: "result_invalid" },
    });
    expect(parseValidatorVerdictBytes(new TextEncoder().encode(JSON.stringify({ version: 1, passed: false, reason: "\uD800" })))).toMatchObject({
      ok: false, failure: { kind: "result_invalid" },
    });
  });

  test("measures UTF-8 bytes and caps worker and verdict payloads", () => {
    expect(() => workerResultSchema.parse({ version: 1, output: "é".repeat(524_289), summary: "", artifacts: [] })).toThrow(/1 MiB/);
    expect(() => workerResultSchema.parse({ version: 1, output: "ok", summary: "é".repeat(32_769), artifacts: [] })).toThrow(/64 KiB/);
    expect(() => workerResultSchema.parse({ version: 1, output: "ok", summary: "", artifacts: Array(101).fill({ kind: "x", path: "x" }) })).toThrow();

    const verdict = { version: 1 as const, passed: false, reason: "Not one sentence." };
    expect(parseValidatorVerdictBytes(new TextEncoder().encode(JSON.stringify(verdict)))).toMatchObject({ ok: true, value: verdict });
    expect(() => validatorVerdictSchema.parse({ version: 1, passed: true })).toThrow();
    expect(() => validatorVerdictSchema.parse({ ...verdict, extra: true })).toThrow();
    expect(() => validatorVerdictSchema.parse({ ...verdict, reason: "" })).toThrow();
  });

  test("rejects oversized, malformed, invalid UTF-8, and duplicate-key JSON as typed failures", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    for (const duplicate of [
      '{"version":1,"output":"first","output":"second","summary":"","artifacts":[]}',
      '{"version":1,"output":"first","out\\u0070ut":"second","summary":"","artifacts":[]}',
    ]) {
      expect(parseWorkerResultBytes(encode(duplicate))).toMatchObject({
        ok: false,
        failure: { kind: "result_invalid", message: expect.stringContaining("duplicate") },
      });
    }
    expect(parseWorkerResultBytes(encode("{"))).toMatchObject({ ok: false, failure: { kind: "result_invalid" } });
    const schemaFailure = parseWorkerResultBytes(encode('{"version":1,"output":"ok","summary":"","artifacts":[],"extra":true}'));
    expect(schemaFailure).toMatchObject({ ok: false, failure: { kind: "result_invalid" } });
    if (!schemaFailure.ok) {
      expect(schemaFailure.failure.message).toContain("unrecognized_keys at <root>");
      expect(schemaFailure.failure.message).not.toContain("true");
    }
    expect(parseWorkerResultBytes(new Uint8Array([0xc3, 0x28]))).toMatchObject({ ok: false, failure: { kind: "result_invalid" } });
    expect(parseWorkerResultBytes(new Uint8Array(1024 * 1024 + 1))).toMatchObject({
      ok: false,
      failure: { kind: "result_too_large" },
    });
  });
});

describe("versioned persisted contracts", () => {
  test("round-trips historical and stdout candidates without changing version 1", () => {
    const historical = {
      version: 1, source: "agent", output: "A checked historical result.", summary: "Checked.", artifacts: [],
      sourceBytesHash: HASH_A, exit: { kind: "code", code: 0 },
    };
    expect(roundTrip(nodeResultSchema, historical)).toEqual(historical);

    const textCandidate = {
      version: 2, source: "agent", output: "Text result.", summary: "", artifacts: [],
      sourceBytesHash: HASH_B, exit: { kind: "code", code: 0 },
      stdioResult: { version: 1, mode: "text", status: "succeeded", reason: null, question: null },
    };
    expect(roundTrip(nodeResultSchema, textCandidate)).toEqual(textCandidate);

    const stdoutCandidate = {
      version: 2, source: "agent", output: "", summary: "Tagged reason.", artifacts: [],
      sourceBytesHash: HASH_B, exit: { kind: "code", code: 0 },
      stdioResult: { version: 1, mode: "tagged", status: "succeeded", reason: "Tagged reason.", question: null },
    };
    expect(roundTrip(nodeResultSchema, stdoutCandidate)).toEqual(stdoutCandidate);

    const needsInput = {
      ...stdoutCandidate,
      output: "Waiting for a person.", summary: "",
      stdioResult: { version: 1, mode: "tagged", status: "needs_input", reason: null, question: "Which project should I use?" },
    };
    expect(roundTrip(nodeResultSchema, needsInput)).toEqual(needsInput);
    const earlyCompletion = {
      ...stdoutCandidate,
      output: "The workflow is complete.", summary: "Finished early.",
      stdioResult: { version: 1, mode: "tagged", status: "success_and_complete", reason: "Finished early.", question: null },
    };
    expect(roundTrip(nodeResultSchema, earlyCompletion)).toEqual(earlyCompletion);
  });

  test("round-trips historical and tagged agent verdicts with explicit pass decisions", () => {
    const historical = {
      kind: "agent", exit: { kind: "code", code: 0 },
      verdict: { version: 1, passed: false, reason: "Historical rejection." }, resultBytesHash: HASH_A,
    };
    expect(roundTrip(validatorOutcomeSchema, historical)).toEqual(historical);
    expect(validatorOutcomePasses(validatorOutcomeSchema.parse(historical))).toBe(false);

    const retry = {
      kind: "agent", exit: { kind: "code", code: 0 },
      verdict: { version: 2, decision: "retry", reason: "The parser rejects malformed input.", corrections: "Add a regression test." },
      resultBytesHash: HASH_B,
    };
    expect(roundTrip(validatorOutcomeSchema, retry)).toEqual(retry);
    expect(validatorOutcomePasses(validatorOutcomeSchema.parse(retry))).toBe(false);
    expect(nodeAttemptOutcomeSchema.parse({
      kind: "failed",
      failure: failureInfo(),
      candidate: {
        version: 1, source: "command", output: "Candidate", summary: "", artifacts: [],
        sourceBytesHash: HASH_A, exit: { kind: "code", code: 0 },
      },
      validator: validatorOutcomeSchema.parse(retry),
    }).kind).toBe("failed");
    expect(validatorOutcomePasses(validatorOutcomeSchema.parse({
      ...retry, verdict: { version: 2, decision: "accept", reason: "The candidate passes.", corrections: null },
    }))).toBe(true);
    expect(validatorOutcomePasses(validatorOutcomeSchema.parse({
      ...retry, verdict: { version: 2, decision: "block", reason: "The evidence is incomplete.", corrections: null },
    }))).toBe(false);
  });

  test("round-trips optional stdin evidence and rejects malformed contract metadata", () => {
    const historical = processIncarnation();
    expect(roundTrip(processIncarnationSchema, historical)).toEqual(historical);

    const stdio = {
      version: 1, stdinSha256: HASH_B, stdinByteCount: 11,
      write: { kind: "write_error", queuedBytes: 8, diagnosticCode: "EPIPE" },
    };
    const taggedCandidate = {
      version: 2, source: "agent", output: "", summary: "Tagged reason.", artifacts: [],
      sourceBytesHash: HASH_B, exit: { kind: "code", code: 0 },
      stdioResult: { version: 1, mode: "tagged", status: "succeeded", reason: "Tagged reason.", question: null },
    };
    expect(roundTrip(processIncarnationSchema, { ...historical, stdio })).toEqual(JSON.parse(JSON.stringify({ ...historical, stdio })));

    expect(() => nodeResultSchema.parse({ version: 3, ...historical })).toThrow();
    expect(() => nodeResultSchema.parse({ ...taggedCandidate, retainedStdoutBytes: "forbidden" })).toThrow();
    expect(() => nodeResultSchema.parse({
      version: 2, source: "agent", output: "", summary: "", artifacts: [], sourceBytesHash: HASH_A,
      exit: { kind: "code", code: 0 },
      stdioResult: { version: 1, mode: "text", status: "needs_input", reason: null, question: null },
    })).toThrow();
    expect(() => nodeResultSchema.parse({
      ...historical, version: 2, stdioResult: { version: 1, mode: "tagged", status: "succeeded", reason: "", question: null },
    })).toThrow();
    expect(() => nodeResultSchema.parse({
      ...historical, version: 2, stdioResult: { version: 1, mode: "tagged", status: "succeeded", reason: "  ", question: null },
    })).toThrow();
    expect(() => nodeResultSchema.parse({
      ...taggedCandidate,
      stdioResult: { ...taggedCandidate.stdioResult, status: "succeeded", question: "Not valid here." },
    })).toThrow();
    expect(() => validatorOutcomeSchema.parse({
      kind: "agent", exit: { kind: "code", code: 0 }, resultBytesHash: HASH_A,
      verdict: { version: 2, decision: "accept", reason: "Accepted.", corrections: "Not allowed." },
    })).toThrow();
    expect(() => validatorOutcomeSchema.parse({
      kind: "operator", resultBytesHash: HASH_A,
      verdict: { version: 2, decision: "accept", reason: "Accepted.", corrections: null },
      acceptance: { target: "validator" },
    })).toThrow();
    expect(() => processIncarnationSchema.parse({
      ...historical, stdio: { ...stdio, write: { ...stdio.write, queuedBytes: 12 } },
    })).toThrow(/queued stdin bytes/);
    expect(() => processIncarnationSchema.parse({
      ...historical, stdio: { ...stdio, write: { ...stdio.write, diagnosticCode: "EPIPE/unsafe" } },
    })).toThrow();
  });
});

describe("domain outcomes and process evidence", () => {
  test("keeps blocked and failed outcomes as distinct strict variants", () => {
    expect(failureInfoSchema.parse(failureInfo()).kind).toBe("validator_rejection");
    expect(blockInfoSchema.parse(blockInfo()).kind).toBe("process_death_unconfirmed");
    expect(runOutcomeSchema.parse({ kind: "failed", failure: failureInfo() }).kind).toBe("failed");
    expect(runOutcomeSchema.parse({ kind: "blocked", block: blockInfo() }).kind).toBe("blocked");
    expect(() => runOutcomeSchema.parse({ kind: "blocked", failure: failureInfo() })).toThrow();
    expect(nodeAttemptOutcomeSchema.parse({ kind: "failed", failure: failureInfo({ kind: "process_error" }), candidate: null, validator: null }).kind).toBe("failed");
    expect(nodeAttemptOutcomeSchema.parse({ kind: "blocked", block: blockInfo(), candidate: null, validator: null }).kind).toBe("blocked");
    expect(() => nodeAttemptOutcomeSchema.parse({ kind: "blocked", failure: failureInfo(), candidate: null, validator: null })).toThrow();
  });

  test("allows empty command output but rejects empty agent output and unsuccessful candidates", () => {
    const emptyCommand = {
      version: 1,
      source: "command",
      output: "",
      summary: "command exited successfully",
      artifacts: [],
      sourceBytesHash: HASH_A,
      exit: { kind: "code", code: 0 },
    };
    expect(nodeAttemptOutcomeSchema.parse({ kind: "succeeded", candidate: emptyCommand, validator: null }).kind).toBe("succeeded");
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "succeeded",
      candidate: { ...emptyCommand, source: "agent" },
      validator: null,
    })).toThrow(/agent output must be nonempty/);
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "succeeded",
      candidate: { ...emptyCommand, exit: { kind: "code", code: 1 } },
      validator: null,
    })).toThrow(/exit code 0/);
  });

  test("requires validator rejection failures to retain a failing verdict and candidate", () => {
    const candidate = {
      version: 1, source: "command", output: "candidate", summary: "ok", artifacts: [],
      sourceBytesHash: HASH_A, exit: { kind: "code", code: 0 },
    };
    const failingValidator = {
      kind: "agent", exit: { kind: "code", code: 0 },
      verdict: { version: 1, passed: false, reason: "rejected" }, resultBytesHash: HASH_B,
    };
    const timedOutCommandValidator = {
      kind: "command", exit: { kind: "signal", signal: "SIGKILL" }, stdoutHash: null, stderrHash: null,
    };
    expect(nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo(), candidate, validator: failingValidator,
    }).kind).toBe("failed");
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo(), candidate: null, validator: null,
    })).toThrow(/validator rejection requires/);
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo(), candidate,
      validator: { ...failingValidator, verdict: { version: 1, passed: true, reason: "accepted" } },
    })).toThrow(/validator rejection requires/);
    expect(nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo({ kind: "timeout" }), candidate,
      validator: timedOutCommandValidator,
    }).kind).toBe("failed");
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo({ kind: "process_error" }), candidate: null,
      validator: { kind: "command", exit: { kind: "code", code: 0 }, stdoutHash: null, stderrHash: null },
    })).toThrow(/validator outcomes require a committed candidate/);
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo({ kind: "timeout" }), candidate,
      validator: { kind: "command", exit: { kind: "code", code: 0 }, stdoutHash: null, stderrHash: null },
    })).toThrow(/execution failures cannot retain a passing validator result/);
    expect(() => validatorOutcomeSchema.parse({
      ...failingValidator, exit: { kind: "code", code: 1 },
    })).toThrow();
    expect(() => nodeAttemptOutcomeSchema.parse({
      kind: "failed", failure: failureInfo({ kind: "process_error" }), candidate,
      validator: failingValidator,
    })).toThrow(/execution failures retain process evidence, not an agent verdict/);
  });

  test("correlates command validator outcomes with process exits", () => {
    const settings = {
      ...commandSettings(),
      validator: {
        kind: "command", command: "test -s candidate.txt", shell: "/bin/bash", cwd: "/tmp/project",
        timeoutMs: null, streamCapBytes: "unlimited", replay: "never",
      },
    };
    const workerFinishedAt = "2026-10-05T12:00:01.200Z";
    const candidateRecordedAt = "2026-10-05T12:00:01.250Z";
    const validatorStartedAt = "2026-10-05T12:00:01.500Z";
    const workerProcess = processIncarnation({
      finishedAt: workerFinishedAt, exit: { kind: "code", code: 0 }, captures: [],
    });
    const validatorProcess = processIncarnation({
      executionId: "execution-validator-command", incarnationId: "incarnation-validator-command-1",
      role: "validator", launchIntentAt: validatorStartedAt, startedAt: validatorStartedAt,
      captures: [],
    });
    const candidateRef = {
      ...evidence("candidate", "candidate-before-validator"), recordedAt: candidateRecordedAt,
    };
    const verdictRef = evidence("verdict", "verdict-before-validator");
    const rejectedAttempt = succeededAttempt({
      status: "failed", failure: failureInfo({ kind: "validator_rejection", message: "command rejected candidate" }),
      candidate: candidateRef, verdict: null, validatorExecutionId: "execution-validator-command",
      processes: [workerProcess, validatorProcess],
    });
    const node = nodeDetail({
      status: "failed", resolvedSettings: settings, attempts: [rejectedAttempt],
    });
    expect(() => nodeDetailDtoSchema.parse(node)).toThrow(/validator rejection requires a nonzero command-validator exit/);

    const nonzeroValidatorProcess = { ...validatorProcess, exit: { kind: "code", code: 1 } };
    expect(nodeDetailDtoSchema.parse({
      ...node, attempts: [{ ...rejectedAttempt, processes: [workerProcess, nonzeroValidatorProcess] }],
    }).status).toBe("failed");
    expect(() => nodeDetailDtoSchema.parse({
      ...node, attempts: [{
        ...rejectedAttempt, verdict: verdictRef, processes: [workerProcess, nonzeroValidatorProcess],
      }],
    })).toThrow(/command validator verdict evidence requires operator acceptance/);

    const agentSettings = {
      ...commandSettings(),
      validator: {
        kind: "agent", harnessCommand: "pi --print", model: "provider/model", instructions: "check candidate",
        shell: "/bin/bash", cwd: "/tmp/project", timeoutMs: null, streamCapBytes: "unlimited", replay: "never",
      },
    };
    const agentValidatorProcess = {
      ...validatorProcess, executionId: "execution-validator-agent",
      incarnationId: "incarnation-validator-agent-1", exit: { kind: "code", code: 1 },
    };
    const agentAttempt = succeededAttempt({
      status: "succeeded", failure: null, candidate: candidateRef,
      verdict: evidence("verdict", "verdict-agent-validator"),
      validatorExecutionId: "execution-validator-agent", processes: [workerProcess, agentValidatorProcess],
    });
    const agentNode = nodeDetail({
      status: "succeeded", successfulOutput: "candidate", resolvedSettings: agentSettings, attempts: [agentAttempt],
    });
    expect(() => nodeDetailDtoSchema.parse(agentNode)).toThrow(
      /agent verdict evidence requires a successful validator process exit or operator acceptance/,
    );
    const successfulAgentValidator = { ...agentValidatorProcess, exit: { kind: "code", code: 0 } };
    expect(nodeDetailDtoSchema.parse({
      ...agentNode, attempts: [{ ...agentAttempt, processes: [workerProcess, successfulAgentValidator] }],
    }).status).toBe("succeeded");
    const validatorUnknownBlock = blockInfo({
      blockId: "block-agent-validator-unknown", kind: "external_outcome_unknown", blockedAt: FINISHED_AT,
    });
    const validatorAcceptance = {
      kind: "operator_acceptance", resolutionId: "resolution-agent-validator-accept", provenance: "operator",
      target: "validator", reason: "I verified the validator result and acknowledged its effects.",
      resolvedAt: FINISHED_AT, processGroupsConfirmedDead: true, acknowledgedEffects: true,
      sourceBlock: validatorUnknownBlock, resultBytesHash: HASH_B,
    };
    const acceptedKnownFailure = {
      ...agentAttempt,
      verdict: evidence("verdict", "verdict-from-known-nonzero-exit", HASH_B),
      operatorAcceptances: [validatorAcceptance], blocks: [validatorUnknownBlock],
    };
    expect(() => nodeDetailDtoSchema.parse({
      ...agentNode, attempts: [acceptedKnownFailure],
    })).toThrow(
      /acceptance requires an unknown target-process outcome without an exit receipt/,
    );

    const successfulWithNonzeroValidator = {
      ...rejectedAttempt, status: "succeeded", failure: null, verdict: null,
      processes: [workerProcess, nonzeroValidatorProcess],
    };
    expect(() => nodeDetailDtoSchema.parse({
      ...node, status: "succeeded", successfulOutput: "candidate", attempts: [successfulWithNonzeroValidator],
    })).toThrow(/successful command validation requires exit code zero/);
    const blockedValidatorProcess = {
      ...validatorProcess, status: "blocked", finishedAt: null, exit: null, cleanupState: "confirmed_dead",
    };
    expect(() => nodeDetailDtoSchema.parse({
      ...node, status: "succeeded", successfulOutput: "candidate",
      attempts: [{ ...successfulWithNonzeroValidator, processes: [workerProcess, blockedValidatorProcess] }],
    })).toThrow(/successful command validation requires exit code zero/);
  });

  test("preserves operator acceptance and forced-failure provenance", () => {
    const acceptance = {
      kind: "operator_acceptance",
      resolutionId: "resolution-a",
      provenance: "operator",
      target: "worker",
      reason: "I verified the output and accept possible external effects.",
      resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true,
      acknowledgedEffects: true,
      sourceBlock: blockInfo({ kind: "external_outcome_unknown" }),
      resultBytesHash: HASH_B,
    };
    expect(operatorAcceptanceSchema.parse(acceptance).provenance).toBe("operator");
    const acceptedCandidate = {
      version: 1, source: "operator", workerKind: "agent", output: "accepted output",
      summary: "operator supplied", artifacts: [], sourceBytesHash: HASH_B, exit: null,
      acceptance,
    };
    expect(nodeResultSchema.parse(acceptedCandidate).source).toBe("operator");
    const wellFormedOperatorCandidate = nodeResultSchema.parse({ ...acceptedCandidate, output: "😀e\u0301\uFEFF" });
    expect(wellFormedOperatorCandidate.output).toBe("😀e\u0301\uFEFF");
    expect(() => nodeResultSchema.parse({ ...acceptedCandidate, output: "\uD800" })).toThrow(/well-formed Unicode/);
    expect(() => nodeResultSchema.parse({ ...acceptedCandidate, sourceBytesHash: HASH_A })).toThrow(/supplied result bytes/);
    const acceptedVerdict = {
      kind: "operator",
      verdict: { version: 1, passed: true, reason: "The checked verdict passed." },
      resultBytesHash: HASH_B,
      acceptance: { ...acceptance, target: "validator" },
    };
    expect(validatorOutcomeSchema.parse(acceptedVerdict).kind).toBe("operator");
    expect(runOutcomeSchema.parse({
      kind: "failed",
      failure: {
        kind: "operator", resolutionId: "resolution-b", provenance: "operator",
        reason: "Stop after reconciling all known processes.", failedAt: FINISHED_AT,
        processGroupsConfirmedDead: true, sourceBlock: blockInfo({ kind: "preflight_failed", nodeId: null, attemptId: null }),
      },
    }).kind).toBe("failed");
  });

  test("checks resolved artifact metadata and process capture integrity", () => {
    expect(resultArtifactSchema.parse({
      kind: "image",
      path: "/tmp/project/image.png",
      availability: "available",
      byteCount: 3,
      sha256: HASH_A,
    }).availability).toBe("available");
    expect(resultArtifactSchema.parse({
      kind: "image",
      path: "/tmp/project/gone.png",
      availability: "missing",
      byteCount: null,
      sha256: null,
    }).availability).toBe("missing");

    expect(resultArtifactSchema.parse({ kind: "file", path: "/tmp/project/unread.txt", availability: "available", byteCount: null, sha256: null }).availability).toBe("available");
    expect(() => resultArtifactSchema.parse({ kind: "file", path: "/tmp/project/bad\u0000path", availability: "available", byteCount: null, sha256: null })).toThrow();
    expect(() => resultArtifactSchema.parse({ kind: "", path: "/tmp/project/file", availability: "available", byteCount: null, sha256: null })).toThrow();
    expect(processCaptureSchema.parse(capture()).truncatedBytes).toBe(0);
    expect(processCaptureSchema.parse(capture({
      totalBytes: 10, retainedBytes: 6, truncatedBytes: 4, keptHeadBytes: 4, keptTailBytes: 2, complete: false,
    })).keptTailBytes).toBe(2);
    expect(() => processCaptureSchema.parse(capture({ totalBytes: 10, retainedBytes: 7, truncatedBytes: 2 }))).toThrow();
    expect(() => processCaptureSchema.parse(capture({ totalBytes: 10, retainedBytes: 6, truncatedBytes: 4, keptHeadBytes: 6 }))).toThrow();
    expect(() => processCaptureSchema.parse(capture({ totalBytes: 10, retainedBytes: 6, truncatedBytes: 4, keptHeadBytes: 4, keptTailBytes: 1 }))).toThrow();
    expect(() => processCaptureSchema.parse(capture({ sha256: null }))).toThrow(/require a SHA-256/);
    expect(String(processIncarnationSchema.parse(processIncarnation()).executionId)).toBe("execution-worker-a");
    expect(() => processIncarnationSchema.parse({ ...processIncarnation(), durableTaskId: "sdk-task-a" })).toThrow();
    expect(() => processIncarnationSchema.parse({ ...processIncarnation(), status: "running", identity: null, finishedAt: null, exit: null, cleanupState: "pending" })).toThrow(/running processes require identity/);
    expect(() => processIncarnationSchema.parse({ ...processIncarnation(), status: "exited", exit: null })).toThrow(/checked exit/);
    expect(() => processIncarnationSchema.parse({ ...processIncarnation({ status: "blocked", startedAt: null, finishedAt: null, identity: null, exit: null, cleanupState: "confirmed_dead" }) })).toThrow(/death cannot be confirmed/);
  });
});

describe("public JSON projections", () => {
  test("requires version 2, explicit nullability, and strict status metadata", () => {
    const summary = runSummary();
    expect(runSummaryDtoSchema.parse(summary).terminalOutput).toBeNull();
    expect(() => runSummaryDtoSchema.parse({ ...summary, taskId: "sdk-task-a" })).toThrow();
    expect(() => runSummaryDtoSchema.parse({ ...summary, finishedAt: FINISHED_AT })).toThrow(/finish time/);
    expect(() => runSummaryDtoSchema.parse({ ...summary, status: "blocked", block: null })).toThrow(/current block/);
    expect(() => runSummaryDtoSchema.parse({ ...summary, status: "failed", failure: null })).toThrow(/failure data/);
    expect(runSummaryDtoSchema.parse(runSummary({
      status: "blocked",
      block: blockInfo(),
      failure: failureInfo(),
    })).status).toBe("blocked");

    const status = {
      version: 2,
      generatedAt: ADMITTED_AT,
      installationId: "installation-a",
      service: {
        state: "running",
        pid: 99,
        bootId: "boot-a",
        startedAt: STARTED_AT,
        socketPath: "/tmp/workshop/service.sock",
        error: null,
      },
      workflows: [{
        workflowId: "clock",
        description: null,
        definitionHash: HASH_A,
        configurationError: null,
        activation: {
          activationId: "activation-a",
          state: "active",
          admittedCount: 1,
          maxRuns: 1,
          activatedAt: STARTED_AT,
          nextDueAt: null,
        },
        unresolvedRun: summary,
      }],
    };
    expect(statusDtoSchema.parse(status).version).toBe(2);
    expect(() => statusDtoSchema.parse({ ...status, apiToken: "secret" })).toThrow();
    expect(() => statusDtoSchema.parse({ ...status, workflows: [...status.workflows].reverse().concat(status.workflows) })).toThrow(/sorted by ID/);
  });

  test("allows unstarted controls and exposes capacity wait state", () => {
    expect(runSummaryDtoSchema.parse(runSummary({
      status: "queued", startedAt: null, currentNodeId: null, currentAttemptNumber: null,
    })).status).toBe("queued");
    expect(runSummaryDtoSchema.parse(runSummary({
      status: "queued", waitingForCapacity: true, currentNodeId: null, currentAttemptNumber: null,
    })).waitingForCapacity).toBe(true);
    const missingCapacityFlag = runSummary({ status: "queued", startedAt: null, currentNodeId: null, currentAttemptNumber: null }) as Record<string, unknown>;
    delete missingCapacityFlag.waitingForCapacity;
    expect(() => runSummaryDtoSchema.parse(missingCapacityFlag)).toThrow(/waitingForCapacity/);
    expect(runSummaryDtoSchema.parse(runSummary({
      status: "paused", desiredState: "paused", startedAt: null, currentNodeId: null,
      currentAttemptNumber: null, failure: failureInfo(),
    })).status).toBe("paused");
    expect(runSummaryDtoSchema.parse(runSummary({
      status: "cancelled", desiredState: "stopped", startedAt: null, finishedAt: FINISHED_AT,
      currentNodeId: null, currentAttemptNumber: null,
    })).status).toBe("cancelled");
    const operatorFailure = {
      kind: "operator", resolutionId: "resolution-a", provenance: "operator",
      reason: "Stop after reconciling all known processes.", failedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: blockInfo(),
    };
    expect(runSummaryDtoSchema.parse(runSummary({
      status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
      currentNodeId: null, currentAttemptNumber: null, failure: operatorFailure,
    })).failure?.kind).toBe("operator");
  });

  test("orders complete run lists newest first with a stable ID tie-break", () => {
    const newer = runSummary({ runId: "run-b", admittedAt: "2026-10-05T12:00:00.002Z" });
    const older = runSummary({ runId: "run-a", admittedAt: "2026-10-05T12:00:00.001Z" });
    expect(runsDtoSchema.parse({ version: 2, workflowId: "clock", total: 2, truncated: false, runs: [newer, older] }).runs).toHaveLength(2);
    expect(() => runsDtoSchema.parse({ version: 2, workflowId: "clock", total: 2, truncated: false, runs: [older, newer] })).toThrow(/newest first/);
    expect(() => runsDtoSchema.parse({ version: 2, workflowId: "clock", total: 2, truncated: true, runs: [newer, older] })).toThrow(/truncation/);
    const allRuns = Array.from({ length: 1001 }, (_, index) => runSummary({
      runId: `run-${String(index).padStart(4, "0")}`, admittedAt: ADMITTED_AT,
    }));
    expect(runsDtoSchema.parse({
      version: 2, workflowId: "clock", total: allRuns.length, truncated: false, runs: allRuns,
    }).runs).toHaveLength(1001);
    const tieA = runSummary({ runId: "run-A", admittedAt: ADMITTED_AT });
    const tiea = runSummary({ runId: "run-a", admittedAt: ADMITTED_AT });
    expect(runsDtoSchema.parse({ version: 2, workflowId: "clock", total: 2, truncated: false, runs: [tieA, tiea] }).runs).toHaveLength(2);
    expect(() => runsDtoSchema.parse({ version: 2, workflowId: "clock", total: 2, truncated: false, runs: [tiea, tieA] })).toThrow(/stable tie-break/);
    expect(() => runsDtoSchema.parse({
      version: 2, workflowId: "clock", total: 2, truncated: false,
      runs: [runSummary({ runId: "duplicate", admittedAt: "2026-10-05T12:00:00.002Z" }), runSummary({ runId: "duplicate", admittedAt: "2026-10-05T12:00:00.001Z" })],
    })).toThrow(/run IDs must be unique/);
  });

  test("validates standalone attempt and node detail projections", () => {
    const first = nodeDetail({
      status: "succeeded",
      successfulOutput: "first output",
      attempts: [succeededAttempt()],
    });
    const preflightProcess = processIncarnation({
      executionId: "execution-preflight", incarnationId: "incarnation-preflight-a", role: "preflight", replay: "safe",
      launchIntentAt: ADMITTED_AT, startedAt: ADMITTED_AT, finishedAt: "2026-10-05T12:00:00.500Z",
    });
    expect(() => attemptDetailDtoSchema.parse({ ...succeededAttempt(), processes: [preflightProcess] }))
      .toThrow(/preflight processes belong to the run/);
    const interruptedBlock = blockInfo({ blockId: "block-interrupted" });
    const interrupted = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [interruptedBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
    });
    expect(attemptDetailDtoSchema.parse(interrupted).blocks[0]?.kind).toBe("process_death_unconfirmed");
    expect(() => attemptDetailDtoSchema.parse({ ...interrupted, status: "succeeded" }))
      .toThrow(/succeeded attempts require/);
    expect(() => nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: null, runStatus: null, runFailure: null, node: first,
    })).toThrow(/no runtime history/);
  });


  test("validates process replay history and millisecond timestamps", () => {
    const firstIncarnation = processIncarnation({
      status: "blocked", exit: null, cleanupState: "confirmed_dead", replay: "safe",
      stdio: { version: 1, stdinSha256: HASH_A, stdinByteCount: 5, write: { kind: "unknown_after_restart", queuedBytes: 2 } },
    });
    const secondIncarnation = processIncarnation({
      incarnationId: "incarnation-worker-a-2", incarnationNumber: 2, replay: "safe",
      launchIntentAt: "2026-10-05T12:00:02.003Z", startedAt: "2026-10-05T12:00:02.003Z",
      finishedAt: "2026-10-05T12:00:04.000Z",
    });
    const replayedAttempt = succeededAttempt({
      finishedAt: "2026-10-05T12:00:04.000Z", elapsedMs: 3_000,
      candidate: { ...evidence("candidate", "evidence-candidate-a", HASH_A), recordedAt: "2026-10-05T12:00:04.000Z" },
      processes: [firstIncarnation, secondIncarnation],
    });
    const projectedProcesses = attemptDetailDtoSchema.parse(replayedAttempt).processes;
    expect(projectedProcesses).toHaveLength(2);
    expect(projectedProcesses[0]?.stdio).toEqual({
      version: 1, stdinSha256: HASH_A, stdinByteCount: 5,
      write: { kind: "unknown_after_restart", queuedBytes: 2 },
    });
    const knownFailureExit = { ...firstIncarnation, status: "exited", exit: { kind: "code", code: 1 } };
    const knownSuccessExit = { ...firstIncarnation, status: "exited", exit: { kind: "code", code: 0 } };
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [knownFailureExit, secondIncarnation],
    })).toThrow(/exitless blocked incarnation/);
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [knownSuccessExit, secondIncarnation],
    })).toThrow(/exitless blocked incarnation/);
    const failedAgentValidator = processIncarnation({
      executionId: "execution-validator-replay", incarnationId: "incarnation-validator-replay-1",
      incarnationNumber: 1, role: "validator", replay: "safe",
      launchIntentAt: "2026-10-05T12:00:02.001Z", startedAt: "2026-10-05T12:00:02.001Z",
      finishedAt: "2026-10-05T12:00:03.000Z",
      identity: { pid: 202, pgid: 202, startIdentity: "validator-start-1", serviceBootId: "boot-a" },
      exit: { kind: "code", code: 1 },
    });
    const replayedAgentValidator = {
      ...failedAgentValidator, incarnationId: "incarnation-validator-replay-2", incarnationNumber: 2,
      launchIntentAt: "2026-10-05T12:00:03.001Z", startedAt: "2026-10-05T12:00:03.001Z",
      finishedAt: "2026-10-05T12:00:04.000Z",
      identity: { pid: 203, pgid: 203, startIdentity: "validator-start-2", serviceBootId: "boot-a" },
      exit: { kind: "code", code: 0 },
    };
    const validatorRerolledAfterFailure = {
      ...replayedAttempt, finishedAt: "2026-10-05T12:00:04.000Z", elapsedMs: 3_000,
      validatorExecutionId: "execution-validator-replay",
      candidate: { ...evidence("candidate", "candidate-before-validator-replay"), recordedAt: FINISHED_AT },
      verdict: { ...evidence("verdict", "verdict-replayed-validator"), recordedAt: "2026-10-05T12:00:04.000Z" },
      processes: [processIncarnation(), failedAgentValidator, replayedAgentValidator],
    };
    expect(() => attemptDetailDtoSchema.parse(validatorRerolledAfterFailure))
      .toThrow(/exitless blocked incarnation/);
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [firstIncarnation, { ...secondIncarnation, replay: "never" }],
    })).toThrow(/replay=safe/);
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [firstIncarnation, { ...secondIncarnation, commandHash: HASH_B }],
    })).toThrow(/preserve role/);
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [
        { ...firstIncarnation, cleanupState: "unconfirmed" }, secondIncarnation,
      ],
    })).toThrow(/confirmed group death/);
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [firstIncarnation, { ...secondIncarnation, launchIntentAt: STARTED_AT, startedAt: STARTED_AT }],
    })).toThrow(/follows confirmed prior completion/);
    expect(() => attemptDetailDtoSchema.parse({
      ...replayedAttempt, processes: [firstIncarnation, { ...secondIncarnation, incarnationId: firstIncarnation.incarnationId }],
    })).toThrow(/incarnation IDs must be unique/);
    expect(() => runSummaryDtoSchema.parse(runSummary({ admittedAt: "2026-10-05T12:00:00.000000001Z" }))).toThrow();
    expect(() => attemptDetailDtoSchema.parse({ ...succeededAttempt(), elapsedMs: 999 })).toThrow(/elapsed time must equal/);
  });

  test("requires an exit receipt or confirmed deadline for terminal failure", () => {
    const deadlineAt = "2026-10-05T12:00:03.000Z";
    const timedOutProcess = processIncarnation({
      status: "blocked", exit: null, cleanupState: "confirmed_dead",
      deadlineAt, finishedAt: deadlineAt,
    });
    const timeoutFailure = failureInfo({ kind: "timeout", failedAt: deadlineAt });
    const timeoutAttempt = succeededAttempt({
      status: "failed", candidate: null, failure: timeoutFailure,
      finishedAt: deadlineAt, elapsedMs: 2_000, processes: [timedOutProcess],
    });
    expect(attemptDetailDtoSchema.parse(timeoutAttempt).failure?.kind).toBe("timeout");
    expect(() => attemptDetailDtoSchema.parse({
      ...timeoutAttempt, failure: { ...timeoutFailure, kind: "process_error" },
    })).toThrow(/exitless blocked process as a known failure/);
    expect(() => attemptDetailDtoSchema.parse({
      ...timeoutAttempt,
      finishedAt: FINISHED_AT, elapsedMs: 1_000,
      failure: { ...timeoutFailure, failedAt: FINISHED_AT },
      processes: [{ ...timedOutProcess, finishedAt: FINISHED_AT }],
    })).toThrow(/confirmed deadline timeout/);
  });

  test("links operator-forced failure to its interrupted attempt and block history", () => {
    const sourceBlock = blockInfo({ blockId: "block-operator-fail" });
    const interrupted = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [sourceBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "confirmed_dead" })],
    });
    const failedNode = nodeDetail({ status: "failed", attempts: [interrupted] });
    const resolution = {
      action: "fail", resolutionId: "resolution-fail-a", provenance: "operator",
      reason: "Stop after reconciling all known processes.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock,
    };
    const runFailure = {
      kind: "operator", resolutionId: "resolution-fail-a", provenance: "operator",
      reason: resolution.reason, failedAt: FINISHED_AT, processGroupsConfirmedDead: true, sourceBlock,
    };
    expect(operatorResolutionSchema.parse(resolution).action).toBe("fail");
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a", runStatus: "failed", runFailure, node: failedNode,
    }).runFailure?.kind).toBe("operator");
  });


  test("accepts only ordered worklog and capture log sections", () => {
    const logs = {
      version: 2,
      runId: "run-a",
      sections: [
        { kind: "worklog", sectionId: "worklog", order: 0, label: "Worklog", content: "completed" },
        {
          kind: "capture",
          sectionId: "stdout-a",
          order: 1,
          label: "Worker stdout",
          executionId: "execution-worker-a",
          incarnationNumber: 1,
          capture: capture({ totalBytes: 8, retainedBytes: 5, truncatedBytes: 3, complete: false }),
          content: "hello",
        },
      ],
    };
    expect(logsDtoSchema.parse(logs).sections).toHaveLength(2);
    expect(logsDtoSchema.parse({
      ...logs, sections: [logs.sections[0], { ...logs.sections[1], content: null }],
    }).sections[1]?.content).toBeNull();
    const parsedLogs = logsDtoSchema.parse(logs);
    const parsedCapture = parsedLogs.sections[1];
    expect(parsedCapture?.kind).toBe("capture");
    if (parsedCapture?.kind !== "capture") throw new Error("capture section is missing");
    expect(Object.hasOwn(parsedCapture.capture, "content")).toBe(false);
    expect(() => logsDtoSchema.parse({ ...logs, sections: [...logs.sections].reverse() })).toThrow(/logs begin with their worklog/);
    expect(() => logsDtoSchema.parse({
      ...logs, sections: [{ kind: "event", sectionId: "event-a", order: 0, label: "Event", content: "" }],
    })).toThrow();
  });



  test("validates operator acceptance in node details", () => {
    const sourceBlock = blockInfo({ blockId: "block-accepted", kind: "external_outcome_unknown" });
    const acceptance = {
      kind: "operator_acceptance", resolutionId: "resolution-accepted", provenance: "operator",
      target: "worker", reason: "I verified the supplied result and acknowledged its effects.",
      resolvedAt: FINISHED_AT, processGroupsConfirmedDead: true, acknowledgedEffects: true,
      sourceBlock, resultBytesHash: HASH_B,
    };
    const acceptedAttempt = succeededAttempt({
      candidate: evidence("candidate", "evidence-accepted", HASH_B),
      operatorAcceptances: [acceptance],
      blocks: [sourceBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "confirmed_dead" })],
    });
    const acceptedNode = nodeDetail({
      status: "succeeded", successfulOutput: "accepted output", attempts: [acceptedAttempt],
    });
    expect(nodeDetailDtoSchema.parse(acceptedNode).attempts[0]?.operatorAcceptances[0]?.resultBytesHash)
      .toBe(HASH_B);
    expect(() => nodeDetailDtoSchema.parse(nodeDetail({
      ...acceptedNode, attempts: [{
        ...acceptedAttempt, operatorAcceptances: [{ ...acceptance, resultBytesHash: HASH_A }],
      }],
    }))).toThrow(/acceptance hash must match/);
    expect(() => nodeDetailDtoSchema.parse(nodeDetail({
      ...acceptedNode, attempts: [{
        ...acceptedAttempt,
        processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
      }],
    }))).toThrow(/target process groups to be reconciled/);
    const olderSourceBlock = {
      ...sourceBlock, blockId: "block-older-acceptance-source", blockedAt: "2026-10-05T12:00:01.500Z",
    };
    const newerSourceBlock = {
      ...sourceBlock, blockId: "block-newer-acceptance-source",
      kind: "process_death_unconfirmed", blockedAt: "2026-10-05T12:00:01.750Z",
    };
    expect(() => nodeDetailDtoSchema.parse(nodeDetail({
      ...acceptedNode, attempts: [{
        ...acceptedAttempt, blocks: [olderSourceBlock, newerSourceBlock],
        operatorAcceptances: [{ ...acceptance, sourceBlock: olderSourceBlock }],
      }],
    }))).toThrow(/acceptance identifies the latest block at its resolution time/);

    const validatorProcess = processIncarnation({
      executionId: "execution-validator-a", incarnationId: "incarnation-validator-a-1", role: "validator",
      launchIntentAt: "2026-10-05T12:00:02.001Z", startedAt: "2026-10-05T12:00:02.001Z",
      finishedAt: "2026-10-05T12:00:03.000Z",
    });
    const validatorSettings = {
      ...commandSettings(),
      validator: {
        kind: "command", command: "test -s result.txt", shell: "/bin/bash", cwd: "/tmp/project",
        timeoutMs: null, streamCapBytes: "unlimited", replay: "never",
      },
    };
    const acceptedWithValidator = {
      ...acceptedAttempt, finishedAt: "2026-10-05T12:00:03.000Z", elapsedMs: 2_000,
      validatorExecutionId: "execution-validator-a",
      processes: [acceptedAttempt.processes[0], validatorProcess],
    };
    expect(nodeDetailDtoSchema.parse(nodeDetail({
      ...acceptedNode, resolvedSettings: validatorSettings, attempts: [acceptedWithValidator],
    })).attempts[0]?.processes).toHaveLength(2);
    expect(() => nodeDetailDtoSchema.parse(nodeDetail({
      ...acceptedNode, resolvedSettings: validatorSettings, attempts: [acceptedAttempt],
    }))).toThrow(/configured validation requires validator execution evidence/);
    const commandValidatorBlock = blockInfo({
      blockId: "block-command-validator-acceptance", kind: "external_outcome_unknown", blockedAt: FINISHED_AT,
    });
    const commandValidatorAcceptance = {
      ...acceptance, resolutionId: "resolution-command-validator-acceptance", target: "validator",
      sourceBlock: commandValidatorBlock,
    };
    const acceptedValidatorProcess = {
      ...validatorProcess, status: "blocked", exit: null,
      launchIntentAt: "2026-10-05T12:00:01.500Z", startedAt: "2026-10-05T12:00:01.500Z",
      finishedAt: null, cleanupState: "confirmed_dead",
    };
    const committedWorkerProcess = {
      ...acceptedAttempt.processes[0], status: "exited", exit: { kind: "code", code: 0 },
      finishedAt: "2026-10-05T12:00:01.300Z",
    };
    const acceptedCommandValidatorAttempt = {
      ...acceptedWithValidator,
      candidate: { ...acceptedAttempt.candidate, recordedAt: "2026-10-05T12:00:01.400Z" },
      verdict: evidence("verdict", "evidence-command-validator-acceptance", HASH_B),
      operatorAcceptances: [commandValidatorAcceptance],
      blocks: [commandValidatorBlock],
      processes: [committedWorkerProcess, acceptedValidatorProcess],
    };
    expect(nodeDetailDtoSchema.parse(nodeDetail({
      ...acceptedNode, resolvedSettings: validatorSettings, attempts: [acceptedCommandValidatorAttempt],
    })).attempts[0]?.operatorAcceptances[0]?.target).toBe("validator");
  });


  test("requires committed candidate before validator launch", () => {
    const candidate = evidence("candidate", "evidence-before-validator");
    const validatorProcess = processIncarnation({
      executionId: "execution-validator-a", incarnationId: "incarnation-validator-a-1", role: "validator",
      status: "running", launchIntentAt: "2026-10-05T12:00:01.500Z", startedAt: "2026-10-05T12:00:01.500Z",
      finishedAt: null, exit: null, cleanupState: "pending",
    });
    const validatingAttempt = succeededAttempt({
      status: "validating", phase: "awaitValidator", finishedAt: null, elapsedMs: null,
      candidate, validatorExecutionId: "execution-validator-a", processes: [processIncarnation(), validatorProcess],
    });
    expect(() => attemptDetailDtoSchema.parse(validatingAttempt))
      .toThrow(/validator launch follows worker completion/);
    expect(() => attemptDetailDtoSchema.parse({ ...validatingAttempt, candidate: null }))
      .toThrow(/validator execution requires a committed candidate/);
  });

  test("validates node descriptions against runtime failure scope", () => {
    const attemptFailure = failureInfo({ kind: "process_error", message: "the semantic attempt failed" });
    const failedAttempt = succeededAttempt({
      status: "failed", candidate: null, failure: attemptFailure, blocks: [],
      processes: [processIncarnation({ exit: { kind: "code", code: 1 } })],
    });
    const failedNode = nodeDetail({ status: "failed", attempts: [failedAttempt] });
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "cancelled", runFailure: null, node: failedNode,
    }).node.status).toBe("failed");

    const blockWithoutAttempt = blockInfo({
      blockId: "block-missing-attempt", kind: "retry_exhausted", nodeId: "node-a", attemptId: null,
    });
    const blockedAfterAttempt = nodeDetailDtoSchema.parse({
      ...failedNode, status: "blocked", block: blockWithoutAttempt,
    });
    expect(blockedAfterAttempt.status).toBe("blocked");
    const nodeRunResolution = {
      action: "fail", resolutionId: "resolution-node-run-fail", provenance: "operator",
      reason: "End the blocked node after reviewing the prior failed attempt.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: blockWithoutAttempt,
    };
    const nodeRunFailure = {
      kind: "operator", resolutionId: nodeRunResolution.resolutionId, provenance: "operator",
      reason: nodeRunResolution.reason, failedAt: FINISHED_AT, processGroupsConfirmedDead: true,
      sourceBlock: blockWithoutAttempt,
    };
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "failed", runFailure: nodeRunFailure, node: failedNode,
    }).runFailure?.kind).toBe("operator");
    const runBlock = blockInfo({
      blockId: "block-run-level", kind: "orchestrator_unavailable", nodeId: null, attemptId: null,
    });
    const runFailure = {
      kind: "operator", resolutionId: "resolution-run-fail", provenance: "operator",
      reason: "End the blocked run after reviewing its state.", failedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: runBlock,
    };
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "failed", runFailure, node: failedNode,
    }).runFailure?.kind).toBe("operator");
    expect(() => nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "failed", runFailure: null, node: failedNode,
    })).toThrow(/failed attempts retain/);
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "failed", runFailure: attemptFailure, node: failedNode,
    }).runFailure?.kind).toBe("process_error");

    const unstartedBlock = blockInfo({
      blockId: "block-unstarted", kind: "orchestrator_unavailable", nodeId: "node-a", attemptId: null,
    });
    const unstartedNode = nodeDetail({ status: "blocked", block: unstartedBlock });
    const unstartedFailure = {
      kind: "operator", resolutionId: "resolution-unstarted-fail", provenance: "operator",
      reason: "End the run before starting its first attempt.", failedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: unstartedBlock,
    };
    const unstartedDescription = {
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "failed", runFailure: unstartedFailure, node: nodeDetail(),
    };
    expect(nodeDescriptionDtoSchema.parse(unstartedDescription).node.status).toBe("pending");
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription, runFailure: null,
    })).toThrow(/failed runs retain their terminal failure cause/);
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription, runStatus: "completed", runFailure: null,
    })).toThrow(/completed runs contain only succeeded nodes/);
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription, runStatus: "running", runFailure: null, node: unstartedNode,
    })).toThrow(/blocked node belongs to a blocked run/);
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription, runStatus: "completed",
    })).toThrow(/run failure details appear only while resolving or reporting a failure/);

    const preflightOperatorFailure = {
      ...unstartedFailure,
      sourceBlock: blockInfo({
        blockId: "block-preflight-description", kind: "preflight_failed", nodeId: null, attemptId: null,
      }),
    };
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription, runFailure: preflightOperatorFailure, node: failedNode,
    })).toThrow(/operator-failed preflight leaves every node pending/);
    const otherNodeOperatorFailure = {
      ...unstartedFailure,
      sourceBlock: blockInfo({
        blockId: "block-other-node-description", kind: "retry_exhausted", nodeId: "node-b", attemptId: "attempt-b",
      }),
    };
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription, runFailure: otherNodeOperatorFailure, node: failedNode,
    })).toThrow(/another node's operator block/);
    expect(() => nodeDescriptionDtoSchema.parse({
      ...unstartedDescription,
      runFailure: failureInfo({ kind: "runtime_fault", nodeId: "node-a", attemptId: null }),
    })).toThrow(/node-scoped run failures identify their failed latest attempt/);
  });

});
