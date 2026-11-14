import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

type ToolCall = { name: string; input: Record<string, unknown> };
type Reply = { text: string } | { tool_calls: ToolCall[] };

const unknownUsage: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderPart(value: unknown): string {
  if (!isRecord(value)) return String(value);
  if (value.type === "text" || value.type === "reasoning") return `${value.type}: ${String(value.text ?? "")}`;
  if (value.type === "tool-call") return `tool call ${String(value.toolName)}: ${json(value.input)}`;
  if (value.type === "tool-result") return `tool result ${String(value.toolName)}: ${json(value.output)}`;
  return `${String(value.type ?? "content")}: ${json(value)}`;
}

function promptFor(options: LanguageModelV4CallOptions): string {
  const systems = options.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const history = options.prompt
    .filter((message) => message.role !== "system")
    .map((message) => {
      const body = typeof message.content === "string"
        ? message.content
        : message.content.map(renderPart).join("\n");
      return `${message.role.toUpperCase()}:\n${body}`;
    });
  const tools = (options.tools ?? []).map((tool) => tool.type === "function"
    ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
    : { name: tool.name, id: tool.id, args: tool.args });
  return [
    "You are the model for an eve agent. Return exactly one JSON object, with no extra keys:",
    '{"text":"final answer"} OR {"tool_calls":[{"name":"tool_name","input":{...}}]}',
    "Use at most one tool call per reply. Do not invent tools. After a tool result, continue the conversation.",
    "SYSTEM INSTRUCTIONS:", ...systems,
    "CONVERSATION (oldest first):", ...history,
    "AVAILABLE TOOLS:", json(tools),
  ].join("\n\n");
}

function parseReply(raw: string): Reply | undefined {
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < raw.length; end++) {
      const char = raw.charAt(end);
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\\\") escaped = true;
        else if (char === '\"') quoted = false;
      } else if (char === '\"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(raw.slice(start, end + 1));
            if (!isRecord(value)) break;
            if (Object.keys(value).length === 1 && typeof value.text === "string") return { text: value.text };
            if (Object.keys(value).length === 1 && Array.isArray(value.tool_calls) && value.tool_calls.length > 0) {
              const calls: ToolCall[] = [];
              for (const item of value.tool_calls) {
                if (!isRecord(item)) break;
                const name = item.name;
                const input = item.input;
                if (typeof name !== "string" || name.length === 0 || !isRecord(input)) break;
                if (Object.keys(item).length !== 2) break;
                calls.push({ name, input });
              }
              if (calls.length === value.tool_calls.length) return { tool_calls: calls };
            }
          } catch {
            // A profile may emit prose around its JSON reply; keep scanning for one complete object.
          }
          break;
        }
      }
    }
  }
  return undefined;
}
function invoke(command: readonly string[], prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = command;
    if (!executable) {
      reject(new Error("Profile command must not be empty"));
      return;
    }
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signalName) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`Profile exited ${code ?? signalName}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(prompt);
  });
}

async function generate(options: LanguageModelV4CallOptions, command: readonly string[]) {
  const prompt = promptFor(options);
  const started = Date.now();
  let repairs = 0;
  try {
    let raw = await invoke(command, prompt, options.abortSignal);
    let reply = parseReply(raw);
    if (!reply) {
      repairs = 1;
      raw = await invoke(
        command,
        `${prompt}\n\nYour previous output was invalid. Repair it into exactly one valid JSON object in the required format.\nINVALID OUTPUT:\n${raw}`,
        options.abortSignal,
      );
      reply = parseReply(raw);
      if (!reply) throw new Error("Profile returned an invalid JSON reply after one repair attempt");
    }
    const content = "tool_calls" in reply
      ? reply.tool_calls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: randomUUID(),
          toolName: call.name,
          input: JSON.stringify(call.input),
        }))
      : [{ type: "text" as const, text: reply.text }];
    const finishReason: LanguageModelV4FinishReason = {
      unified: "tool_calls" in reply ? "tool-calls" : "stop",
      raw: undefined,
    };
    console.info(`[profile-model] latency_ms=${Date.now() - started} repairs=${repairs} output_chars=${raw.length} finish=${finishReason.unified}`);
    return { content, finishReason };
  } catch (error) {
    console.info(`[profile-model] latency_ms=${Date.now() - started} failed`);
    throw error;
  }
}

export function createProfileModel(command: readonly string[]): LanguageModelV4 {
  if (command.length === 0 || command[0]?.trim().length === 0) {
    throw new Error("Profile command must contain an executable");
  }
  return {
    specificationVersion: "v4",
    provider: "workshop-profile",
    modelId: "command-line",
    supportedUrls: {},
    async doGenerate(options): Promise<LanguageModelV4GenerateResult> {
      const result = await generate(options, command);
      return { ...result, usage: unknownUsage, warnings: [] };
    },
    async doStream(options) {
      const result = await generate(options, command);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const item of result.content) {
        if (item.type === "text") {
          parts.push({ type: "text-start", id: "text-1" });
          parts.push({ type: "text-delta", id: "text-1", delta: item.text });
          parts.push({ type: "text-end", id: "text-1" });
        } else if (item.type === "tool-call") parts.push(item);
      }
      parts.push({ type: "finish", usage: unknownUsage, finishReason: result.finishReason });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
