import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { stderr, stdin, stdout } from "node:process";

const socketPath = join(process.cwd(), "state", "service.sock");
type Event = Record<string, unknown>;
type EventHandler = (event: Event) => void;
type PendingChat = { streamedText: string; hasText: boolean; lineEnded: boolean };
type ChatClientState =
  | { phase: "connecting"; queuedMessages: string[]; inputEnded: boolean }
  | { phase: "attaching"; watchId: string; queuedMessages: string[]; inputEnded: boolean }
  | { phase: "attached"; watchId: string; queuedMessages: string[]; pendingById: Map<string, PendingChat>; inputEnded: boolean; promptVisible: boolean }
  | { phase: "closing"; watchId?: string; pendingById: ReadonlyMap<string, PendingChat> }
  | { phase: "closed" };

function isRecord(value: unknown): value is Event {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(): string {
  return randomUUID();
}

async function connectChat(watchId: string, onEvent: EventHandler, onError: (error: Error) => void): Promise<Socket> {
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.removeListener("error", failed);
      resolve();
    });
  });

  let buffer = "";
  let attached = false;
  let resolveAttached = () => {};
  let rejectAttached = (_error: Error) => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveAttached = resolve;
    rejectAttached = reject;
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("Workshop returned an invalid chat event");
        if (parsed.type === "chat.attached") {
          if (attached || parsed.request_id !== watchId) {
            newline = buffer.indexOf("\n");
            continue;
          }
          attached = true;
          resolveAttached();
        } else if (!attached && parsed.ok === false) {
          throw new Error(String(parsed.error ?? "Chat attachment failed"));
        }
        if (attached && parsed.type !== "chat.attached") onEvent(parsed);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!attached) rejectAttached(failure);
        else onError(failure);
        socket.destroy();
        return;
      }
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", (error: Error) => {
    if (!attached) rejectAttached(error);
    else onError(error);
  });
  socket.once("close", () => {
    if (!attached) rejectAttached(new Error("Workshop closed the chat connection before attaching"));
    else onError(new Error("Workshop chat connection closed"));
  });
  socket.write(`${JSON.stringify({ request_id: watchId, type: "watch_chat" })}\n`);
  await ready;
  return socket;
}

function isMissingSocket(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED");
}

function outputTool(event: Event, output: NodeJS.WriteStream): void {
  const name = typeof event.name === "string" ? event.name : "tool";
  const args = typeof event.arguments === "string" ? ` ${event.arguments}` : "";
  const nested = event.nested === true ? "nested " : "";
  const dim = output.isTTY ? "\u001b[2m" : "";
  const reset = output.isTTY ? "\u001b[0m" : "";
  if (event.type === "tool.call") output.write(`${dim}  ${nested}${name}${args}${reset}\n`);
  if (event.type === "tool.result") {
    const status = typeof event.status === "string" ? event.status : "done";
    output.write(`${dim}  ${name} ${status}${reset}\n`);
  }
}

function appendDelta(pending: PendingChat, text: string, replace: boolean, output: NodeJS.WriteStream): void {
  if (replace) {
    if (pending.streamedText.length > 0) output.write("\n");
    output.write(text);
    pending.streamedText = text;
    pending.hasText = text.length > 0;
    pending.lineEnded = false;
    return;
  }
  output.write(text);
  pending.streamedText += text;
  pending.hasText ||= text.length > 0;
  pending.lineEnded = false;
}

function printAnswer(pending: PendingChat, answer: string, output: NodeJS.WriteStream): void {
  if (answer.startsWith(pending.streamedText)) {
    output.write(answer.slice(pending.streamedText.length));
  } else {
    if (pending.streamedText.length > 0) output.write("\n");
    output.write(answer);
  }
  pending.streamedText = answer;
  pending.hasText ||= answer.length > 0;
  pending.lineEnded = false;
}

async function printMessage(message: string): Promise<void> {
  const id = requestId();
  const watchId = requestId();
  const pending: PendingChat = { streamedText: "", hasText: false, lineEnded: false };
  let resolveReply = () => {};
  let rejectReply = (_error: Error) => {};
  let settled = false;
  const reply = new Promise<void>((resolve, reject) => {
    resolveReply = resolve;
    rejectReply = reject;
  });
  let socket: Socket | undefined;
  try {
    socket = await connectChat(watchId, (event) => {
      if (settled) return;
      if (event.type === "assistant.delta" && event.chat_request_id === id && typeof event.text === "string") {
        appendDelta(pending, event.text, event.replace === true, stdout);
      } else if (event.type === "assistant.final" && event.chat_request_id === id && typeof event.answer === "string") {
        printAnswer(pending, event.answer, stdout);
      } else if ((event.type === "tool.call" || event.type === "tool.result") && event.chat_request_id === id) {
        outputTool(event, stderr);
      }
      if (event.request_id !== id || (event.ok !== false && typeof event.answer !== "string")) return;
      settled = true;
      if (event.ok === false) {
        rejectReply(new Error(String(event.error ?? "Chat request failed")));
        return;
      }
      const answer = event.answer;
      if (typeof answer !== "string") return;
      if (answer.startsWith(pending.streamedText)) stdout.write(answer.slice(pending.streamedText.length));
      else if (pending.streamedText.length === 0) stdout.write(answer);
      else stdout.write(`\n${answer}`);
      pending.streamedText = answer;
      if (answer.length > 0 || pending.hasText) stdout.write("\n");
      resolveReply();
    }, (error) => {
      if (!settled) rejectReply(error);
    });
    socket.write(`${JSON.stringify({ request_id: id, type: "submit_chat", content: message })}\n`);
    await reply;
  } finally {
    socket?.destroy();
  }
}

async function startChat(): Promise<void> {
  const watchId = requestId();
  let state: ChatClientState = { phase: "connecting", queuedMessages: [], inputEnded: false };
  let socket: Socket | undefined;
  let interrupted = false;
  const reader = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY && stdout.isTTY });

  const prompt = () => {
    if (state.phase === "attached" && state.pendingById.size === 0 && state.queuedMessages.length === 0 && !state.inputEnded) {
      reader.setPrompt("workshop> ");
      reader.prompt();
      state.promptVisible = true;
    }
  };
  const closeSocket = () => {
    if (state.phase === "closing" || state.phase === "closed") return;
    const pendingById = state.phase === "attached" ? state.pendingById : new Map<string, PendingChat>();
    state = { phase: "closing", watchId, pendingById };
    socket?.destroy();
    state = { phase: "closed" };
  };
  const finishIfDrained = () => {
    if (state.phase === "attached" && state.inputEnded && state.queuedMessages.length === 0 && state.pendingById.size === 0) closeSocket();
  };
  const hidePrompt = () => {
    if (state.phase === "attached" && state.promptVisible) {
      stdout.write("\n");
      state.promptVisible = false;
    }
  };
  const queueMessage = (line: string) => {
    if (state.phase === "connecting" || state.phase === "attaching") {
      state.queuedMessages.push(line);
      return;
    }
    if (state.phase === "attached" && !state.inputEnded) {
      state.promptVisible = false;
      state.queuedMessages.push(line);
      flushQueuedMessages();
    }
  };
  const flushQueuedMessages = () => {
    if (state.phase !== "attached") return;
    while (state.queuedMessages.length > 0) {
      const line = state.queuedMessages.shift() ?? "";
      const content = line.trim();
      if (content.length === 0) continue;
      const id = `chat-${requestId()}`;
      state.pendingById.set(id, { streamedText: "", hasText: false, lineEnded: false });
      socket?.write(`${JSON.stringify({ request_id: id, type: "submit_chat", content })}\n`);
    }
    prompt();
    finishIfDrained();
  };
  const handleEvent = (event: Event) => {
    if (state.phase !== "attached") return;
    const chatId = typeof event.chat_request_id === "string" ? event.chat_request_id : undefined;
    const pending = chatId === undefined ? undefined : state.pendingById.get(chatId);
    if (event.type === "assistant.delta" && pending && typeof event.text === "string") {
      hidePrompt();
      appendDelta(pending, event.text, event.replace === true, stdout);
    } else if ((event.type === "tool.call" || event.type === "tool.result") && pending) {
      hidePrompt();
      outputTool(event, stdout);
    } else if (event.type === "assistant.final" && pending && typeof event.answer === "string") {
      hidePrompt();
      printAnswer(pending, event.answer, stdout);
    } else if (event.type === "run.end" && pending) {
      if (pending.hasText && !pending.lineEnded) stdout.write("\n");
      pending.lineEnded = true;
    }

    const id = typeof event.request_id === "string" ? event.request_id : undefined;
    if (id === undefined) return;
    const response = state.pendingById.get(id);
    if (!response) return;
    if (event.ok === false) {
      stderr.write(`Chat failed: ${String(event.error ?? "unknown error")}\n`);
      state.pendingById.delete(id);
      prompt();
      finishIfDrained();
      return;
    }
    if (typeof event.answer !== "string") return;
    if (event.answer.startsWith(response.streamedText)) stdout.write(event.answer.slice(response.streamedText.length));
    else if (response.streamedText.length === 0) stdout.write(event.answer);
    else stdout.write(`\n${event.answer}`);
    response.streamedText = event.answer;
    if ((event.answer.length > 0 || response.hasText) && !response.lineEnded) stdout.write("\n");
    state.pendingById.delete(id);
    prompt();
    finishIfDrained();
  };

  reader.on("line", (line) => queueMessage(line));
  reader.on("SIGINT", () => {
    interrupted = true;
    reader.close();
  });
  reader.once("close", () => {
    if (interrupted) {
      closeSocket();
      return;
    }
    if (state.phase === "connecting" || state.phase === "attaching") state.inputEnded = true;
    else if (state.phase === "attached") state.inputEnded = true;
    if (state.phase === "attached") flushQueuedMessages();
  });

  state = { phase: "attaching", watchId, queuedMessages: state.queuedMessages, inputEnded: state.inputEnded };
  try {
    socket = await connectChat(watchId, handleEvent, (error) => {
      if (state.phase === "closing" || state.phase === "closed") return;
      stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      reader.close();
      closeSocket();
    });
    if (state.phase !== "attaching") {
      socket.destroy();
      return;
    }
    state = {
      phase: "attached",
      watchId,
      queuedMessages: state.queuedMessages,
      pendingById: new Map(),
      inputEnded: state.inputEnded,
      promptVisible: false,
    };
    flushQueuedMessages();
  } catch (error) {
    reader.close();
    if (isMissingSocket(error)) {
      stderr.write("Workshop service is not running. Run `make start`.\n");
    } else {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    closeSocket();
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
if (args[0] === "--print" && args.length === 2 && args[1] !== undefined && args[1].trim().length > 0) {
  try {
    await printMessage(args[1]);
  } catch (error) {
    if (isMissingSocket(error)) stderr.write("Workshop service is not running. Run `make start`.\n");
    else stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (args.length === 0) {
  await startChat();
} else {
  stderr.write('Usage: node scripts/chat-workshop.ts [--print "message"]\n');
  process.exitCode = 2;
}
