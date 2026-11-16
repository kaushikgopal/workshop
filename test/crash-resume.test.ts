import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { test } from "node:test";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { createStepAttemptTask, STEP_ATTEMPT_TASK_NAME } from "../workflow/define-step-attempt-task.ts";
import { WorkflowTask, WORKFLOW_TASK_NAME } from "../workflow/define-workflow-task.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHarness(storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>) {
  const registry = createRegistry();
  registry.install({ name: "workshop", tasks: [WorkflowTask, createStepAttemptTask(executeWorkflowProcess)] });
  return Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
}

async function waitForInvocationCount(file: string, expected: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const pids = readFileSync(file, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
      if (pids.length >= expected) return pids;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${expected} workflow command invocations`);
}

async function taskById(storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>, id: string | number): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>> {
  const page = await storage.scanTasks({}, 1_000, undefined, BACKGROUND_CONTEXT);
  const task = page.items.find((record) => String(record.id) === String(id));
  if (!task) throw new Error(`Durable task ${id} was not found`);
  return task;
}

function activeAttemptId(task: TaskRecord<JsonValue, JsonValue, JsonValue>): string | number {
  if (task.state.status !== "running" || !isRecord(task.state.checkpoint)) throw new Error(`Workflow task has no running checkpoint: ${JSON.stringify(task.state)}`);
  const activeAttempt = task.state.checkpoint.activeAttempt;
  if (!isRecord(activeAttempt) || (typeof activeAttempt.taskId !== "string" && typeof activeAttempt.taskId !== "number")) throw new Error(`Workflow task has no child attempt ID: ${JSON.stringify(task.state.checkpoint)}`);
  return activeAttempt.taskId;
}

function killProcessGroups(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") throw error;
    }
  }
}

async function startHarnessProcess(projectRoot: string, startWorkflow: boolean): Promise<ReturnType<typeof spawn>> {
  const script = [
    `import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";`,
    `import { createModels } from "@earendil-works/pi-ai/models";`,
    `import { createRegistry, Harness } from "@earendil-works/pi-durable";`,
    `import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";`,
    `import { startWorkflow, createWorkflowStartPort } from ${JSON.stringify(new URL("../run/start-workflow.ts", import.meta.url).href)};`,
    `import { executeWorkflowProcess } from ${JSON.stringify(new URL("../run/execute-workflow-process.ts", import.meta.url).href)};`,
    `import { WorkflowTask } from ${JSON.stringify(new URL("../workflow/define-workflow-task.ts", import.meta.url).href)};`,
    `import { createStepAttemptTask } from ${JSON.stringify(new URL("../workflow/define-step-attempt-task.ts", import.meta.url).href)};`,
    `const StepAttemptTask = createStepAttemptTask(executeWorkflowProcess);`,
    `const root = ${JSON.stringify(projectRoot)};`,
    `const storage = await openNodeSqliteStorage(root + "/state/workshop.sqlite");`,
    `const registry = createRegistry(); registry.install({ name: "workshop", tasks: [WorkflowTask, StepAttemptTask] });`,
    `const harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);`,
    `harness.resume();`,
    ...(startWorkflow ? [
      `const port = await createWorkflowStartPort(harness);`,
      `const started = await startWorkflow({ workflowName: "clock", projectRoot: root, port });`,
      `process.stdout.write(JSON.stringify(started) + "\\n");`,
    ] : []),
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: resolve("."),
    env: { ...process.env, WORKSHOP_CONFIG: join(projectRoot, "workshop.yaml") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function startedRun(child: ReturnType<typeof spawn>): Promise<string> {
  return await new Promise((resolveStarted, rejectStarted) => {
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const result: unknown = JSON.parse(stdout.slice(0, newline));
        if (!isRecord(result) || result.kind !== "started" || typeof result.run_id !== "string") throw new Error("Workflow did not start");
        resolveStarted(result.run_id);
      } catch (error) {
        rejectStarted(error);
      }
    });
    child.once("error", rejectStarted);
    child.once("exit", (code, signal) => rejectStarted(new Error(`Harness exited before starting (${code ?? signal})`)));
  });
}

test("a killed service resumes the same parent and child tasks from SQLite", { skip: process.platform === "win32" }, async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "workshop-crash-resume-test-"));
  const workflowDirectory = join(projectRoot, "workflows", "clock");
  const stateDirectory = join(projectRoot, "state");
  const invocationFile = join(projectRoot, "invocations");
  const releaseFile = join(projectRoot, "release");
  mkdirSync(workflowDirectory, { recursive: true });
  writeFileSync(join(projectRoot, "workshop.yaml"), [
    "agent_profiles:",
    `  writer:\n    command: ["${process.execPath}"]`,
    "orchestrator: {}",
    "",
  ].join("\n"));
  writeFileSync(join(workflowDirectory, "workflow.md"), "---\ncron: '* * * * *'\nretries: 0\n---\nCrash-resume fixture.\n");
  writeFileSync(join(workflowDirectory, "10-gated.sh"), [
    `printf '%s\\n' "$$" >> "$WORKSHOP_PROJECT_ROOT/invocations"`,
    `while [ ! -f "$WORKSHOP_PROJECT_ROOT/release" ]; do sleep 0.02; done`,
    `printf 'resumed output'`,
    "",
  ].join("\n"));

  let child: ReturnType<typeof spawn> | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let pids: number[] = [];
  try {
    child = await startHarnessProcess(projectRoot, true);
    const runId = await startedRun(child);
    pids = await waitForInvocationCount(invocationFile, 1);
    const beforeStorage = await openNodeSqliteStorage(join(stateDirectory, "workshop.sqlite"));
    const beforeRun = (await beforeStorage.scanTasks({ kind: WORKFLOW_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT)).items.find((record) => isRecord(record.input) && record.input.runId === runId);
    assert.ok(beforeRun, "SQLite contains the workflow task before the crash");
    const attemptId = activeAttemptId(beforeRun);
    const beforeAttempt = await taskById(beforeStorage, attemptId);
    assert.equal(beforeAttempt.kind, STEP_ATTEMPT_TASK_NAME);
    const runRestartCount = beforeRun.restarts ?? 0;
    const attemptRestartCount = beforeAttempt.restarts ?? 0;
    await beforeStorage.close(BACKGROUND_CONTEXT);

    child.kill("SIGKILL");
    await once(child, "exit");
    child = undefined;

    storage = await openNodeSqliteStorage(join(stateDirectory, "workshop.sqlite"));
    harness = await createHarness(storage);
    const reopenedRun = await taskById(storage, beforeRun.id);
    const reopenedAttempt = await taskById(storage, attemptId);
    assert.equal(reopenedRun.id, beforeRun.id);
    assert.equal(reopenedAttempt.id, beforeAttempt.id);
    assert.ok((reopenedRun.restarts ?? 0) > runRestartCount);
    assert.ok((reopenedAttempt.restarts ?? 0) > attemptRestartCount);
    harness.resume();

    pids = await waitForInvocationCount(invocationFile, 2);
    writeFileSync(releaseFile, "release\n");
    const settled = await harness.waitForTask(beforeRun.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status === "terminal") {
      assert.equal(settled.state.outcome.status, "completed");
      if (settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result;
        assert.ok(isRecord(result));
        assert.equal(result.output, "resumed output");
      }
    }
    assert.equal((await waitForInvocationCount(invocationFile, 2)).length, 2);
  } finally {
    writeFileSync(releaseFile, "release\n");
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    killProcessGroups(pids);
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    else if (storage) await storage.close(BACKGROUND_CONTEXT);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a completed step attempt is reused when the parent checkpoint lags", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "workshop-completed-attempt-test-"));
  const workflowDirectory = join(projectRoot, "workflows", "clock");
  const stateDirectory = join(projectRoot, "state");
  const invocationFile = join(projectRoot, "invocations");
  const checkpointFile = join(projectRoot, "child-completed");
  mkdirSync(workflowDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(join(projectRoot, "workshop.yaml"), [
    "agent_profiles:",
    `  writer:\n    command: ["${process.execPath}"]`,
    "orchestrator: {}",
    "",
  ].join("\n"));
  writeFileSync(join(workflowDirectory, "workflow.md"), "---\ncron: '* * * * *'\nretries: 0\n---\nCompleted-attempt fixture.\n");
  writeFileSync(join(workflowDirectory, "10-finish.sh"), [
    `printf 'called\\n' >> "$WORKSHOP_PROJECT_ROOT/invocations"`,
    "printf 'finished output'",
    "",
  ].join("\n"));

  let child: ReturnType<typeof spawn> | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  try {
    const script = [
      `import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";`,
      `import { createModels } from "@earendil-works/pi-ai/models";`,
      `import { createRegistry, Harness } from "@earendil-works/pi-durable";`,
      `import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";`,
      `import { startWorkflow, createWorkflowStartPort } from ${JSON.stringify(new URL("../run/start-workflow.ts", import.meta.url).href)};`,
      `import { executeWorkflowProcess } from ${JSON.stringify(new URL("../run/execute-workflow-process.ts", import.meta.url).href)};`,
      `import { WorkflowTask } from ${JSON.stringify(new URL("../workflow/define-workflow-task.ts", import.meta.url).href)};`,
      `import { createStepAttemptTask } from ${JSON.stringify(new URL("../workflow/define-step-attempt-task.ts", import.meta.url).href)};`,
      `const StepAttemptTask = createStepAttemptTask(executeWorkflowProcess);`,
      `const root = ${JSON.stringify(projectRoot)};`,
      `const checkpointFile = ${JSON.stringify(checkpointFile)};`,
      `const storage = await openNodeSqliteStorage(root + "/state/workshop.sqlite");`,
      `const originalCommit = storage.commit.bind(storage);`,
      `let paused = false;`,
      `storage.commit = async (...args) => {`,
      `  const result = await originalCommit(...args);`,
      `  if (!paused) {`,
      `    const page = await storage.scanTasks({}, 1000, undefined, BACKGROUND_CONTEXT);`,
      `    const parent = page.items.find((task) => task.kind === "workshop.workflow" && task.state.checkpoint?.phase === "attempt");`,
      `    const active = parent?.state.checkpoint?.activeAttempt;`,
      `    const attempt = active ? await storage.task(active.taskId, BACKGROUND_CONTEXT) : undefined;`,
      `    if (attempt?.state.status === "terminal" && attempt.state.outcome.status === "completed") {`,
      `      paused = true;`,
      `      const { writeFileSync } = await import("node:fs");`,
      `      writeFileSync(checkpointFile, "child complete; parent still waiting");`,
      `      await new Promise(() => {});`,
      `    }`,
      `  }`,
      `  return result;`,
      `};`,
      `const registry = createRegistry(); registry.install({ name: "workshop", tasks: [WorkflowTask, StepAttemptTask] });`,
      `const harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);`,
      `harness.resume();`,
      `const port = await createWorkflowStartPort(harness);`,
      `const started = await startWorkflow({ workflowName: "clock", projectRoot: root, port });`,
      `process.stdout.write(JSON.stringify(started) + "\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolve("."),
      env: { ...process.env, WORKSHOP_CONFIG: join(projectRoot, "workshop.yaml") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runId = await startedRun(child);
    const deadline = Date.now() + 10_000;
    while (!existsSync(checkpointFile) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.ok(existsSync(checkpointFile), "the child result reached storage before its parent checkpoint");
    child.kill("SIGKILL");
    await once(child, "exit");
    child = undefined;

    storage = await openNodeSqliteStorage(join(stateDirectory, "workshop.sqlite"));
    harness = await createHarness(storage);
    const beforeRestart = (await storage.scanTasks({ kind: WORKFLOW_TASK_NAME }, 100, undefined, BACKGROUND_CONTEXT)).items.find((record) => isRecord(record.input) && record.input.runId === runId);
    assert.ok(beforeRestart, "SQLite retains the parent task");
    if (!beforeRestart) throw new Error("SQLite retains the parent task");
    assert.equal(beforeRestart.state.status, "pending", "the reopened parent is eligible to resume");
    if (beforeRestart.state.status !== "pending") throw new Error("The reopened parent is not pending");
    assert.ok(isRecord(beforeRestart.state.checkpoint), "the parent retains its attempt checkpoint");
    if (!isRecord(beforeRestart.state.checkpoint)) throw new Error("The parent has no attempt checkpoint");
    assert.equal(beforeRestart.state.checkpoint.phase, "attempt");
    const active = beforeRestart.state.checkpoint.activeAttempt;
    assert.ok(isRecord(active) && typeof active.taskId === "number", "the attempt checkpoint retains its child task ID");
    if (!isRecord(active) || typeof active.taskId !== "number") throw new Error("The attempt checkpoint has no child task ID");
    const completedAttempt = await taskById(storage, active.taskId);
    assert.equal(completedAttempt.kind, STEP_ATTEMPT_TASK_NAME);
    assert.equal(completedAttempt.state.status, "terminal");
    if (completedAttempt.state.status !== "terminal") throw new Error("The child attempt is not terminal");
    assert.equal(completedAttempt.state.outcome.status, "completed");

    harness.resume();
    const settled = await harness.waitForTask(beforeRestart.id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.status !== "terminal") throw new Error("The workflow did not complete after recovery");
    assert.equal(settled.state.outcome.status, "completed");
    if (settled.state.outcome.status !== "completed") throw new Error("The recovered workflow did not complete");
    assert.ok(isRecord(settled.state.outcome.result));
    if (!isRecord(settled.state.outcome.result)) throw new Error("The recovered workflow has no result");
    assert.equal(settled.state.outcome.result.output, "finished output");
    assert.equal(readFileSync(invocationFile, "utf8").trim().split(/\r?\n/).length, 1);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    else if (storage) await storage.close(BACKGROUND_CONTEXT);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
