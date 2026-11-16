import type { ConversationView } from "@earendil-works/pi-durable";

type ChatEvent = { ok: true; type: string; chat_request_id?: string; [key: string]: unknown };
export type ChatProjectorState = {
  currentRun?: string;
  currentChatRequestId?: string;
  currentGeneration?: string;
  partialText: string;
  sentCalls: ReadonlySet<string>;
  callStatuses: ReadonlyMap<string, string>;
  sentNestedCalls: ReadonlySet<string>;
};
export type ChatObservation = { view: ConversationView; chatRequestId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("");
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

export function initialChatProjectorState(): ChatProjectorState {
  return { partialText: "", sentCalls: new Set(), callStatuses: new Map(), sentNestedCalls: new Set() };
}

export function projectChatEvents(
  previous: ChatProjectorState,
  observation: ChatObservation,
): { state: ChatProjectorState; events: ChatEvent[] } {
  const { view, chatRequestId } = observation;
  const live = liveState(view);
  const run = isRecord(live.run) ? live.run : undefined;
  const runId = run === undefined ? undefined : String(run.taskId);
  let currentRun = previous.currentRun;
  let currentChatRequestId = previous.currentChatRequestId;
  let currentGeneration = previous.currentGeneration;
  let partialText = previous.partialText;
  let sentCalls = new Set(previous.sentCalls);
  let callStatuses = new Map(previous.callStatuses);
  let sentNestedCalls = new Set(previous.sentNestedCalls);
  const events: ChatEvent[] = [];
  const emit = (requestId: string | undefined, type: string, fields: Record<string, unknown> = {}) => {
    if (requestId === undefined) return;
    events.push({ ok: true, type, chat_request_id: requestId, ...fields });
  };

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
    sentCalls = new Set();
    callStatuses = new Map();
    sentNestedCalls = new Set();
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

  return {
    state: { currentRun, currentChatRequestId, currentGeneration, partialText, sentCalls, callStatuses, sentNestedCalls },
    events,
  };
}
