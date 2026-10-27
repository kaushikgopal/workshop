import { Buffer } from "node:buffer";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { botChatEntryV1Schema, type BotChatEntryV1, type BotPendingDecisionV1 } from "./schema.js";

const TOOL_RESULT_PREVIEW_LIMIT_BYTES = 16 * 1024;
const TOOL_RESULT_TRUNCATION_LABEL = "\n[truncated: tool result preview reached 16 KiB]";

export function encodeBotChatCursor(cursor: Cursor | undefined): string | null {
  return cursor === undefined ? null : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeBotChatCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("bad cursor encoding");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad cursor shape");
    return parsed as Cursor;
  } catch {
    throw new Error("chat cursor is invalid");
  }
}

export function buildBotChatEntries(entries: readonly EntryRecord[], includeKinds = false): BotChatEntryV1[] {
  const result: BotChatEntryV1[] = [];
  for (const entry of [...entries].reverse()) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      const mapped = mapMessage(entry, index, message, includeKinds);
      if (mapped !== null) result.push(botChatEntryV1Schema.parse(mapped));
    }
  }
  return result.slice(-100);
}

export function pendingDecisionActions(blockKind: string): ("retry" | "accept" | "fail")[] {
  switch (blockKind) {
    case "verifier_block": case "verifier_failed": case "repeated_failure": case "preflight_failed":
      return ["retry", "fail"];
    case "external_outcome_unknown":
      return ["retry", "accept", "fail"];
    case "process_death_unconfirmed":
      return ["retry", "fail"];
    case "integrity_failed": case "runtime_incompatible":
      return ["fail"];
    default:
      return [];
  }
}

export type PendingDecision = BotPendingDecisionV1;

function mapMessage(entry: EntryRecord, index: number, message: Message, includeKinds: boolean): BotChatEntryV1 | null {
  if (message.role === "user") {
    const text = readContent(message.content);
    return text.length === 0 ? null : { id: String(entry.id) + ":" + index, role: "user", ...(includeKinds ? { kind: "input" as const } : {}), text };
  }
  if (message.role === "assistant") {
    const content = message.content as unknown as readonly Record<string, unknown>[];
    const lines: string[] = [];
    let hasToolCall = false;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) lines.push(block.text);
      else if (block.type === "toolCall") {
        hasToolCall = true;
        if (typeof block.name === "string") lines.push("Used " + block.name);
      }
    }
    return lines.length === 0 ? null : {
      id: String(entry.id) + ":" + index, role: "assistant", ...(includeKinds ? { kind: hasToolCall ? "tool_call" as const : "message" as const } : {}), text: lines.join("\n"),
    };
  }
  if (message.role === "toolResult") {
    const tool = "toolName" in message && typeof message.toolName === "string" ? message.toolName : "tool";
    if (!includeKinds) return { id: String(entry.id) + ":" + index, role: "activity", text: "Completed " + tool };
    const output = previewToolResult(readContent(message.content));
    return {
      id: String(entry.id) + ":" + index, role: "activity", kind: message.isError ? "error" : "tool_result",
      text: tool + (output.length === 0 ? "" : "\n" + output),
    };
  }
  return null;
}

function previewToolResult(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= TOOL_RESULT_PREVIEW_LIMIT_BYTES) return text;

  const contentLimit = TOOL_RESULT_PREVIEW_LIMIT_BYTES - Buffer.byteLength(TOOL_RESULT_TRUNCATION_LABEL, "utf8");
  let end = Math.min(contentLimit, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + TOOL_RESULT_TRUNCATION_LABEL;
}

function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => typeof block === "object" && block !== null && "type" in block
    && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("");
}
