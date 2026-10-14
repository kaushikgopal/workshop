import { z } from "zod";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const boundedUtf8 = (maxBytes: number, label: string) => z.string().refine(
  value => new TextEncoder().encode(value).byteLength <= maxBytes,
  label + " must be at most " + (maxBytes / 1024) + " KiB in UTF-8",
);

export const botDocumentV1Schema = z.strictObject({
  state: z.literal("ready"),
  conversationId: positiveSafeInteger.nullable(),
  cursorInitialized: z.boolean(),
  eventCursors: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1).nullable()),
});
export type BotDocumentV1 = z.infer<typeof botDocumentV1Schema>;

export const chatTextV1Schema = boundedUtf8(64 * 1024, "chat text").refine(value => value.trim().length > 0, "chat text must be nonempty");

export const botChatEntryV1Schema = z.strictObject({
  id: z.string().min(1).max(256),
  role: z.enum(["user", "assistant", "activity"]),
  text: boundedUtf8(64 * 1024, "chat entry"),
});

export type BotChatEntryV1 = z.infer<typeof botChatEntryV1Schema>;

export const botPendingDecisionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("wait"), workflowId: z.string().min(1), runId: z.string().min(1), waitId: z.string().min(1),
    question: boundedUtf8(64 * 1024, "wait question"), proposal: boundedUtf8(1024 * 1024, "wait proposal"),
  }),
  z.strictObject({
    kind: z.literal("block"), workflowId: z.string().min(1), runId: z.string().min(1), blockId: z.string().min(1),
    blockKind: z.string().min(1), reason: boundedUtf8(16 * 1024, "block reason"),
    actions: z.array(z.enum(["retry", "accept", "fail"])),
  }),
]);

export type BotPendingDecisionV1 = z.infer<typeof botPendingDecisionV1Schema>;

export const botChatViewV1Schema = z.strictObject({
  configured: z.boolean(),
  bot: z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1) }).nullable().default(null),
  entries: z.array(botChatEntryV1Schema).max(100),
  nextCursor: z.string().max(4096).nullable(),
  pending: z.array(botPendingDecisionV1Schema).max(1000),
});
export type BotChatViewV1 = z.infer<typeof botChatViewV1Schema>;
