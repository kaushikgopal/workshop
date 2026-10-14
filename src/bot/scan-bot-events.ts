import type { Context } from "@earendil-works/chord";
import type { Conversation, ConversationId, Cursor, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { workshopEventV1Schema, type WorkshopEventV1 } from "../run/records.js";
import { WorkshopBotDoc } from "../storage/durable/define-workshop-records.js";
import { botDocumentV1Schema } from "./schema.js";

export interface BotRunCursorTarget {
  readonly runId: string;
  readonly workflowId: string;
  readonly conversationId: number;
}

export type BotEventSubmit = (requestId: string, message: string) => Promise<unknown>;

export async function initializeBotEventCursors(
  harness: Pick<Harness, "snapshot" | "commit" | "conversation">,
  targets: readonly BotRunCursorTarget[],
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  const current = botDocumentV1Schema.parse(await harness.snapshot(WorkshopBotDoc, context)
    ?? { state: "ready", conversationId: null, cursorInitialized: false, eventCursors: {} });
  if (current.cursorInitialized) return;
  const eventCursors: Record<string, string | null> = {};
  for (const target of targets) {
    const key = String(target.conversationId);
    if (eventCursors[key] === undefined) {
      eventCursors[key] = await latestEventId(harness, target.conversationId as ConversationId, context);
    }
  }
  await harness.commit(async tx => {
    const draft = await tx.doc(WorkshopBotDoc);
    const doc = botDocumentV1Schema.parse(draft);
    if (!doc.cursorInitialized) {
      Object.assign(draft, { ...doc, cursorInitialized: true, eventCursors });
    }
  }, context);
}

export async function scanCommittedBotEvents(input: {
  readonly harness: Pick<Harness, "snapshot" | "commit" | "conversation">;
  readonly botConversation: Conversation;
  readonly targets: readonly BotRunCursorTarget[];
  readonly submit: BotEventSubmit;
  readonly context?: Context;
}): Promise<number> {
  const context = input.context ?? BACKGROUND_CONTEXT;
  let submitted = 0;
  for (const target of input.targets) {
    const cursorKey = String(target.conversationId);
    let document = botDocumentV1Schema.parse(await input.harness.snapshot(WorkshopBotDoc, context)
      ?? { state: "ready", conversationId: input.botConversation.id, cursorInitialized: false, eventCursors: {} });
    if (!document.cursorInitialized) return submitted;
    const previous = document.eventCursors[cursorKey];
    const conversation = await input.harness.conversation(target.conversationId as ConversationId, context);
    if (conversation === undefined) continue;
    const events = await eventsAfter(conversation, previous, context);
    let cursor = previous;
    for (const event of events) {
      if (isWakeEvent(event)) {
        const message = renderWakeMessage(target, event);
        await input.submit(event.eventId, message);
        submitted += 1;
      }
      await input.harness.commit(async tx => {
        const raw = await tx.doc(WorkshopBotDoc);
        const draft = botDocumentV1Schema.parse(raw);
        const stored = draft.eventCursors[cursorKey];
        if (stored !== cursor) throw new Error("bot event cursor changed during a serialized scan");
        const nextCursors = { ...draft.eventCursors, [cursorKey]: event.eventId };
        Object.assign(raw, { ...draft, eventCursors: nextCursors });
      }, context);
      cursor = event.eventId;
    }
  }
  return submitted;
}

async function latestEventId(
  harness: Pick<Harness, "conversation">,
  conversationId: ConversationId,
  context: Context,
): Promise<string | null> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) return null;
  let pageCursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, pageCursor, context);
    for (const entry of page.items) {
      const event = parseEvent(entry.kind, entry.data);
      if (event !== null) return event.eventId;
    }
    pageCursor = page.next;
  } while (pageCursor !== undefined);
  return null;
}

async function eventsAfter(conversation: Conversation, previous: string | null | undefined, context: Context): Promise<WorkshopEventV1[]> {
  const newer: WorkshopEventV1[] = [];
  let pageCursor: Cursor | undefined;
  let foundBoundary = previous === null || previous === undefined;
  do {
    const page = await conversation.entries({}, 256, pageCursor, context);
    for (const entry of page.items) {
      const event = parseEvent(entry.kind, entry.data);
      if (event === null) continue;
      if (previous !== null && previous !== undefined && event.eventId === previous) {
        foundBoundary = true;
        break;
      }
      newer.push(event);
    }
    if (previous !== null && previous !== undefined && foundBoundary) break;
    pageCursor = page.next;
  } while (pageCursor !== undefined);
  return newer.reverse();
}

function parseEvent(kind: string, data: unknown): WorkshopEventV1 | null {
  if (kind !== "workshop.event") return null;
  const parsed = workshopEventV1Schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

function isWakeEvent(event: WorkshopEventV1): boolean {
  if (event.type !== "run_settled") return false;
  return event.outcome.kind === "waiting" || event.outcome.kind === "blocked"
    || event.outcome.kind === "completed" || event.outcome.kind === "failed" || event.outcome.kind === "cancelled";
}

function renderWakeMessage(target: BotRunCursorTarget, event: WorkshopEventV1): string {
  return [
    "A committed workflow event needs attention.",
    "Workflow: " + target.workflowId,
    "Run: " + target.runId,
    "Event: " + event.type + " (" + event.eventId + ")",
    "State: " + JSON.stringify(event.type === "run_settled" ? event.outcome : event),
    "Read the current run and retained logs before you respond. Follow the bot tool limits.",
  ].join("\n");
}
