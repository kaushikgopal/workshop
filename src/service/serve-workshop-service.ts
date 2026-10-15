import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { acquireServiceLock, type ServiceLock } from "./acquire-service-lock.js";
import { locateServiceSocket } from "./locate-service-socket.js";
import {
  type ServiceHealthResponseV1,
  type ServiceMetadataV1,
  type ServiceRequestV1,
  serviceHealthResponseV1Schema,
} from "./schema.js";
import {
  encodeServiceResponseFrames,
  MAX_SERVICE_FRAME_BYTES,
  parseServiceRequestLine,
  serviceError,
  serviceSuccess,
} from "./parse-service-protocol.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_SERVICE_DIAGNOSTIC_BYTES = 1024 * 1024;

export interface WorkshopServiceRuntime {
  /** Commit mutation effects with their receipts before returning; starts use the atomic admission request index. */
  handleRequest(request: Exclude<ServiceRequestV1, { readonly method: "health" }>): Promise<unknown>;
  /** Reconcile child processes, then close the Harness and storage before deadline. */
  shutdown(deadlineMs: number): Promise<void>;
}

export interface ServeWorkshopServiceOptions {
  readonly stateDirectory: string;
  readonly openRuntime: (metadata: ServiceMetadataV1) => Promise<WorkshopServiceRuntime>;
  readonly shutdownTimeoutMs?: number;
}

export interface WorkshopServiceOwner {
  readonly metadata: ServiceMetadataV1;
  shutdown(): Promise<void>;
}

export class ServiceRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceRequestError";
    this.code = code;
  }
}

export class ServiceShutdownError extends Error {
  readonly code = "service_shutdown_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceShutdownError";
  }
}

/** Acquire ownership before opening runtime resources, then publish a private health socket. */
export async function serveWorkshopService(options: ServeWorkshopServiceOptions): Promise<WorkshopServiceOwner> {
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("service shutdown timeout must be a positive safe integer");
  }

  preparePrivateDirectory(resolve(options.stateDirectory));
  const location = locateServiceSocket(options.stateDirectory);
  if (location.runtimeDirectory !== null) preparePrivateDirectory(location.runtimeDirectory);

  const lockPath = join(location.stateDirectory, "service.lock");
  const lock = acquireServiceLock(lockPath);
  let metadata = makeMetadata(lock, location.socketPath, "starting");
  let runtime: WorkshopServiceRuntime | undefined;
  let server: Server | undefined;
  let socketIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let acceptingRequests = false;
  const sockets = new Set<Socket>();
  const inFlightRequests = new Set<Promise<void>>();

  try {
    removeStaleSocket(location.socketPath);
    writeServiceMetadata(location.stateDirectory, metadata);
    runtime = await options.openRuntime(metadata);

    server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const request = handleServiceSocket(
        socket,
        () => metadata,
        () => acceptingRequests,
        (serviceRequest) => {
          if (runtime === undefined) return Promise.reject(new Error("service runtime is unavailable"));
          return runtime.handleRequest(serviceRequest);
        },
        (method, error) => appendServiceDiagnostic(location.stateDirectory, method, error),
      );
      inFlightRequests.add(request);
      void request.then(
        () => inFlightRequests.delete(request),
        () => inFlightRequests.delete(request),
      );
    });
    await listen(server, location.socketPath);
    chmodSync(location.socketPath, 0o600);
    const socketStat = lstatSync(location.socketPath);
    if (!socketStat.isSocket()) throw new Error(`service endpoint is not a Unix socket: ${location.socketPath}`);
    socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };

    metadata = { ...metadata, status: "ready" };
    acceptingRequests = true;
    writeServiceMetadata(location.stateDirectory, metadata);
  } catch (error) {
    acceptingRequests = false;
    metadata = { ...metadata, status: "failed" };
    try { writeServiceMetadata(location.stateDirectory, metadata); } catch { /* readiness also requires the socket */ }

    let safeToRelease = !(error instanceof ServiceShutdownError);
    const deadlineMs = Date.now() + timeoutMs;
    if (server !== undefined) {
      try { await closeServiceServer(server, sockets, inFlightRequests, deadlineMs); } catch { safeToRelease = false; }
    }
    if (runtime !== undefined) {
      try { await beforeDeadline(runtime.shutdown(deadlineMs), deadlineMs, "startup cleanup"); }
      catch { safeToRelease = false; }
    }
    if (safeToRelease) {
      try {
        if (socketIdentity !== undefined) removeOwnedSocket(location.socketPath, socketIdentity);
        lock.release();
      } catch {
        // Keep the kernel lock when cleanup cannot prove that the endpoint is gone.
      }
    }
    if (!safeToRelease) {
      if (error instanceof ServiceShutdownError) throw error;
      throw new ServiceShutdownError("service startup failed and cleanup could not safely release ownership", { cause: error });
    }
    throw error;
  }

  const activeRuntime = runtime;
  const activeServer = server;
  const activeSocketIdentity = socketIdentity;
  if (activeRuntime === undefined || activeServer === undefined || activeSocketIdentity === undefined) {
    throw new Error("service startup completed without its runtime or health socket");
  }

  let shutdownPromise: Promise<void> | undefined;
  return {
    metadata,
    shutdown() {
      if (shutdownPromise === undefined) shutdownPromise = shutdownOwnedService();
      return shutdownPromise;
    },
  };

  async function shutdownOwnedService(): Promise<void> {
    const deadlineMs = Date.now() + timeoutMs;
    acceptingRequests = false;
    metadata = { ...metadata, status: "stopping" };
    try { writeServiceMetadata(location.stateDirectory, metadata); } catch { /* the socket also reports stopping */ }

    try {
      await closeServiceServer(activeServer, sockets, inFlightRequests, deadlineMs);
      await beforeDeadline(activeRuntime.shutdown(deadlineMs), deadlineMs, "runtime reconciliation and close");
      removeOwnedSocket(location.socketPath, activeSocketIdentity);
      metadata = { ...metadata, status: "stopped" };
      try { writeServiceMetadata(location.stateDirectory, metadata); } catch { /* the socket is already gone */ }
      lock.release();
    } catch (error) {
      metadata = { ...metadata, status: "shutdown_failed" };
      try { writeServiceMetadata(location.stateDirectory, metadata); } catch { /* retain kernel ownership on failure */ }
      throw error instanceof ServiceShutdownError
        ? error
        : new ServiceShutdownError("Workshop service did not finish bounded shutdown; ownership remains held", { cause: error });
    }
  }
}

function makeMetadata(lock: ServiceLock, socketPath: string, status: ServiceMetadataV1["status"]): ServiceMetadataV1 {
  return {
    version: 1,
    status,
    pid: lock.metadata.pid,
    startIdentity: lock.metadata.startIdentity,
    bootId: lock.metadata.bootId,
    startedAt: lock.metadata.acquiredAt,
    socketPath,
  };
}

function preparePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`service state path must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`service state directory belongs to another user: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

function removeStaleSocket(socketPath: string): void {
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket service endpoint: ${socketPath}`);
    rmSync(socketPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function removeOwnedSocket(socketPath: string, identity: { readonly dev: number; readonly ino: number }): void {
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error(`service socket identity changed before cleanup: ${socketPath}`);
    }
    rmSync(socketPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function writeServiceMetadata(stateDirectory: string, metadata: ServiceMetadataV1): void {
  const path = join(stateDirectory, "service.json");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(metadata)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
  try {
    const directoryFd = openSync(stateDirectory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch {
    // Some supported filesystems do not permit directory fsync.
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function handleServiceSocket(
  socket: Socket,
  readMetadata: () => ServiceMetadataV1,
  acceptsRequests: () => boolean,
  handleRequest: (request: Exclude<ServiceRequestV1, { readonly method: "health" }>) => Promise<unknown>,
  diagnostic: (method: string, error: unknown) => void,
): Promise<void> {
  return new Promise((resolveRequest) => {
    let buffer = Buffer.alloc(0);
    let dispatched = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolveRequest();
    };
    const send = (response: ReturnType<typeof serviceError>): void => {
      if (!socket.destroyed) socket.end(encodeServiceResponseFrames(response).join(""));
    };
    const timeout = setTimeout(() => {
      if (!dispatched) {
        dispatched = true;
        send(serviceError(null, "frame_timeout", "Timed out while reading the request frame"));
        settle();
      } else {
        socket.destroy();
      }
    }, 10_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      if (!dispatched) settle();
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      if (!dispatched) settle();
    });
    socket.on("data", (chunk: Buffer) => {
      if (dispatched) {
        socket.destroy();
        return;
      }
      if (buffer.byteLength + chunk.byteLength > MAX_SERVICE_FRAME_BYTES) {
        dispatched = true;
        clearTimeout(timeout);
        send(serviceError(null, "frame_too_large", `Request exceeds ${MAX_SERVICE_FRAME_BYTES} bytes`));
        settle();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.byteLength - 1) {
        dispatched = true;
        clearTimeout(timeout);
        send(serviceError(null, "multiple_requests_unsupported", "Send one request per connection"));
        settle();
        return;
      }
      dispatched = true;
      clearTimeout(timeout);
      const line = buffer.subarray(0, newline);
      void dispatch(line)
        .catch((error) => {
          diagnostic("dispatch", error);
          send(serviceError(null, "request_failed", "Service request failed"));
        })
        .finally(settle);
    });
    socket.once("end", () => {
      if (dispatched) return;
      dispatched = true;
      clearTimeout(timeout);
      send(serviceError(null, "incomplete_frame", "Request ended before its newline delimiter"));
      settle();
    });

    async function dispatch(line: Uint8Array): Promise<void> {
      const parsed = parseServiceRequestLine(line);
      if (!parsed.ok) {
        send(serviceError(
          parsed.failure.requestId,
          parsed.failure.error.code,
          parsed.failure.error.message,
          parsed.failure.error.details,
        ));
        return;
      }
      const request = parsed.request;
      if (request.method === "health") {
        const metadata = readMetadata();
        const health: ServiceHealthResponseV1 = serviceHealthResponseV1Schema.parse({
          version: 1,
          status: metadata.status,
          pid: metadata.pid,
          bootId: metadata.bootId,
        });
        send(serviceSuccess(null, health));
        return;
      }
      const requestId = "requestId" in request ? request.requestId : null;
      if (!acceptsRequests()) {
        send(serviceError(requestId, "service_not_ready", "Service is stopping or not ready"));
        return;
      }
      try {
        const result = await handleRequest(request);
        send(serviceSuccess(requestId, result));
      } catch (error) {
        if (error instanceof ServiceRequestError) send(serviceError(requestId, error.code, error.message));
        else {
          diagnostic(request.method, error);
          send(serviceError(requestId, "request_failed", "Service request failed"));
        }
      }
    }
  });
}

function appendServiceDiagnostic(stateDirectory: string, method: string, error: unknown): void {
  let descriptor: number | undefined;
  try {
    const path = join(stateDirectory, "service.log");
    descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("service diagnostic path is not a file owned by this user");
    }
    fchmodSync(descriptor, 0o600);
    const line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), method, error: diagnosticErrorText(error) }) + "\n", "utf8");
    if (stat.size + line.byteLength > MAX_SERVICE_DIAGNOSTIC_BYTES) ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < line.byteLength) {
      const written = writeSync(descriptor, line, offset, line.byteLength - offset);
      if (written < 1) throw new Error("service diagnostic write made no progress");
      offset += written;
    }
  } catch {
    console.error("could not write service request diagnostic");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* the diagnostic has already been handled */ }
    }
  }
}

function diagnosticErrorText(error: unknown): string {
  const detail = error instanceof Error ? error.name + ": " + error.message : "Thrown value of type " + typeof error;
  return detail
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token|secret)["']?\s*[:=]\s*)(?:Bearer\s+)?["']?[^\s,"'&}]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 4096);
}

async function closeServiceServer(
  server: Server,
  sockets: Set<Socket>,
  inFlightRequests: Set<Promise<void>>,
  deadlineMs: number,
): Promise<void> {
  if (server.listening) {
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    const destroyAfterMs = Math.min(50, Math.max(0, deadlineMs - Date.now() - 10));
    const destroyTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, destroyAfterMs);
    try {
      await beforeDeadline(closed, deadlineMs, "service socket close");
    } finally {
      clearTimeout(destroyTimer);
    }
  }
  await beforeDeadline(Promise.all(inFlightRequests), deadlineMs, "in-flight service requests");
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new ServiceShutdownError(`timed out during ${label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ServiceShutdownError(`timed out during ${label}`)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
