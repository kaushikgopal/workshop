import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, UserEntry, configure, defineDoc, defineExtension, defineTask, GenerationTask, hook, Harness, type ConversationId, type EntryId, type Extension, type Task, type TaskId, type TaskRuntime, type Conversation, type Cursor } from "@earendil-works/pi-durable";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ToolTask, type ToolTaskInput, type ToolTaskResult, AgentDoc as AgentExecutionAgentDoc } from "@earendil-works/pi-durable";
import { z } from "zod";

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const maximumSemanticOutputBytes = 1024 * 1024;
const requestIdFor = (executionId: string) => "workshop.agent-execution:" + executionId;
const guardExtensionName = "workshop-agent-execution-guard";

export const AgentExecutionEnvironmentDoc = defineDoc<{
  state: "ready";
  values: Record<string, string>;
  shellPath: string | null;
}>({
  kind: "workshop.agent-execution-environment",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ state: "ready", values: {}, shellPath: null }),
});

const AgentExecutionDeadlineDoc = defineDoc<{ deadlineAt: number | null }>({
  kind: "workshop.agent-execution-deadline",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ deadlineAt: null }),
});

export const AgentExecutionGuardDoc = defineDoc<{
  state: "clear" | "blocked" | "failed" | "timed_out";
  toolTaskIds: number[];
  reason: string | null;
}>({
  kind: "workshop.agent-execution-guard-state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ state: "clear", toolTaskIds: [], reason: null }),
});

export const agentExecutionTaskInputSchema = z.strictObject({
  executionId: z.string().uuid(),
  role: z.enum(["worker", "verifier"]),
  model: z.strictObject({ provider: z.string().min(1), modelId: z.string().min(1), thinkingLevel: z.string().min(1) }),
  cwd: z.string().min(1),
  shellPath: z.string().min(1).nullable(),
  promptText: z.string(),
  env: z.record(z.string(), z.string()),
  startedAt: z.number().int().nonnegative().refine(Number.isSafeInteger),
  deadlineAt: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
});
export type AgentExecutionTaskInput = z.infer<typeof agentExecutionTaskInputSchema>;

const agentExecutionCheckpointSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("prepare") }),
  z.strictObject({ phase: z.literal("await"), conversationId: positive, requestId: z.string().min(1) }),
]);
type AgentExecutionCheckpoint = z.infer<typeof agentExecutionCheckpointSchema>;

export const agentExecutionTaskResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("completed"), executionId: z.string().uuid(), conversationId: positive,
    requestId: z.string().min(1), assistantEntryId: positive, finalText: z.string(),
    finalTextSha256: sha256Schema, startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("too_large"), executionId: z.string().uuid(), conversationId: positive,
    requestId: z.string().min(1), assistantEntryId: positive, byteCount: positive, finalTextSha256: sha256Schema,
    startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("blocked"), executionId: z.string().uuid(), conversationId: positive,
    requestId: z.string().min(1), reason: z.literal("unsafe_tool_interrupted"),
    toolTaskIds: z.array(positive), startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("guard_failed"), executionId: z.string().uuid(), conversationId: z.number().int().positive().nullable(),
    requestId: z.string().min(1), reason: z.string().min(1), startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("failed"), executionId: z.string().uuid(), conversationId: z.number().int().positive().nullable(),
    requestId: z.string().min(1), reason: z.string().min(1), startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("timed_out"), executionId: z.string().uuid(), conversationId: positive,
    requestId: z.string().min(1), deadlineAt: z.number().int().nonnegative(), startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("cancelled"), executionId: z.string().uuid(), conversationId: z.number().int().positive().nullable(),
    requestId: z.string().min(1), startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(),
  }),
]);
export type AgentExecutionTaskResult = z.infer<typeof agentExecutionTaskResultSchema>;
export type AgentExecutionTaskDefinition = Task<AgentExecutionTaskInput, AgentExecutionCheckpoint, AgentExecutionTaskResult, object>;

export type AgentExecutionGuardState =
  | { readonly state: "clear" }
  | { readonly state: "blocked"; readonly toolTaskIds: readonly number[] }
  | { readonly state: "failed"; readonly reason: string };

type InternalAgentExecutionGuardState = AgentExecutionGuardState
  | { readonly state: "timed_out" };

export interface AgentExecutionGuard {
  readonly extension: Extension;
  waitForResult(conversationId: ConversationId): Promise<AgentExecutionGuardState>;
}

export function defineAgentExecutionTask(options: { readonly getHarness: () => Harness }): {
  readonly task: AgentExecutionTaskDefinition;
  readonly guard: AgentExecutionGuard;
} {
  const guardResults = new Map<number, InternalAgentExecutionGuardState>();
  const waitForGuardResult = async (conversationId: ConversationId): Promise<InternalAgentExecutionGuardState> => {
    const key = Number(conversationId);
    const tracked = guardResults.get(key);
    if (tracked !== undefined) {
      guardResults.delete(key);
      return tracked;
    }
    try {
      const saved = await options.getHarness().snapshot(AgentExecutionGuardDoc, conversationId, BACKGROUND_CONTEXT);
      if (saved === undefined) return { state: "failed", reason: "guard state is unavailable" };
      if (saved.state === "clear") return { state: "clear" };
      if (saved.state === "blocked") return { state: "blocked", toolTaskIds: saved.toolTaskIds };
      if (saved.state === "failed") return { state: "failed", reason: saved.reason ?? "guard integrity failure" };
      return { state: "timed_out" };
    } catch (error) {
      return { state: "failed", reason: "guard result read failed: " + safeError(error) };
    }
  };
  const extension = defineExtension({
    name: guardExtensionName,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const harness = options.getHarness();
          try {
            const saved = await harness.snapshot(AgentExecutionGuardDoc, api.conversationId, context);
            if (saved === undefined) throw new Error("guard state is unavailable");
            if (saved.state === "blocked") return { block: "an earlier unsafe tool was interrupted" };
            if (saved.state === "failed") return { block: "the unsafe-tool guard could not verify prior tool evidence" };
            if (saved.state === "timed_out") return { block: "agent execution deadline expired" };
            const deadline = await harness.snapshot(AgentExecutionDeadlineDoc, api.conversationId, context);
            if (deadline === undefined) throw new Error("agent deadline record is unavailable");
            if (deadline.deadlineAt !== null && Date.now() >= deadline.deadlineAt) {
              // The tool result records only that a hook blocked it, so preserve the deadline cause here.
              await saveGuardState(harness, api.conversationId, { state: "timed_out" }, context);
              return { block: "agent execution deadline expired" };
            }

            const task = await harness.getTask<ToolTaskResult>(api.taskId as TaskId<ToolTaskResult>, context);
            if (task?.kind !== ToolTask.definition.name) throw new Error("current tool task is unavailable");
            const toolInput = task.input as unknown as ToolTaskInput;
            await waitForEarlierTools(harness, api.conversationId, api.taskId, context);
            const interrupted = await readInterruptedEarlierTools(harness, api.conversationId, toolInput.assistant, call.id);
            if (interrupted.length > 0) {
              const state: AgentExecutionGuardState = { state: "blocked", toolTaskIds: interrupted.map(item => Number(item.taskId)) };
              await saveGuardState(harness, api.conversationId, state, context);
              return { block: "an earlier unsafe tool was interrupted" };
            }
            const latest = await harness.snapshot(AgentExecutionGuardDoc, api.conversationId, context);
            if (latest === undefined) throw new Error("guard state is unavailable");
            if (latest.state === "blocked") return { block: "an earlier unsafe tool was interrupted" };
            if (latest.state === "failed") return { block: "the unsafe-tool guard could not verify prior tool evidence" };
            if (latest.state === "timed_out") return { block: "agent execution deadline expired" };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            const failed: AgentExecutionGuardState = { state: "failed", reason: "guard verification failed: " + safeError(error) };
            await saveGuardState(harness, api.conversationId, failed, BACKGROUND_CONTEXT).catch(() => undefined);
            return { block: "guard verification failed" };
          }
        },
      }),
      hook(GenerationTask, {
        afterTools: async (_assistant, resultIds, api, context) => {
          const harness = options.getHarness();
          const key = Number(api.conversationId);
          let result: InternalAgentExecutionGuardState;
          try {
            const saved = await harness.snapshot(AgentExecutionGuardDoc, api.conversationId, context);
            if (saved === undefined) throw new Error("guard state is unavailable");
            const interrupted = await readInterruptedUnsafeTools(harness, api.conversationId, resultIds);
            const blocked = await hasBlockedToolResult(harness, api.conversationId, resultIds);
            if (saved.state === "failed") result = { state: "failed", reason: saved.reason ?? "guard integrity failure" };
            else if (saved.state === "blocked" || interrupted.length > 0) {
              result = {
                state: "blocked",
                toolTaskIds: saved.state === "blocked" ? saved.toolTaskIds : interrupted.map(item => Number(item.taskId)),
              };
            } else if (saved.state === "timed_out") result = { state: "timed_out" };
            else if (blocked) result = { state: "failed", reason: "guard or deadline blocked a tool call" };
            else result = { state: "clear" };
          } catch (error) {
            result = { state: "failed", reason: safeError(error) };
          }
          if (result.state === "clear") return;

          guardResults.set(key, result);
          try {
            await saveGuardState(harness, api.conversationId, result, context);
          } catch (error) {
            result = { state: "failed", reason: "guard evidence commit failed: " + safeError(error) };
            guardResults.set(key, result);
          }
          try {
            const { join } = await commitAbortMark(harness, api.taskId);
            const tracked = result;
            const cleanup = () => { if (guardResults.get(key) === tracked) guardResults.delete(key); };
            void join.then(cleanup, cleanup);
          } catch (error) {
            guardResults.delete(key);
            throw error;
          }
        },
      }),
    ],
  });
  const guard: AgentExecutionGuard = {
    extension,
    async waitForResult(conversationId) {
      const result = await waitForGuardResult(conversationId);
      return result.state === "timed_out" ? { state: "failed", reason: "agent execution deadline expired" } : result;
    },
  };

  const task = defineTask<AgentExecutionTaskInput, AgentExecutionCheckpoint, AgentExecutionTaskResult>({
    name: "workshop.agent-execution",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (task, runtime, context) => {
        const input = agentExecutionTaskInputSchema.parse(task.input);
        const requestId = requestIdFor(input.executionId);
        await runtime.commit(async tx => {
          const record = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
          await configure(tx, record.id, {
            model: { provider: input.model.provider, modelId: input.model.modelId },
            thinkingLevel: input.model.thinkingLevel as ModelThinkingLevel,
            extensions: [CodingTools, extension],
            tools: CodingTools.tools,
            cwd: input.cwd,
          });
          const env = await tx.doc(AgentExecutionEnvironmentDoc, record.id);
          Object.assign(env, { values: { ...input.env }, shellPath: input.shellPath });
          const deadline = await tx.doc(AgentExecutionDeadlineDoc, record.id);
          deadline.deadlineAt = input.deadlineAt;
          const guard = await tx.doc(AgentExecutionGuardDoc, record.id);
          Object.assign(guard, { state: "clear", toolTaskIds: [], reason: null });
          return { status: "running", checkpoint: { phase: "await", conversationId: Number(record.id), requestId } };
        }, context);
      },
      await: async (task, runtime, context) => {
        const input = agentExecutionTaskInputSchema.parse(task.input);
        const checkpoint = agentExecutionCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "await") throw new Error("agent execution checkpoint lacks its conversation");
        const conversationId = checkpoint.conversationId as ConversationId;
        const conversation = await runtime.conversation(conversationId, context);
        if (conversation === undefined) {
          await settle(runtime, input, checkpoint, { kind: "failed", reason: "owned agent conversation is unavailable" }, context);
          return;
        }
        const child = await options.getHarness().conversation(conversationId, BACKGROUND_CONTEXT);
        if (child === undefined) {
          await settle(runtime, input, checkpoint, { kind: "failed", reason: "owned agent transcript is unavailable" }, context);
          return;
        }
        let existingPrompt = await hasPromptEntry(child, input.promptText);
        const expired = input.deadlineAt !== null && runtime.now() >= input.deadlineAt;
        if (expired && !existingPrompt) {
          await conversation.abort(context, { background: true });
          await settle(runtime, input, checkpoint, { kind: "timed_out", deadlineAt: input.deadlineAt! }, context);
          return;
        }
        const submission = await conversation.submit({
          type: "input", content: input.promptText, requestId: checkpoint.requestId, whenBusy: "reject",
        }, context);
        const status = await submission.status(context);
        let settled;
        if (status.status === "done" || status.status === "unanswered") settled = status;
        else if (input.deadlineAt !== null && runtime.now() >= input.deadlineAt && !(await hasCommittedFinalAnswer(child, input.promptText))) {
          await conversation.abort(context, { background: true });
          await settle(runtime, input, checkpoint, { kind: "timed_out", deadlineAt: input.deadlineAt }, context);
          return;
        } else {
          const answer = submission.wait(context).then(value => ({ kind: "settled" as const, value }));
          const timeout = input.deadlineAt === null || expired ? undefined
            : runtime.sleep(input.deadlineAt, context).then(() => ({ kind: "timeout" as const }));
          const result = timeout === undefined ? await answer : await Promise.race([answer, timeout]);
          if (result.kind === "timeout" && !(await hasCommittedFinalAnswer(child, input.promptText))) {
            await conversation.abort(context, { background: true });
            await settle(runtime, input, checkpoint, { kind: "timed_out", deadlineAt: input.deadlineAt! }, context);
            return;
          }
          settled = result.kind === "settled" ? result.value : await submission.status(context);
        }
        if (input.deadlineAt !== null && runtime.now() >= input.deadlineAt && !(await hasCommittedFinalAnswer(child, input.promptText))) {
          await conversation.abort(context, { background: true });
          await settle(runtime, input, checkpoint, { kind: "timed_out", deadlineAt: input.deadlineAt }, context);
          return;
        }
        if (settled.status !== "done" || settled.type !== "input") {
          const state = await waitForGuardResult(conversationId);
          if (state.state === "timed_out") {
            if (input.deadlineAt === null) {
              await settle(runtime, input, checkpoint, { kind: "guard_failed", reason: "deadline guard state has no execution deadline" }, context);
            } else {
              await settle(runtime, input, checkpoint, { kind: "timed_out", deadlineAt: input.deadlineAt }, context);
            }
            return;
          }
          if (state.state === "blocked") {
            await settle(runtime, input, checkpoint, { kind: "blocked", reason: "unsafe_tool_interrupted", toolTaskIds: state.toolTaskIds }, context);
            return;
          }
          if (state.state === "failed") {
            await settle(runtime, input, checkpoint, { kind: "guard_failed", reason: state.reason }, context);
            return;
          }
          await settle(runtime, input, checkpoint, { kind: "failed", reason: "agent submission ended without a final answer" }, context);
          return;
        }
        const page = await child.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, BACKGROUND_CONTEXT);
        const entry = page.items[0];
        const message = entry !== undefined && AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
        if (entry === undefined || message?.role !== "assistant") {
          await settle(runtime, input, checkpoint, { kind: "failed", reason: "final assistant entry is unavailable" }, context);
          return;
        }
        const guardState = await waitForGuardResult(conversationId);
        if (guardState.state === "blocked") {
          await settle(runtime, input, checkpoint, { kind: "blocked", reason: "unsafe_tool_interrupted", toolTaskIds: guardState.toolTaskIds }, context);
          return;
        }
        if (guardState.state === "failed") {
          await settle(runtime, input, checkpoint, { kind: "guard_failed", reason: guardState.reason }, context);
          return;
        }
        const finalText = message.content.filter(block => block.type === "text").map(block => block.text).join("");
        const bytes = Buffer.from(finalText, "utf8");
        const finalTextSha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
        await settle(runtime, input, checkpoint, bytes.byteLength > maximumSemanticOutputBytes
          ? { kind: "too_large", assistantEntryId: Number(entry.id), byteCount: bytes.byteLength, finalTextSha256 }
          : { kind: "completed", assistantEntryId: Number(entry.id), finalText, finalTextSha256 }, context);
      },
    },
    abort: async (task, runtime, context) => {
      const input = agentExecutionTaskInputSchema.parse(task.input);
      const checkpoint = agentExecutionCheckpointSchema.parse(task.state.checkpoint);
      const conversationId = checkpoint.phase === "await" ? checkpoint.conversationId : null;
      const requestId = checkpoint.phase === "await" ? checkpoint.requestId : requestIdFor(input.executionId);
      const result = agentExecutionTaskResultSchema.parse({
        kind: "cancelled", executionId: input.executionId, conversationId, requestId,
        startedAt: input.startedAt, finishedAt: runtime.now(),
      });
      await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted", result } }), context);
    },
  });
  return { task, guard };
}

export async function buildAgentExecutionEnvironment(target: EnvTarget, context: Context): Promise<NodeExecutionEnv | undefined> {
  const agent = await target.read.snapshot(AgentExecutionAgentDoc, target.conversationId, context);
  const selected = agent?.extensions;
  if (!Array.isArray(selected) || selected.length !== 2 || !selected.includes(CodingTools.name) || !selected.includes(guardExtensionName)) return undefined;
  const saved = await target.read.snapshot(AgentExecutionEnvironmentDoc, target.conversationId, context);
  return new NodeExecutionEnv({
    cwd: target.cwd ?? process.cwd(),
    shellPath: saved?.shellPath ?? undefined,
    shellEnv: { ...process.env, ...(saved?.values ?? {}) },
  });
}

async function commitAbortMark(harness: Harness, taskId: TaskId): Promise<{ join: Promise<unknown> }> {
  const watch = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
  const key = String(taskId);
  let marked = false;
  let resolveMark!: () => void;
  let rejectMark!: (error: unknown) => void;
  const markedPromise = new Promise<void>((resolve, reject) => { resolveMark = resolve; rejectMark = reject; });
  const check = (graph: typeof watch.value) => {
    if (graph.tasks[key]?.abortRequested === true) {
      marked = true;
      resolveMark();
    } else if (graph.tasks[key] === undefined && !marked) {
      rejectMark(new Error("generation left the task graph before its abort mark committed"));
    }
  };
  watch.start(async graph => { check(graph); });
  check(watch.value);
  const joined = harness.abortTask(taskId, BACKGROUND_CONTEXT).then(result => {
    if (result === "terminal" && !marked) rejectMark(new Error("generation became terminal before its abort mark committed"));
    return result;
  }, error => {
    rejectMark(error);
    throw error;
  });
  void joined.catch(() => undefined);
  const closed = watch.closed.then(end => {
    if (!marked) rejectMark(new Error("abort watcher closed before the durable abort mark: " + end.reason));
  });
  void closed.catch(() => undefined);
  try {
    await markedPromise;
    return { join: joined };
  } finally {
    await watch.stop();
  }
}

async function waitForEarlierTools(harness: Harness, conversationId: ConversationId, currentTaskId: TaskId, context: Context): Promise<void> {
  const watch = await harness.watchTaskGraph(context);
  const current = Number(currentTaskId);
  const earlierIds = Object.values(watch.value.tasks)
    .filter(node => node.kind === "pi.tool" && node.conversationId === conversationId && Number(node.id) < current)
    .map(node => node.id);
  const earlier = earlierIds.map(String);
  if (earlier.length === 0) {
    await watch.stop();
    return;
  }
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const check = (graph: typeof watch.value) => {
    if (earlier.every(id => graph.tasks[id] === undefined)) {
      settled = true;
      resolve();
    }
  };
  watch.start(async graph => { check(graph); });
  check(watch.value);
  const closed = watch.closed.then(end => {
    if (!settled) reject(new Error("tool-order watch closed before predecessors settled: " + end.reason));
  });
  void closed.catch(() => undefined);
  try {
    await done;
  } finally {
    await watch.stop();
  }
}

async function saveGuardState(
  harness: Harness,
  conversationId: ConversationId,
  state: InternalAgentExecutionGuardState,
  context: Context,
): Promise<void> {
  await harness.commit(async tx => {
    const saved = await tx.doc(AgentExecutionGuardDoc, conversationId);
    saved.state = state.state;
    saved.toolTaskIds = state.state === "blocked" ? [...state.toolTaskIds] : [];
    saved.reason = state.state === "failed" ? state.reason : null;
  }, context);
}

async function readInterruptedEarlierTools(
  harness: Harness,
  conversationId: ConversationId,
  assistantId: EntryId,
  currentCallId: string,
): Promise<Array<{ taskId: TaskId; entryId: EntryId }>> {
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("guard conversation is unavailable");
  const assistantPage = await conversation.entries({ minEntryId: assistantId, maxEntryId: assistantId }, 1, undefined, BACKGROUND_CONTEXT);
  const assistant = assistantPage.items[0];
  const message = assistant !== undefined && AssistantEntry.is(assistant) ? assistant.model?.[0] : undefined;
  if (message?.role !== "assistant") throw new Error("tool round assistant entry is unavailable");
  const calls = message.content.filter(block => block.type === "toolCall");
  const index = calls.findIndex(call => call.id === currentCallId);
  if (index < 0) throw new Error("current call is missing from its assistant entry");
  const earlierCalls = new Set(calls.slice(0, index).map(call => call.id));
  if (earlierCalls.size === 0) return [];

  const receipts: Array<{ taskId: TaskId; entryId: EntryId }> = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ minEntryId: assistantId }, 256, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (!ToolResultEntry.is(entry)) continue;
      const result = entry.model?.[0];
      if (result?.role !== "toolResult" || !earlierCalls.delete(result.toolCallId)) continue;
      if (entry.byTaskId === undefined) continue;
      const receipt = await readInterruptedUnsafeTool(harness, conversationId, entry.byTaskId);
      if (receipt !== undefined && receipt.entryId === entry.id) receipts.push(receipt);
    }
    cursor = page.next;
  } while (cursor !== undefined && earlierCalls.size > 0);
  if (earlierCalls.size > 0) throw new Error("an earlier tool result is unavailable");
  return receipts;
}

async function hasBlockedToolResult(
  harness: Harness,
  conversationId: ConversationId,
  resultIds: readonly EntryId[],
): Promise<boolean> {
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("guard conversation is unavailable");
  for (const entryId of resultIds) {
    const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, BACKGROUND_CONTEXT);
    const entry = page.items[0];
    if (entry !== undefined && ToolResultEntry.is(entry) && entry.data.diagnostics.some(diagnostic => diagnostic.code === "blocked")) return true;
  }
  return false;
}

async function readInterruptedUnsafeTools(
  harness: Harness,
  conversationId: ConversationId,
  resultIds: readonly EntryId[],
): Promise<Array<{ taskId: TaskId; entryId: EntryId }>> {
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("guard conversation is unavailable");
  const found: Array<{ taskId: TaskId; entryId: EntryId }> = [];
  for (const entryId of resultIds) {
    const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, BACKGROUND_CONTEXT);
    const entry = page.items[0];
    if (entry === undefined || !ToolResultEntry.is(entry) || entry.byTaskId === undefined) continue;
    const receipt = await readInterruptedUnsafeTool(harness, conversationId, entry.byTaskId);
    if (receipt !== undefined && receipt.entryId === entry.id) found.push(receipt);
  }
  return found;
}

async function readInterruptedUnsafeTool(
  harness: Harness,
  conversationId: ConversationId,
  taskId: TaskId,
): Promise<{ taskId: TaskId; entryId: EntryId } | undefined> {
  const task = await harness.getTask<ToolTaskResult>(taskId as TaskId<ToolTaskResult>, BACKGROUND_CONTEXT);
  if (task?.kind !== ToolTask.definition.name || task.state.status !== "terminal" || task.state.outcome.status !== "failed") return undefined;
  const result = task.state.outcome.result;
  if (result === undefined) throw new Error("failed tool task has no durable result receipt");
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("guard conversation is unavailable");
  const page = await conversation.entries({ minEntryId: result.entryId, maxEntryId: result.entryId }, 1, undefined, BACKGROUND_CONTEXT);
  const entry = page.items[0];
  if (entry === undefined || !ToolResultEntry.is(entry) || entry.byTaskId !== taskId) throw new Error("failed tool result receipt is unavailable");
  const message = entry.model?.[0];
  if (message?.role !== "toolResult") throw new Error("failed tool result has no tool identity");
  const expected = "Tool " + message.toolName + " was interrupted and may have partially run";
  if (task.state.outcome.error.message !== expected) return undefined;
  if (!entry.data.diagnostics.some(diagnostic => diagnostic.code === "interrupted")) throw new Error("interrupted tool result lacks its diagnostic");
  return { taskId, entryId: entry.id };
}

async function hasPromptEntry(conversation: Conversation, promptText: string): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT);
    if (page.items.some(entry => UserEntry.is(entry) && entry.model?.some(message => message.role === "user" && userText(message.content) === promptText))) return true;
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

async function hasCommittedFinalAnswer(conversation: Conversation, promptText: string): Promise<boolean> {
  let cursor: Cursor | undefined;
  let finalAfterPrompt = false;
  do {
    const page = await conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (UserEntry.is(entry) && entry.model?.some(message => message.role === "user" && userText(message.content) === promptText)) return finalAfterPrompt;
      if (!AssistantEntry.is(entry)) continue;
      const message = entry.model?.[0];
      if (message?.role === "assistant" && message.stopReason === "stop" && !message.content.some(block => block.type === "toolCall")) finalAfterPrompt = true;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null
    && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map(block => block.text).join("");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settle(
  runtime: TaskRuntime<AgentExecutionTaskInput, AgentExecutionCheckpoint, AgentExecutionTaskResult, object>,
  input: AgentExecutionTaskInput,
  checkpoint: Extract<AgentExecutionCheckpoint, { phase: "await" }>,
  result: { kind: "completed"; assistantEntryId: number; finalText: string; finalTextSha256: string }
    | { kind: "too_large"; assistantEntryId: number; byteCount: number; finalTextSha256: string }
    | { kind: "blocked"; reason: "unsafe_tool_interrupted"; toolTaskIds: readonly number[] }
    | { kind: "guard_failed" | "failed"; reason: string }
    | { kind: "timed_out"; deadlineAt: number },
  context: Context,
): Promise<void> {
  const taskResult = agentExecutionTaskResultSchema.parse({
    ...result,
    executionId: input.executionId,
    conversationId: checkpoint.conversationId,
    requestId: checkpoint.requestId,
    startedAt: input.startedAt,
    finishedAt: runtime.now(),
  });
  await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: taskResult } }), context);
}
