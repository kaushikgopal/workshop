import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ZodError } from "zod";
import { createWorkflowProcessState, executeWorkflowProcess, transitionWorkflowProcess } from "../run/execute-workflow-process.ts";
import { executeWorkflowAttempt, parseMarkdownVerdict, transitionWorkflowAttempt, type ProcessExecutionRequest, type ProcessExecutionResult, type WorkflowAttemptEnvironment, type WorkflowAttemptResult } from "../workflow/execute-workflow-attempt.ts";
import { parseWorkflowDecision } from "../workflow/parse-workflow-decision.ts";
import type { Workflow, WorkflowStep } from "../workflow/types.ts";

const fixture = resolve("test/fixtures/execute-profile-command.mjs");

function makeWorkflow(steps: WorkflowStep[], extra: Partial<Workflow> = {}): Workflow {
  return {
    name: "clock",
    directory: "clock",
    cron: "* * * * *",
    description: "test workflow",
    steps,
    ...extra,
  };
}
function firstStep(workflow: Workflow): WorkflowStep {
  const step = workflow.steps[0];
  if (!step) throw new Error("Test workflow needs a first step");
  return step;
}


function makeInput(
  workflow: Workflow,
  executeProcess: WorkflowAttemptEnvironment["executeProcess"],
  extra: Partial<WorkflowAttemptEnvironment> = {},
): WorkflowAttemptEnvironment {
  const files = workflow.steps.flatMap((step) => [step.file, ...(step.check ? [step.check.file] : [])]);
  return {
    workflow,
    documents: {},
    files: Object.fromEntries(files.map((file) => [file, join("/workflows/clock", file)] as const)),
    profileCommands: { writer: ["fake-writer"], judge: ["fake-judge"], fast: ["fake-writer", "--fast"] },
    executeProcess,
    ...extra,
  };
}

function successful(stdout: string): ProcessExecutionResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function failed(stdout = "", stderr = "failure"): ProcessExecutionResult {
  return { exitCode: 7, stdout, stderr, timedOut: false };
}

async function withRoot(action: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workshop-attempt-test-"));
  try {
    await action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("command attempts preserve stdout and use the source-file command", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([{ kind: "command", file: "10-first.sh", number: 10, name: "first", timeout: "3s" }]);
  const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => {
    calls.push(request);
    return successful("command output\n");
  }), { step: firstStep(workflow), pipeInput: "prior\n", feedback: "retry hint", attempt: 2 });

  assert.deepEqual(result, { kind: "accepted", output: "command output\n" });
  assert.deepEqual(calls.map(({ kind, command, input, timeoutMs, attempt }) => [kind, command, input, timeoutMs, attempt]), [
    ["command", ["sh", "/workflows/clock/10-first.sh"], "prior\n", 3_000, 2],
  ]);
});

test("agent attempts receive the prompt, untrimmed input, feedback, and selected profile", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([{ kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer" }]);
  const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => {
    calls.push(request);
    return successful("agent output\n");
  }, { documents: { "10-write.md": "Write one line." } }), {
    step: firstStep(workflow), profile: "fast", pipeInput: "upstream\n", feedback: "Use the hint.", attempt: 1,
  });

  assert.deepEqual(result, { kind: "accepted", output: "agent output\n" });
  assert.deepEqual(calls.map(({ kind, command, input, feedback, profile }) => [kind, command, input, feedback, profile]), [[
    "agent", ["fake-writer", "--fast"], "Write one line.\n\n## Input\n\nupstream\n\n\n## Feedback\n\nUse the hint.", "Use the hint.", "fast",
  ]]);
});

test("only a clean command exit 99 means nothing-to-do", async () => {
  const workflow = makeWorkflow([{ kind: "command", file: "10-step.sh", number: 10, name: "step" }]);
  const nothing = await executeWorkflowAttempt(makeInput(workflow, async () => ({ exitCode: 99, stdout: "", stderr: "", timedOut: false })), {
    step: firstStep(workflow), pipeInput: "", feedback: "", attempt: 1,
  });
  assert.deepEqual(nothing, { kind: "nothing-to-do", output: "" });

  const errored = await executeWorkflowAttempt(makeInput(workflow, async () => ({
    exitCode: 99, stdout: "partial", stderr: "", timedOut: false, error: "pipe failed",
  })), { step: firstStep(workflow), pipeInput: "", feedback: "", attempt: 1 });
  assert.equal(errored.kind, "failed");
  if (errored.kind === "failed") assert.match(errored.reason, /pipe failed/);
});

type AgentNothingToDoCase = {
  name: string;
  stdout: string;
  expected: "accepted" | "failed" | "nothing-to-do";
  stepKind?: WorkflowStep["kind"];
  stderr?: string;
  process?: Partial<ProcessExecutionResult>;
  check?: boolean;
  checkOutput?: string;
  expectedCalls?: ProcessExecutionRequest["kind"][];
};

test("agent nothing-to-do matches only a clean worker's last nonblank stdout line", async () => {
  const token = "WORKSHOP_NOTHING_TO_DO";
  const cases: AgentNothingToDoCase[] = [
    { name: "bare token", stdout: token, expected: "nothing-to-do", check: true },
    { name: "text before token", stdout: `Report ready.\n${token}\n`, expected: "nothing-to-do" },
    { name: "CRLF", stdout: `Report ready.\r\n${token}\r\n`, expected: "nothing-to-do" },
    { name: "surrounding whitespace and trailing blank lines", stdout: ` \t${token} \t\r\n \t\n\r\n`, expected: "nothing-to-do" },
    { name: "prefix", stdout: `text ${token}`, expected: "accepted" },
    { name: "suffix", stdout: `${token}_LATER`, expected: "accepted" },
    { name: "wrong case", stdout: token.toLowerCase(), expected: "accepted" },
    { name: "ANSI escape codes", stdout: `\u001b[32m${token}\u001b[0m`, expected: "accepted" },
    { name: "JSON text", stdout: JSON.stringify({ result: token }), expected: "accepted" },
    { name: "backticks", stdout: `\`${token}\``, expected: "accepted" },
    { name: "quotes", stdout: `\"${token}\"`, expected: "accepted" },
    { name: "closed fence", stdout: `\`\`\`\n${token}\n\`\`\``, expected: "accepted" },
    { name: "text after token", stdout: `${token}\nMore text`, expected: "accepted" },
    { name: "stderr only", stdout: "ordinary output", stderr: token, expected: "accepted" },
    { name: "command output token", stdout: token, expected: "accepted", stepKind: "command", expectedCalls: ["command"] },
    { name: "nonzero exit", stdout: token, process: { exitCode: 7 }, expected: "failed" },
    { name: "agent exit 99", stdout: token, process: { exitCode: 99 }, expected: "failed" },
    { name: "timeout", stdout: token, process: { exitCode: null, timedOut: true, signal: "SIGTERM" }, expected: "failed" },
    { name: "launch or I/O error", stdout: token, process: { error: "stdin failed" }, expected: "failed" },
    { name: "cancelled process", stdout: token, process: { exitCode: null, signal: "SIGTERM" }, expected: "failed" },
    {
      name: "judge token is not a verdict", stdout: "draft", check: true, checkOutput: token,
      expected: "failed", expectedCalls: ["agent", "agent-check"],
    },
  ];
  for (const entry of cases) {
    const stepKind = entry.stepKind ?? "agent";
    const step: WorkflowStep = {
      kind: stepKind, file: stepKind === "command" ? "10-step.sh" : "10-step.md", number: 10, name: "step", profile: "writer",
      ...(entry.check ? { check: { kind: "agent", file: "10-step.check.md", profile: "judge" } } : {}),
    };
    const workflow = makeWorkflow([step]);
    const calls: ProcessExecutionRequest[] = [];
    const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => {
      calls.push(request);
      if (request.kind === "agent-check") return successful(entry.checkOutput ?? "ACCEPT");
      return { exitCode: 0, stdout: entry.stdout, stderr: entry.stderr ?? "", timedOut: false, ...entry.process };
    }, { documents: { "10-step.md": "Write the report.", "10-step.check.md": "Judge the report." } }), {
      step, profile: "writer", pipeInput: "", feedback: "", attempt: 1,
    });
    assert.equal(result.kind, entry.expected, entry.name);
    if (entry.expected === "nothing-to-do" || entry.expected === "accepted") {
      assert.equal(result.output, entry.stdout, `${entry.name} keeps the original output`);
    }
    if (entry.name === "judge token is not a verdict") {
      assert.deepEqual(result, {
        kind: "failed", output: "draft",
        reason: 'check must start with ACCEPT or REJECT; received "WORKSHOP_NOTHING_TO_DO"',
      });
    }
    assert.deepEqual(calls.map(({ kind }) => kind), entry.expectedCalls ?? ["agent"], entry.name);
  }
});

test("command checks accept exit zero and keep the worker output", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([{
    kind: "command", file: "10-checkable.sh", number: 10, name: "checkable",
    check: { kind: "command", file: "10-checkable.check.sh" },
  }]);
  const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => {
    calls.push(request);
    return request.kind === "command-check" ? successful("checker output does not replace the worker") : successful("candidate\n");
  }), { step: firstStep(workflow), pipeInput: "input", feedback: "", attempt: 1 });

  assert.deepEqual(result, { kind: "accepted", output: "candidate\n" });
  assert.deepEqual(calls.map(({ kind, input }) => [kind, input]), [["command", "input"], ["command-check", "candidate\n"]]);
});

test("a failed command check rejects the attempt with its output and reason", async () => {
  const workflow = makeWorkflow([{
    kind: "command", file: "10-checkable.sh", number: 10, name: "checkable",
    check: { kind: "command", file: "10-checkable.check.sh" },
  }]);
  const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => request.kind === "command-check"
    ? failed("wrong output", "expected a line")
    : successful("candidate")), { step: firstStep(workflow), pipeInput: "", feedback: "", attempt: 1 });

  assert.deepEqual(result, { kind: "failed", output: "candidate", reason: "wrong output\nexpected a line" });
});

test("command-check diagnostics report signals and retain stdout-first fallback text", async (t) => {
  const step: WorkflowStep = {
    kind: "command", file: "10-work.sh", number: 10, name: "work",
    check: { kind: "command", file: "10-work.check.sh" },
  };
  const request = { step, pipeInput: "", feedback: "", attempt: 1 };

  await t.test("real nonempty signal", async () => {
    await withRoot(async (root) => {
      const workerFile = join(root, "10-work.sh");
      const checkFile = join(root, "10-work.check.sh");
      writeFileSync(workerFile, ["printf '  worker\\n'", ""].join("\n"));
      writeFileSync(checkFile, [
        "cat >/dev/null",
        "printf ' explanation\\n'",
        "printf ' diagnostic\\n' >&2",
        "kill -TERM $$",
        "",
      ].join("\n"));
      const input = makeInput(makeWorkflow([step]), (processRequest) => executeWorkflowProcess({
        ...processRequest,
        workflow: "clock", runId: "wrun_test_1", projectRoot: root,
        dataDirectory: root, stateDirectory: root, cwd: root,
      }), { files: { "10-work.sh": workerFile, "10-work.check.sh": checkFile } });

      assert.deepEqual(await executeWorkflowAttempt(input, request), {
        kind: "failed", output: "  worker\n",
        reason: "10-work.check failed with signal SIGTERM: explanation\ndiagnostic",
      });
    });
  });

  const noSignalResults: { name: string; result: ProcessExecutionResult }[] = [
    { name: "absent signal", result: { exitCode: null, stdout: " explanation\n", stderr: " diagnostic\n", timedOut: false } },
    { name: "null signal", result: { exitCode: null, stdout: " explanation\n", stderr: " diagnostic\n", timedOut: false, signal: null } },
    { name: "empty signal", result: { exitCode: null, stdout: " explanation\n", stderr: " diagnostic\n", timedOut: false, signal: "" } },
  ];
  for (const { name, result } of noSignalResults) {
    await t.test(name, async () => {
      const input = makeInput(makeWorkflow([step]), async (processRequest) =>
        processRequest.kind === "command-check" ? result : successful("  worker\n"));
      assert.deepEqual(await executeWorkflowAttempt(input, request), {
        kind: "failed", output: "  worker\n", reason: "explanation\ndiagnostic",
      });
    });
  }
});

test("Markdown judges use their resolved profile and reject unresolved profiles", async (t) => {
  await t.test("uses the resolved judge profile instead of the worker override", async () => {
    const calls: ProcessExecutionRequest[] = [];
    const step: WorkflowStep = {
      kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer",
      check: { kind: "agent", file: "10-write.check.md", profile: "judge" },
    };
    const input = makeInput(makeWorkflow([step]), async (request) => {
      calls.push(request);
      return successful(request.kind === "agent-check" ? "ACCEPT" : "draft");
    }, { documents: { "10-write.md": "Write.", "10-write.check.md": "Judge." } });
    const result = await executeWorkflowAttempt(input, { step, profile: "fast", pipeInput: "", feedback: "", attempt: 1 });

    assert.deepEqual(result, { kind: "accepted", output: "draft" });
    assert.deepEqual(calls.map(({ kind, command }) => [kind, command]), [
      ["agent", ["fake-writer", "--fast"]],
      ["agent-check", ["fake-judge"]],
    ]);
  });

  for (const workerProfile of ["fast", undefined] as const) {
    await t.test(`fails when the judge profile is unresolved and worker profile is ${workerProfile ?? "configured"}`, async () => {
      const calls: ProcessExecutionRequest[] = [];
      const step: WorkflowStep = {
        kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer",
        check: { kind: "agent", file: "10-write.check.md" },
      };
      const input = makeInput(makeWorkflow([step]), async (request) => {
        calls.push(request);
        return successful("draft");
      }, { documents: { "10-write.md": "Write.", "10-write.check.md": "Judge." } });

      await assert.rejects(executeWorkflowAttempt(input, {
        step, ...(workerProfile === undefined ? {} : { profile: workerProfile }),
        pipeInput: "", feedback: "", attempt: 1,
      }), /10-write\.check selects an unknown profile ""/);
      assert.deepEqual(calls.map(({ kind }) => kind), ["agent"]);
    });
  }
});

test("Markdown judges receive worker retry feedback without changing their input", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const retryFeedback = "repeats a previous sentence";
  const workflow = makeWorkflow([{
    kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer",
    check: { kind: "agent", file: "10-write.check.md", profile: "judge" },
  }]);
  const input = makeInput(workflow, async (request) => {
    calls.push(request);
    if (request.kind === "agent-check") {
      return request.attempt === 1 ? successful(`REJECT - ${retryFeedback}`) : successful("ACCEPT");
    }
    return successful(request.attempt === 1 ? "first candidate\n" : "second candidate\n");
  }, { documents: { "10-write.md": "Write the sentence.", "10-write.check.md": "Judge the sentence." } });

  const first = await executeWorkflowAttempt(input, {
    step: firstStep(workflow), profile: "writer", pipeInput: "", feedback: "", attempt: 1,
  });
  const second = await executeWorkflowAttempt(input, {
    step: firstStep(workflow), profile: "writer", pipeInput: "", feedback: retryFeedback, attempt: 2,
  });

  assert.deepEqual(first, { kind: "failed", output: "first candidate\n", reason: retryFeedback });
  assert.deepEqual(second, { kind: "accepted", output: "second candidate\n" });
  assert.equal(calls[1]?.feedback, "");
  assert.equal(calls[3]?.feedback, retryFeedback);
  assert.equal(calls[3]?.input, "Judge the sentence.\n\n## Input\n\nsecond candidate\n");
});

test("Markdown checks use only their first line and failed check processes cannot accept", async () => {
  assert.deepEqual(parseMarkdownVerdict("ACCEPT - original\nREJECT"), { accepted: true, reason: "original" });
  assert.deepEqual(parseMarkdownVerdict("explanation\nACCEPT"), {
    accepted: false,
    reason: "check must start with ACCEPT or REJECT; received \"explanation\"",
  });
  const calls: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([{
    kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer",
    check: { kind: "agent", file: "10-write.check.md", profile: "judge" },
  }]);
  const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => {
    calls.push(request);
    return request.kind === "agent"
      ? successful("draft")
      : { exitCode: 7, stdout: "ACCEPT", stderr: "judge crashed", timedOut: false };
  }, { documents: { "10-write.md": "Write.", "10-write.check.md": "Judge." } }), {
    step: firstStep(workflow), profile: "writer", pipeInput: "", feedback: "", attempt: 1,
  });

  assert.deepEqual(calls.map(({ kind }) => kind), ["agent", "agent-check"]);
  assert.deepEqual(result, { kind: "failed", output: "draft", reason: "10-write.check failed with exit code 7: judge crashed\nACCEPT" });
});

test("Markdown judge attempts require complete verdict tokens and preserve supported forms", async () => {
  const step: WorkflowStep = {
    kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer",
    check: { kind: "agent", file: "10-write.check.md", profile: "judge" },
  };
  const cases: Array<[string, WorkflowAttemptResult]> = [
    ["ACCEPTED", { kind: "failed", output: "draft", reason: 'check must start with ACCEPT or REJECT; received "ACCEPTED"' }],
    ["REJECTED", { kind: "failed", output: "draft", reason: 'check must start with ACCEPT or REJECT; received "REJECTED"' }],
    ["accept", { kind: "accepted", output: "draft" }],
    ["reject", { kind: "failed", output: "draft", reason: "check rejected the output" }],
    ["ACCEPT\r\nignored", { kind: "accepted", output: "draft" }],
    ["REJECT\r\nignored", { kind: "failed", output: "draft", reason: "check rejected the output" }],
    ["ACCEPT: approved", { kind: "accepted", output: "draft" }],
    ["REJECT - needs work", { kind: "failed", output: "draft", reason: "needs work" }],
    ["ACCEPT with a reason", { kind: "accepted", output: "draft" }],
    ["", { kind: "failed", output: "draft", reason: 'check must start with ACCEPT or REJECT; received ""' }],
    ["   ", { kind: "failed", output: "draft", reason: 'check must start with ACCEPT or REJECT; received ""' }],
  ];

  for (const [verdict, expected] of cases) {
    const input = makeInput(makeWorkflow([step]), async ({ kind }) =>
      successful(kind === "agent-check" ? verdict : "draft"), {
        documents: { "10-write.md": "Write.", "10-write.check.md": "Judge." },
      });
    assert.deepEqual(await executeWorkflowAttempt(input, {
      step, profile: "writer", pipeInput: "", feedback: "", attempt: 1,
    }), expected, verdict);
  }
});

test("attempt timeouts and invalid saved workflow timeouts keep their limits", async () => {
  const requests: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([{ kind: "command", file: "10-slow.sh", number: 10, name: "slow" }], { timeout: "2s" });
  const result = await executeWorkflowAttempt(makeInput(workflow, async (request) => {
    requests.push(request);
    return { exitCode: null, stdout: "partial", stderr: "", timedOut: true, signal: "SIGTERM" };
  }), { step: firstStep(workflow), pipeInput: "", feedback: "", attempt: 1 });
  assert.deepEqual(requests.map(({ timeoutMs }) => timeoutMs), [2_000]);
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.match(result.reason, /10-slow timed out after 2000ms/);

  const invalid = makeWorkflow([{ kind: "command", file: "10-slow.sh", number: 10, name: "slow" }], { timeout: "999999h" });
  await assert.rejects(executeWorkflowAttempt(makeInput(invalid, async () => successful("unused")), {
    step: firstStep(invalid), pipeInput: "", feedback: "", attempt: 1,
  }), /Workflow timeout is too large for Node timers: 999999h/);
});

test("retry decision validation preserves its public duration message", () => {
  assert.throws(() => parseWorkflowDecision({ action: "retry", after: "0s" }), (error: unknown) => {
    if (!(error instanceof ZodError)) return false;
    assert.deepEqual(error.issues[0]?.path, ["after"]);
    assert.equal(error.issues[0]?.message, "must be a positive duration supported by Node timers");
    return true;
  });
});

test("fake profile commands receive stdin and Workshop environment without a shell", async () => {
  await withRoot(async (root) => {
    const result = await executeWorkflowProcess({
      kind: "agent", command: [process.execPath, fixture, "environment"], input: "prompt from stdin", step: "20-write",
      feedback: "try again", attempt: 2, timeoutMs: 2_000, workflow: "clock", runId: "wrun_process_1",
      projectRoot: root, dataDirectory: "/data/clock", stateDirectory: root, cwd: process.cwd(),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      input: "prompt from stdin", workflow: "clock", runId: "wrun_process_1", step: "20-write",
      dataDirectory: "/data/clock", stateDirectory: root, feedback: "try again",
    });
  });
});

test("command processes execute their source path with stdin semantics", async () => {
  await withRoot(async (root) => {
    const file = join(root, "10-step with spaces.sh");
    writeFileSync(file, `IFS= read -r line\nprintf '%s:%s' "$line" "$0"\n`);
    const result = await executeWorkflowProcess({
      kind: "command", command: ["sh", file], input: "pipe content\n", step: "10-step", feedback: "", attempt: 1,
      workflow: "clock", runId: "wrun_file_path", projectRoot: root, dataDirectory: root, stateDirectory: root, cwd: root,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `pipe content:${file}`);
  });
});

test("typed TypeScript commands and checks execute through Node", async () => {
  await withRoot(async (root) => {
    const stepFile = join(root, "10-typed.ts");
    const checkFile = join(root, "10-typed.check.ts");
    writeFileSync(stepFile, [
      "type Result = { text: string };",
      'const result: Result = { text: "typed output" };',
      "process.stdout.write(result.text);",
      "",
    ].join("\n"));
    writeFileSync(checkFile, [
      'let input = "";',
      "for await (const chunk of process.stdin) input += chunk.toString();",
      "const checked: string = input;",
      'if (checked !== "typed output") throw new Error(`Unexpected input: ${checked}`);',
      "",
    ].join("\n"));
    const workflow = makeWorkflow([{
      kind: "command", file: "10-typed.ts", number: 10, name: "typed",
      check: { kind: "command", file: "10-typed.check.ts" },
    }]);
    const result = await executeWorkflowAttempt(makeInput(workflow, (request) => executeWorkflowProcess({
      ...request, workflow: "clock", runId: "typed-run", projectRoot: root,
      dataDirectory: root, stateDirectory: root, cwd: root,
    }), { files: { "10-typed.ts": stepFile, "10-typed.check.ts": checkFile } }), {
      step: firstStep(workflow), pipeInput: "", feedback: "", attempt: 1,
    });
    assert.deepEqual(result, { kind: "accepted", output: "typed output" });
  });
});

async function waitForProcessId(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail("fixture did not start its grandchild");
}

async function assertProcessStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    assert.ifError(result.error);
    const state = result.stdout.trim();
    if (result.status !== 0 || state.length === 0 || state.startsWith("Z")) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`grandchild ${pid} is still running`);
}

function grandchildProcessInput(root: string, pidFile: string, timeoutMs?: number, signal?: AbortSignal) {
  return executeWorkflowProcess({
    kind: "agent", command: [process.execPath, fixture, "spawn-grandchild", pidFile], input: "", step: "10-grandchild",
    feedback: "", attempt: 1, ...(timeoutMs === undefined ? {} : { timeoutMs }), workflow: "clock",
    runId: "wrun_grandchild_1", projectRoot: root, dataDirectory: root, stateDirectory: root, cwd: root,
    ...(signal === undefined ? {} : { signal }),
  });
}

test("step timeout kills the process tree", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    const pidFile = join(root, "grandchild.pid");
    const pending = grandchildProcessInput(root, pidFile, 500);
    const pid = await waitForProcessId(pidFile);
    const result = await pending;
    assert.equal(result.timedOut, true);
    await assertProcessStopped(pid);
  });
});

test("aborting the step task signal kills the active process tree", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    const pidFile = join(root, "grandchild.pid");
    const controller = new AbortController();
    const pending = grandchildProcessInput(root, pidFile, undefined, controller.signal);
    const pid = await waitForProcessId(pidFile);
    controller.abort();
    const result = await pending;
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, "SIGTERM");
    await assertProcessStopped(pid);
  });
});

test("a pre-aborted attempt does not spawn its process", async () => {
  await withRoot(async (root) => {
    const marker = join(root, "spawned");
    const controller = new AbortController();
    controller.abort();
    const result = await executeWorkflowProcess({
      kind: "command", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      input: "", step: "10-pre-aborted", feedback: "", attempt: 1, workflow: "clock", runId: "pre-aborted",
      projectRoot: root, dataDirectory: root, stateDirectory: root, cwd: root, signal: controller.signal,
    });
    assert.equal(existsSync(marker), false);
    assert.equal(result.timedOut, false);
    assert.match(result.error ?? "", /cancelled before it started/);
  });
});

test("abort remains the first stop cause when timeout fires during termination", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    const marker = join(root, "ready");
    const controller = new AbortController();
    const pending = executeWorkflowProcess({
      kind: "command",
      command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`],
      input: "", step: "10-abort-before-timeout", feedback: "", attempt: 1, timeoutMs: 1_000,
      workflow: "clock", runId: "abort-before-timeout", projectRoot: root, dataDirectory: root,
      stateDirectory: root, cwd: root, signal: controller.signal,
    });
    const abortTimer = setTimeout(() => controller.abort(), 850);
    const deadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.ok(existsSync(marker), "the process started");
    const result = await pending;
    clearTimeout(abortTimer);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, "SIGKILL");
  });
});

test("a worker that succeeds after cancellation does not start its checker", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const workflow = makeWorkflow([{
    kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer",
    check: { kind: "command", file: "10-write.check.sh" },
  }]);
  const input = makeInput(workflow, async (request) => {
    calls.push(request.kind);
    controller.abort();
    return successful("candidate");
  }, { documents: { "10-write.md": "Write." }, signal: controller.signal });

  await assert.rejects(executeWorkflowAttempt(input, {
    step: firstStep(workflow), profile: "writer", pipeInput: "", feedback: "", attempt: 1,
  }), /cancelled before its check could start/);
  assert.deepEqual(calls, ["agent"]);
});

test("process transitions preserve the first stop cause and reject repeated or out-of-order events", () => {
  const spawning = createWorkflowProcessState();
  assert.deepEqual(transitionWorkflowProcess(spawning, { kind: "closed", exitCode: 0, signal: null }), {
    kind: "rejected", code: "out-of-order", message: "Cannot close a process while it is spawning",
  });

  const running = transitionWorkflowProcess(spawning, { kind: "spawned" });
  assert.deepEqual(running, { kind: "accepted", state: { kind: "running" }, effects: [] });
  if (running.kind !== "accepted") throw new Error("Spawning process should become running");

  const stopping = transitionWorkflowProcess(running.state, { kind: "stop-requested", cause: { kind: "aborted" } });
  assert.deepEqual(stopping, {
    kind: "accepted",
    state: { kind: "stopping", cause: { kind: "aborted" }, phase: "waiting-for-close-and-grace" },
    effects: [{ kind: "signal", signal: "SIGTERM" }, { kind: "schedule-kill", delayMs: 250 }],
  });
  if (stopping.kind !== "accepted") throw new Error("Running process should stop");
  assert.deepEqual(transitionWorkflowProcess(stopping.state, { kind: "stop-requested", cause: { kind: "timeout" } }), {
    kind: "rejected", code: "already-stopping", message: "Process is already stopping for aborted",
  });

  const closed = transitionWorkflowProcess(stopping.state, { kind: "closed", exitCode: null, signal: "SIGTERM" });
  assert.deepEqual(closed, {
    kind: "accepted",
    state: {
      kind: "stopping", cause: { kind: "aborted" }, phase: "waiting-for-grace",
      closeResult: { exitCode: null, signal: "SIGTERM" },
    },
    effects: [],
  });
  if (closed.kind !== "accepted") throw new Error("Stopping process should record its close");
  const exited = transitionWorkflowProcess(closed.state, { kind: "grace-elapsed" });
  assert.deepEqual(exited, {
    kind: "accepted",
    state: { kind: "exited", cause: { kind: "aborted" }, closeResult: { exitCode: null, signal: "SIGTERM" } },
    effects: [{ kind: "signal", signal: "SIGKILL" }],
  });
  if (exited.kind !== "accepted") throw new Error("Closed process should exit after the grace period");
  assert.deepEqual(transitionWorkflowProcess(exited.state, { kind: "closed", exitCode: null, signal: "SIGKILL" }), {
    kind: "rejected", code: "already-exited", message: "Process has already exited",
  });
});

test("attempt transitions reject repeated, out-of-order, and terminal events", () => {
  const worker = { kind: "worker" } as const;
  const checking = transitionWorkflowAttempt(worker, { kind: "worker-succeeded", output: "draft", hasCheck: true });
  assert.deepEqual(checking, {
    kind: "accepted", state: { kind: "checking", output: "draft" }, effects: [{ kind: "check", output: "draft" }],
  });
  if (checking.kind !== "accepted") throw new Error("Successful worker should enter checking");
  assert.deepEqual(transitionWorkflowAttempt(checking.state, { kind: "worker-succeeded", output: "duplicate", hasCheck: true }), {
    kind: "rejected", code: "out-of-order", message: "Cannot complete the worker while attempt phase is checking",
  });

  const rejected = transitionWorkflowAttempt(checking.state, { kind: "check-rejected", feedback: "expected a line" });
  assert.deepEqual(rejected, {
    kind: "accepted",
    state: { kind: "rejected", output: "draft", feedback: "expected a line" },
    effects: [],
  });
  if (rejected.kind !== "accepted") throw new Error("Rejected check should finish the attempt");
  assert.deepEqual(transitionWorkflowAttempt(rejected.state, { kind: "check-accepted" }), {
    kind: "rejected", code: "already-terminal", message: "Attempt is already rejected",
  });
  assert.deepEqual(transitionWorkflowAttempt(worker, { kind: "check-accepted" }), {
    kind: "rejected", code: "out-of-order", message: "Cannot accept a check while attempt phase is worker",
  });
});
