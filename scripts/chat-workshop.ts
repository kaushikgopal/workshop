import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { stderr, stdin, stdout } from "node:process";

const socketPath = join(process.cwd(), "state", "service.sock");
type Event = Record<string, unknown>;
type EventHandler = (event: Event) => void;

function isRecord(value: unknown): value is Event {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(): string {
  return randomUUID();
}

async function connectChat(onEvent: EventHandler, onError: (error: Error) => void): Promise<Socket> {
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
        if (!attached && parsed.ok === false) throw new Error(String(parsed.error ?? "Chat attachment failed"));
        if (parsed.type === "chat.attached") {
          attached = true;
          resolveAttached();
        }
        onEvent(parsed);
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
  socket.write(`${JSON.stringify({ request_id: requestId(), type: "watch_chat" })}\n`);
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

async function printMessage(message: string): Promise<void> {
  const id = requestId();
  let streamed = "";
  let resolveReply = () => {};
  let rejectReply = (_error: Error) => {};
  const reply = new Promise<void>((resolve, reject) => {
    resolveReply = resolve;
    rejectReply = reject;
  });
  let socket: Socket | undefined;
  try {
    socket = await connectChat((event) => {
      if (event.type === "assistant.delta" && typeof event.text === "string") {
        streamed += event.text;
        stdout.write(event.text);
      } else if (event.type === "assistant.final" && event.chat_request_id === id && typeof event.answer === "string") {
        if (event.answer.startsWith(streamed)) stdout.write(event.answer.slice(streamed.length));
        else stdout.write(`\n${event.answer}`);
        streamed = event.answer;
      } else if (event.type === "tool.call" || event.type === "tool.result") {
        outputTool(event, stderr);
      }
      if (event.request_id !== id) return;
      if (event.ok === false) {
        rejectReply(new Error(String(event.error ?? "Chat request failed")));
      } else if (typeof event.answer === "string") {
        if (streamed.length === 0 && event.answer.length > 0) stdout.write(event.answer);
        if (event.answer.length > 0 || streamed.length > 0) stdout.write("\n");
        resolveReply();
      }
    }, (error) => rejectReply(error));
    socket.write(`${JSON.stringify({ request_id: id, type: "submit_chat", content: message })}\n`);
    await reply;
  } finally {
    socket?.destroy();
  }
}

async function startChat(): Promise<void> {
  let pending = 0;
  let responseHasText = false;
  let promptVisible = false;
  let readerClosed = false;
  const pendingText = new Map<string, string>();
  let closeReader: (() => void) | undefined;
  let socket: Socket | undefined;
  const reader = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY && stdout.isTTY });
  const prompt = () => {
    if (pending === 0 && !readerClosed) {
      reader.setPrompt("workshop> ");
      reader.prompt();
      promptVisible = true;
      responseHasText = false;
    }
  };
  try {
    socket = await connectChat((event) => {
      if (event.type === "assistant.delta" && typeof event.text === "string") {
        if (promptVisible) {
          stdout.write("\n");
          promptVisible = false;
        }
        stdout.write(event.text);
        const first = pendingText.keys().next().value;
        if (first !== undefined) pendingText.set(first, (pendingText.get(first) ?? "") + event.text);
        responseHasText = true;
      } else if (event.type === "tool.call" || event.type === "tool.result") {
        if (promptVisible) {
          stdout.write("\n");
          promptVisible = false;
        }
        outputTool(event, stdout);
      } else if (event.type === "assistant.final" && typeof event.chat_request_id === "string" && typeof event.answer === "string") {
        const streamed = pendingText.get(event.chat_request_id);
        if (streamed !== undefined) {
          if (promptVisible) {
            stdout.write("\n");
            promptVisible = false;
          }
          if (event.answer.startsWith(streamed)) stdout.write(event.answer.slice(streamed.length));
          else if (streamed.length === 0) stdout.write(event.answer);
          else stdout.write(`\n${event.answer}`);
          pendingText.set(event.chat_request_id, event.answer);
          responseHasText = true;
          if (pending === 0) {
            if (event.answer.length > 0) stdout.write("\n");
            prompt();
          }
        }
      } else if (event.type === "run.end" && pending === 0) {
        if (responseHasText) stdout.write("\n");
        prompt();
      }

      if (typeof event.request_id !== "string" || !event.request_id.startsWith("chat-")) return;
      if (event.ok === false) {
        stderr.write(`Chat failed: ${String(event.error ?? "unknown error")}\n`);
        pending = Math.max(0, pending - 1);
        pendingText.delete(event.request_id);
        prompt();
      } else if (typeof event.answer === "string") {
        const streamed = pendingText.get(event.request_id) ?? "";
        if (event.answer.startsWith(streamed)) stdout.write(event.answer.slice(streamed.length));
        else if (streamed.length === 0) stdout.write(event.answer);
        else stdout.write(`\n${event.answer}`);
        if (event.answer.length > 0 || streamed.length > 0) stdout.write("\n");
        pendingText.delete(event.request_id);
        responseHasText = false;
        pending = Math.max(0, pending - 1);
        prompt();
      }
    }, (error) => {
      if (!readerClosed) stderr.write(`${error.message}\n`);
      closeReader?.();
    });
    reader.on("line", (line) => {
      promptVisible = false;
      const content = line.trim();
      if (content.length === 0) {
        prompt();
        return;
      }
      pending += 1;
      const id = `chat-${requestId()}`;
      pendingText.set(id, "");
      socket?.write(`${JSON.stringify({ request_id: id, type: "submit_chat", content })}\n`);
    });
    reader.on("SIGINT", () => reader.close());
    reader.once("close", () => {
      readerClosed = true;
      socket?.destroy();
    });
    closeReader = () => reader.close();
    prompt();
  } catch (error) {
    reader.close();
    if (isMissingSocket(error)) {
      stderr.write("Workshop service is not running. Run `make start`.\n");
    } else {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    socket?.destroy();
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
