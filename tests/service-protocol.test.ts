import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { commitServiceMutation } from "../src/storage/durable/commit-service-mutation.js";
import { WorkshopServiceReceiptsDoc } from "../src/storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import {
  encodeServiceRequestLine,
  encodeServiceResponseFrames,
  encodeServiceResponseLine,
  MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES,
  MAX_SERVICE_FRAME_BYTES,
  MAX_SERVICE_RESPONSE_BYTES,
  parseServiceRequestLine,
  parseServiceResponseLine,
  serviceSuccess,
} from "../src/service/parse-service-protocol.js";
import { startWorkshopService } from "../src/service/serve-workshop-service.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";

const ReceiptCounterDoc = defineDoc<{ state: "ready"; applied: number }>({
  kind: "workshop.test.service-mutation-counter",
  version: 1,
  scope: "session",
  initial: () => ({ state: "ready", applied: 0 }),
});

async function openHarness(path: string): Promise<Harness> {
  const opened = await openDurableStorage(path);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  return await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
}

describe("service protocol v1", () => {
  test("checks request versions, method arguments, JSON, and the frame bound", () => {
    expect(parseServiceRequestLine('{"version":1,"method":"status"}').ok).toBe(true);
    expect(parseServiceRequestLine("{").ok).toBe(false);
    expect(parseServiceRequestLine(Uint8Array.from([0xff]))).toMatchObject({
      ok: false,
      failure: { error: { code: "invalid_encoding" } },
    });
    expect(parseServiceRequestLine('{"version":2,"method":"status"}')).toMatchObject({
      ok: false,
      failure: { error: { code: "unsupported_version" } },
    });
    expect(parseServiceRequestLine('{"version":1,"method":"remove"}')).toMatchObject({
      ok: false,
      failure: { error: { code: "unknown_method" } },
    });
    expect(parseServiceRequestLine('{"version":1,"method":"start","workflowId":"release"}')).toMatchObject({
      ok: false,
      failure: { error: { code: "invalid_arguments" } },
    });
    expect(parseServiceRequestLine("x".repeat(MAX_SERVICE_FRAME_BYTES))).toMatchObject({
      ok: false,
      failure: { error: { code: "frame_too_large" } },
    });

    const line = encodeServiceRequestLine({ version: 1, method: "start", requestId: "start-1", workflowId: "release" });
    expect(parseServiceRequestLine(line.slice(0, -1))).toMatchObject({ ok: true, request: { method: "start", requestId: "start-1" } });
  });

  test("validates responses and replaces oversized results with a typed error", () => {
    const response = serviceSuccess("request-1", { runId: "release-1" });
    const line = encodeServiceResponseLine(response);
    expect(parseServiceResponseLine(line.slice(0, -1))).toMatchObject({ ok: true, response: { ok: true, requestId: "request-1" } });

    const oversized = encodeServiceResponseLine(serviceSuccess("request-1", { payload: "x".repeat(MAX_SERVICE_FRAME_BYTES) }));
    expect(Buffer.byteLength(oversized)).toBeLessThanOrEqual(MAX_SERVICE_FRAME_BYTES);
    expect(parseServiceResponseLine(oversized.slice(0, -1))).toMatchObject({
      ok: true,
      response: { ok: false, error: { code: "response_too_large" } },
    });
  });
  test("reassembles large Unicode and escaped responses and rejects dropped fragments", async () => {
    const payload = `λ\"🙂`.repeat(200_000);
    const response = serviceSuccess("start-fragmented", { payload });
    const frames = encodeServiceResponseFrames(response);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => Buffer.byteLength(frame, "utf8") <= MAX_SERVICE_FRAME_BYTES)).toBe(true);
    expect(frames.at(-1)).toContain('"final":true');

    const request = { version: 1, method: "start", requestId: "start-fragmented", workflowId: "release" } as const;
    await withResponseFrames(frames.slice(0, -1), async (socketPath) => {
      await expect(sendServiceRequest(socketPath, request)).rejects.toThrow("final response fragment");
    });
    await withResponseFrames([frames[1]!, frames[0]!, ...frames.slice(2)], async (socketPath) => {
      await expect(sendServiceRequest(socketPath, request)).rejects.toThrow("out of order");
    });
    await withResponseFrames(frames, async (socketPath) => {
      await expect(sendServiceRequest(socketPath, request)).resolves.toEqual(response);
    });
  });

  test("retries a dropped final fragment with the same request identity", async () => {
    const response = serviceSuccess("start-retry", { payload: `λ"🙂`.repeat(200_000) });
    const frames = encodeServiceResponseFrames(response);
    const request = { version: 1, method: "start", requestId: "start-retry", workflowId: "release" } as const;
    const attempts = await withResponseFrames([frames.slice(0, -1), frames], async (socketPath) => {
      await expect(sendServiceRequest(socketPath, request)).resolves.toEqual(response);
    });
    expect(attempts).toBe(2);
  });

  test("bounds total reassembly even when every fragment is individually valid", async () => {
    const requestId = "start-overflow";
    const data = Buffer.alloc(MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES).toString("base64");
    const count = Math.ceil(MAX_SERVICE_RESPONSE_BYTES / MAX_SERVICE_FRAGMENT_PAYLOAD_BYTES) + 1;
    const frames = Array.from({ length: count }, (_, sequence) => `${JSON.stringify({
      version: 1,
      requestId,
      fragment: { sequence, final: sequence === count - 1, data },
    })}\n`);
    const request = { version: 1, method: "start", requestId, workflowId: "release" } as const;
    await withResponseFrames(frames, async (socketPath) => {
      await expect(sendServiceRequest(socketPath, request)).rejects.toThrow("reassembled service response exceeds");
    });
  });

  test("commits mutation receipts with domain changes and replays them after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-receipt-"));
    const databasePath = join(directory, "durable.db");
    const request = { requestId: "stop-release-1", method: "stop" as const, arguments: { workflowId: "release" } };
    let harness: Harness | undefined;
    try {
      harness = await openHarness(databasePath);
      const first = await commitServiceMutation({
        harness,
        context: BACKGROUND_CONTEXT,
        request,
        retain: () => ({ kind: "service" }),
        committedAt: "2026-10-06T01:00:00.000Z",
        apply: async (tx) => {
          const counter = await tx.doc(ReceiptCounterDoc);
          counter.applied += 1;
          return { applied: counter.applied, accepted: true };
        },
      });
      expect(first).toEqual({ kind: "committed", response: { applied: 1, accepted: true } });
      await harness.close(BACKGROUND_CONTEXT);
      harness = await openHarness(databasePath);

      const retried = await commitServiceMutation({
        harness,
        context: BACKGROUND_CONTEXT,
        request,
        retain: () => ({ kind: "service" }),
        apply: async () => { throw new Error("a committed mutation must not run again"); },
      });
      expect(retried).toEqual({ kind: "replayed", response: { applied: 1, accepted: true } });

      const conflict = await commitServiceMutation({
        harness,
        context: BACKGROUND_CONTEXT,
        request: { ...request, arguments: { workflowId: "other" } },
        retain: () => ({ kind: "service" }),
        apply: async () => { throw new Error("a conflicting request must not run"); },
      });
      expect(conflict).toEqual({ kind: "idempotency_conflict" });
      expect((await harness.snapshot(ReceiptCounterDoc, BACKGROUND_CONTEXT))?.applied).toBe(1);
      expect((await harness.snapshot(WorkshopServiceReceiptsDoc, BACKGROUND_CONTEXT))?.receipts).toHaveLength(1);
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for an in-flight mutation after the client disconnects before closing Durable storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-drain-"));
    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    let socket: ReturnType<typeof createConnection> | undefined;
    let releaseHandler: () => void = () => {};
    let markHandlerStarted: () => void = () => {};
    let runtimeClosed = false;
    let shutdownFinished = false;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
    try {
      owner = await startWorkshopService({
        stateDirectory: join(directory, "service"),
        openRuntime: async () => ({
          async handleRequest() {
            markHandlerStarted();
            await handlerGate;
            return { accepted: true };
          },
          async shutdown() { runtimeClosed = true; },
        }),
      });
      socket = createConnection(owner.metadata.socketPath);
      socket.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        socket?.once("connect", () => {
          socket?.end(encodeServiceRequestLine({ version: 1, method: "stop", requestId: "stop-1", workflowId: "release" }));
          resolve();
        });
        socket?.once("error", reject);
      });
      await handlerStarted;
      socket.destroy();
      const shutdown = owner.shutdown().then(() => { shutdownFinished = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(shutdownFinished).toBe(false);
      expect(runtimeClosed).toBe(false);
      await expect(startWorkshopService({
        stateDirectory: join(directory, "service"),
        openRuntime: async () => ({ handleRequest: async () => null, shutdown: async () => {} }),
      })).rejects.toThrow();
      releaseHandler();
      await shutdown;
      expect(runtimeClosed).toBe(true);
      expect(shutdownFinished).toBe(true);
    } finally {
      releaseHandler();
      socket?.destroy();
      if (owner !== undefined) await owner.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function withResponseFrames(
  responses: readonly string[] | readonly (readonly string[])[],
  test: (socketPath: string) => Promise<void>,
): Promise<number> {
  const firstResponse = responses[0];
  const responseSets: readonly (readonly string[])[] = typeof firstResponse === "string"
    ? [responses as readonly string[]]
    : responses as readonly (readonly string[])[];
  const directory = mkdtempSync(join(tmpdir(), "workshop-service-frames-"));
  const socketPath = join(directory, "service.sock");
  let connectionCount = 0;
  const server: Server = createServer((socket) => {
    const frames = responseSets[Math.min(connectionCount, responseSets.length - 1)] ?? [];
    connectionCount += 1;
    socket.on("error", () => {});
    let request: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      request = request.byteLength === 0 ? chunk : Buffer.concat([request, chunk]);
      if (request.indexOf(0x0a) < 0) return;
      socket.removeAllListeners("data");
      let index = 0;
      const writeNext = (): void => {
        if (socket.destroyed) return;
        while (index < frames.length) {
          if (!socket.write(frames[index++]!)) {
            socket.once("drain", writeNext);
            return;
          }
        }
        socket.end();
      };
      writeNext();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await test(socketPath);
    return connectionCount;
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    rmSync(directory, { recursive: true, force: true });
  }
}
