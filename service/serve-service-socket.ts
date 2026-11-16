import { connect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import type { ServiceResponse } from "./types.ts";

const maximumRequestBytes = 1_048_576;
type EventWriter = (event: ServiceResponse) => void;
type SocketSession = { close(): Promise<void> };
type RequestHandler = (
  request: unknown,
  send: EventWriter,
  connection: { persistent: boolean },
) => Promise<SocketSession | void>;

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

async function answer(
  socket: Socket,
  line: string,
  handler: RequestHandler,
  persistent: boolean,
): Promise<SocketSession | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    send(socket, { ok: false, error: `Invalid JSON request: ${errorMessage(error)}` });
    return undefined;
  }
  try {
    const session = await handler(value, (event) => send(socket, event), { persistent });
    return session && typeof session.close === "function" ? session : undefined;
  } catch (error) {
    send(socket, { request_id: requestId(value), ok: false, error: errorMessage(error) });
    return undefined;
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
  const sessions = new Map<Socket, SocketSession>();
  const closeSession = async (socket: Socket): Promise<void> => {
    const session = sessions.get(socket);
    if (!session) return;
    sessions.delete(socket);
    await session.close();
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      void closeSession(socket);
    });
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let request = "";
    let persistent = false;
    let processing = false;
    let ended = false;
    const pending: string[] = [];
    const rejectSocket = (message: string) => {
      send(socket, { ok: false, error: message });
      socket.end();
      void closeSession(socket);
    };
    const processRequests = async () => {
      if (processing) return;
      processing = true;
      try {
        while (pending.length > 0 && !socket.destroyed) {
          const line = pending.shift() ?? "";
          if (line.trim().length === 0) {
            send(socket, { ok: false, error: "Service request is empty" });
            if (!persistent) {
              socket.end();
              pending.length = 0;
              break;
            }
            continue;
          }
          const session = await answer(socket, line.trim(), handler, persistent);
          if (session !== undefined) {
            if (persistent) {
              await session.close();
              send(socket, { request_id: requestId(JSON.parse(line)), ok: false, error: "A chat watch is already attached" });
            } else {
              persistent = true;
              sessions.set(socket, session);
              if (socket.destroyed) await closeSession(socket);
            }
          } else if (!persistent) {
            socket.end();
            pending.length = 0;
            break;
          }
        }
        if (ended && persistent) {
          await closeSession(socket);
          socket.end();
        }
      } finally {
        processing = false;
      }
    };
    socket.on("data", (chunk: string) => {
      request += chunk;
      let newline = request.indexOf("\n");
      while (newline >= 0) {
        const line = request.slice(0, newline);
        request = request.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > maximumRequestBytes) {
          rejectSocket("Service request exceeds the 1 MiB limit");
          return;
        }
        pending.push(line);
        newline = request.indexOf("\n");
      }
      if (Buffer.byteLength(request, "utf8") > maximumRequestBytes) {
        rejectSocket("Service request exceeds the 1 MiB limit");
        return;
      }
      void processRequests();
    });
    socket.on("end", () => {
      if (request.trim().length > 0) pending.push(request);
      request = "";
      ended = true;
      void processRequests();
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
      await Promise.all([...sockets].map(async (socket) => {
        await closeSession(socket);
        socket.destroy();
      }));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      rmSync(socketPath, { force: true });
    },
  };
}
