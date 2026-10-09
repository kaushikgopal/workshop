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
  validatorOutcomeSchema,
} from "../src/run/schema.js";
import {
  nodeDetailDtoSchema,
  attemptDetailDtoSchema,
  logsDtoSchema,
  nodeDescriptionDtoSchema,
  runDetailDtoSchema,
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
    const acceptedKnownFailureRun = {
      version: 2,
      summary: runSummary({
        status: "completed", currentNodeId: "node-a", currentAttemptNumber: 1, terminalOutput: "candidate",
      }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({
        status: "succeeded", successfulOutput: "candidate", resolvedSettings: agentSettings,
        attempts: [acceptedKnownFailure],
      })],
    };
    expect(() => runDetailDtoSchema.parse(acceptedKnownFailureRun)).toThrow(
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

  test("preserves a selected historical chain in position order", () => {
    const first = nodeDetail({
      nodeId: "node-a",
      position: 1,
      predecessorId: null,
      successorId: "node-b",
      status: "succeeded",
      successfulOutput: "first output",
      attempts: [succeededAttempt()],
    });
    const second = nodeDetail({
      nodeId: "node-b",
      position: 2,
      predecessorId: "node-a",
      successorId: null,
    });
    const preflightFinishedAt = "2026-10-05T12:00:00.500Z";
    const preflightProcess = processIncarnation({
      executionId: "execution-preflight", incarnationId: "incarnation-preflight-a", role: "preflight", replay: "safe",
      launchIntentAt: ADMITTED_AT, startedAt: ADMITTED_AT, finishedAt: preflightFinishedAt,
    });
    const preflight = {
      cacheKeyHash: HASH_B, outcome: "passed", reusedFrom: null,
      checks: [{
        checkId: "preflight-check-a", outcome: "passed", startedAt: ADMITTED_AT, finishedAt: preflightFinishedAt,
        failure: null, block: null, processes: [preflightProcess],
      }],
    };
    const detail = {
      version: 2, summary: runSummary({ currentNodeId: "node-b", currentAttemptNumber: null }),
      preflight, resolutions: [], nodes: [first, second],
    };
    const parsed = runDetailDtoSchema.parse(detail);
    expect(parsed.nodes.map((node) => node.nodeId)).toEqual(["node-a", "node-b"]);
    expect(String(parsed.preflight?.checks[0]?.processes[0]?.executionId)).toBe("execution-preflight");
    expect(() => attemptDetailDtoSchema.parse({ ...succeededAttempt(), processes: [preflightProcess] })).toThrow(/preflight processes belong to the run/);
    const interruptedBlock = blockInfo({ blockId: "block-interrupted" });
    const interrupted = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [interruptedBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
    });
    expect(attemptDetailDtoSchema.parse(interrupted).blocks[0]?.kind).toBe("process_death_unconfirmed");
    expect(() => attemptDetailDtoSchema.parse({ ...interrupted, status: "succeeded" })).toThrow(/succeeded attempts require/);
    expect(() => runDetailDtoSchema.parse({ ...detail, nodes: [second, first] })).toThrow(/chain position|chain/);
    expect(() => nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: null, runStatus: null, runFailure: null, node: first,
    })).toThrow(/no runtime history/);
  });

  test("allows pending successors after the current running or blocked node", () => {
    const pendingSuccessor = nodeDetail({
      nodeId: "node-b", position: 2, predecessorId: "node-a", successorId: null,
    });
    const runningProcess = processIncarnation({
      status: "running", finishedAt: null, exit: null, cleanupState: "pending",
    });
    const runningAttempt = succeededAttempt({
      status: "executing", phase: "awaitWorker", finishedAt: null, elapsedMs: null,
      candidate: null, processes: [runningProcess],
    });
    const runningNode = nodeDetail({
      status: "running", successorId: "node-b", attempts: [runningAttempt],
    });
    const runningDetail = {
      version: 2, summary: runSummary({ currentNodeId: "node-a", currentAttemptNumber: 1 }),
      preflight: null, resolutions: [], nodes: [runningNode, pendingSuccessor],
    };
    expect(runDetailDtoSchema.parse(runningDetail).nodes.map((node) => node.status))
      .toEqual(["running", "pending"]);

    const block = blockInfo({
      blockId: "block-pending-successor", kind: "external_outcome_unknown",
      reason: "the worker outcome is unknown", nodeId: "node-a", attemptId: "attempt-a",
    });
    const interruptedAttempt = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [block],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
    });
    const blockedNode = nodeDetail({
      status: "blocked", block, successorId: "node-b", attempts: [interruptedAttempt],
    });
    const blockedDetail = {
      version: 2, summary: runSummary({
        status: "blocked", block, currentNodeId: "node-a", currentAttemptNumber: 1,
      }),
      preflight: null, resolutions: [], nodes: [blockedNode, pendingSuccessor],
    };
    expect(runDetailDtoSchema.parse(blockedDetail).nodes.map((node) => node.status))
      .toEqual(["blocked", "pending"]);

    const succeededLaterAttempt = succeededAttempt({
      attemptId: "attempt-b", workerExecutionId: "execution-worker-b",
      candidate: evidence("candidate", "evidence-candidate-b"),
      processes: [processIncarnation({
        executionId: "execution-worker-b", incarnationId: "incarnation-worker-b-1",
      })],
    });
    const succeededLaterNode = nodeDetail({
      nodeId: "node-b", position: 2, predecessorId: "node-a", successorId: null,
      status: "succeeded", successfulOutput: "later output", attempts: [succeededLaterAttempt],
    });
    expect(() => runDetailDtoSchema.parse({
      ...runningDetail, nodes: [runningNode, succeededLaterNode],
    })).toThrow(/succeeded nodes form a prefix/);
  });

  test("validates process replay history and millisecond timestamps", () => {
    const firstIncarnation = processIncarnation({
      status: "blocked", exit: null, cleanupState: "confirmed_dead", replay: "safe",
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
    expect(attemptDetailDtoSchema.parse(replayedAttempt).processes).toHaveLength(2);
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
    const unresolvedReplayBlock = blockInfo({
      blockId: "block-replay-without-resolution", kind: "external_outcome_unknown",
      blockedAt: "2026-10-05T12:00:01.500Z",
    });
    const replayAfterCommittedBlock = { ...replayedAttempt, blocks: [unresolvedReplayBlock] };
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "completed", finishedAt: "2026-10-05T12:00:04.000Z",
        terminalOutput: "replayed output",
      }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({
        status: "succeeded", successfulOutput: "replayed output", attempts: [replayAfterCommittedBlock],
      })],
    })).toThrow(/every block remains current or has an audited resolution/);
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
    const summary = runSummary({
      status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
      currentNodeId: "node-a", currentAttemptNumber: 1, failure: runFailure,
    });
    const detail = { version: 2, summary, preflight: null, resolutions: [resolution], nodes: [failedNode] };
    expect(operatorResolutionSchema.parse(resolution).action).toBe("fail");
    expect(runDetailDtoSchema.parse(detail).summary.failure?.kind).toBe("operator");
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a", runStatus: "failed", runFailure, node: failedNode,
    }).runFailure?.kind).toBe("operator");
    expect(() => runDetailDtoSchema.parse({ ...detail, resolutions: [] })).toThrow(/match its fail resolution/);
    expect(() => runDetailDtoSchema.parse({
      ...detail, summary: { ...summary, failure: { ...runFailure, sourceBlock: blockInfo({ blockId: "block-other" }) } },
    })).toThrow(/retained historical evidence/);
  });

  test("retains preflight failure evidence and rejects contradictory terminal runs", () => {
    const preflightBlock = blockInfo({
      blockId: "block-preflight", kind: "preflight_failed", nodeId: null, attemptId: null,
    });
    const preflightProcess = processIncarnation({
      executionId: "execution-preflight-fail", incarnationId: "incarnation-preflight-fail",
      role: "preflight", replay: "safe", exit: { kind: "code", code: 1 },
    });
    const failedPreflight = {
      cacheKeyHash: HASH_B, outcome: "failed", reusedFrom: null,
      checks: [{
        checkId: "preflight-check-failed", outcome: "failed", startedAt: STARTED_AT, finishedAt: FINISHED_AT,
        failure: failureInfo({ kind: "process_error", nodeId: null, attemptId: null }),
        block: preflightBlock, processes: [preflightProcess],
      }],
    };
    const blockedSummary = runSummary({
      status: "blocked", currentNodeId: null, currentAttemptNumber: null, block: preflightBlock,
    });
    const preflightDetail = {
      version: 2, summary: blockedSummary, preflight: failedPreflight, resolutions: [],
      nodes: [nodeDetail()],
    };
    expect(runDetailDtoSchema.parse(preflightDetail).preflight?.outcome).toBe("failed");
    expect(() => runDetailDtoSchema.parse({ ...preflightDetail, preflight: null })).toThrow(/preflight failure requires/);
    expect(() => runDetailDtoSchema.parse({
      ...preflightDetail, preflight: {
        ...failedPreflight, checks: [{ ...failedPreflight.checks[0], processes: [{ ...preflightProcess, replay: "never" }] }],
      },
    })).toThrow(/preflight must be repeat-safe/);

    const succeeded = nodeDetail({
      status: "succeeded", successfulOutput: "done", attempts: [succeededAttempt()],
    });
    const impossibleFailure = runSummary({
      status: "failed", currentNodeId: null, currentAttemptNumber: null, finishedAt: FINISHED_AT,
      failure: failureInfo({ kind: "runtime_fault", nodeId: null, attemptId: null }),
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: impossibleFailure, preflight: null, resolutions: [], nodes: [succeeded],
    })).toThrow(/failed runs retain/);

    const uncertainBlock = blockInfo({ blockId: "block-cancelled" });
    const interrupted = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [uncertainBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
    });
    const cancelled = runSummary({
      status: "cancelled", desiredState: "stopped", finishedAt: FINISHED_AT,
      currentNodeId: null, currentAttemptNumber: null,
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: cancelled, preflight: null, resolutions: [],
      nodes: [nodeDetail({ status: "cancelled", attempts: [interrupted] })],
    })).toThrow(/terminal runs have no live or uncertain process groups/);
    const reconcilingAttempt = {
      ...interrupted,
      processes: [processIncarnation({ status: "reconciling", exit: null, cleanupState: "confirmed_dead" })],
    };
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: cancelled, preflight: null, resolutions: [],
      nodes: [nodeDetail({ status: "cancelled", attempts: [reconcilingAttempt] })],
    })).toThrow(/only prepared or reconciled process incarnations/);
    const preparedProcess = processIncarnation({
      status: "prepared", launchIntentAt: null, startedAt: null, finishedAt: null, deadlineAt: null,
      identity: null, exit: null, cleanupState: "not_started", captures: [],
    });
    const cancelledBeforeStart = succeededAttempt({
      status: "cancelled", phase: null, startedAt: null, finishedAt: FINISHED_AT, elapsedMs: null,
      candidate: null, processes: [preparedProcess],
    });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: cancelled, preflight: null, resolutions: [],
      nodes: [nodeDetail({ status: "cancelled", attempts: [cancelledBeforeStart] })],
    }).nodes[0]?.attempts[0]?.startedAt).toBeNull();
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: cancelled, preflight: null, resolutions: [], nodes: [succeeded],
    })).toThrow(/fully successful chain is completed rather than cancelled/);
  });

  test("requires explicit log-capture availability and projection truncation metadata", () => {
    const logs = {
      version: 2,
      runId: "run-a",
      sections: [
        { kind: "worklog", sectionId: "worklog", order: 0, label: "Worklog", content: "completed", omittedBytes: 0 },
        {
          kind: "capture",
          sectionId: "stdout-a",
          order: 1,
          label: "Worker stdout",
          executionId: "execution-worker-a",
          incarnationNumber: 1,
          capture: capture({ totalBytes: 8, retainedBytes: 5, truncatedBytes: 3, complete: false }),
          content: "hello",
          unavailableReason: null,
          omittedBytes: 0,
        },
      ],
      projection: { truncated: false, omittedSections: 0, omittedBytes: 0 },
    };
    expect(logsDtoSchema.parse(logs).sections).toHaveLength(2);
    expect(logsDtoSchema.parse({
      ...logs, sections: [{
        ...logs.sections[1],
        capture: capture({ totalBytes: 3, retainedBytes: 2, truncatedBytes: 1, complete: false }),
        content: "�",
      }],
    }).sections).toHaveLength(1);
    expect(() => logsDtoSchema.parse({ ...logs, projection: { truncated: false, omittedSections: 0, omittedBytes: 4 } })).toThrow(/truncation flag/);
    expect(() => logsDtoSchema.parse({ ...logs, sections: [...logs.sections].reverse() })).toThrow(/uniquely ordered/);
    expect(() => logsDtoSchema.parse({
      ...logs,
      sections: [
        { kind: "event", sectionId: "event-a", order: 0, label: "First", content: "", omittedBytes: Number.MAX_SAFE_INTEGER },
        { kind: "event", sectionId: "event-b", order: 1, label: "Second", content: "", omittedBytes: Number.MAX_SAFE_INTEGER },
      ],
      projection: { truncated: true, omittedSections: 0, omittedBytes: Number.MAX_SAFE_INTEGER },
    })).toThrow(/aggregate omitted bytes exceed/);
  });

  test("links operator acceptance to exact supplied bytes and reconciled process groups", () => {
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
    const acceptedNode = nodeDetail({ status: "succeeded", successfulOutput: "accepted output", attempts: [acceptedAttempt] });
    const acceptedRun = runSummary({
      status: "completed", finishedAt: FINISHED_AT, currentNodeId: null, currentAttemptNumber: null,
      terminalOutput: "accepted output",
    });
    const detail = { version: 2, summary: acceptedRun, preflight: null, resolutions: [], nodes: [acceptedNode] };
    expect(runDetailDtoSchema.parse(detail).nodes[0]?.attempts[0]?.operatorAcceptances[0]?.resultBytesHash).toBe(HASH_B);
    const invalidRetryOfAcceptedResult = {
      action: "retry", resolutionId: "resolution-retry-accepted", provenance: "operator",
      reason: "Retry a result that was already accepted.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock, allowRepeat: true, extraAttempt: false,
    };
    expect(() => runDetailDtoSchema.parse({ ...detail, resolutions: [invalidRetryOfAcceptedResult] }))
      .toThrow(/each block has at most one resolution or acceptance/);
    expect(() => runDetailDtoSchema.parse({
      ...detail, nodes: [nodeDetail({ ...acceptedNode, attempts: [{
        ...acceptedAttempt, operatorAcceptances: [{ ...acceptance, resultBytesHash: HASH_A }],
      }] })],
    })).toThrow(/acceptance hash must match/);
    expect(() => runDetailDtoSchema.parse({
      ...detail, nodes: [nodeDetail({ ...acceptedNode, attempts: [{
        ...acceptedAttempt, processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
      }] })],
    })).toThrow(/target process groups to be reconciled/);
    const olderSourceBlock = {
      ...sourceBlock, blockId: "block-older-acceptance-source", blockedAt: "2026-10-05T12:00:01.500Z",
    };
    const newerSourceBlock = {
      ...sourceBlock, blockId: "block-newer-acceptance-source",
      kind: "process_death_unconfirmed", blockedAt: "2026-10-05T12:00:01.750Z",
    };
    expect(() => runDetailDtoSchema.parse({
      ...detail, nodes: [nodeDetail({ ...acceptedNode, attempts: [{
        ...acceptedAttempt, blocks: [olderSourceBlock, newerSourceBlock],
        operatorAcceptances: [{ ...acceptance, sourceBlock: olderSourceBlock }],
      }] })],
    })).toThrow(/acceptance identifies the latest block at its resolution time/);

    const validatorProcess = processIncarnation({
      executionId: "execution-validator-a", incarnationId: "incarnation-validator-a-1", role: "validator",
      launchIntentAt: "2026-10-05T12:00:02.001Z", startedAt: "2026-10-05T12:00:02.001Z",
      finishedAt: "2026-10-05T12:00:03.000Z",
    });
    const acceptedWithValidator = {
      ...acceptedAttempt, finishedAt: "2026-10-05T12:00:03.000Z", elapsedMs: 2_000,
      validatorExecutionId: "execution-validator-a", processes: [acceptedAttempt.processes[0], validatorProcess],
    };
    const validatorSettings = {
      ...commandSettings(),
      validator: {
        kind: "command", command: "test -s result.txt", shell: "/bin/bash", cwd: "/tmp/project",
        timeoutMs: null, streamCapBytes: "unlimited", replay: "never",
      },
    };
    const acceptedWithConfiguredValidator = {
      ...detail,
      summary: { ...acceptedRun, finishedAt: "2026-10-05T12:00:03.000Z" },
      nodes: [nodeDetail({
        ...acceptedNode, resolvedSettings: validatorSettings,
        attempts: [acceptedWithValidator],
      })],
    };
    expect(runDetailDtoSchema.parse(acceptedWithConfiguredValidator).nodes[0]?.attempts[0]?.processes).toHaveLength(2);
    const validatorFailure = failureInfo({
      kind: "validator_rejection", message: "The command validator rejected the accepted worker result.",
      failedAt: "2026-10-05T12:00:03.000Z",
    });
    const failedAfterWorkerAcceptance = {
      ...acceptedWithValidator, status: "failed", failure: validatorFailure,
      processes: [acceptedAttempt.processes[0], { ...validatorProcess, exit: { kind: "code", code: 1 } }],
    };
    expect(runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: "2026-10-05T12:00:03.000Z",
        currentNodeId: "node-a", currentAttemptNumber: 1, failure: validatorFailure,
      }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({
        status: "failed", resolvedSettings: validatorSettings, attempts: [failedAfterWorkerAcceptance],
      })],
    }).summary.failure?.kind).toBe("validator_rejection");
    expect(() => runDetailDtoSchema.parse({
      ...acceptedWithConfiguredValidator,
      nodes: [nodeDetail({
        ...acceptedNode, resolvedSettings: validatorSettings, attempts: [acceptedAttempt],
      })],
    })).toThrow(/configured validation requires validator execution evidence/);
    const commandValidatorBlock = blockInfo({
      blockId: "block-command-validator-acceptance", kind: "external_outcome_unknown",
      blockedAt: FINISHED_AT,
    });
    const commandValidatorAcceptance = {
      ...acceptance, resolutionId: "resolution-command-validator-acceptance", target: "validator",
      sourceBlock: commandValidatorBlock,
    };
    const acceptedValidatorProcess = {
      ...validatorProcess,
      status: "blocked",
      exit: null,
      launchIntentAt: "2026-10-05T12:00:01.500Z",
      startedAt: "2026-10-05T12:00:01.500Z",
      finishedAt: null,
      cleanupState: "confirmed_dead",
    };
    const committedWorkerProcess = {
      ...acceptedAttempt.processes[0],
      status: "exited",
      exit: { kind: "code", code: 0 },
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
      ...acceptedNode,
      resolvedSettings: validatorSettings,
      attempts: [acceptedCommandValidatorAttempt],
    })).attempts[0]?.operatorAcceptances[0]?.target).toBe("validator");
  });

  test("requires safe resolution before attempt successors and preserves failure linkage", () => {
    const sourceBlock = blockInfo({ blockId: "block-retry" });
    const interrupted = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [sourceBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "unconfirmed" })],
    });
    const preparedProcess = processIncarnation({
      executionId: "execution-worker-b", incarnationId: "incarnation-worker-b-1", status: "prepared",
      launchIntentAt: null, startedAt: null, finishedAt: null, deadlineAt: null, identity: null,
      exit: null, cleanupState: "not_started", captures: [],
    });
    const preparedAttempt = succeededAttempt({
      attemptId: "attempt-b", number: 2, status: "prepared", phase: "prepare",
      startedAt: null, finishedAt: null, elapsedMs: null, workerExecutionId: "execution-worker-b",
      candidate: null, blocks: [], processes: [preparedProcess],
    });
    const retryNode = nodeDetail({ status: "running", attempts: [interrupted, preparedAttempt] });
    const running = runSummary({ currentAttemptNumber: 2 });
    const withoutResolution = { version: 2, summary: running, preflight: null, resolutions: [], nodes: [retryNode] };
    expect(() => runDetailDtoSchema.parse(withoutResolution)).toThrow(/successor waits|interrupted attempt resumes/);

    const reconciledAttempt = {
      ...interrupted,
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "confirmed_dead" })],
    };
    const retryResolution = {
      action: "retry", resolutionId: "resolution-retry", provenance: "operator",
      reason: "Retry after confirming the process group is dead.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock, allowRepeat: true, extraAttempt: false,
    };
    const retriedNode = nodeDetail({ status: "running", attempts: [reconciledAttempt, preparedAttempt] });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: running, preflight: null, resolutions: [retryResolution], nodes: [retriedNode],
    }).resolutions).toHaveLength(1);
    const cancelledPreparedAttempt = {
      ...preparedAttempt, status: "cancelled", phase: null, finishedAt: "2026-10-05T12:00:02.001Z",
    };
    const stoppedAfterRetry = runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "cancelled", desiredState: "stopped", finishedAt: "2026-10-05T12:00:02.001Z",
        currentNodeId: "node-a", currentAttemptNumber: 2,
      }),
      preflight: null, resolutions: [retryResolution],
      nodes: [nodeDetail({
        status: "cancelled", attempts: [reconciledAttempt, cancelledPreparedAttempt],
      })],
    });
    expect(stoppedAfterRetry.nodes[0]?.attempts[1]?.startedAt).toBeNull();
    const successfulRetryBlock = blockInfo({
      blockId: "block-retry-after-success", kind: "retry_exhausted",
    });
    const successfulAttemptWithBlock = succeededAttempt({ blocks: [successfulRetryBlock] });
    const invalidRetryOfSuccess = {
      ...retryResolution, resolutionId: "resolution-retry-after-success",
      resolvedAt: "2026-10-05T12:00:02.001Z", sourceBlock: successfulRetryBlock,
    };
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "completed", finishedAt: "2026-10-05T12:00:02.001Z", terminalOutput: "completed output",
      }),
      preflight: null, resolutions: [invalidRetryOfSuccess],
      nodes: [nodeDetail({
        status: "succeeded", successfulOutput: "completed output", attempts: [successfulAttemptWithBlock],
      })],
    })).toThrow(/attempt-scoped retry requires a failed or interrupted source attempt/);
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: runSummary({ status: "blocked", block: sourceBlock }), preflight: null,
      resolutions: [retryResolution], nodes: [nodeDetail({ status: "blocked", block: sourceBlock, attempts: [reconciledAttempt] })],
    })).toThrow(/resolved blocks are no longer current/);

    const safeFailure = failureInfo({ kind: "process_error", message: "safe worker exited unsuccessfully" });
    const safeFailedAttempt = succeededAttempt({
      status: "failed", candidate: null, failure: safeFailure,
      judgments: [evidence("judgment", "judgment-retry", null, "retry")],
      processes: [processIncarnation({ replay: "safe", exit: { kind: "code", code: 1 } })],
    });
    const safeSettings = {
      ...commandSettings(), run: { ...commandSettings().run, replay: "safe" },
    };
    const safePreparedAttempt = {
      ...preparedAttempt, processes: [{ ...preparedProcess, replay: "safe" }],
    };
    const safeRetryNode = nodeDetail({
      status: "running", resolvedSettings: safeSettings, attempts: [safeFailedAttempt, safePreparedAttempt],
    });
    const parsedSafeRetry = runDetailDtoSchema.parse({
      version: 2, summary: running, preflight: null, resolutions: [], nodes: [safeRetryNode],
    });
    const retryEvidence = parsedSafeRetry.nodes[0]?.attempts[0]?.judgments[0];
    expect(retryEvidence?.kind).toBe("judgment");
    if (retryEvidence?.kind === "judgment") expect(retryEvidence.decision.action).toBe("retry");
    const unsafeRetryNode = nodeDetail({
      status: "running", resolvedSettings: commandSettings(),
      attempts: [
        { ...safeFailedAttempt, judgments: [evidence("judgment", "judgment-unsafe-retry", null, "retry")],
          processes: [processIncarnation({ replay: "never", exit: { kind: "code", code: 1 } })] },
        preparedAttempt,
      ],
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: running, preflight: null, resolutions: [], nodes: [unsafeRetryNode],
    })).toThrow(/safe replay for every previously launched role/);
    const exhaustedRetryNode = nodeDetail({
      status: "running", resolvedSettings: { ...safeSettings, maxAttempts: 1 },
      attempts: [safeFailedAttempt, safePreparedAttempt],
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: running, preflight: null, resolutions: [], nodes: [exhaustedRetryNode],
    })).toThrow(/maxAttempts|remaining semantic attempts/);

    const processFailure = failureInfo({ kind: "process_error", message: "worker exited unsuccessfully" });
    const failedAttempt = succeededAttempt({
      status: "failed", candidate: null, failure: processFailure, workerExecutionId: null, processes: [],
    });
    const failedNode = nodeDetail({ status: "failed", attempts: [failedAttempt] });
    const failedSummary = runSummary({
      status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
      currentNodeId: "node-a", currentAttemptNumber: 1, failure: processFailure,
    });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: failedSummary, preflight: null, resolutions: [], nodes: [failedNode],
    }).summary.failure?.kind).toBe("process_error");
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: { ...failedSummary, failure: { ...processFailure, message: "different failure" } },
      preflight: null, resolutions: [], nodes: [failedNode],
    })).toThrow(/latest attempt/);
    const pendingFailure = runSummary({
      status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT, currentAttemptNumber: null,
      failure: failureInfo({ kind: "runtime_fault", nodeId: "node-a", attemptId: null }),
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: pendingFailure, preflight: null, resolutions: [], nodes: [nodeDetail()],
    })).toThrow(/failed node|latest attempt|exactly one failed node/);
  });

  test("rejects active terminal attempts and validator launch before candidate commit", () => {
    const preparedProcess = processIncarnation({
      status: "prepared", launchIntentAt: null, startedAt: null, finishedAt: null, deadlineAt: null,
      identity: null, exit: null, cleanupState: "not_started", captures: [],
    });
    const activeAttempt = succeededAttempt({
      status: "executing", phase: "awaitWorker", finishedAt: null, elapsedMs: null,
      candidate: null, processes: [preparedProcess],
    });
    const cancelled = runSummary({
      status: "cancelled", desiredState: "stopped", finishedAt: FINISHED_AT, currentAttemptNumber: null,
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: cancelled, preflight: null, resolutions: [],
      nodes: [nodeDetail({ status: "cancelled", attempts: [activeAttempt] })],
    })).toThrow(/terminal semantic attempts|cancelled nodes end/);

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
    expect(() => attemptDetailDtoSchema.parse(validatingAttempt)).toThrow(/validator launch follows worker completion/);
    expect(() => attemptDetailDtoSchema.parse({
      ...validatingAttempt, candidate: null,
    })).toThrow(/validator execution requires a committed candidate/);
  });

  test("allows operator fail after a failed attempt or a pre-attempt block", () => {
    const attemptFailure = failureInfo({ kind: "process_error", message: "the semantic attempt failed" });
    const failedAttempt = succeededAttempt({
      status: "failed", candidate: null, failure: attemptFailure, blocks: [],
      processes: [processIncarnation({ exit: { kind: "code", code: 1 } })],
    });
    const failedNode = nodeDetail({ status: "failed", attempts: [failedAttempt] });
    const cancelledAttempt = { ...failedAttempt, blocks: [] };
    const cancelledNode = nodeDetail({ status: "failed", attempts: [cancelledAttempt] });
    const cancelledSummary = runSummary({
      status: "cancelled", desiredState: "stopped", finishedAt: FINISHED_AT,
      currentNodeId: "node-a", currentAttemptNumber: 1,
    });
    const cancelledDetail = {
      version: 2, summary: cancelledSummary, preflight: null, resolutions: [], nodes: [cancelledNode],
    };
    expect(runDetailDtoSchema.parse(cancelledDetail).nodes[0]?.status).toBe("failed");
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "cancelled", runFailure: null, node: cancelledNode,
    }).node.status).toBe("failed");
    const unresolvedPostFinishBlock = blockInfo({
      blockId: "block-stop-while-blocked", kind: "retry_exhausted", blockedAt: FINISHED_AT,
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2, summary: cancelledSummary, preflight: null, resolutions: [],
      nodes: [nodeDetail({ status: "failed", attempts: [{ ...failedAttempt, blocks: [unresolvedPostFinishBlock] }] })],
    })).toThrow(/every block remains current or has an audited resolution/);
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
        currentNodeId: null, currentAttemptNumber: null,
        failure: failureInfo({ kind: "runtime_fault", nodeId: null, attemptId: null }),
      }),
      preflight: null, resolutions: [], nodes: [nodeDetail({ status: "cancelled" })],
    })).toThrow(/failed runs have no running, blocked, or cancelled nodes/);
    const blockWithoutAttempt = blockInfo({
      blockId: "block-missing-attempt", kind: "retry_exhausted", nodeId: "node-a", attemptId: null,
    });
    const blockedAfterAttempt = nodeDetailDtoSchema.parse({
      ...failedNode, status: "blocked", block: blockWithoutAttempt,
    });
    expect(blockedAfterAttempt.status).toBe("blocked");
    const blockedAfterAttemptSummary = runSummary({
      status: "blocked", block: blockWithoutAttempt, currentNodeId: "node-a", currentAttemptNumber: 1,
      failure: attemptFailure,
    });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: blockedAfterAttemptSummary, preflight: null, resolutions: [],
      nodes: [blockedAfterAttempt],
    }).nodes[0]?.block?.attemptId).toBeNull();
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
    const failedAtNodeBlock = {
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
        currentNodeId: "node-a", currentAttemptNumber: 1, failure: nodeRunFailure,
      }),
      preflight: null, resolutions: [nodeRunResolution], nodes: [failedNode],
    };
    expect(runDetailDtoSchema.parse(failedAtNodeBlock).summary.failure?.kind).toBe("operator");
    expect(nodeDescriptionDtoSchema.parse({
      version: 2, workflowId: "clock", definitionHash: HASH_A, runId: "run-a",
      runStatus: "failed", runFailure: nodeRunFailure, node: failedNode,
    }).runFailure?.kind).toBe("operator");
    const interruptedNodeBlock = blockInfo({
      blockId: "block-node-interrupted-no-attempt", kind: "process_death_unconfirmed",
      nodeId: "node-a", attemptId: null,
    });
    const interruptedWithoutAttemptLink = succeededAttempt({
      status: "interrupted", candidate: null, blocks: [interruptedNodeBlock],
      processes: [processIncarnation({ status: "blocked", exit: null, cleanupState: "confirmed_dead" })],
    });
    const failedAfterInterruptedBlock = {
      action: "fail", resolutionId: "resolution-node-interrupted-fail", provenance: "operator",
      reason: "End the run after confirming the interrupted process group is dead.",
      resolvedAt: FINISHED_AT, processGroupsConfirmedDead: true, sourceBlock: interruptedNodeBlock,
    };
    const operatorFailureAfterInterruptedBlock = {
      kind: "operator", resolutionId: failedAfterInterruptedBlock.resolutionId, provenance: "operator",
      reason: failedAfterInterruptedBlock.reason, failedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: interruptedNodeBlock,
    };
    const failedInterruptedRun = runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
        currentNodeId: "node-a", currentAttemptNumber: 1, failure: operatorFailureAfterInterruptedBlock,
      }),
      preflight: null, resolutions: [failedAfterInterruptedBlock],
      nodes: [nodeDetail({ status: "failed", attempts: [interruptedWithoutAttemptLink] })],
    });
    expect(failedInterruptedRun.summary.failure?.kind).toBe("operator");

    const runBlock = blockInfo({
      blockId: "block-run-level", kind: "orchestrator_unavailable", nodeId: null, attemptId: null,
    });
    const blockedSummary = runSummary({
      status: "blocked", block: runBlock, currentNodeId: "node-a", currentAttemptNumber: 1,
      failure: attemptFailure,
    });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: blockedSummary, preflight: null, resolutions: [], nodes: [failedNode],
    }).summary.block?.kind).toBe("orchestrator_unavailable");

    const runResolution = {
      action: "fail", resolutionId: "resolution-run-fail", provenance: "operator",
      reason: "End the blocked run after reviewing its state.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: runBlock,
    };
    const runFailure = {
      kind: "operator", resolutionId: runResolution.resolutionId, provenance: "operator",
      reason: runResolution.reason, failedAt: FINISHED_AT, processGroupsConfirmedDead: true,
      sourceBlock: runBlock,
    };
    const operatorTerminatedSummary = runSummary({
      status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT, currentAttemptNumber: 1,
      failure: runFailure,
    });
    const operatorTerminatedRun = {
      version: 2, summary: operatorTerminatedSummary, preflight: null,
      resolutions: [runResolution], nodes: [failedNode],
    };
    expect(runDetailDtoSchema.parse(operatorTerminatedRun).summary.failure?.kind).toBe("operator");
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
    const unstartedSummary = runSummary({
      status: "blocked", block: unstartedBlock, currentNodeId: "node-a", currentAttemptNumber: null,
    });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: unstartedSummary, preflight: null, resolutions: [], nodes: [unstartedNode],
    }).summary.block?.kind).toBe("orchestrator_unavailable");
    const unstartedResolution = {
      action: "fail", resolutionId: "resolution-unstarted-fail", provenance: "operator",
      reason: "End the run before starting its first attempt.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: unstartedBlock,
    };
    const unstartedFailure = {
      kind: "operator", resolutionId: unstartedResolution.resolutionId, provenance: "operator",
      reason: unstartedResolution.reason, failedAt: FINISHED_AT, processGroupsConfirmedDead: true,
      sourceBlock: unstartedBlock,
    };
    expect(runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
        currentNodeId: null, currentAttemptNumber: null, failure: unstartedFailure,
      }),
      preflight: null, resolutions: [unstartedResolution], nodes: [nodeDetail()],
    }).summary.failure?.kind).toBe("operator");

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


    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "blocked", block: runBlock, currentNodeId: "node-a", currentAttemptNumber: null,
      }),
      preflight: null, resolutions: [], nodes: [unstartedNode],
    })).toThrow(/summary and blocked node identify the same current block/);


    const unconfirmedPreflightProcess = processIncarnation({
      executionId: "execution-preflight-pending", incarnationId: "incarnation-preflight-pending",
      role: "preflight", replay: "safe", status: "blocked",
      startedAt: null, finishedAt: null, identity: null, exit: null, cleanupState: "unconfirmed", captures: [],
    });
    const pendingPreflight = {
      cacheKeyHash: HASH_A, outcome: "pending", reusedFrom: null,
      checks: [{
        checkId: "preflight-pending", outcome: "pending", startedAt: null, finishedAt: null,
        failure: null, block: null, processes: [unconfirmedPreflightProcess],
      }],
    };
    const blockedRunForCleanup = runSummary({
      status: "blocked", block: runBlock, currentNodeId: null, currentAttemptNumber: null,
    });
    expect(runDetailDtoSchema.parse({
      version: 2, summary: blockedRunForCleanup, preflight: pendingPreflight, resolutions: [], nodes: [nodeDetail()],
    }).summary.status).toBe("blocked");
    const cleanupResolution = {
      action: "fail", resolutionId: "resolution-cleanup-blocked", provenance: "operator",
      reason: "Cannot end the run until its process group is reconciled.", resolvedAt: FINISHED_AT,
      processGroupsConfirmedDead: true, sourceBlock: runBlock,
    };
    const cleanupFailure = {
      kind: "operator", resolutionId: cleanupResolution.resolutionId, provenance: "operator",
      reason: cleanupResolution.reason, failedAt: FINISHED_AT, processGroupsConfirmedDead: true,
      sourceBlock: runBlock,
    };
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: FINISHED_AT,
        currentNodeId: null, currentAttemptNumber: null, failure: cleanupFailure,
      }),
      preflight: pendingPreflight, resolutions: [cleanupResolution], nodes: [nodeDetail()],
    })).toThrow(/every source process group to be reconciled/);
  });

  test("allows attemptless retries to launch new work after resolution", () => {
    const resolutionAt = "2026-10-05T12:00:03.000Z";
    const firstWorkAt = "2026-10-05T12:00:04.000Z";
    const sourceBlock = blockInfo({
      blockId: "block-node-before-attempt", kind: "orchestrator_unavailable",
      blockedAt: FINISHED_AT, nodeId: "node-a", attemptId: null,
    });
    const nodeRetry = {
      action: "retry", resolutionId: "resolution-node-retry", provenance: "operator",
      reason: "Retry the unstarted node after the service recovers.", resolvedAt: resolutionAt,
      processGroupsConfirmedDead: true, sourceBlock, allowRepeat: false, extraAttempt: false,
    };
    const activeWorker = processIncarnation({
      executionId: "execution-node-retry", incarnationId: "incarnation-node-retry-1",
      status: "running", launchIntentAt: firstWorkAt, startedAt: firstWorkAt, finishedAt: null,
      identity: { pid: 401, pgid: 401, startIdentity: "pid-start-node-retry", serviceBootId: "boot-a" },
      exit: null, cleanupState: "pending", captures: [],
    });
    const activeAttempt = succeededAttempt({
      status: "executing", phase: "awaitWorker", startedAt: firstWorkAt, finishedAt: null, elapsedMs: null,
      workerExecutionId: "execution-node-retry", candidate: null, processes: [activeWorker],
    });
    expect(runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 1 }),
      preflight: null, resolutions: [nodeRetry],
      nodes: [nodeDetail({ status: "running", attempts: [activeAttempt] })],
    }).nodes[0]?.attempts[0]?.status).toBe("executing");
    const prematureStartedAt = "2026-10-05T12:00:02.500Z";
    const prematureFinishedAt = "2026-10-05T12:00:02.800Z";
    const prematureWorker = {
      ...activeWorker, launchIntentAt: prematureStartedAt, startedAt: prematureStartedAt,
      finishedAt: prematureFinishedAt, status: "exited", exit: { kind: "code", code: 0 },
      cleanupState: "confirmed_dead",
    };
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 1 }),
      preflight: null, resolutions: [nodeRetry],
      nodes: [nodeDetail({
        status: "running", attempts: [{ ...activeAttempt, startedAt: prematureStartedAt, processes: [prematureWorker] }],
      })],
    })).toThrow(/first semantic attempt starts at or after/);

    const runLevelBlock = blockInfo({
      blockId: "block-run-level-retry-window", kind: "orchestrator_unavailable",
      blockedAt: FINISHED_AT, nodeId: null, attemptId: null,
    });
    const runLevelResolution = {
      ...nodeRetry, resolutionId: "resolution-run-level-retry-window",
      sourceBlock: runLevelBlock,
    };
    const runLevelLaunchAt = "2026-10-05T12:00:02.500Z";
    const runLevelExitAt = "2026-10-05T12:00:02.800Z";
    const runLevelProcess = processIncarnation({
      executionId: "execution-run-level-retry-window", incarnationId: "incarnation-run-level-retry-window-1",
      replay: "safe", launchIntentAt: runLevelLaunchAt, startedAt: runLevelLaunchAt, finishedAt: runLevelExitAt,
      identity: { pid: 405, pgid: 405, startIdentity: "pid-start-run-level-retry-window", serviceBootId: "boot-a" },
      exit: { kind: "code", code: 0 }, cleanupState: "confirmed_dead", captures: [],
    });
    const attemptInBlockedWindow = succeededAttempt({
      status: "executing", phase: "awaitWorker", startedAt: runLevelLaunchAt, finishedAt: null, elapsedMs: null,
      workerExecutionId: "execution-run-level-retry-window", candidate: null, processes: [runLevelProcess],
    });
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 1 }),
      preflight: null, resolutions: [runLevelResolution],
      nodes: [nodeDetail({
        status: "running", resolvedSettings: {
          ...commandSettings(), run: { ...commandSettings().run, replay: "safe" },
        }, attempts: [attemptInBlockedWindow],
      })],
    })).toThrow(/semantic attempts cannot start while a source block is unresolved/);
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "blocked", block: runLevelBlock, currentNodeId: "node-a", currentAttemptNumber: 1,
      }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({
        status: "running", resolvedSettings: {
          ...commandSettings(), run: { ...commandSettings().run, replay: "safe" },
        }, attempts: [attemptInBlockedWindow],
      })],
    })).toThrow(/a current block has no later attempt, process, or preflight starts/);

    const preflightBlock = blockInfo({
      blockId: "block-preflight-retry", kind: "preflight_failed",
      blockedAt: FINISHED_AT, nodeId: null, attemptId: null,
    });
    const preflightFailure = failureInfo({
      kind: "runtime_fault", message: "environment check failed", failedAt: FINISHED_AT,
      nodeId: null, attemptId: null,
    });
    const failedCheckProcess = processIncarnation({
      executionId: "execution-preflight-failed", incarnationId: "incarnation-preflight-failed-1",
      role: "preflight", replay: "safe", captures: [],
      exit: { kind: "code", code: 1 },
    });
    const passedCheckStartedAt = "2026-10-05T12:00:04.000Z";
    const passedCheckFinishedAt = "2026-10-05T12:00:05.000Z";
    const passedCheckProcess = processIncarnation({
      executionId: "execution-preflight-passed", incarnationId: "incarnation-preflight-passed-1",
      role: "preflight", replay: "safe", captures: [],
      launchIntentAt: passedCheckStartedAt, startedAt: passedCheckStartedAt, finishedAt: passedCheckFinishedAt,
      identity: { pid: 402, pgid: 402, startIdentity: "pid-start-preflight-pass", serviceBootId: "boot-a" },
      exit: { kind: "code", code: 0 },
    });
    const preflight = {
      cacheKeyHash: HASH_A, outcome: "passed", reusedFrom: null,
      checks: [
        {
          checkId: "preflight-first", outcome: "failed", startedAt: STARTED_AT, finishedAt: FINISHED_AT,
          failure: preflightFailure, block: preflightBlock, processes: [failedCheckProcess],
        },
        {
          checkId: "preflight-retry", outcome: "passed",
          startedAt: passedCheckStartedAt, finishedAt: passedCheckFinishedAt,
          failure: null, block: null, processes: [passedCheckProcess],
        },
      ],
    };
    const preflightRetry = {
      action: "retry", resolutionId: "resolution-preflight-retry", provenance: "operator",
      reason: "Retry the environment check after fixing the host.", resolvedAt: resolutionAt,
      processGroupsConfirmedDead: true, sourceBlock: preflightBlock, allowRepeat: false, extraAttempt: false,
    };
    const nodeStartedAt = "2026-10-05T12:00:06.000Z";
    const nodeFinishedAt = "2026-10-05T12:00:07.000Z";
    const terminalOutput = "candidate after successful preflight";
    const workerAfterPreflight = processIncarnation({
      executionId: "execution-after-preflight", incarnationId: "incarnation-after-preflight-1",
      launchIntentAt: nodeStartedAt, startedAt: nodeStartedAt, finishedAt: nodeFinishedAt,
      identity: { pid: 403, pgid: 403, startIdentity: "pid-start-after-preflight", serviceBootId: "boot-a" },
      captures: [], exit: { kind: "code", code: 0 },
    });
    const completedAttempt = succeededAttempt({
      startedAt: nodeStartedAt, finishedAt: nodeFinishedAt, elapsedMs: 1_000,
      workerExecutionId: "execution-after-preflight",
      candidate: {
        ...evidence("candidate", "candidate-after-preflight"), recordedAt: nodeFinishedAt,
      },
      processes: [workerAfterPreflight],
    });
    const completed = runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "completed", finishedAt: "2026-10-05T12:00:08.000Z",
        currentNodeId: "node-a", currentAttemptNumber: 1, terminalOutput,
      }),
      preflight, resolutions: [preflightRetry],
      nodes: [nodeDetail({ status: "succeeded", successfulOutput: terminalOutput, attempts: [completedAttempt] })],
    });
    expect(completed.preflight?.outcome).toBe("passed");
    expect(completed.resolutions[0]?.action).toBe("retry");
    expect(() => runDetailDtoSchema.parse({
      ...completed, summary: { ...completed.summary, terminalOutput: "mismatched terminal output" },
    })).toThrow(/terminal output matches the final node's successful output/);
    const prematureCheckStartedAt = "2026-10-05T12:00:02.500Z";
    const prematureCheckFinishedAt = "2026-10-05T12:00:02.800Z";
    const prematureCheckProcess = {
      ...passedCheckProcess, launchIntentAt: prematureCheckStartedAt, startedAt: prematureCheckStartedAt,
      finishedAt: prematureCheckFinishedAt,
    };
    const prematurePreflight = {
      ...preflight, checks: [preflight.checks[0], {
        ...preflight.checks[1], startedAt: prematureCheckStartedAt, finishedAt: prematureCheckFinishedAt,
        processes: [prematureCheckProcess],
      }],
    };
    expect(() => runDetailDtoSchema.parse({ ...completed, preflight: prematurePreflight }))
      .toThrow(/retried preflight checks start at or after resolution/);
    const earlyNodeStart = "2026-10-05T12:00:04.999Z";
    const workerBeforePreflight = {
      ...workerAfterPreflight, launchIntentAt: earlyNodeStart, startedAt: earlyNodeStart,
    };
    const attemptBeforePreflight = {
      ...completedAttempt, startedAt: earlyNodeStart, elapsedMs: 2_001, processes: [workerBeforePreflight],
    };
    expect(() => runDetailDtoSchema.parse({
      ...completed,
      nodes: [nodeDetail({
        status: "succeeded", successfulOutput: terminalOutput, attempts: [attemptBeforePreflight],
      })],
    })).toThrow(/node attempts start after the final passed preflight check/);
  });

  test("allows workflow decisions after a failed attempt finishes", () => {
    const blockAt = "2026-10-05T12:00:03.000Z";
    const resolvedAt = "2026-10-05T12:00:04.000Z";
    const failure = failureInfo({ kind: "process_error", message: "worker exited unsuccessfully" });
    const retryBlock = blockInfo({
      blockId: "block-retry-exhausted-late", kind: "retry_exhausted", blockedAt: blockAt,
    });
    const failedAttempt = succeededAttempt({
      status: "failed", candidate: null, failure, blocks: [retryBlock],
      processes: [processIncarnation({ exit: { kind: "code", code: 1 } })],
    });
    const boundedSettings = { ...commandSettings(), maxAttempts: 1 };
    const blockedNode = nodeDetail({
      status: "blocked", block: retryBlock, resolvedSettings: boundedSettings, attempts: [failedAttempt],
    });
    expect(runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "blocked", block: retryBlock, currentNodeId: "node-a", currentAttemptNumber: 1, failure,
      }),
      preflight: null, resolutions: [], nodes: [blockedNode],
    }).nodes[0]?.block?.kind).toBe("retry_exhausted");

    const retryResolution = {
      action: "retry", resolutionId: "resolution-extra-attempt", provenance: "operator",
      reason: "Authorize the final semantic attempt after inspecting the failure.", resolvedAt,
      processGroupsConfirmedDead: true, sourceBlock: retryBlock, allowRepeat: true, extraAttempt: true,
    };
    const preparedProcess = processIncarnation({
      executionId: "execution-worker-b", incarnationId: "incarnation-worker-b-1", status: "prepared",
      launchIntentAt: null, startedAt: null, finishedAt: null, deadlineAt: null, identity: null,
      exit: null, cleanupState: "not_started", captures: [],
    });
    const preparedAttempt = succeededAttempt({
      attemptId: "attempt-b", number: 2, status: "prepared", phase: "prepare",
      startedAt: null, finishedAt: null, elapsedMs: null, workerExecutionId: "execution-worker-b",
      candidate: null, blocks: [], processes: [preparedProcess],
    });
    const retried = runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 2 }),
      preflight: null, resolutions: [retryResolution],
      nodes: [nodeDetail({ status: "running", resolvedSettings: boundedSettings, attempts: [failedAttempt, preparedAttempt] })],
    });
    expect(retried.nodes[0]?.attempts).toHaveLength(2);
    expect(retried.resolutions[0]).toMatchObject({ extraAttempt: true, allowRepeat: true });

    const retryableSettings = {
      ...commandSettings(), maxAttempts: 2,
      run: { ...commandSettings().run, replay: "safe" },
    };
    const judgedAttempt = {
      ...failedAttempt, blocks: [],
      processes: [processIncarnation({ replay: "safe", exit: { kind: "code", code: 1 } })],
      judgments: [{ ...evidence("judgment", "judgment-after-block", null, "retry"), recordedAt: blockAt }],
    };
    const safePreparedAttempt = {
      ...preparedAttempt, processes: [{ ...preparedProcess, replay: "safe" }],
    };
    expect(runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 2 }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({
        status: "running", resolvedSettings: retryableSettings, attempts: [judgedAttempt, safePreparedAttempt],
      })],
    }).nodes[0]?.status).toBe("running");
    const judgedAttemptWithBlock = { ...judgedAttempt, blocks: [retryBlock] };
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 2 }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({
        status: "running", resolvedSettings: retryableSettings, attempts: [judgedAttemptWithBlock, safePreparedAttempt],
      })],
    })).toThrow(/every block remains current or has an audited resolution/);

    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: resolvedAt,
        currentNodeId: "node-a", currentAttemptNumber: 1, failure,
      }),
      preflight: null, resolutions: [],
      nodes: [nodeDetail({ status: "failed", resolvedSettings: boundedSettings, attempts: [failedAttempt] })],
    })).toThrow(/every block remains current or has an audited resolution/);

    const earlierBlock = blockInfo({
      blockId: "block-earlier-than-current", kind: "retry_exhausted",
      blockedAt: "2026-10-05T12:00:02.500Z",
    });
    const twoBlockAttempt = { ...failedAttempt, blocks: [earlierBlock, retryBlock] };
    const staleSourceRetry = { ...retryResolution, sourceBlock: earlierBlock };
    expect(() => runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({ status: "running", currentNodeId: "node-a", currentAttemptNumber: 2 }),
      preflight: null, resolutions: [staleSourceRetry],
      nodes: [nodeDetail({ status: "running", resolvedSettings: boundedSettings, attempts: [twoBlockAttempt, preparedAttempt] })],
    })).toThrow(/attempt-scoped resolution identifies the latest block/);

    const failResolution = {
      action: "fail", resolutionId: "resolution-fail-late-block", provenance: "operator",
      reason: "End the run after reviewing the failed attempt.", resolvedAt,
      processGroupsConfirmedDead: true, sourceBlock: retryBlock,
    };
    const runFailure = {
      kind: "operator", resolutionId: failResolution.resolutionId, provenance: "operator",
      reason: failResolution.reason, failedAt: resolvedAt, processGroupsConfirmedDead: true,
      sourceBlock: retryBlock,
    };
    expect(runDetailDtoSchema.parse({
      version: 2,
      summary: runSummary({
        status: "failed", desiredState: "stopped", finishedAt: resolvedAt,
        currentNodeId: "node-a", currentAttemptNumber: 1, failure: runFailure,
      }),
      preflight: null, resolutions: [failResolution],
      nodes: [nodeDetail({ status: "failed", resolvedSettings: boundedSettings, attempts: [failedAttempt] })],
    }).summary.failure?.kind).toBe("operator");
  });
});
