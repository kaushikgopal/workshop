import { AssistantEntry, type ConversationView, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServiceRequest, ServiceResponse } from "./types.ts";
import { initialChatProjectorState, projectChatEvents, type ChatProjectorState } from "./project-chat-events.ts";

type ChatWatcher = { send(event: ServiceResponse): void; refresh(): void };

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

export function createWorkshopChat(input: { harness: Harness }): {
  submitChat(request: Extract<ServiceRequest, { type: "submit_chat" }>): Promise<ServiceResponse>;
  watchChat(requestId: string, send: (event: ServiceResponse) => void): Promise<{ close(): Promise<void> }>;
} {
  const chatWatchers = new Set<ChatWatcher>();
  const chatSubmissions = new Map<string, string>();
  const refreshChatWatchers = () => {
    for (const watcher of chatWatchers) watcher.refresh();
  };

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
    let projectorState: ChatProjectorState = initialChatProjectorState();
    const watcher: ChatWatcher = {
      send: (event) => send({ request_id: requestId, ...event }),
      refresh: () => publish(watch.value),
    };
    const requestForView = (view: ConversationView): string | undefined => {
      const live = view.docs["pi.live"];
      const run = isRecord(live) && isRecord(live.run) ? live.run : undefined;
      if (!isRecord(run) || !Array.isArray(run.inputs)) return undefined;
      for (const submissionId of run.inputs) {
        const chatRequestId = chatSubmissions.get(String(submissionId));
        if (chatRequestId !== undefined) return chatRequestId;
      }
      return undefined;
    };
    const publish = (view: ConversationView) => {
      const projection = projectChatEvents(projectorState, { view, chatRequestId: requestForView(view) });
      projectorState = projection.state;
      for (const event of projection.events) watcher.send(event);
    };

    chatWatchers.add(watcher);
    watcher.send({ ok: true, type: "chat.attached", conversation_id: root.id, busy: isRecord(viewLiveRun(watch.value)) });
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

  return { submitChat, watchChat };
}

function viewLiveRun(view: ConversationView): unknown {
  const live = view.docs["pi.live"];
  return isRecord(live) ? live.run : undefined;
}
