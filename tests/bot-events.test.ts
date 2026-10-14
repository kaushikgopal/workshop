import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { WorkshopBotDoc, WorkshopEventEntry } from "../src/storage/durable/define-workshop-records.js";
import { botDocumentV1Schema } from "../src/bot/schema.js";
import { initializeBotEventCursors, scanCommittedBotEvents, type BotRunCursorTarget } from "../src/bot/scan-bot-events.js";
import { workshopEventV1Schema, type WorkshopEventV1 } from "../src/run/records.js";

const at = "2026-10-01T00:00:00.000Z";
function models() {
  const result = createModels();
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "fake" }] });
  result.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Acknowledged.")]);
  return result;
}
async function openHarness(path: string) {
  const storage = await openDurableStorage(path);
  if (!storage.ok) throw new Error(storage.failure.message);
  return await Harness.open(storage.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
}
async function createFixture(path: string) {
  const harness = await openHarness(path);
  const run = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const bot = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "fixture", modelId: "fake" } } }, BACKGROUND_CONTEXT);
  await harness.commit(async tx => {
    const document = await tx.doc(WorkshopBotDoc);
    Object.assign(document, { state: "ready", conversationId: Number(bot.id), cursorInitialized: false, eventCursors: {} });
  }, BACKGROUND_CONTEXT);
  const target: BotRunCursorTarget = { workflowId: "checks", runId: "run-checks", conversationId: Number(run.id) };
  await appendEvent(harness, run.id, event("old-terminal", target, "completed"));
  await initializeBotEventCursors(harness, [target]);
  return { harness, bot, target };
}
async function appendEvent(harness: Harness, conversationId: ConversationId, data: WorkshopEventV1) {
  await harness.commit(async tx => { await tx.appendEntry(WorkshopEventEntry, conversationId, { data }); }, BACKGROUND_CONTEXT);
}
function event(eventId: string, target: BotRunCursorTarget, kind: "completed" | "failed" | "cancelled" | "blocked" | "waiting"): WorkshopEventV1 {
  const outcome = kind === "waiting" ? { kind, waitId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }
    : kind === "blocked" ? { kind, block: { blockId: "block", kind: "verifier_block", reason: "needs review", blockedAt: at, nodeId: "check", attemptId: "attempt" } }
      : kind === "failed" ? { kind, failure: { kind: "process_error", message: "failed", failedAt: at, nodeId: "check", attemptId: "attempt" } }
        : kind === "completed" ? { kind, terminalOutput: "done" } : { kind };
  return workshopEventV1Schema.parse({ version: 1, eventId, type: "run_settled", runId: target.runId, outcome, occurredAt: at });
}
async function countUserEntries(conversation: Conversation): Promise<number> {
  const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  return page.items.reduce((count, entry) => count + (entry.model?.filter(message => message.role === "user").length ?? 0), 0);
}
async function close(harness: Harness) {
  await harness.waitForIdle(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
}

test("bot event cursor skips pre-configuration history and resumes after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-cursor-"));
  const database = join(directory, "durable.db");
  try {
    const first = await createFixture(database);
    await appendEvent(first.harness, first.target.conversationId as ConversationId, event("event-one", first.target, "waiting"));
    const delivered: string[] = [];
    await scanCommittedBotEvents({ harness: first.harness, botConversation: first.bot, targets: [first.target],
      submit: async requestId => { delivered.push(requestId); return requestId; } });
    expect(delivered).toEqual(["event-one"]);
    const saved = botDocumentV1Schema.parse(await first.harness.snapshot(WorkshopBotDoc, BACKGROUND_CONTEXT));
    expect(saved.eventCursors[String(first.target.conversationId)]).toBe("event-one");
    await close(first.harness);
    const reopened = await openHarness(database);
    const state = botDocumentV1Schema.parse(await reopened.snapshot(WorkshopBotDoc, BACKGROUND_CONTEXT));
    const bot = await reopened.conversation(state.conversationId! as ConversationId, BACKGROUND_CONTEXT);
    if (bot === undefined) throw new Error("bot conversation is missing after restart");
    await appendEvent(reopened, first.target.conversationId as ConversationId, event("event-two", first.target, "failed"));
    const resumed: string[] = [];
    await scanCommittedBotEvents({ harness: reopened, botConversation: bot, targets: [first.target],
      submit: async requestId => { resumed.push(requestId); return requestId; } });
    expect(resumed).toEqual(["event-two"]);
    await close(reopened);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("restart after bot submission reuses the stable event request ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-submit-"));
  const database = join(directory, "durable.db");
  try {
    const first = await createFixture(database);
    await appendEvent(first.harness, first.target.conversationId as ConversationId, event("event-retry", first.target, "completed"));
    let threw = false;
    await expect(scanCommittedBotEvents({ harness: first.harness, botConversation: first.bot, targets: [first.target],
      submit: async (requestId, message) => {
        const submission = await first.bot.submit({ type: "input", requestId, content: message }, BACKGROUND_CONTEXT);
        if (!threw) { threw = true; throw new Error("simulated crash after durable submission"); }
        return submission;
      } })).rejects.toThrow("simulated crash");
    expect(await countUserEntries(first.bot)).toBe(1);
    await close(first.harness);
    const reopened = await openHarness(database);
    const state = botDocumentV1Schema.parse(await reopened.snapshot(WorkshopBotDoc, BACKGROUND_CONTEXT));
    const bot = await reopened.conversation(state.conversationId! as ConversationId, BACKGROUND_CONTEXT);
    if (bot === undefined) throw new Error("bot conversation is missing after restart");
    let calls = 0;
    await scanCommittedBotEvents({ harness: reopened, botConversation: bot, targets: [first.target],
      submit: async (requestId, message) => {
        calls += 1;
        return await bot.submit({ type: "input", requestId, content: message }, BACKGROUND_CONTEXT);
      } });
    expect(calls).toBe(1);
    expect(await countUserEntries(bot)).toBe(1);
    const saved = botDocumentV1Schema.parse(await reopened.snapshot(WorkshopBotDoc, BACKGROUND_CONTEXT));
    expect(saved.eventCursors[String(first.target.conversationId)]).toBe("event-retry");
    await close(reopened);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
