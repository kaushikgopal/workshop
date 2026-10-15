import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, GenerationTask, Harness, MemoryStorage, ToolResultEntry, defineDoc, defineTool, hook, type ConversationId, type Harness as HarnessType, type TaskId } from "@earendil-works/pi-durable";
import { ExecutionError, err, ok, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, test } from "bun:test";
import { AgentExecutionGuardDoc, defineAgentExecutionTask, type AgentExecutionTaskInput, type AgentExecutionTaskResult } from "../src/storage/durable/define-agent-execution-task.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const model = { provider: "fixture", modelId: "native-agent" };
const executionId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const DeadlineDocForTest = defineDoc<{ deadlineAt: number | null }>({
  kind: "workshop.agent-execution-deadline",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ deadlineAt: null }),
});
const command = "workshop-test-unsafe-effect";
const firstToolCommand = "workshop-test-first-tool";
const secondToolCommand = "workshop-test-second-tool";


test("reopened unsafe bash intent blocks with no new provider request or effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-interrupted-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  const firstEnv = new TestExecutionEnv(directory, effects, "stall");
  let firstHarness: HarnessType | undefined;
  let recoveredHarness: HarnessType | undefined;
  try {
    const first = await openHarness(database, firstEnv, [() => {
      logRequest(requests);
      return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    }]);
    firstHarness = first.harness;
    const taskId = await createExecution(first.harness, first.task);
    await within(firstEnv.effectStarted, 5_000);
    expect(readLines(effects)).toEqual(["effect"]);

    await within(first.harness.close(BACKGROUND_CONTEXT), 5_000);
    firstHarness = undefined;

    const recoveryEnv = new TestExecutionEnv(directory, effects, "complete");
    const recovered = await openHarness(database, recoveryEnv, [() => {
      logRequest(requests);
      return fauxAssistantMessage("must not be requested after interruption");
    }]);
    recoveredHarness = recovered.harness;
    const inspection = await recovered.harness.inspect(BACKGROUND_CONTEXT);
    const interruptedTool = inspection.tasks.find(item => item.record.kind === "pi.tool");
    expect(interruptedTool).toBeDefined();
    if (interruptedTool === undefined) throw new Error("unsafe tool intent is missing after reopen");
    const toolRecord = await recovered.harness.getTask(interruptedTool.record.id as TaskId, BACKGROUND_CONTEXT);
    expect(toolRecord?.state.status).toBe("pending");
    if (toolRecord?.state.status !== "pending") throw new Error("unsafe tool did not reopen from a pending state");
    expect(toolRecord.state.checkpoint).toMatchObject({ phase: "execute", replay: "unsafe" });
    const toolConversation = await recovered.harness.conversation(interruptedTool.record.conversationId, BACKGROUND_CONTEXT);
    if (toolConversation === undefined) throw new Error("tool conversation is missing after reopen");
    const toolEntries = await toolConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(toolEntries.items.some(entry => ToolResultEntry.is(entry))).toBe(false);

    const settled = await within(recovered.harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    expect(settled.state.outcome.result.kind).toBe("blocked");
    expect(readLines(requests)).toEqual(["request"]);
    expect(readLines(effects)).toEqual(["effect"]);
    await closeHarness(recovered.harness);
    recoveredHarness = undefined;
  } finally {
    if (firstHarness !== undefined) await closeHarness(firstHarness).catch(() => undefined);
    if (recoveredHarness !== undefined) await closeHarness(recoveredHarness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reopened completed unsafe bash receipt resumes without replaying its effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-completed-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  const secondModelRequest = join(directory, "model-request-started");
  const firstEnv = new TestExecutionEnv(directory, effects, "complete");
  let firstHarness: HarnessType | undefined;
  let recoveredHarness: HarnessType | undefined;
  try {
    const first = await openHarness(database, firstEnv, [
      () => {
        logRequest(requests);
        return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
      },
      async (_context, options) => {
        logRequest(requests);
        writeFileSync(secondModelRequest, "started", "utf8");
        await waitForAbort(options?.signal);
        throw new Error("test provider request cancelled by close");
      },
    ]);
    firstHarness = first.harness;
    const taskId = await createExecution(first.harness, first.task);
    await within(firstEnv.effectStarted, 5_000);
    await waitForFile(secondModelRequest, 5_000);
    expect(readLines(effects)).toEqual(["effect"]);

    await within(first.harness.close(BACKGROUND_CONTEXT), 5_000);
    firstHarness = undefined;

    const recoveryEnv = new TestExecutionEnv(directory, effects, "complete");
    const recovered = await openHarness(database, recoveryEnv, [() => {
      logRequest(requests);
      return fauxAssistantMessage("completed after recovery");
    }]);
    recoveredHarness = recovered.harness;
    const settled = await within(recovered.harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    const result: AgentExecutionTaskResult = settled.state.outcome.result;
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("native task did not recover a final answer");
    expect(result.finalText).toBe("completed after recovery");
    expect(readLines(requests)).toEqual(["request", "request", "request"]);
    expect(readLines(effects)).toEqual(["effect"]);
    await closeHarness(recovered.harness);
    recoveredHarness = undefined;
  } finally {
    if (firstHarness !== undefined) await closeHarness(firstHarness).catch(() => undefined);
    if (recoveredHarness !== undefined) await closeHarness(recoveredHarness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same-round later unsafe call is blocked after its predecessor is interrupted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-sibling-interrupt-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  const calls = fauxAssistantMessage([
    fauxToolCall("bash", { command: firstToolCommand }, { id: "first-call" }),
    fauxToolCall("bash", { command: secondToolCommand }, { id: "second-call" }),
  ], { stopReason: "toolUse" });
  const firstEnv = new MultiToolExecutionEnv(directory, effects, "stall");
  let firstHarness: HarnessType | undefined;
  let recoveredHarness: HarnessType | undefined;
  try {
    const first = await openHarness(database, firstEnv, [() => {
      logRequest(requests);
      return calls;
    }]);
    firstHarness = first.harness;
    const taskId = await createExecution(first.harness, first.task, { promptText: "Use both tools." });
    await within(firstEnv.effectStarted, 5_000);
    await waitForCondition(async () => {
      const inspection = await first.harness.inspect(BACKGROUND_CONTEXT);
      const tools = inspection.tasks.filter(item => item.record.kind === "pi.tool");
      const phases = tools.map(item => checkpointPhase(item.record));
      return tools.length === 2 && phases.includes("execute") && tools.some(item => item.state.kind === "running" && checkpointPhase(item.record) === "call");
    }, 5_000, "the second tool to wait on its predecessor");
    expect(readLines(effects)).toEqual(["first"]);
    await within(first.harness.close(BACKGROUND_CONTEXT), 5_000);
    firstHarness = undefined;

    const recoveryEnv = new MultiToolExecutionEnv(directory, effects, "complete");
    const recovered = await openHarness(database, recoveryEnv, [() => {
      logRequest(requests);
      return fauxAssistantMessage("must not be requested after the interrupted tool");
    }]);
    recoveredHarness = recovered.harness;
    const beforeResume = await recovered.harness.inspect(BACKGROUND_CONTEXT);
    const reopenedTools = beforeResume.tasks.filter(item => item.record.kind === "pi.tool");
    expect(reopenedTools).toHaveLength(2);
    expect(reopenedTools.map(item => checkpointPhase(item.record)).sort()).toEqual(["call", "execute"]);
    const settled = await within(recovered.harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    const result: AgentExecutionTaskResult = settled.state.outcome.result;
    expect(result.kind).toBe("blocked");
    expect(readLines(requests)).toEqual(["request"]);
    expect(readLines(effects)).toEqual(["first"]);
    if (result.kind === "blocked") {
      const conversationId = result.conversationId as ConversationId;
      await recovered.harness.commit(async tx => {
        const guard = await tx.doc(AgentExecutionGuardDoc, conversationId);
        guard.state = "clear";
        guard.toolTaskIds = [];
        guard.reason = null;
      }, BACKGROUND_CONTEXT);
      expect(await recovered.guard.waitForResult(conversationId)).toEqual({ state: "clear" });
    }
    await within(closeHarness(recovered.harness), 5_000);
    recoveredHarness = undefined;
  } finally {
    if (firstHarness !== undefined) await closeHarness(firstHarness).catch(() => undefined);
    if (recoveredHarness !== undefined) await closeHarness(recoveredHarness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed same-round unsafe predecessor allows its later tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-sibling-complete-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  const env = new MultiToolExecutionEnv(directory, effects, "complete");
  let harness: HarnessType | undefined;
  try {
    const opened = await openHarness(database, env, [
      () => {
        logRequest(requests);
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: firstToolCommand }, { id: "first-call" }),
          fauxToolCall("bash", { command: secondToolCommand }, { id: "second-call" }),
        ], { stopReason: "toolUse" });
      },
      () => {
        logRequest(requests);
        return fauxAssistantMessage("both tools completed");
      },
    ]);
    harness = opened.harness;
    const taskId = await createExecution(harness, opened.task, { promptText: "Use both tools." });
    const settled = await within(harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    expect(settled.state.outcome.result.kind).toBe("completed");
    if (settled.state.outcome.result.kind === "completed") expect(settled.state.outcome.result.finalText).toBe("both tools completed");
    expect(readLines(requests)).toEqual(["request", "request"]);
    expect(readLines(effects)).toEqual(["first", "second"]);
    await within(closeHarness(harness), 5_000);
    harness = undefined;
  } finally {
    if (harness !== undefined) await closeHarness(harness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired persisted deadline before first submission returns timed_out without provider calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-deadline-expired-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  let clock = 100;
  let firstHarness: HarnessType | undefined;
  let recoveredHarness: HarnessType | undefined;
  try {
    const first = await openHarness(database, new TestExecutionEnv(directory, effects, "complete"), [() => {
      logRequest(requests);
      return fauxAssistantMessage("must not be requested");
    }], () => clock);
    firstHarness = first.harness;
    const taskId = await createExecution(first.harness, first.task, { deadlineAt: 200, resume: false });
    await within(closeHarness(first.harness), 5_000);
    firstHarness = undefined;

    clock = 201;
    const recovered = await openHarness(database, new TestExecutionEnv(directory, effects, "complete"), [() => {
      logRequest(requests);
      return fauxAssistantMessage("must not be requested after reopen");
    }], () => clock);
    recoveredHarness = recovered.harness;
    const record = await recovered.harness.getTask<AgentExecutionTaskResult>(taskId, BACKGROUND_CONTEXT);
    expect(record?.input).toMatchObject({ deadlineAt: 200 });
    const settled = await within(recovered.harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    expect(settled.state.outcome.result.kind).toBe("timed_out");
    expect(readLines(requests)).toEqual([]);
    expect(readLines(effects)).toEqual([]);
    await within(closeHarness(recovered.harness), 5_000);
    recoveredHarness = undefined;
  } finally {
    if (firstHarness !== undefined) await closeHarness(firstHarness).catch(() => undefined);
    if (recoveredHarness !== undefined) await closeHarness(recoveredHarness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deadline tool block settles as timed_out after afterTools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-tool-deadline-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  const providerStarted = deferred();
  const releaseResponse = deferred<void>();
  const env = new TestExecutionEnv(directory, effects, "complete");
  let harness: HarnessType | undefined;
  try {
    const deadlineAt = Date.now() + 60_000;
    const opened = await openHarness(database, env, [async () => {
      logRequest(requests);
      providerStarted.resolve();
      await releaseResponse.promise;
      return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    }]);
    harness = opened.harness;
    const taskId = await createExecution(harness, opened.task, { deadlineAt });
    await within(providerStarted.promise, 5_000);
    const record = await harness.getTask<AgentExecutionTaskResult>(taskId, BACKGROUND_CONTEXT);
    if (record?.state.status !== "running") throw new Error("native task is not waiting for the child submission");
    const checkpoint = record.state.checkpoint as { readonly phase?: string; readonly conversationId?: number };
    if (checkpoint.phase !== "await" || checkpoint.conversationId === undefined) throw new Error("native task has no child conversation");
    const childId = checkpoint.conversationId as ConversationId;
    await harness.commit(async tx => {
      const deadline = await tx.doc(DeadlineDocForTest, childId);
      deadline.deadlineAt = Date.now() - 1;
    }, BACKGROUND_CONTEXT);
    releaseResponse.resolve();
    const settled = await within(harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    expect(settled.state.outcome.result.kind).toBe("timed_out");
    if (settled.state.outcome.result.kind === "timed_out") expect(settled.state.outcome.result.deadlineAt).toBe(deadlineAt);
    expect(readLines(requests)).toEqual(["request"]);
    expect(readLines(effects)).toEqual([]);
    await within(closeHarness(harness), 5_000);
    harness = undefined;
  } finally {
    releaseResponse.resolve();
    if (harness !== undefined) await closeHarness(harness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guard integrity failure stays guard_failed when a tool is blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-guard-failure-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  const providerStarted = deferred();
  const releaseResponse = deferred<void>();
  const env = new TestExecutionEnv(directory, effects, "complete");
  let harness: HarnessType | undefined;
  try {
    const deadlineAt = Date.now() + 60_000;
    const opened = await openHarness(database, env, [async () => {
      logRequest(requests);
      providerStarted.resolve();
      await releaseResponse.promise;
      return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    }]);
    harness = opened.harness;
    const taskId = await createExecution(harness, opened.task, { deadlineAt });
    await within(providerStarted.promise, 5_000);
    const record = await harness.getTask<AgentExecutionTaskResult>(taskId, BACKGROUND_CONTEXT);
    if (record?.state.status !== "running") throw new Error("native task is not waiting for the child submission");
    const checkpoint = record.state.checkpoint as { readonly phase?: string; readonly conversationId?: number };
    if (checkpoint.phase !== "await" || checkpoint.conversationId === undefined) throw new Error("native task has no child conversation");
    const childId = checkpoint.conversationId as ConversationId;
    await harness.commit(async tx => {
      const deadline = await tx.doc(DeadlineDocForTest, childId);
      deadline.deadlineAt = Date.now() - 1;
      const guard = await tx.doc(AgentExecutionGuardDoc, childId);
      guard.state = "failed";
      guard.reason = "test guard integrity failure";
    }, BACKGROUND_CONTEXT);
    releaseResponse.resolve();
    const settled = await within(harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    expect(settled.state.outcome.result.kind).toBe("guard_failed");
    if (settled.state.outcome.result.kind === "guard_failed") expect(settled.state.outcome.result.reason).toBe("test guard integrity failure");
    expect(readLines(requests)).toEqual(["request"]);
    expect(readLines(effects)).toEqual([]);
    await within(closeHarness(harness), 5_000);
    harness = undefined;
  } finally {
    releaseResponse.resolve();
    if (harness !== undefined) await closeHarness(harness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("final answer stays recoverable after the deadline expires", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-native-agent-final-deadline-"));
  const database = join(directory, "durable.db");
  const effects = join(directory, "effects.log");
  const requests = join(directory, "requests.log");
  let clock = 1_000;
  let firstHarness: HarnessType | undefined;
  let recoveredHarness: HarnessType | undefined;
  try {
    const first = await openHarness(database, new TestExecutionEnv(directory, effects, "complete"), [() => {
      logRequest(requests);
      return fauxAssistantMessage("committed before reopen");
    }], () => clock);
    firstHarness = first.harness;
    const taskId = await createExecution(first.harness, first.task, { deadlineAt: 5_000 });
    const settled = await within(first.harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(settled.state.outcome.status).toBe("completed");
    if (settled.state.outcome.status !== "completed") throw new Error("native task did not settle");
    expect(settled.state.outcome.result.kind).toBe("completed");
    if (settled.state.outcome.result.kind === "completed") expect(settled.state.outcome.result.finalText).toBe("committed before reopen");
    clock = 5_001;
    await within(closeHarness(first.harness), 5_000);
    firstHarness = undefined;

    const recovered = await openHarness(database, new TestExecutionEnv(directory, effects, "complete"), [() => {
      logRequest(requests);
      return fauxAssistantMessage("must not be requested after the deadline");
    }], () => clock);
    recoveredHarness = recovered.harness;
    const replayed = await within(recovered.harness.waitForTask(taskId, BACKGROUND_CONTEXT), 5_000);
    expect(replayed.state.outcome.status).toBe("completed");
    if (replayed.state.outcome.status !== "completed") throw new Error("native task result is unavailable");
    expect(replayed.state.outcome.result.kind).toBe("completed");
    if (replayed.state.outcome.result.kind === "completed") expect(replayed.state.outcome.result.finalText).toBe("committed before reopen");
    expect(readLines(requests)).toEqual(["request"]);
    await within(closeHarness(recovered.harness), 5_000);
    recoveredHarness = undefined;
  } finally {
    if (firstHarness !== undefined) await closeHarness(firstHarness).catch(() => undefined);
    if (recoveredHarness !== undefined) await closeHarness(recoveredHarness).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

class MultiToolExecutionEnv extends NodeExecutionEnv {
  readonly effectStarted: Promise<void>;
  #start!: () => void;
  #mode: "stall" | "complete";
  #effects: string;

  constructor(cwd: string, effects: string, mode: "stall" | "complete") {
    super({ cwd });
    this.#effects = effects;
    this.#mode = mode;
    this.effectStarted = new Promise(resolve => { this.#start = resolve; });
  }

  override async exec(commandText: string, options: ShellExecOptions | undefined, context: Context) {
    if (commandText !== firstToolCommand && commandText !== secondToolCommand) return await super.exec(commandText, options, context);
    const label = commandText === firstToolCommand ? "first" : "second";
    appendFileSync(this.#effects, label + String.fromCharCode(10));
    this.#start();
    if (this.#mode === "stall" && commandText === firstToolCommand) {
      await waitForAbort(context.abortSignal);
      return err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "simulated first tool cancelled"));
    }
    return ok<ShellExecResult, ExecutionError>({ exitCode: 0 });
  }
}

class TestExecutionEnv extends NodeExecutionEnv {
  readonly effectStarted: Promise<void>;
  #start!: () => void;
  #mode: "stall" | "complete";
  #effects: string;

  constructor(cwd: string, effects: string, mode: "stall" | "complete") {
    super({ cwd });
    this.#effects = effects;
    this.#mode = mode;
    this.effectStarted = new Promise(resolve => { this.#start = resolve; });
  }

  override async exec(commandText: string, options: ShellExecOptions | undefined, context: Context) {
    if (commandText !== command) return await super.exec(commandText, options, context);
    appendFileSync(this.#effects, "effect" + String.fromCharCode(10));
    this.#start();
    if (this.#mode === "stall") {
      await waitForAbort(context.abortSignal);
      return err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "simulated bash cancelled"));
    }
    return ok<ShellExecResult, ExecutionError>({ exitCode: 0 });
  }
}

async function openHarness(
  database: string,
  env: NodeExecutionEnv,
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  now?: () => number,
) {
  const storage = await openDurableStorage(database);
  if (!storage.ok) throw new Error(storage.failure.message);
  const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  let harness: HarnessType;
  const { task, guard } = defineAgentExecutionTask({ getHarness: () => harness });
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(guard.extension);
  registry.install(defineExtension({ name: "workshop-agent-execution-task", tasks: [task] }));
  harness = await Harness.open(storage.storage, { models, registry, env: () => env, ...(now === undefined ? {} : { now }) }, BACKGROUND_CONTEXT);
  return { harness, task, guard, faux };
}

async function createExecution(
  harness: HarnessType,
  task: ReturnType<typeof defineAgentExecutionTask>["task"],
  options: { readonly deadlineAt?: number | null; readonly promptText?: string; readonly resume?: boolean } = {},
): Promise<TaskId<AgentExecutionTaskResult>> {
  const owner = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const input: AgentExecutionTaskInput = {
    executionId,
    role: "worker",
    model: { ...model, thinkingLevel: "off" },
    cwd: process.cwd(),
    shellPath: null,
    promptText: options.promptText ?? "Use bash once.",
    env: {},
    startedAt: Date.now(),
    deadlineAt: options.deadlineAt ?? null,
  };
  const taskId = await harness.commit(tx => tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId: owner.id }), BACKGROUND_CONTEXT);
  if (options.resume !== false) harness.resume();
  return taskId;
}

function logRequest(path: string): void {
  appendFileSync(path, "request" + String.fromCharCode(10));
}

async function closeHarness(harness: HarnessType): Promise<void> {
  await harness.close(BACKGROUND_CONTEXT);
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean) : [];
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function waitForCondition(check: () => Promise<boolean>, milliseconds: number, description: string): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for " + description);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function checkpointPhase(record: { readonly state: unknown }): string | undefined {
  const state = record.state as { readonly checkpoint?: { readonly phase?: unknown } };
  return typeof state.checkpoint?.phase === "string" ? state.checkpoint.phase : undefined;
}

async function waitForFile(path: string, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for " + path);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) throw new Error("expected an abort signal");
  if (signal.aborted) return;
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test timed out")), milliseconds); }),
  ]).finally(() => clearTimeout(timer!));
}

test("synthetic afterTools hook observes its durable abort mark", async () => {
  const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("synthetic_unsafe", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("must not be requested"),
  ]);
  const joins: Promise<unknown>[] = [];
  let harness: HarnessType | undefined;
  const tools = defineExtension({
    name: "native-agent-synthetic-proof-tools",
    tools: [defineTool({
      name: "synthetic_unsafe",
      description: "Return a synthetic interrupted diagnostic.",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: async () => ({ isError: true, diagnostics: [{ severity: "error" as const, code: "interrupted", message: "synthetic interruption" }] }),
    })],
  });
  const guard = defineExtension({
    name: "native-agent-synthetic-proof-guard",
    hooks: [hook(GenerationTask, {
      afterTools: async (_assistant, resultIds, api) => {
        const active = harness;
        if (active === undefined) throw new Error("synthetic proof harness is unavailable");
        const conversation = await active.conversation(api.conversationId, BACKGROUND_CONTEXT);
        if (conversation === undefined) throw new Error("synthetic proof conversation is unavailable");
        const interrupted = await Promise.all(resultIds.map(async id => {
          const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND_CONTEXT);
          const entry = page.items[0];
          return ToolResultEntry.is(entry) && entry.data.diagnostics.some(item => item.code === "interrupted");
        }));
        if (!interrupted.some(Boolean)) return;
        const watch = await active.watchTaskGraph(BACKGROUND_CONTEXT);
        const key = String(api.taskId);
        let release!: () => void;
        const marked = new Promise<void>(resolve => { release = resolve; });
        const check = (graph: typeof watch.value) => { if (graph.tasks[key]?.abortRequested === true) release(); };
        watch.start(async graph => { check(graph); });
        check(watch.value);
        const join = active.abortTask(api.taskId, BACKGROUND_CONTEXT);
        joins.push(join);
        void join.catch(() => undefined);
        try { await marked; } finally { await watch.stop(); }
      },
    })],
  });
  const registry = createRegistry();
  registry.install(tools);
  registry.install(guard);
  harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, extensions: [tools, guard] } }, BACKGROUND_CONTEXT);
    const submission = await conversation.submit({ type: "input", content: "Invoke one synthetic tool.", requestId: "synthetic-native-agent-proof" }, BACKGROUND_CONTEXT);
    expect((await within(submission.wait(BACKGROUND_CONTEXT), 5_000)).status).toBe("unanswered");
    await within(Promise.all(joins), 5_000);
    expect(faux.state.callCount).toBe(1);
  } finally {
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);
  }
});
