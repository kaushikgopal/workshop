import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationHandle,
  type ConversationId,
  type Submission,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { blockInfoV2Schema, judgmentDecisionV2Schema, runIdV2Schema, type JudgmentDecisionV2 } from "../../run/schema-v2.js";
import {
  persistedJudgmentV2Schema,
  workflowRunDocumentV1Schema,
  workshopJudgmentV1Schema,
  type PersistedJudgmentV2,
  type WorkflowRunDocumentV1,
} from "../../run/records-v2.js";
import { WorkshopJudgmentEntry, WorkshopRunDoc } from "./define-workshop-records.js";

const FAILURE_JUDGMENT_TASK_NAME = "workshop.failure-judgment";
const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const boundedPromptSchema = z.string().max(2 * 1024 * 1024);

export const failureJudgmentTaskInputV2Schema = z.strictObject({
  runId: runIdV2Schema,
  runConversationId: positiveSafeInteger,
  workflowTaskId: positiveSafeInteger,
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
  judgmentId: z.string().min(1),
  submissionRequestId: z.string().min(1),
  modelProvider: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  prompt: boundedPromptSchema,
  deadlineAt: z.string().datetime().nullable(),
  allowedActions: z.array(z.enum(["retry", "block", "fail"])).nonempty(),
});
export type FailureJudgmentTaskInputV2 = z.infer<typeof failureJudgmentTaskInputV2Schema>;

export const failureJudgmentTaskResultV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decided"), decision: judgmentDecisionV2Schema }),
  z.strictObject({ kind: z.literal("failed"), block: blockInfoV2Schema }),
]);
export type FailureJudgmentTaskResultV2 = z.infer<typeof failureJudgmentTaskResultV2Schema>;

const failureJudgmentCheckpointV2Schema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("createConversation") }),
  z.strictObject({ phase: z.literal("submit"), conversationId: positiveSafeInteger }),
  z.strictObject({ phase: z.literal("awaitSubmission"), conversationId: positiveSafeInteger, submissionId: positiveSafeInteger }),
]);
type FailureJudgmentCheckpointV2 = z.infer<typeof failureJudgmentCheckpointV2Schema>;
type FailureJudgmentRuntime = TaskRuntime<FailureJudgmentTaskInputV2, FailureJudgmentCheckpointV2, FailureJudgmentTaskResultV2, object>;
type ReadyRun = Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { state: "ready" }>;

export const FAILURE_JUDGMENT_DECISION_TOOL_NAME = "record_workshop_failure_decision";

const decisionParameters = Type.Object({
  action: Type.Union([Type.Literal("retry"), Type.Literal("block"), Type.Literal("fail")]),
  reason: Type.String({ minLength: 1, maxLength: 16_384 }),
}, { additionalProperties: false });

const recordFailureDecision = defineTool({
  name: FAILURE_JUDGMENT_DECISION_TOOL_NAME,
  description: "Record one checked retry, block, or fail decision for this judgment.",
  parameters: decisionParameters,
  replay: "safe",
  async execute(rawDecision, api, context) {
    const decision = judgmentDecisionV2Schema.safeParse(rawDecision);
    if (!decision.success) {
      return { isError: true, content: [{ type: "text", text: "Decision does not match the checked failure-decision contract." }] };
    }
    const recorded = await api.commit(async (tx) => {
      const conversation = await tx.conversation(api.conversationId);
      const ownerTaskId = conversation?.owner?.taskId;
      if (ownerTaskId === undefined) throw new Error("failure-judge conversation has no owning task");
      const owner = await tx.task(ownerTaskId);
      if (owner === undefined || owner.kind !== FAILURE_JUDGMENT_TASK_NAME) {
        throw new Error("failure-judge conversation is not owned by a failure-judgment task");
      }
      const taskInput = failureJudgmentTaskInputV2Schema.parse(owner.input);
      if (!taskInput.allowedActions.includes(decision.data.action)) return { rejected: true as const };
      const runDraft = await tx.doc(WorkshopRunDoc, taskInput.runConversationId as ConversationId);
      const run = readyRun(runDraft);
      assertInputRun(taskInput, run);
      const located = locateAttempt(run, taskInput.nodeId, taskInput.attemptId);
      const judgment = located.attempt.judgments.find((entry) => entry.judgmentId === taskInput.judgmentId);
      if (judgment === undefined
        || judgment.taskId !== Number(ownerTaskId)
        || judgment.conversationId !== Number(api.conversationId)
        || judgment.submissionRequestId !== taskInput.submissionRequestId) {
        throw new Error("decision does not match the persisted judgment identity");
      }
      if (judgment.status === "decided") {
        if (judgment.decision === null || !sameDecision(judgment.decision, decision.data)) {
          throw new Error("conflicting duplicate failure-judgment decision");
        }
        return { decision: judgment.decision, rejected: false as const };
      }
      if (judgment.status !== "pending") throw new Error("failure judgment is no longer accepting a decision");
      if (taskInput.deadlineAt !== null && Date.now() >= Date.parse(taskInput.deadlineAt)) return { late: true as const };
      const decidedAt = new Date().toISOString();
      const nextJudgment = persistedJudgmentV2Schema.parse({
        ...judgment,
        status: "decided",
        decision: decision.data,
        finishedAt: decidedAt,
        decidedAt,
      });
      Object.assign(runDraft, workflowRunDocumentV1Schema.parse(replaceAttempt(run, taskInput.nodeId, taskInput.attemptId, (attempt) => ({
        ...attempt,
        judgments: attempt.judgments.map((value) => value.judgmentId === taskInput.judgmentId ? nextJudgment : value),
      }))));
      const evidence = workshopJudgmentV1Schema.parse({
        ...judgmentEvidenceFields(taskInput, Number(api.conversationId), Number(ownerTaskId), decidedAt),
        phase: "decision_recorded",
        decision: decision.data,
        decidedAt,
      });
      await tx.appendEntry(WorkshopJudgmentEntry, taskInput.runConversationId as ConversationId, { data: evidence });
      return { decision: decision.data, rejected: false as const };
    }, context);
    if ("late" in recorded) {
      return {
        isError: true,
        content: [{ type: "text", text: "The failure-judge deadline elapsed; the decision was not recorded." }],
        control: { terminate: true },
      };
    }
    if (recorded.rejected) {
      return {
        content: [{ type: "text", text: "That action is not allowed by the frozen retry policy; the judgment will be blocked." }],
        control: { terminate: true },
      };
    }
    return {
      content: [{ type: "text", text: "The checked decision has been recorded." }],
      details: { decision: recorded.decision },
      control: { terminate: true },
    };
  },
});

export const FailureJudgmentExtension = defineExtension({
  name: "workshop-failure-judgment",
  tools: [recordFailureDecision],
});

export const FailureJudgmentTask: Task<FailureJudgmentTaskInputV2, FailureJudgmentCheckpointV2, FailureJudgmentTaskResultV2, object> = defineTask<FailureJudgmentTaskInputV2, FailureJudgmentCheckpointV2, FailureJudgmentTaskResultV2>({
  name: FAILURE_JUDGMENT_TASK_NAME,
  version: 1,
  initial: () => ({ phase: "createConversation" }),
  phases: {
    createConversation: async (task, runtime, context) => {
      const input = parseInput(task.input);
      const existing = await readJudgment(runtime, input, context);
      if (existing !== undefined) {
        if (existing.taskId !== Number(runtime.taskId) || existing.submissionRequestId !== input.submissionRequestId) {
          throw new Error("persisted judgment belongs to a different task or submission");
        }
        await runtime.commit(() => ({
          status: "running",
          checkpoint: { phase: "submit", conversationId: existing.conversationId },
        }), context);
        return;
      }

      const startedAt = timestamp(runtime.now());
      await runtime.commit(async (tx) => {
        const runDraft = await tx.doc(WorkshopRunDoc, input.runConversationId as ConversationId);
        const run = readyRun(runDraft);
        assertInputRun(input, run);
        const located = locateAttempt(run, input.nodeId, input.attemptId);
        if (located.attempt.result.kind !== "settled" || located.attempt.result.outcome.kind !== "failed") {
          throw new Error("failure judgment requires a committed known attempt failure");
        }
        if (located.attempt.judgments.some((judgment) => judgment.judgmentId === input.judgmentId)) {
          throw new Error("failure-judgment identity already exists without its task checkpoint");
        }
        const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
        await configure(tx, conversation.id, {
          model: { provider: input.modelProvider, modelId: input.modelId },
          thinkingLevel: input.thinkingLevel,
          extensions: [FailureJudgmentExtension],
          tools: [recordFailureDecision],
          instructions: input.prompt,
          cwd: null,
        });
        const judgment = persistedJudgmentV2Schema.parse({
          judgmentId: input.judgmentId,
          conversationId: Number(conversation.id),
          submissionRequestId: input.submissionRequestId,
          taskId: Number(runtime.taskId),
          status: "pending",
          decision: null,
          startedAt,
          finishedAt: null,
          decidedAt: null,
          applicationReceipt: null,
        });
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse(replaceAttempt(run, input.nodeId, input.attemptId, (attempt) => ({
          ...attempt,
          judgments: [...attempt.judgments, judgment],
        }))));
        const evidence = workshopJudgmentV1Schema.parse({
          ...judgmentEvidenceFields(input, Number(conversation.id), Number(runtime.taskId), startedAt),
          phase: "prepared",
        });
        await tx.appendEntry(WorkshopJudgmentEntry, input.runConversationId as ConversationId, { data: evidence });
        return { status: "running", checkpoint: { phase: "submit", conversationId: Number(conversation.id) } };
      }, context);
    },
    submit: async (task, runtime, context) => {
      const input = parseInput(task.input);
      const checkpoint = parseCheckpoint(task.state.checkpoint);
      if (checkpoint.phase !== "submit") throw new Error("failure-judgment checkpoint lacks its conversation");
      const existingDecision = await readJudgment(runtime, input, context);
      if (existingDecision?.status === "decided" && existingDecision.decision !== null) {
        await runtime.commit(() => ({
          status: "terminal",
          outcome: { status: "completed", result: { kind: "decided", decision: existingDecision.decision! } },
        }), context);
        return;
      }
      if (isPastDeadline(input.deadlineAt, runtime.now())) {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure judge exceeded its configured deadline", "orchestrator_unavailable", context);
        return;
      }
      const model = runtime.models.getModel(input.modelProvider, input.modelId);
      if (model === undefined) {
        await finishFailure(runtime, input, checkpoint.conversationId, "configured failure judge provider or model is unavailable", "orchestrator_unavailable", context);
        return;
      }
      const authPromise = runtime.models.getAuth(model).then((auth) => ({ kind: "resolved" as const, auth }));
      let authResult: Awaited<typeof authPromise> | { kind: "deadline" };
      try {
        authResult = input.deadlineAt === null
          ? await authPromise
          : await Promise.race([
            authPromise,
            runtime.sleep(Date.parse(input.deadlineAt), context).then(() => ({ kind: "deadline" as const })),
          ]);
      } catch {
        await finishFailure(runtime, input, checkpoint.conversationId, "configured failure judge credentials could not be resolved", "orchestrator_unavailable", context);
        return;
      }
      if (authResult.kind === "deadline" || isPastDeadline(input.deadlineAt, runtime.now())) {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure judge exceeded its configured deadline", "orchestrator_unavailable", context);
        return;
      }
      if (authResult.auth === undefined) {
        await finishFailure(runtime, input, checkpoint.conversationId, "configured failure judge credentials are unavailable", "orchestrator_unavailable", context);
        return;
      }
      const conversation = await runtime.conversation(checkpoint.conversationId as ConversationId, context);
      if (conversation === undefined) {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure-judge conversation is unavailable", "orchestrator_unavailable", context);
        return;
      }
      let submission: Submission;
      try {
        submission = await submitJudgment(conversation, input, context);
      } catch {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure judge could not accept its durable submission", "orchestrator_unavailable", context);
        return;
      }
      await runtime.commit(() => ({
        status: "running",
        checkpoint: { phase: "awaitSubmission", conversationId: checkpoint.conversationId, submissionId: Number(submission.id) },
      }), context);
    },
    awaitSubmission: async (task, runtime, context) => {
      const input = parseInput(task.input);
      const checkpoint = parseCheckpoint(task.state.checkpoint);
      if (checkpoint.phase !== "awaitSubmission") throw new Error("failure-judgment checkpoint lacks its submission identity");
      const conversation = await runtime.conversation(checkpoint.conversationId as ConversationId, context);
      if (conversation === undefined) {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure-judge conversation is unavailable after restart", "orchestrator_unavailable", context);
        return;
      }
      let submission: Submission;
      try {
        submission = await submitJudgment(conversation, input, context);
      } catch {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure judge submission could not be reacquired", "orchestrator_unavailable", context);
        return;
      }
      if (Number(submission.id) !== checkpoint.submissionId) {
        throw new Error("stable failure-judgment submission ID changed during recovery");
      }
      const waited = await waitForSubmission(runtime, input, conversation, submission, context);
      const judgment = await readJudgment(runtime, input, context);
      if (judgment?.status === "decided" && judgment.decision !== null) {
        await runtime.commit(() => ({
          status: "terminal",
          outcome: { status: "completed", result: { kind: "decided", decision: judgment.decision! } },
        }), context);
        return;
      }
      if (waited === "deadline" || isPastDeadline(input.deadlineAt, runtime.now())) {
        await finishFailure(runtime, input, checkpoint.conversationId, "failure judge exceeded its configured deadline", "orchestrator_unavailable", context);
        return;
      }
      const reason = waited === "unanswered"
        ? "failure judge provider did not return a usable response"
        : "failure judge completed without recording a checked decision";
      await finishFailure(runtime, input, checkpoint.conversationId, reason, waited === "unanswered" ? "orchestrator_unavailable" : "orchestrator_invalid", context);
    },
  },
  abort: async (task, runtime, context) => {
    const input = parseInput(task.input);
    const checkpoint = failureJudgmentCheckpointV2Schema.safeParse(task.state.checkpoint);
    if (checkpoint.success && checkpoint.data.phase !== "createConversation") {
      const conversation = await runtime.conversation(checkpoint.data.conversationId as ConversationId, context);
      await conversation?.abort(withoutAbortSignal(context)).catch(() => undefined);
    }
    const finishedAt = timestamp(runtime.now());
    await runtime.commit(async (tx) => {
      const runDraft = await tx.doc(WorkshopRunDoc, input.runConversationId as ConversationId);
      const run = readyRun(runDraft);
      assertInputRun(input, run);
      const located = locateAttempt(run, input.nodeId, input.attemptId);
      const judgment = located.attempt.judgments.find((entry) => entry.judgmentId === input.judgmentId);
      if (judgment?.taskId === Number(runtime.taskId) && judgment.status === "pending"
        && (!checkpoint.success || checkpoint.data.phase === "createConversation"
          || judgment.conversationId === checkpoint.data.conversationId)) {
        const cancelled = persistedJudgmentV2Schema.parse({
          ...judgment,
          status: "cancelled",
          decision: null,
          finishedAt,
          decidedAt: null,
          applicationReceipt: null,
        });
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse(replaceAttempt(run, input.nodeId, input.attemptId, (attempt) => ({
          ...attempt,
          judgments: attempt.judgments.map((entry) => entry.judgmentId === input.judgmentId ? cancelled : entry),
        }))));
        const evidence = workshopJudgmentV1Schema.parse({
          ...judgmentEvidenceFields(input, judgment.conversationId, Number(runtime.taskId), finishedAt),
          phase: "cancelled",
        });
        await tx.appendEntry(WorkshopJudgmentEntry, input.runConversationId as ConversationId, { data: evidence });
      }
      return {
        status: "terminal",
        outcome: { status: "aborted", reason: "failure judgment was aborted with its owning workflow" },
      };
    }, context);
  },
});

async function submitJudgment(conversation: ConversationHandle, input: FailureJudgmentTaskInputV2, context: Context): Promise<Submission> {
  return await conversation.submit({
    type: "input",
    requestId: input.submissionRequestId,
    content: "Assess the checked failure evidence in your instructions. Call the decision tool exactly once.",
  }, context);
}

async function waitForSubmission(
  runtime: FailureJudgmentRuntime,
  input: FailureJudgmentTaskInputV2,
  conversation: ConversationHandle,
  submission: Submission,
  context: Context,
): Promise<"done" | "unanswered" | "deadline"> {
  if (input.deadlineAt === null) return (await submission.wait(context)).status;
  const outcome = await Promise.race([
    submission.wait(context).then((settled) => ({ kind: "settled" as const, status: settled.status })),
    runtime.sleep(Date.parse(input.deadlineAt), context).then(() => ({ kind: "deadline" as const })),
  ]);
  if (outcome.kind === "settled") return outcome.status;
  await conversation.abort(withoutAbortSignal(context)).catch(() => undefined);
  return "deadline";
}

async function finishFailure(
  runtime: FailureJudgmentRuntime,
  input: FailureJudgmentTaskInputV2,
  conversationId: number,
  reason: string,
  kind: "orchestrator_unavailable" | "orchestrator_invalid",
  context: Context,
): Promise<void> {
  const blockedAt = timestamp(runtime.now());
  const block = blockInfoV2Schema.parse({
    blockId: `judgment-${input.judgmentId}`,
    kind,
    reason,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    blockedAt,
  });
  await runtime.commit(async (tx) => {
    const runDraft = await tx.doc(WorkshopRunDoc, input.runConversationId as ConversationId);
    const run = readyRun(runDraft);
    assertInputRun(input, run);
    const located = locateAttempt(run, input.nodeId, input.attemptId);
    const judgment = located.attempt.judgments.find((entry) => entry.judgmentId === input.judgmentId);
    if (judgment?.status === "decided" && judgment.decision !== null) {
      return { status: "terminal", outcome: { status: "completed", result: { kind: "decided", decision: judgment.decision } } };
    }
    if (judgment === undefined || judgment.conversationId !== conversationId || judgment.taskId !== Number(runtime.taskId)) {
      throw new Error("failure-judgment failure differs from its persisted task identity");
    }
    const failedJudgment = persistedJudgmentV2Schema.parse({
      ...judgment,
      status: "failed",
      decision: null,
      finishedAt: blockedAt,
      decidedAt: null,
      applicationReceipt: null,
    });
    Object.assign(runDraft, workflowRunDocumentV1Schema.parse(replaceAttempt(run, input.nodeId, input.attemptId, (attempt) => ({
      ...attempt,
      judgments: attempt.judgments.map((entry) => entry.judgmentId === input.judgmentId ? failedJudgment : entry),
    }))));
    const evidence = workshopJudgmentV1Schema.parse({
      ...judgmentEvidenceFields(input, conversationId, Number(runtime.taskId), blockedAt),
      phase: "failed",
      block,
    });
    await tx.appendEntry(WorkshopJudgmentEntry, input.runConversationId as ConversationId, { data: evidence });
    return { status: "terminal", outcome: { status: "completed", result: { kind: "failed", block } } };
  }, context);
}

async function readJudgment(
  runtime: FailureJudgmentRuntime,
  input: FailureJudgmentTaskInputV2,
  context: Context,
): Promise<PersistedJudgmentV2 | undefined> {
  const value = await runtime.snapshot(WorkshopRunDoc, input.runConversationId as ConversationId, context);
  const run = readyRun(value);
  assertInputRun(input, run);
  return locateAttempt(run, input.nodeId, input.attemptId).attempt.judgments.find((entry) => entry.judgmentId === input.judgmentId);
}

function readyRun(value: unknown): ReadyRun {
  const parsed = workflowRunDocumentV1Schema.parse(value);
  if (parsed.state !== "ready") throw new Error("canonical failure-judgment run is uninitialized");
  return parsed;
}

function assertInputRun(input: FailureJudgmentTaskInputV2, run: ReadyRun): void {
  if (run.runId !== input.runId || run.durable.conversationId !== input.runConversationId
    || run.durable.workflowTaskId !== input.workflowTaskId) {
    throw new Error("failure-judgment task input differs from the canonical run identity");
  }
}

function locateAttempt(run: ReadyRun, nodeId: string, attemptId: string) {
  const node = run.nodes.find((entry) => entry.nodeId === nodeId);
  const attempt = node?.attempts.find((entry) => entry.attemptId === attemptId);
  if (node === undefined || attempt === undefined) throw new Error("failure-judgment attempt is missing from the canonical run");
  return { node, attempt };
}

function replaceAttempt(
  run: ReadyRun,
  nodeId: string,
  attemptId: string,
  update: (attempt: ReadyRun["nodes"][number]["attempts"][number]) => ReadyRun["nodes"][number]["attempts"][number],
) {
  locateAttempt(run, nodeId, attemptId);
  return {
    ...run,
    nodes: run.nodes.map((node) => node.nodeId !== nodeId ? node : {
      ...node,
      attempts: node.attempts.map((attempt) => attempt.attemptId === attemptId ? update(attempt) : attempt),
    }),
  };
}

function parseInput(value: unknown): FailureJudgmentTaskInputV2 {
  return failureJudgmentTaskInputV2Schema.parse(value);
}

function parseCheckpoint(value: unknown): FailureJudgmentCheckpointV2 {
  return failureJudgmentCheckpointV2Schema.parse(value);
}

function timestamp(milliseconds: number): string {
  return z.string().datetime().parse(new Date(milliseconds).toISOString());
}

function isPastDeadline(deadlineAt: string | null, now: number): boolean {
  return deadlineAt !== null && now >= Date.parse(deadlineAt);
}

function sameDecision(left: JudgmentDecisionV2, right: JudgmentDecisionV2): boolean {
  return left.action === right.action && left.reason === right.reason;
}

function judgmentEvidenceFields(
  input: FailureJudgmentTaskInputV2,
  conversationId: number,
  taskId: number,
  recordedAt: string,
) {
  return {
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    judgmentId: input.judgmentId,
    conversationId,
    taskId,
    submissionRequestId: input.submissionRequestId,
    recordedAt,
  };
}
