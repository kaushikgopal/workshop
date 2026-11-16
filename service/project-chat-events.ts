import type { ConversationView } from "@earendil-works/pi-durable";

type ChatView = Pick<ConversationView, "entries" | "docs">;
type ChatEvent = { ok: true; type: string; chat_request_id?: string; [key: string]: unknown };
type ProjectedTool = { status: string; resultSent: boolean };
type ProjectingTurn = {
  phase: "projecting";
  turnId: string;
  submissionId?: string;
  chatRequestId?: string;
  generationAttempt?: number;
  partialText: string;
  replacePending: boolean;
  tools: ReadonlyMap<string, ProjectedTool>;
  nestedTools: ReadonlyMap<string, ProjectedTool>;
};
export type ChatProjectorState =
  | { phase: "idle"; lastTurnId?: string }
  | ProjectingTurn;
export type ChatSettlement = { submissionId: string; status: "done" | "unanswered"; reason?: string; detail?: string };
export type ChatObservation = { view: ChatView; chatRequestId?: string; settledSubmissions?: readonly ChatSettlement[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("");
}

function liveState(view: ChatView): Record<string, unknown> {
  const live = view.docs["pi.live"];
  return isRecord(live) ? live : {};
}

function partialAssistantText(live: Record<string, unknown>): string {
  if (!isRecord(live.generation) || !isRecord(live.generation.message)) return "";
  return textContent(live.generation.message.content);
}

function generationAttempt(live: Record<string, unknown>): number | undefined {
  if (!isRecord(live.generation) || !Number.isSafeInteger(live.generation.attempt) || typeof live.generation.attempt !== "number") return undefined;
  return live.generation.attempt;
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

function toolArguments(view: ChatView, callId: string): unknown {
  for (const entry of view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") continue;
      const call = message.content.find((part) => part.type === "toolCall" && part.id === callId);
      if (call?.type === "toolCall") return call.arguments;
    }
  }
  return undefined;
}

function toolResult(view: ChatView, callId: string): { status: string } {
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
  return { phase: "idle" };
}

function turnIdentity(run: Record<string, unknown>): { turnId: string; submissionId?: string } {
  const input = Array.isArray(run.inputs) ? run.inputs.find((value) => typeof value === "string" || typeof value === "number") : undefined;
  if (input !== undefined) {
    const submissionId = String(input);
    return { turnId: `submission:${submissionId}`, submissionId };
  }
  return { turnId: `task:${String(run.taskId)}` };
}

function startTurn(turnId: string, submissionId?: string, chatRequestId?: string): ProjectingTurn {
  return {
    phase: "projecting",
    turnId,
    ...(submissionId === undefined ? {} : { submissionId }),
    ...(chatRequestId === undefined ? {} : { chatRequestId }),
    partialText: "",
    replacePending: false,
    tools: new Map(),
    nestedTools: new Map(),
  };
}

function settlementFor(turn: ProjectingTurn, settlements: readonly ChatSettlement[]): ChatSettlement | undefined {
  if (turn.submissionId === undefined) return undefined;
  return settlements.find((settlement) => settlement.submissionId === turn.submissionId);
}

function runEnd(turn: ProjectingTurn, live: Record<string, unknown>, settlement: ChatSettlement): ChatEvent[] {
  if (turn.chatRequestId === undefined) return [];
  const failure = isRecord(live.runFailure) ? live.runFailure : undefined;
  return [{
    ok: true,
    type: "run.end",
    chat_request_id: turn.chatRequestId,
    status: settlement.status === "done" ? "done" : "error",
    ...(typeof settlement.reason === "string" ? { reason: settlement.reason } : typeof failure?.reason === "string" ? { reason: failure.reason } : {}),
    ...(typeof settlement.detail === "string" ? { detail: settlement.detail } : typeof failure?.detail === "string" ? { detail: failure.detail } : {}),
  }];
}

function projectTurn(turn: ProjectingTurn, view: ChatView): { state: ProjectingTurn; events: ChatEvent[] } {
  const live = liveState(view);
  const requestId = turn.chatRequestId;
  if (requestId === undefined) return { state: turn, events: [] };

  let partialText = turn.partialText;
  let replacePending = turn.replacePending;
  const tools = new Map(turn.tools);
  const nestedTools = new Map(turn.nestedTools);
  const events: ChatEvent[] = [];
  const emit = (type: string, fields: Record<string, unknown> = {}) => {
    events.push({ ok: true, type, chat_request_id: requestId, ...fields });
  };

  const text = partialAssistantText(live);
  if (text !== partialText) {
    const extendsText = text.startsWith(partialText);
    const delta = extendsText ? text.slice(partialText.length) : text;
    if (delta.length > 0) {
      emit("assistant.delta", { text: delta, ...(replacePending || !extendsText ? { replace: true } : {}) });
      replacePending = false;
    } else if (partialText.length > 0 && text.length === 0) {
      replacePending = true;
    }
    partialText = text;
  }

  const currentTools = Array.isArray(live.tools) ? live.tools : [];
  for (const item of currentTools) {
    if (!isRecord(item) || typeof item.callId !== "string" || typeof item.name !== "string") continue;
    const callId = item.callId;
    const status = typeof item.status === "string" ? item.status : "pending";
    const previous = tools.get(callId);
    if (!previous) {
      const argumentsSummary = summarizedArguments(toolArguments(view, callId));
      emit("tool.call", {
        call_id: callId,
        name: item.name,
        ...(argumentsSummary === undefined ? {} : { arguments: argumentsSummary }),
      });
    }
    const completed = status === "done";
    if (completed && previous?.resultSent !== true) {
      emit("tool.result", { call_id: callId, name: item.name, ...toolResult(view, callId) });
    }
    tools.set(callId, { status, resultSent: completed || previous?.resultSent === true });
  }

  const currentNestedTools = Array.isArray(live.nestedTools) ? live.nestedTools : [];
  for (const item of currentNestedTools) {
    if (!isRecord(item) || typeof item.callId !== "string" || typeof item.name !== "string") continue;
    const callId = item.callId;
    const previous = nestedTools.get(callId);
    if (!previous) {
      const argumentsSummary = summarizedArguments(item.arguments);
      emit("tool.call", {
        call_id: callId,
        name: item.name,
        nested: true,
        ...(argumentsSummary === undefined ? {} : { arguments: argumentsSummary }),
      });
    }
    const completed = isRecord(item.summary);
    if (completed && previous?.resultSent !== true) {
      const summary = item.summary;
      if (isRecord(summary)) emit("tool.result", {
        call_id: callId,
        name: item.name,
        status: summary.isError === true ? "error" : "ok",
      });
    }
    nestedTools.set(callId, { status: completed ? "done" : "pending", resultSent: completed || previous?.resultSent === true });
  }

  return { state: { ...turn, partialText, replacePending, tools, nestedTools }, events };
}

export function projectChatEvents(
  previous: ChatProjectorState,
  observation: ChatObservation,
 ): { state: ChatProjectorState; events: ChatEvent[] } {
  const live = liveState(observation.view);
  const run = isRecord(live.run) ? live.run : undefined;
  const settlements = observation.settledSubmissions ?? [];
  if (run === undefined) {
    if (previous.phase === "idle") return { state: previous, events: [] };
    const settlement = settlementFor(previous, settlements);
    if (settlement === undefined) return { state: previous, events: [] };
    return {
      state: { phase: "idle", lastTurnId: previous.turnId },
      events: runEnd(previous, live, settlement),
    };
  }

  const identity = turnIdentity(run);
  let turn: ProjectingTurn;
  let events: ChatEvent[] = [];
  if (previous.phase === "idle") {
    if (previous.lastTurnId === identity.turnId) return { state: previous, events: [] };
    turn = startTurn(identity.turnId, identity.submissionId, observation.chatRequestId);
  } else if (previous.turnId !== identity.turnId) {
    const settlement = settlementFor(previous, settlements);
    if (previous.chatRequestId !== undefined && settlement === undefined) return { state: previous, events: [] };
    if (settlement !== undefined) events = runEnd(previous, live, settlement);
    turn = startTurn(identity.turnId, identity.submissionId, observation.chatRequestId);
  } else {
    const attempt = generationAttempt(live);
    if (attempt !== undefined && previous.generationAttempt !== undefined && attempt < previous.generationAttempt) {
      const settlement = settlementFor(previous, settlements);
      if (settlement === undefined) return { state: previous, events: [] };
      return {
        state: { phase: "idle", lastTurnId: previous.turnId },
        events: runEnd(previous, live, settlement),
      };
    }
    const newGeneration = attempt !== previous.generationAttempt;
    turn = {
      ...previous,
      ...(previous.chatRequestId === undefined && observation.chatRequestId !== undefined ? { chatRequestId: observation.chatRequestId } : {}),
      ...(newGeneration ? {
        generationAttempt: attempt,
        partialText: "",
        replacePending: previous.replacePending || previous.partialText.length > 0,
        tools: new Map(),
        nestedTools: new Map(),
      } : {}),
    };
  }

  if (previous.phase === "idle" || (previous.phase === "projecting" && previous.turnId !== identity.turnId)) {
    turn = { ...turn, generationAttempt: generationAttempt(live) };
  }
  const projected = projectTurn(turn, observation.view);
  const settlement = settlementFor(turn, settlements);
  if (settlement !== undefined) {
    return {
      state: { phase: "idle", lastTurnId: turn.turnId },
      events: [...events, ...projected.events, ...runEnd(turn, live, settlement)],
    };
  }
  return { state: projected.state, events: [...events, ...projected.events] };
}
