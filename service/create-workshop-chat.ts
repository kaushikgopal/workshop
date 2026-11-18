import { AssistantEntry, type ConversationView, type Harness, type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServiceRequest, ServiceResponse } from "./parse-service-request.ts";
import { initialChatProjectorState, projectChatEvents, type ChatProjectorState, type ChatSettlement } from "./project-chat-events.ts";

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

function liveRun(view: ConversationView): Record<string, unknown> | undefined {
  const live = view.docs["pi.live"];
  return isRecord(live) && isRecord(live.run) ? live.run : undefined;
}

function liveSubmissionIds(view: ConversationView): SubmissionId[] {
  const run = liveRun(view);
  if (!run || !Array.isArray(run.inputs)) return [];
  return run.inputs.flatMap((value) => {
    const id = typeof value === "number" ? value : typeof value === "string" && String(Number(value)) === value ? Number(value) : undefined;
    if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return [];
    // pi.live stores pi-durable submission IDs as numbers; only the erased TypeScript brand is missing here.
    return [id as SubmissionId];
  });
}

function chatRequestId(record: SubmissionRecord): string | undefined {
  if (record.type !== "input" || !record.requestId?.startsWith("chat:")) return undefined;
  const requestId = record.requestId.slice("chat:".length);
  return requestId.length > 0 ? requestId : undefined;
}

type ChatSubmissionState =
  | { phase: "observed"; record: SubmissionRecord }
  | { phase: "tracking"; record: SubmissionRecord; chatRequestId: string }
  | { phase: "settled"; record: SubmissionRecord; chatRequestId: string };

async function loadLiveSubmissions(
  harness: Harness,
  ids: readonly SubmissionId[],
  submissions: Map<SubmissionId, ChatSubmissionState>,
): Promise<void> {
  for (const id of ids) {
    if (submissions.has(id)) continue;
    const submission = await harness.submission(id, BACKGROUND_CONTEXT);
    const record = await submission?.status(BACKGROUND_CONTEXT);
    if (record) submissions.set(id, { phase: "observed", record });
  }
}

export function createWorkshopChat(input: { harness: Harness }): {
  submitChat(request: Extract<ServiceRequest, { type: "submit_chat" }>): Promise<ServiceResponse>;
  watchChat(requestId: string, send: (event: ServiceResponse) => void): Promise<{ close(): Promise<void> }>;
} {
  async function submitChat(request: Extract<ServiceRequest, { type: "submit_chat" }>): Promise<ServiceResponse> {
    const root = await input.harness.root(BACKGROUND_CONTEXT);
    const submission = await root.submit({
      type: "input",
      content: request.content,
      requestId: `chat:${request.request_id}`,
      whenBusy: "followUp",
    }, BACKGROUND_CONTEXT);
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
    return {
      request_id: request.request_id,
      ok: true,
      conversation_id: root.id,
      submission_id: submission.id,
      answer,
    };
  }

  async function watchChat(requestId: string, send: (event: ServiceResponse) => void): Promise<{ close(): Promise<void> }> {
    const root = await input.harness.root(BACKGROUND_CONTEXT);
    const watch = await root.watch(BACKGROUND_CONTEXT);
    let projectorState: ChatProjectorState = initialChatProjectorState();
    const submissions = new Map<SubmissionId, ChatSubmissionState>();
    let publishChain = Promise.resolve();
    let closed = false;
    const sendEvent = (event: ServiceResponse) => send({ request_id: requestId, ...event });

    const publish = async (view: ConversationView): Promise<void> => {
      const inputIds = liveSubmissionIds(view);
      await loadLiveSubmissions(input.harness, inputIds, submissions);
      for (const id of inputIds) {
        const state = submissions.get(id);
        if (state?.phase !== "observed") continue;
        const { record } = state;
        const chatId = chatRequestId(record);
        const terminal = record.status === "done" || record.status === "unanswered";
        if (record.type === "input" && chatId !== undefined && (record.status === "placed" || terminal)) {
          submissions.set(id, { phase: "tracking", record, chatRequestId: chatId });
        }
      }
      const settledSubmissions: ChatSettlement[] = [];
      for (const [key, state] of submissions) {
        if (state.phase !== "tracking") continue;
        const submission = await input.harness.submission(state.record.id, BACKGROUND_CONTEXT);
        const record = await submission?.status(BACKGROUND_CONTEXT);
        if (!record) continue;
        if (record.status === "queued" || record.status === "placed") {
          submissions.set(key, { ...state, record });
          continue;
        }
        if (record.type === "input" && record.status === "done") {
          const entry = await input.harness.commit((tx) => tx.entry(AssistantEntry, record.answer), BACKGROUND_CONTEXT);
          sendEvent({
            ok: true,
            type: "assistant.final",
            chat_request_id: state.chatRequestId,
            conversation_id: root.id,
            answer: assistantText(entry),
          });
          settledSubmissions.push({ submissionId: String(key), status: "done" });
        } else if (record.type === "input" && record.status === "unanswered") {
          settledSubmissions.push({
            submissionId: String(key),
            status: "unanswered",
            reason: record.reason,
            ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
          });
        }
        submissions.set(key, { phase: "settled", record, chatRequestId: state.chatRequestId });
      }

      const correlatedRequestId = inputIds.flatMap((id) => {
        const state = submissions.get(id);
        if (state === undefined) return [];
        const chatId = state.phase === "observed" ? chatRequestId(state.record) : state.chatRequestId;
        return chatId === undefined ? [] : [chatId];
      })[0];
      const projection = projectChatEvents(projectorState, { view, chatRequestId: correlatedRequestId, settledSubmissions });
      projectorState = projection.state;
      for (const event of projection.events) sendEvent(event);
    };
    const enqueuePublish = (view: ConversationView): Promise<void> => {
      publishChain = publishChain.then(async () => {
        if (!closed) await publish(view);
      });
      return publishChain;
    };

    try {
      sendEvent({ ok: true, type: "chat.attached", conversation_id: root.id, busy: liveRun(watch.value) !== undefined });
      await enqueuePublish(watch.value);
      watch.start(async (call) => {
        if (call.kind === "value") await enqueuePublish(call.value);
      });
    } catch (error) {
      closed = true;
      await Promise.resolve().then(() => watch.stop()).catch((cleanupError: unknown) => {
        throw new AggregateError([error, cleanupError], "Chat attachment failed and cleanup was incomplete");
      });
      throw error;
    }
    return {
      async close() {
        if (closed) return;
        closed = true;
        await watch.stop();
        await publishChain;
      },
    };
  }

  return { submitChat, watchChat };
}
