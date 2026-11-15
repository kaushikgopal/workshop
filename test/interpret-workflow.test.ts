import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cancelWorkflowProcesses, executeWorkflowProcess } from "../agent/lib/execute-workflow-process.ts";
import { createWorkflowSnapshot } from "../workflow/create-workflow-snapshot.ts";
import { interpretWorkflow, parseMarkdownVerdict, type ProcessExecutionRequest, type ProcessExecutionResult, type WorkflowInterpreterInput } from "../workflow/interpret-workflow.ts";
import type { Workflow, WorkflowDecision, WorkflowStep } from "../workflow/types.ts";

const fixture = resolve("test/fixtures/profile-command.mjs");

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

function makeInput(
  workflow: Workflow,
  executeProcess: WorkflowInterpreterInput["executeProcess"],
  waitForDecision: WorkflowInterpreterInput["waitForDecision"] = async () => ({ action: "fail" }),
  extra: Partial<WorkflowInterpreterInput> = {},
): WorkflowInterpreterInput {
  return {
    workflow,
    documents: {},
    files: Object.fromEntries(workflow.steps.flatMap((step) => [step.file, ...(step.check ? [step.check.file] : [])].map((file) => [file, join("/snapshot/clock", file)] as const))),
    workflowRunId: "wrun_test_1",
    profileCommands: { writer: ["fake-writer"], judge: ["fake-judge"], fast: ["fake-writer", "--fast"] },
    executeProcess,
    waitForDecision,
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
  const root = mkdtempSync(join(tmpdir(), "workshop-interpreter-test-"));
  try {
    await action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("pipes stdout between command and agent steps without changing it", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const executeProcess = async (request: ProcessExecutionRequest) => {
    calls.push(request);
    if (request.kind === "command" && request.step === "30-last") return successful("done\n");
    if (request.kind === "command") return successful("command output\n");
    if (request.kind === "agent") return successful("agent output\n");
    return successful("done\n");
  };
  const workflow = makeWorkflow([
    { kind: "command", file: "10-first.sh", number: 10, name: "first" },
    { kind: "agent", file: "20-write.md", number: 20, name: "write", profile: "writer" },
    { kind: "command", file: "30-last.ts", number: 30, name: "last" },
  ], { timeout: "3s" });
  const result = await interpretWorkflow(makeInput(workflow, executeProcess, undefined, {
    documents: { "20-write.md": "Write one line." },
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.output, "done\n");
  assert.equal(result.completedSteps, 3);
  assert.deepEqual(calls.map(({ input, timeoutMs }) => [input, timeoutMs]), [
    ["", 3_000],
    ["Write one line.\n\n## Input\n\ncommand output\n", 3_000],
    ["agent output\n", 3_000],
  ]);
  assert.deepEqual(calls.map(({ command }) => command.map((part) => part.split("/").at(-1))), [
    ["sh", "10-first.sh"],
    ["fake-writer"],
    ["node", "30-last.ts"],
  ]);
});

test("exit 99 ends the workflow successfully before later steps", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const result = await interpretWorkflow(makeInput(makeWorkflow([
    { kind: "command", file: "10-nothing.sh", number: 10, name: "nothing" },
    { kind: "command", file: "20-later.sh", number: 20, name: "later" },
  ]), async (request) => {
    calls.push(request);
    return { exitCode: 99, stdout: "", stderr: "", timedOut: false };
  }));

  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.completedSteps, 0);
  assert.equal(calls.length, 1);
});

test("check rejection retries with its reason and accepts the next candidate", async () => {
  const calls: ProcessExecutionRequest[] = [];
  let candidates = 0;
  let verdicts = 0;
  const workflow = makeWorkflow([{
    kind: "agent",
    file: "10-write.md",
    number: 10,
    name: "write",
    profile: "writer",
    retries: 1,
    check: { kind: "agent", file: "10-write.check.md", profile: "judge" },
  }]);
  const result = await interpretWorkflow(makeInput(workflow, async (request) => {
    calls.push(request);
    if (request.kind === "agent") {
      candidates += 1;
      return successful(candidates === 1 ? "first candidate\n" : "second candidate\n");
    }
    if (request.kind === "agent-check") {
      verdicts += 1;
      return successful(verdicts === 1 ? "REJECT - repeats a previous sentence\n" : "ACCEPT - original\n");
    }
    return successful("");
  }, undefined, {
    documents: {
      "10-write.md": "Write one sentence.",
      "10-write.check.md": "Judge the sentence.",
    },
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.output, "second candidate\n");
  assert.equal(calls.length, 4);
  assert.match(calls[2]?.input ?? "", /## Feedback\n\nrepeats a previous sentence/);
  assert.equal(calls[3]?.input, "Judge the sentence.\n\n## Input\n\nsecond candidate\n");
});

test("command checks accept on exit zero and feed a rejection back into the retry", async () => {
  const calls: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([{
    kind: "command",
    file: "10-checkable.sh",
    number: 10,
    name: "checkable",
    retries: 1,
    check: { kind: "command", file: "10-checkable.check.sh" },
  }]);
  const result = await interpretWorkflow(makeInput(workflow, async (request) => {
    calls.push(request);
    if (request.kind === "command-check" && request.attempt === 1) {
      return { exitCode: 2, stdout: "wrong output", stderr: "expected a line", timedOut: false };
    }
    if (request.kind === "command-check") return successful("");
    return successful(`candidate ${request.attempt}`);
  }));

  assert.equal(result.output, "candidate 2");
  assert.deepEqual(calls.map(({ kind, input }) => [kind, input]), [
    ["command", ""],
    ["command-check", "candidate 1"],
    ["command", ""],
    ["command-check", "candidate 2"],
  ]);
  assert.equal(calls[2]?.feedback, "wrong output\nexpected a line");
});

test("Markdown checks use only their first line", () => {
  assert.deepEqual(parseMarkdownVerdict("ACCEPT - original\nREJECT"), { accepted: true, reason: "original" });
  assert.deepEqual(parseMarkdownVerdict("explanation\nACCEPT"), {
    accepted: false,
    reason: `check must start with ACCEPT or REJECT; received "explanation"`,
  });
});

test("exhausted attempts stay blocked and expose the step and last error", async () => {
  let releaseDecision: ((decision: WorkflowDecision) => void) | undefined;
  let signalBlocked: (() => void) | undefined;
  const blocked = new Promise<void>((resolveBlocked) => { signalBlocked = resolveBlocked; });
  const decision = new Promise<WorkflowDecision>((resolveDecision) => { releaseDecision = resolveDecision; });
  let settled = false;
  let blockedInput: Parameters<WorkflowInterpreterInput["waitForDecision"]>[0] | undefined;
  const workflow = makeWorkflow([{
    kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer", retries: 0,
  }]);
  const pending = interpretWorkflow(makeInput(workflow, async () => failed("last output", "profile crashed"), async (input) => {
    blockedInput = input;
    signalBlocked?.();
    return decision;
  }, { documents: { "10-write.md": "Write." } })).then((value) => {
    settled = true;
    return value;
  });

  await blocked;
  assert.equal(settled, false);
  assert.deepEqual(blockedInput, {
    workflow: "clock",
    runId: "wrun_test_1",
    step: "10-write",
    stepKind: "agent",
    retryProfiles: ["writer", "fast"],
    lastError: "10-write profile failed with exit code 7: profile crashed\nlast output",
    lastOutput: "last output",
    attemptHistory: [{
      attempt: 1,
      profile: "writer",
      output: "last output",
      error: "10-write profile failed with exit code 7: profile crashed\nlast output",
    }],
    decisionNumber: 1,
  });
  releaseDecision?.({ action: "skip" });
  assert.equal((await pending).status, "completed");
});

test("retry, skip, accept, and fail decisions have distinct effects", async (t) => {
  await t.test("retry applies the hint and selected agent profile", async () => {
    const calls: ProcessExecutionRequest[] = [];
    const result = await interpretWorkflow(makeInput(makeWorkflow([
      { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer", retries: 0 },
    ]), async (request) => {
      calls.push(request);
      return request.attempt === 1 ? failed("bad output") : successful("fixed output");
    }, async () => ({ action: "retry", hint: "Use a different image.", profile: "fast" }), {
      documents: { "10-write.md": "Write." },
    }));

    assert.equal(result.output, "fixed output");
    assert.deepEqual(calls.map(({ command }) => command), [["fake-writer"], ["fake-writer", "--fast"]]);
    assert.match(calls[1]?.input ?? "", /Hint: Use a different image\./);
  });

  await t.test("retry profiles cannot switch executables", async () => {
    const workflow = makeWorkflow([
      { kind: "agent", file: "10-write.md", number: 10, name: "write", profile: "writer", retries: 0 },
    ]);
    await assert.rejects(interpretWorkflow(makeInput(workflow, async () => failed("bad output"), async () => ({
      action: "retry", profile: "other",
    }), {
      documents: { "10-write.md": "Write." },
      profileCommands: { writer: ["fake-writer"], other: ["other-writer"] },
    })), /same executable/);
  });

  await t.test("skip preserves the previous pipe input", async () => {
    const inputs: string[] = [];
    const result = await interpretWorkflow(makeInput(makeWorkflow([
      { kind: "command", file: "10-first.sh", number: 10, name: "first" },
      { kind: "command", file: "20-skip.sh", number: 20, name: "skip" },
      { kind: "command", file: "30-last.sh", number: 30, name: "last" },
    ]), async (request) => {
      inputs.push(request.input);
      return request.step === "20-skip" ? failed("not accepted") : successful(request.step === "10-first" ? "upstream" : "downstream");
    }, async () => ({ action: "skip" })));

    assert.deepEqual(inputs, ["", "upstream", "upstream"]);
    assert.equal(result.output, "downstream");
  });

  await t.test("accept passes the last failed output to the next step", async () => {
    const inputs: string[] = [];
    const result = await interpretWorkflow(makeInput(makeWorkflow([
      { kind: "command", file: "10-accept.sh", number: 10, name: "accept" },
      { kind: "command", file: "20-last.sh", number: 20, name: "last" },
    ]), async (request) => {
      inputs.push(request.input);
      return request.step === "10-accept" ? failed("last output") : successful("finished");
    }, async () => ({ action: "accept" })));

    assert.deepEqual(inputs, ["", "last output"]);
    assert.equal(result.output, "finished");
  });

  await t.test("fail ends the workflow with the last failure", async () => {
    await assert.rejects(
      interpretWorkflow(makeInput(makeWorkflow([
        { kind: "command", file: "10-fail.sh", number: 10, name: "fail" },
      ]), async () => failed("", "command broke"), async () => ({ action: "fail" }))),
      /10-fail failed after 1 attempts: 10-fail failed with exit code 7: command broke/,
    );
  });
});

test("snapshot copies prompts and scripts so later workflow edits do not affect the active run", async () => {
  await withRoot(async (root) => {
    const workflowRoot = join(root, "workflows");
    const workflowDirectory = join(workflowRoot, "clock");
    const stateRoot = join(root, "state");
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(join(workflowDirectory, "workflow.md"), "---\ncron: '* * * * *'\n---\n\nTest snapshot.\n");
    writeFileSync(join(workflowDirectory, "10-first.sh"), "first version\n");
    writeFileSync(join(workflowDirectory, "20-second.sh"), "old second version\n");
    writeFileSync(join(workflowDirectory, "30-write.md"), "---\nprofile: writer\n---\n\nOld prompt.\n");

    const snapshot = createWorkflowSnapshot({
      workflowName: "clock",
      runId: "wrun_snapshot_1",
      workflowRoot,
      stateRoot,
      dataDirectory: join(root, "data", "clock"),
      profileCommands: { writer: ["fake-writer"] },
    });
    const seenScripts: string[] = [];
    const seenPrompts: string[] = [];
    await interpretWorkflow({
      workflow: snapshot.workflow,
      documents: snapshot.documents,
      files: snapshot.files,
      workflowRunId: "wrun_snapshot_1",
      profileCommands: snapshot.profileCommands,
      executeProcess: async (request) => {
        if (request.kind === "agent") {
          seenPrompts.push(request.input);
          return successful("agent output");
        }
        const script = request.command[1];
        if (!script) throw new Error("command fixture path is missing");
        seenScripts.push(readFileSync(script, "utf8"));
        if (request.step === "10-first") {
          writeFileSync(join(workflowDirectory, "20-second.sh"), "new second version\n");
          writeFileSync(join(workflowDirectory, "30-write.md"), "---\nprofile: writer\n---\n\nNew prompt.\n");
        }
        return successful(request.step);
      },
      waitForDecision: async () => ({ action: "fail" }),
    });
    assert.deepEqual(seenScripts, ["first version\n", "old second version\n"]);
    assert.ok(seenPrompts[0]?.startsWith("Old prompt."));
    assert.doesNotMatch(seenPrompts[0] ?? "", /New prompt/);
  });
});

test("timeouts become workflow failures with the configured limit", async () => {
  const requests: ProcessExecutionRequest[] = [];
  const workflow = makeWorkflow([
    { kind: "command", file: "10-slow.sh", number: 10, name: "slow" },
  ], { timeout: "2s", retries: 0 });
  await assert.rejects(interpretWorkflow(makeInput(workflow, async (request) => {
    requests.push(request);
    return { exitCode: null, stdout: "partial", stderr: "", timedOut: true, signal: "SIGTERM" };
  }, async () => ({ action: "fail" }))), /10-slow timed out after 2000ms/);
  assert.equal(requests[0]?.timeoutMs, 2_000);
});

test("fake profile commands receive stdin and Workshop environment without a shell", async () => {
  const result = await executeWorkflowProcess({
    kind: "agent",
    command: [process.execPath, fixture, "environment"],
    input: "prompt from stdin",
    step: "20-write",
    feedback: "try again",
    attempt: 2,
    timeoutMs: 2_000,
    workflow: "clock",
    runId: "wrun_process_1",
    dataDirectory: "/data/clock",
    stateDirectory: "/service/state",
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    input: "prompt from stdin",
    workflow: "clock",
    runId: "wrun_process_1",
    step: "20-write",
    dataDirectory: "/data/clock",
    stateDirectory: "/service/state",
    feedback: "try again",
  });
});

async function waitForProcessId(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "fixture must write a valid grandchild PID");
      return pid;
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

function grandchildProcessInput(root: string, pidFile: string, timeoutMs?: number) {
  return executeWorkflowProcess({
    kind: "agent",
    command: [process.execPath, fixture, "spawn-grandchild", pidFile],
    input: "",
    step: "10-grandchild",
    feedback: "",
    attempt: 1,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    workflow: "clock",
    runId: "wrun_grandchild_1",
    dataDirectory: root,
    stateDirectory: root,
    cwd: root,
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

test("run cancellation kills the active process tree", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    const pidFile = join(root, "grandchild.pid");
    const pending = grandchildProcessInput(root, pidFile);
    const pid = await waitForProcessId(pidFile);
    await cancelWorkflowProcesses("wrun_grandchild_1");
    const result = await pending;
    assert.equal(result.timedOut, false);
    await assertProcessStopped(pid);
  });
});
