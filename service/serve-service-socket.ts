import { connect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import type { ServiceResponse } from "./types.ts";

const maximumRequestBytes = 1_048_576;
type EventWriter = (event: ServiceResponse) => void;
type RequestHandler = (request: unknown, send: EventWriter) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Service request failed";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function requestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return "request_id" in value && typeof value.request_id === "string" ? value.request_id : undefined;
}

function send(socket: Socket, event: ServiceResponse): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(event)}\n`);
}

async function answer(socket: Socket, line: string, handler: RequestHandler): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    send(socket, { ok: false, error: `Invalid JSON request: ${errorMessage(error)}` });
    socket.end();
    return;
  }
  try {
    await handler(value, (event) => send(socket, event));
  } catch (error) {
    send(socket, { request_id: requestId(value), ok: false, error: errorMessage(error) });
  } finally {
    socket.end();
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const probe = connect(socketPath);
  const outcome = await new Promise<"connected" | "refused">((resolve, reject) => {
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new Error(`Could not verify ownership of service socket ${socketPath}`));
    }, 1_000);
    const finish = (value: "connected" | "refused") => {
      clearTimeout(timer);
      probe.destroy();
      resolve(value);
    };
    probe.once("connect", () => finish("connected"));
    probe.once("error", (error) => {
      if (["ECONNREFUSED", "ENOENT", "ENOTSOCK"].includes(errorCode(error) ?? "")) finish("refused");
      else {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
  if (outcome === "connected") throw new Error("Workshop service is already running (the service socket is active)");
  if (!lstatSync(socketPath).isSocket()) throw new Error(`Refusing to replace non-socket file at ${socketPath}`);
  rmSync(socketPath);
}

export async function serveServiceSocket(socketPath: string, handler: RequestHandler): Promise<{ close(): Promise<void> }> {
  await removeStaleSocket(socketPath);
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let request = "";
    let receivedLine = false;
    socket.on("data", (chunk: string) => {
      if (receivedLine) return;
      request += chunk;
      if (Buffer.byteLength(request, "utf8") > maximumRequestBytes) {
        receivedLine = true;
        request = "";
        send(socket, { ok: false, error: "Service request exceeds the 1 MiB limit" });
        socket.end();
        return;
      }
      const end = request.indexOf("\n");
      if (end < 0) return;
      receivedLine = true;
      const line = request.slice(0, end).trim();
      if (line.length === 0) {
        send(socket, { ok: false, error: "Service request is empty" });
        socket.end();
        return;
      }
      void answer(socket, line, handler);
    });
    socket.on("end", () => {
      if (receivedLine || request.length === 0) return;
      receivedLine = true;
      void answer(socket, request.trim(), handler);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") reject(new Error("Workshop service is already running (service socket is in use)"));
        else reject(error);
      };
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if (server.listening) server.close();
    throw error;
  }
  chmodSync(socketPath, 0o600);

  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      rmSync(socketPath, { force: true });
    },
  };
}
