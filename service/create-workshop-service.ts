import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, LiveDoc, type ConversationView, type Harness, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import type { WorkshopServiceInvocation } from "./create-workshop-extension.ts";
import { checkProfileCommands, readConfig } from "../config/read-workshop-config.ts";
import { createWorkflowStartPort, startWorkflow, type StartWorkflowOutcome } from "../run/start-workflow.ts";
import { appendRecent, workshopStateDocument, workflowRunReferenceDocument, type WorkshopAction, type WorkshopState } from "../workflow/define-workshop-state.ts";
import { parseServiceRequest, type ServiceRequest, type ServiceResponse } from "./types.ts";
import { WORKFLOW_TASK_NAME, workflowDecisionDocument, type WorkflowTaskCheckpoint } from "../workflow/define-workflow-task.ts";
import { listWorkflowStatus } from "../workflow/list-workflow-status.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";
import { parseWorkflowDecision } from "../workflow/parse-workflow-decision.ts";
import type { WorkflowDecision } from "../workflow/types.ts";

export type WorkshopService = {
  handleRequest(value: unknown, invocation?: WorkshopServiceInvocation): Promise<ServiceResponse>;
  watchChat(requestId: string, send: (event: ServiceResponse) => void): Promise<{ close(): Promise<void> }>;
};

type WorkflowTaskRecord = TaskRecord<JsonValue, JsonValue, unknown>;
type RunInput = { runId: string; workflow: string; slot: string | null; startedAt: string };

type WorkflowTaskState = WorkflowTaskCheckpoint;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("");
}

function assistantText(entry: unknown): string {
  if (!isRecord(entry) || !Array.isArray(entry.model)) return "";
  return entry.model.map((message) => isRecord(message) && message.role === "assistant" ? textContent(message.content) : "").join("");
}

function liveState(view: ConversationView): Record<string, unknown> {
  const live = view.docs["pi.live"];
  return isRecord(live) ? live : {};
}

function partialAssistantText(live: Record<string, unknown>): string {
  if (!isRecord(live.generation) || !isRecord(live.generation.message)) return "";
  return textContent(live.generation.message.content);
}

function sanitizeArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArguments);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|secret|password|credential|api[_-]?key|authorization|bearer/i.test(key) ? "[redacted]" : sanitizeArguments(item),
  ]));
}

function summarizedArguments(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const summary = JSON.stringify(sanitizeArguments(value));
  if (summary === undefined) return undefined;
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function toolArguments(view: ConversationView, callId: string): unknown {
  for (const entry of view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") continue;
      const call = message.content.find((part) => part.type === "toolCall" && part.id === callId);
      if (call?.type === "toolCall") return call.arguments;
    }
  }
  return undefined;
}

function toolResult(view: ConversationView, callId: string): { status: string } {
  for (const entry of view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult" && message.toolCallId === callId) {
        return { status: message.isError ? "error" : "ok" };
      }
    }
  }
  return { status: "done" };
}

function isWorkflowTaskCheckpoint(value: unknown): value is WorkflowTaskCheckpoint {
  if (!isRecord(value) || !["step", "attempt", "blocked", "decision"].includes(String(value.phase))) return false;
  if (!Number.isSafeInteger(value.stepIndex) || typeof value.pipeInput !== "string" || !Array.isArray(value.results) || !Array.isArray(value.attemptHistory)) return false;
  if (typeof value.localRetriesLeft !== "number" || typeof value.feedback !== "string" || typeof value.decisionNumber !== "number" || typeof value.automaticRoundUsed !== "boolean") return false;
  if (value.profile !== undefined && typeof value.profile !== "string") return false;
  if (value.waitUntil !== undefined && typeof value.waitUntil !== "number") return false;
  if (value.roundStatus !== undefined && value.roundStatus !== "pending" && value.roundStatus !== "settled") return false;
  if (value.decisionSource !== undefined && value.decisionSource !== "chat" && value.decisionSource !== "round") return false;
  if (value.phase === "attempt" && (!isRecord(value.activeAttempt) || (typeof value.activeAttempt.taskId !== "string" && typeof value.activeAttempt.taskId !== "number") || !isRecord(value.activeAttempt.request))) return false;
  if (value.phase === "blocked" || value.phase === "decision") {
    if (!isRecord(value.failure) || typeof value.failure.step !== "string" || typeof value.failure.lastError !== "string" || typeof value.failure.lastOutput !== "string" || !Array.isArray(value.failure.retryProfiles) || !Array.isArray(value.failure.attemptHistory)) return false;
  }
  if (value.phase === "decision" && (!isRecord(value.decision) || !["retry", "skip", "accept", "fail"].includes(String(value.decision.action)))) return false;
  return true;
}

function runInputOf(record: WorkflowTaskRecord): RunInput | undefined {
  if (!isRecord(record.input)) return undefined;
  const { runId, workflowName, slot, startedAt } = record.input;
  if (typeof runId !== "string" || typeof workflowName !== "string" || typeof startedAt !== "string") return undefined;
  return { runId, workflow: workflowName, slot: typeof slot === "string" ? slot : null, startedAt };
}

function checkpointOf(record: WorkflowTaskRecord): WorkflowTaskState | undefined {
  const state = record.state;
  if (state.status !== "pending" && state.status !== "running" && state.status !== "waiting" && state.status !== "sleeping") return undefined;
  return isWorkflowTaskCheckpoint(state.checkpoint) ? state.checkpoint : undefined;
}

function checkpointPhase(record: WorkflowTaskRecord): string | undefined {
  return checkpointOf(record)?.phase;
}

function statusOf(record: WorkflowTaskRecord): string {
  const phase = checkpointPhase(record);
  const state = record.state;
  if (state.status === "pending" || state.status === "running" || state.status === "waiting" || state.status === "sleeping") {
    return phase === "blocked" || phase === "decision" ? "blocked" : state.status;
  }
  if (state.status === "completing" || state.status === "terminal") {
    if (state.outcome.status === "completed") {
      const result = state.outcome.result;
      return isRecord(result) && result.status === "nothing-to-do" ? "nothing-to-do" : "completed";
    }
    if (state.outcome.status === "aborted") return "cancelled";
    return state.outcome.status;
  }
  return "unavailable";
}

function outputTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[truncated; showing last ${limit} characters]\n${value.slice(-limit)}`;
}

function readConfiguration(projectRoot: string) {
  const configFile = process.env.WORKSHOP_CONFIG ?? resolve(projectRoot, "workshop.yaml");
  const config = readConfig(configFile);
  const issues = checkProfileCommands(config, process.env.PATH, configFile);
  if (issues.length > 0) throw new Error(issues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
  return config;
}

async function scanLiveWorkflowTasks(harness: Harness): Promise<WorkflowTaskRecord[]> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return inspection.tasks
    .map(({ record }) => record)
    .filter((record) => record.kind === WORKFLOW_TASK_NAME);
}

async function taskForRun(harness: Harness, runId: string): Promise<WorkflowTaskRecord | undefined> {
  const reference = await harness.snapshot(workflowRunReferenceDocument, runId, BACKGROUND_CONTEXT);
  if (!reference || reference.run_id !== runId) return undefined;
  const record = await harness.getTask(reference.task_id, BACKGROUND_CONTEXT);
  if (!record || record.kind !== WORKFLOW_TASK_NAME || runInputOf(record)?.runId !== runId) return undefined;
  return record;
}

type FailureRound = { runId: string; step: string; attempt: number; decisionNumber: number };

function parseFailureRoundRequestId(requestId: string | undefined): Omit<FailureRound, "decisionNumber"> | undefined {
  const match = requestId === undefined ? null : /^round:([^:]+):(.+):([1-9][0-9]*)$/.exec(requestId);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const attempt = Number(match[3]);
  if (!Number.isSafeInteger(attempt)) return undefined;
  return { runId: match[1], step: match[2], attempt };
}

async function failureRoundForTool(harness: Harness, taskId: TaskId): Promise<FailureRound | undefined> {
  const tool = await harness.getTask(taskId, BACKGROUND_CONTEXT);
  if (!tool) throw new Error("Decision tool task is unavailable");
  const root = await harness.root(BACKGROUND_CONTEXT);
  if (tool.conversationId !== root.id) throw new Error("Blocked-run decisions are only available in the root conversation");

  const live = await harness.snapshot(LiveDoc, tool.conversationId, BACKGROUND_CONTEXT);
  if (!live?.run) throw new Error("Blocked-run decision has no active orchestrator turn");
  const rounds: Omit<FailureRound, "decisionNumber">[] = [];
  for (const submissionId of live.run.inputs) {
    const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
    const record = await submission?.status(BACKGROUND_CONTEXT);
    if (!record?.requestId?.startsWith("round:")) continue;
    const round = parseFailureRoundRequestId(record.requestId);
    if (!round) throw new Error("Automatic failure round has an invalid request ID");
    rounds.push(round);
  }
  if (rounds.length === 0) return undefined;
  if (rounds.length !== 1) throw new Error("This orchestrator turn contains multiple failure rounds; no blocked-run decision was applied");
  const round = rounds[0];
  if (!round) throw new Error("Automatic failure round context is unavailable");

  if (!isRecord(tool.input) || tool.input.kind !== "model" ||
    (typeof tool.input.assistant !== "string" && typeof tool.input.assistant !== "number") || tool.owner === undefined) {
    throw new Error("Automatic failure round tool context is unavailable");
  }
  const generation = await harness.getTask(tool.owner, BACKGROUND_CONTEXT);
  if (!generation || generation.kind !== "pi.generation" || !isRecord(generation.state)) {
    throw new Error("Automatic failure round generation is unavailable");
  }
  const generationCheckpoint = generation.state.checkpoint;
  if (!isRecord(generationCheckpoint) || generationCheckpoint.phase !== "tools" ||
    generationCheckpoint.assistant !== tool.input.assistant || !Array.isArray(generationCheckpoint.tools) ||
    !generationCheckpoint.tools.some((id) => String(id) === String(tool.id)) ||
    String(live.run.taskId) !== String(generation.id)) {
    throw new Error("Automatic failure round does not match the current tool call");
  }

  const record = await taskForRun(harness, round.runId);
  const checkpoint = record === undefined ? undefined : checkpointOf(record);
  if (!checkpoint || checkpoint.phase !== "blocked" || checkpoint.failure.step !== round.step ||
    checkpoint.failure.attemptHistory.at(-1)?.attempt !== round.attempt) {
    throw new Error("This failure round no longer matches its blocked step");
  }
  return { ...round, decisionNumber: checkpoint.failure.decisionNumber };
}

function actionNote(decision: WorkflowDecision, source: "chat" | "round"): string {
  const by = source === "round" ? "automatic failure round" : "chat";
  if (decision.action === "retry") return [decision.hint, decision.after === undefined ? undefined : `retry after ${decision.after}`].filter(Boolean).join("; ") || `Step retried by ${by}.`;
  if (decision.action === "skip") return `Step skipped by ${by}.`;
  if (decision.action === "accept") return `Last output accepted by ${by}.`;
  return `Run failed by ${by}.`;
}

function actionForDecision(workflow: string, runId: string, step: string, decision: WorkflowDecision, source: "chat" | "round", note: string | undefined, at: string): WorkshopAction {
  const noteText = source === "round" && note?.trim() ? note.trim() : actionNote(decision, source);
  const actionDecision: WorkshopAction["decision"] = source === "round" ? { ...decision, note: noteText } : decision;
  return { at, workflow, run_id: runId, step, source, decision: actionDecision, note: noteText };
}

function statusResult(record: WorkflowTaskRecord): { returnValue?: Record<string, unknown>; error?: string } {
  const state = record.state;
  if (state.status !== "completing" && state.status !== "terminal") return {};
  if (state.outcome.status === "completed") return { returnValue: isRecord(state.outcome.result) ? state.outcome.result : undefined };
  if (state.outcome.status === "failed") return { error: state.outcome.error.message };
  if (state.outcome.status === "aborted") return { error: state.outcome.reason ?? "cancelled" };
  return { error: state.outcome.reason };
}

function resultSteps(record: WorkflowTaskRecord): unknown[] | undefined {
  const result = statusResult(record).returnValue;
  if (Array.isArray(result?.steps)) return result.steps;
  const checkpoint = checkpointOf(record);
  if (checkpoint && Array.isArray(checkpoint.results)) return checkpoint.results;
  return undefined;
}

function blockedStep(record: WorkflowTaskRecord): Record<string, unknown> | undefined {
  const checkpoint = checkpointOf(record);
  if (!checkpoint || (checkpoint.phase !== "blocked" && checkpoint.phase !== "decision")) return undefined;
  const failure = checkpoint.failure;
  return {
    step: failure.step,
    decision_number: failure.decisionNumber,
    last_error: failure.lastError,
    last_output: outputTail(failure.lastOutput, 4_000),
    attempt_history: failure.attemptHistory.map((attempt) => ({
      ...attempt,
      output: outputTail(attempt.output, 2_000),
      ...(attempt.error === undefined ? {} : { error: outputTail(attempt.error, 2_000) }),
    })),
  };
}

function runDetails(record: WorkflowTaskRecord) {
  const input = runInputOf(record);
  if (!input) throw new Error("Durable workflow task has invalid run metadata");
  const outcome = statusResult(record);
  const checkpoint = checkpointOf(record);
  const current = checkpoint && isRecord(checkpoint) && typeof checkpoint.pipeInput === "string" ? checkpoint.pipeInput : undefined;
  return {
    run_id: input.runId,
    workflow: input.workflow,
    slot: input.slot,
    started_at: input.startedAt,
    status: statusOf(record),
    ...(resultSteps(record) === undefined ? {} : { steps: resultSteps(record) }),
    ...(outcome.returnValue && Object.hasOwn(outcome.returnValue, "output") ? { output: outcome.returnValue.output } : current === undefined ? {} : { output: current }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(blockedStep(record) === undefined ? {} : { blocked_step: blockedStep(record) }),
  };
}

function runSummary(record: WorkflowTaskRecord) {
  const input = runInputOf(record);
  if (!input) return undefined;
  const blocked = blockedStep(record);
  return {
    run_id: input.runId,
    workflow: input.workflow,
    slot: input.slot,
    started_at: input.startedAt,
    status: statusOf(record),
    ...(blocked === undefined ? {} : { blocked_step: blocked.step, last_error: blocked.last_error }),
  };
}

function fingerprint(request: ServiceRequest): string {
  const { request_id: _requestId, ...payload } = request;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  };
  return JSON.stringify(normalize(payload));
}

function responseFromReceipt(value: JsonValue): ServiceResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("Stored service receipt is invalid");
  if (value.request_id !== undefined && typeof value.request_id !== "string") throw new Error("Stored service receipt has an invalid request ID");
  return {
    ...value,
    ok: value.ok,
    ...(typeof value.request_id === "string" ? { request_id: value.request_id } : {}),
  };
}

function startResponse(requestId: string, outcome: StartWorkflowOutcome): ServiceResponse {
  if (outcome.kind === "skipped" || outcome.kind === "locked") return { request_id: requestId, ok: false, error: outcome.reason };
  if (outcome.kind === "already-indexed") return { request_id: requestId, ok: false, error: `Workflow slot ${outcome.slot} was already indexed` };
  return { request_id: requestId, ok: true, workflow: outcome.workflow, run_id: outcome.run_id };
}

function receiptFor(state: WorkshopState, request: ServiceRequest): ServiceResponse | undefined {
  const receipt = state.receipts.find((entry) => entry.request_id === request.request_id);
  if (!receipt) return undefined;
  if (receipt.fingerprint !== fingerprint(request)) throw new Error("Request ID was already used for a different request");
  return responseFromReceipt(receipt.response);
}

function saveReceipt(state: WorkshopState, request: ServiceRequest, response: ServiceResponse): void {
  const serialized = JSON.stringify(response);
  if (serialized === undefined) throw new Error("Service response could not be saved");
  const responseValue = JSON.parse(serialized);
  appendRecent(state.receipts, { request_id: request.request_id, fingerprint: fingerprint(request), response: responseValue });
}

function liveStatus(record: WorkflowTaskRecord): boolean {
  return ["pending", "running", "waiting", "sleeping", "completing"].includes(record.state.status);
}

export function createWorkshopService(input: { projectRoot: string; harness: Harness }): WorkshopService {
  const projectRoot = resolve(input.projectRoot);
  const workflowDirectory = resolve(projectRoot, "workflows");
  type ChatWatcher = { send(event: ServiceResponse): void; refresh(): void };
  const chatWatchers = new Set<ChatWatcher>();
  const chatSubmissions = new Map<string, string>();
  const refreshChatWatchers = () => {
    for (const watcher of chatWatchers) watcher.refresh();
  };

  async function decideBlockedRun(
    request: Extract<ServiceRequest, { type: "decide_blocked_run" }>,
    source: "chat" | "round",
  ): Promise<ServiceResponse> {
    const decision = parseWorkflowDecision(request.decision);
    const previousState = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    const prior = previousState === undefined ? undefined : receiptFor(previousState, request);
    if (prior) return prior;
    const record = await taskForRun(input.harness, request.run_id);
    if (!record || checkpointPhase(record) !== "blocked") throw new Error(`Workflow run ${request.run_id} is not waiting on a decision`);

    return await input.harness.commit(async (tx) => {
      const state = await tx.doc(workshopStateDocument);
      const prior = receiptFor(state, request);
      if (prior) return prior;
      const current = await tx.task(record.id);
      if (!current || current.kind !== WORKFLOW_TASK_NAME || checkpointPhase(current) !== "blocked") {
        throw new Error(`Workflow run ${request.run_id} is no longer waiting on a decision`);
      }
      const currentCheckpoint = checkpointOf(current);
      if (!currentCheckpoint || (currentCheckpoint.phase !== "blocked" && currentCheckpoint.phase !== "decision")) {
        throw new Error(`Workflow run ${request.run_id} is no longer waiting on a decision`);
      }
      const failure = currentCheckpoint.failure;
      if (failure.decisionNumber !== request.decision_number) {
        throw new Error(`Blocked decision ${request.decision_number} is stale; current decision is ${failure.decisionNumber}`);
      }
      if (decision.action === "accept" && failure.lastOutput.trim().length === 0) {
        throw new Error("Cannot accept a blocked step with empty output");
      }
      if (decision.action === "retry" && decision.profile !== undefined && !failure.retryProfiles.includes(decision.profile)) {
        throw new Error(`Profile "${decision.profile}" cannot retry ${failure.stepKind} step ${failure.step}`);
      }
      const document = await tx.doc(workflowDecisionDocument, record.id);
      if (document.choice !== null) throw new Error("A decision was already accepted for this blocked step");
      document.choice = { requestId: request.request_id, decisionNumber: request.decision_number, decision, source };
      const response: ServiceResponse = { request_id: request.request_id, ok: true, run_id: request.run_id, decision };
      appendRecent(state.actions, actionForDecision(failure.workflow, request.run_id, failure.step, decision, source, request.note, new Date().toISOString()));
      saveReceipt(state, request, response);
      return response;
    }, BACKGROUND_CONTEXT);
  }

  async function pauseWorkflow(request: Extract<ServiceRequest, { type: "pause_workflow" | "resume_workflow" }>): Promise<ServiceResponse> {
    const paused = request.type === "pause_workflow";
    const previous = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    const prior = previous === undefined ? undefined : receiptFor(previous, request);
    if (prior) return prior;
    return await input.harness.commit(async (tx) => {
      const state = await tx.doc(workshopStateDocument);
      const prior = receiptFor(state, request);
      if (prior) return prior;
      if (paused && !state.paused.includes(request.workflow)) state.paused.push(request.workflow);
      if (!paused) state.paused = state.paused.filter((workflow) => workflow !== request.workflow);
      state.paused.sort();
      const action = paused ? "pause" as const : "resume" as const;
      appendRecent(state.actions, {
        at: new Date().toISOString(),
        workflow: request.workflow,
        run_id: null,
        step: null,
        source: "chat",
        decision: { action },
        note: paused ? "Workflow paused from chat." : "Workflow resumed from chat.",
      });
      const response = { request_id: request.request_id, ok: true, workflow: request.workflow, paused, paused_workflows: [...state.paused] };
      saveReceipt(state, request, response);
      return response;
    }, BACKGROUND_CONTEXT);
  }

  async function submitChat(request: Extract<ServiceRequest, { type: "submit_chat" }>): Promise<ServiceResponse> {
    const root = await input.harness.root(BACKGROUND_CONTEXT);
    const submission = await root.submit({
      type: "input",
      content: request.content,
      requestId: `chat:${request.request_id}`,
      whenBusy: "followUp",
    }, BACKGROUND_CONTEXT);
    const submissionId = String(submission.id);
    chatSubmissions.set(submissionId, request.request_id);
    refreshChatWatchers();
    try {
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status !== "done" || settled.type !== "input") {
        return {
          request_id: request.request_id,
          ok: false,
          error: "chat_unanswered",
          conversation_id: root.id,
          submission_id: submission.id,
          reason: settled.status === "unanswered" ? settled.reason : "Unexpected submission type",
        };
      }
      const entry = await input.harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      const answer = assistantText(entry);
      for (const watcher of chatWatchers) watcher.send({
        ok: true,
        type: "assistant.final",
        chat_request_id: request.request_id,
        conversation_id: root.id,
        answer,
      });
      return {
        request_id: request.request_id,
        ok: true,
        conversation_id: root.id,
        submission_id: submission.id,
        answer,
      };
    } finally {
      chatSubmissions.delete(submissionId);
      refreshChatWatchers();
    }
  }

  async function watchChat(requestId: string, send: (event: ServiceResponse) => void): Promise<{ close(): Promise<void> }> {
    const root = await input.harness.root(BACKGROUND_CONTEXT);
    const watch = await root.watch(BACKGROUND_CONTEXT);
    let currentRun: string | undefined;
    let currentChatRequestId: string | undefined;
    let currentGeneration: string | undefined;
    let partialText = "";
    const sentCalls = new Set<string>();
    const callStatuses = new Map<string, string>();
    const sentNestedCalls = new Set<string>();
    const watcher: ChatWatcher = {
      send: (event) => send({ request_id: requestId, ...event }),
      refresh: () => publish(watch.value),
    };
    const emit = (chatRequestId: string | undefined, type: string, fields: Record<string, unknown> = {}) => {
      if (chatRequestId === undefined) return;
      watcher.send({ ok: true, type, chat_request_id: chatRequestId, ...fields });
    };
    const requestForView = (view: ConversationView): string | undefined => {
      const run = liveState(view).run;
      if (!isRecord(run) || !Array.isArray(run.inputs)) return undefined;
      for (const submissionId of run.inputs) {
        const chatRequestId = chatSubmissions.get(String(submissionId));
        if (chatRequestId !== undefined) return chatRequestId;
      }
      return undefined;
    };
    const publish = (view: ConversationView) => {
      const live = liveState(view);
      const run = isRecord(live.run) ? live.run : undefined;
      const runId = run === undefined ? undefined : String(run.taskId);
      const chatRequestId = requestForView(view);
      if (currentRun !== undefined && runId === undefined && currentChatRequestId !== undefined) {
        const failure = isRecord(live.runFailure) ? live.runFailure : undefined;
        emit(currentChatRequestId, "run.end", {
          status: failure === undefined ? "done" : "error",
          ...(typeof failure?.reason === "string" ? { reason: failure.reason } : {}),
          ...(typeof failure?.detail === "string" ? { detail: failure.detail } : {}),
        });
      }
      if (runId !== currentRun) {
        currentChatRequestId = undefined;
        currentGeneration = undefined;
        partialText = "";
        sentCalls.clear();
        callStatuses.clear();
        sentNestedCalls.clear();
      }
      currentRun = runId;

      const generation = isRecord(live.generation) ? live.generation : undefined;
      const generationKey = runId === undefined || generation === undefined
        ? undefined
        : `${runId}:${String(generation.attempt)}`;
      if (generationKey !== currentGeneration) {
        currentGeneration = generationKey;
        currentChatRequestId = chatRequestId;
        partialText = partialAssistantText(live);
      }
      const text = partialAssistantText(live);
      if (text !== partialText) {
        const delta = text.startsWith(partialText) ? text.slice(partialText.length) : text;
        if (delta.length > 0) emit(currentChatRequestId, "assistant.delta", { text: delta, ...(text.startsWith(partialText) ? {} : { replace: true }) });
        partialText = text;
      }

      const tools = Array.isArray(live.tools) ? live.tools : [];
      for (const item of tools) {
        if (!isRecord(item) || typeof item.callId !== "string" || typeof item.name !== "string") continue;
        const callId = item.callId;
        const status = typeof item.status === "string" ? item.status : "pending";
        if (!sentCalls.has(callId)) {
          sentCalls.add(callId);
          const argumentsSummary = summarizedArguments(toolArguments(view, callId));
          emit(currentChatRequestId, "tool.call", {
            call_id: callId,
            name: item.name,
            ...(argumentsSummary === undefined ? {} : { arguments: argumentsSummary }),
          });
        }
        if (status === "done" && callStatuses.get(callId) !== "done") {
          emit(currentChatRequestId, "tool.result", { call_id: callId, name: item.name, ...toolResult(view, callId) });
        }
        callStatuses.set(callId, status);
      }

      const nestedTools = Array.isArray(live.nestedTools) ? live.nestedTools : [];
      for (const item of nestedTools) {
        if (!isRecord(item) || typeof item.callId !== "string" || typeof item.name !== "string" || sentNestedCalls.has(item.callId)) continue;
        sentNestedCalls.add(item.callId);
        const argumentsSummary = summarizedArguments(item.arguments);
        emit(currentChatRequestId, "tool.call", {
          call_id: item.callId,
          name: item.name,
          nested: true,
          ...(argumentsSummary === undefined ? {} : { arguments: argumentsSummary }),
        });
        if (isRecord(item.summary)) {
          emit(currentChatRequestId, "tool.result", {
            call_id: item.callId,
            name: item.name,
            status: item.summary.isError === true ? "error" : "ok",
          });
        }
      }
    };

    chatWatchers.add(watcher);
    watcher.send({ ok: true, type: "chat.attached", conversation_id: root.id, busy: isRecord(liveState(watch.value).run) });
    publish(watch.value);
    watch.start(async (call) => {
      if (call.kind === "value") publish(call.value);
    });
    let closed = false;
    return {
      async close() {
        if (closed) return;
        closed = true;
        chatWatchers.delete(watcher);
        await watch.stop();
      },
    };
  }

  async function handleRequest(value: unknown, invocation?: WorkshopServiceInvocation): Promise<ServiceResponse> {
    const request = parseServiceRequest(value);
    switch (request.type) {
      case "list_workflows": {
        const config = readConfiguration(projectRoot);
        const loaded = loadWorkflows(workflowDirectory, new Set(Object.keys(config.agent_profiles)));
        const state = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
        return { request_id: request.request_id, ok: true, ...listWorkflowStatus(loaded, new Set(state?.paused ?? [])) };
      }
      case "list_runs": {
        const limit = request.limit ?? 20;
        if (limit === 0) return { request_id: request.request_id, ok: true, runs: [] };
        const [tasks, state] = await Promise.all([
          scanLiveWorkflowTasks(input.harness),
          input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT),
        ]);
        const live = tasks.flatMap((task) => {
          const run = runSummary(task);
          return run !== undefined && (request.workflow === undefined || run.workflow === request.workflow) ? [run] : [];
        });
        const liveById = new Map(live.map((run) => [run.run_id, run]));
        const admissions = (state?.admissions ?? []).filter((admission) => request.workflow === undefined || admission.workflow === request.workflow).slice(-limit);
        const recent = await Promise.all(admissions.map(async (admission) => {
          if (admission.outcome === "skipped") return {
            run_id: null,
            workflow: admission.workflow,
            slot: admission.slot,
            started_at: admission.at,
            status: "skipped",
            reason: admission.reason,
          };
          if (admission.run_id === null) return undefined;
          const current = liveById.get(admission.run_id);
          if (current) return current;
          const task = await taskForRun(input.harness, admission.run_id);
          const run = task === undefined ? undefined : runSummary(task);
          return run ?? {
            run_id: admission.run_id,
            workflow: admission.workflow,
            slot: admission.slot,
            started_at: admission.at,
            status: "unavailable",
            reason: "Durable workflow task was not found",
          };
        }));
        const rows = [...live, ...recent.filter((row): row is NonNullable<typeof row> => row !== undefined)];
        const seen = new Set<string>();
        const unique = rows.filter((row) => {
          const key = row.run_id === null ? `${row.workflow}:${row.slot}:${row.status}` : row.run_id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        unique.sort((left, right) => Number(right.status === "blocked") - Number(left.status === "blocked") || right.started_at.localeCompare(left.started_at));
        return { request_id: request.request_id, ok: true, runs: unique.slice(0, limit) };
      }
      case "read_run": {
        const record = await taskForRun(input.harness, request.run_id);
        if (!record) throw new Error(`Workflow run ${request.run_id} was not found`);
        return { request_id: request.request_id, ok: true, run: runDetails(record) };
      }
      case "watch_chat":
        return { request_id: request.request_id, ok: false, error: "watch_chat requires a persistent socket" };
      case "submit_chat":
        return await submitChat(request);
      case "start_workflow": {
        const port = await createWorkflowStartPort(input.harness);
        const result = await startWorkflow({
          workflowName: request.workflow,
          projectRoot,
          port,
          source: "chat",
          idempotency: {
            requestId: request.request_id,
            fingerprint: fingerprint(request),
            response: (outcome: StartWorkflowOutcome) => {
              const response = startResponse(request.request_id, outcome);
              const serialized = JSON.stringify(response);
              if (serialized === undefined) throw new Error("Start response could not be saved");
              return JSON.parse(serialized);
            },
          },
        });
        return result.kind === "replayed" ? responseFromReceipt(result.response) : startResponse(request.request_id, result);
      }
      case "decide_blocked_run": {
        const round = invocation === undefined ? undefined : await failureRoundForTool(input.harness, invocation.taskId);
        if (round) return await decideBlockedRun({
          ...request,
          run_id: round.runId,
          decision_number: round.decisionNumber,
        }, "round");
        return await decideBlockedRun(request, "chat");
      }
      case "cancel_run": {
        const previous = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
        const prior = previous === undefined ? undefined : receiptFor(previous, request);
        if (prior) {
          if (prior.cancelled === true) {
            const priorTask = await taskForRun(input.harness, request.run_id);
            if (priorTask) await input.harness.abortTask(priorTask.id, BACKGROUND_CONTEXT);
          }
          return prior;
        }
        const record = await taskForRun(input.harness, request.run_id);
        if (!record) throw new Error(`Workflow run ${request.run_id} was not found`);
        const run = runInputOf(record);
        if (!run) throw new Error("Durable workflow task has invalid run metadata");
        const abortRequested = liveStatus(record);
        const abortResult = abortRequested ? await input.harness.abortTask(record.id, BACKGROUND_CONTEXT) : undefined;
        return await input.harness.commit(async (tx) => {
          const state = await tx.doc(workshopStateDocument);
          const prior = receiptFor(state, request);
          if (prior) return prior;
          const current = await tx.task(record.id);
          if (!current || current.kind !== WORKFLOW_TASK_NAME) throw new Error(`Workflow run ${request.run_id} was not found`);
          const cancelled = statusOf(current) === "cancelled" || (abortRequested && abortResult === "marked");
          const result: ServiceResponse = cancelled
            ? { request_id: request.request_id, ok: true, run_id: request.run_id, workflow: run.workflow, status: "cancellation-requested", cancelled: true }
            : { request_id: request.request_id, ok: true, run_id: request.run_id, workflow: run.workflow, status: statusOf(current), cancelled: false };
          if (cancelled) appendRecent(state.actions, {
            at: new Date().toISOString(),
            workflow: run.workflow,
            run_id: request.run_id,
            step: null,
            source: "chat",
            decision: { action: "cancel" },
            note: "Workflow run cancellation requested from chat.",
          });
          saveReceipt(state, request, result);
          return result;
        }, BACKGROUND_CONTEXT);
      }
      case "pause_workflow":
      case "resume_workflow":
        return await pauseWorkflow(request);
      case "list_actions": {
        const state = await input.harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
        const all = [...(state?.actions ?? [])].reverse().filter((action) => request.workflow === undefined || action.workflow === request.workflow);
        return { request_id: request.request_id, ok: true, actions: all.slice(0, request.limit ?? 20) };
      }
    }
  }

  return { handleRequest, watchChat };
}
