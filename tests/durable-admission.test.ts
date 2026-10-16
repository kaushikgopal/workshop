import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { installationDocumentV1Schema } from "../src/installation/schema.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { admitPreparedRun, type DurableRunAdmission } from "../src/storage/durable/admit-run.js";
import { serveWorkshopService } from "../src/service/serve-workshop-service.js";
import { encodeServiceRequestLine, parseServiceResponseLine } from "../src/service/parse-service-protocol.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const sourceText = [
  "version: 4",
  "defaults:",
  "  retries: 0",
  "  replay: never",
  "steps:",
  "  - prepare-report: echo prepare",
  "",
].join("\n");
const machineConfig = { shell: "/bin/bash" } as const;
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const admissionTestTaskInputSchema = z.strictObject({ runId: z.string().min(1) });
const AdmissionReceiptTask = defineTask<z.infer<typeof admissionTestTaskInputSchema>, { phase: "settle" }, { persisted: true }>({
  name: "workshop.test.admission-receipt",
  version: 1,
  initial: () => ({ phase: "settle" }),
  phases: {
    settle: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "completed", result: { persisted: true } },
      }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "aborted", reason: "test task aborted" },
    }), context);
  },
});

async function openAdmissionHarness(path: string) {
  const opened = await openDurableStorage(path);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const registry = createRegistry();
  registry.install({ name: "workshop-test-admission", tasks: [AdmissionReceiptTask] });
  return Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
}

function prepare(directory: string, overrides: Record<string, unknown> = {}) {
  const checked = checkDefinitionText(sourceText, "release.yaml", "release");
  const resolvedSettings = resolveWorkflowSettings({
    definition: checked.def,
    machine: machineConfig,
    projectCwd: directory,
  });
  const result = prepareRunAdmission({
    sourceText,
    sourceLabel: "release.yaml",
    workflowId: "release",
    machineConfig,
    projectCwd: directory,
    stateDirectory: join(directory, ".workshop", ".state"),
    resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: hash("test integration"),
      taskVersions: {},
    },
    runId: "release-candidate-001",
    eventId: "event-admission-001",
    activationId: "activation-release",
    occurrenceId: "occurrence-slot-001",
    requestId: "request-start-001",
    admittedAt: "2026-10-05T12:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

async function initializeInstallation(harness: Awaited<ReturnType<typeof openAdmissionHarness>>, definitionHash: string) {
  const installation = installationDocumentV1Schema.parse({
    state: "ready",
    installationId: "installation-admission-test",
    maxConcurrentRuns: 1,
    workflows: {
      release: {
        definitionHash,
        admissionHighWater: 0,
        openRunId: null,
        activations: [{
          activationId: "activation-release",
          state: "active",
          admittedCount: 0,
          maxRuns: 1,
          activatedAt: "2026-10-05T11:00:00.000Z",
          nextDueAt: null,
        }],
        occurrenceCounters: { "activation-release": 0 },
        runs: [],
        requestIndex: {},
        capacityReservations: [],
        preflightCache: {},
      },
    },
  });
  await harness.commit(async (tx) => {
    const document = await tx.doc(WorkshopInstallationDoc);
    Object.assign(document, installation);
  }, BACKGROUND_CONTEXT);
}

function useTestTask(harness: Awaited<ReturnType<typeof openAdmissionHarness>>, prepared: ReturnType<typeof prepare>) {
  return admitPreparedRun({
    harness,
    prepared,
    workflowRunTask: AdmissionReceiptTask,
    createTaskInput: (identity) => ({ runId: identity.runId }),
    parseTaskInput: (value, identity) => {
      const parsed = admissionTestTaskInputSchema.safeParse(value);
      return parsed.success && parsed.data.runId === identity.runId ? parsed.data : undefined;
    },
    context: BACKGROUND_CONTEXT,
  });
}

describe("Durable admission transaction seam (test-only task)", () => {
  test("deduplicates the same request after SQLite reopen and rejects changed source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-admission-dedup-"));
    const databasePath = join(directory, "durable.db");
    let harness: Awaited<ReturnType<typeof openAdmissionHarness>> | undefined;
    try {
      const firstPrepared = prepare(directory);
      harness = await openAdmissionHarness(databasePath);
      await initializeInstallation(harness, firstPrepared.canonicalHash);
      const first = await useTestTask(harness, firstPrepared);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(`${first.failure.kind}: ${first.failure.message}`);
      expect(first.value.duplicate).toBe(false);
      const firstValue = first.value;
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      harness = await openAdmissionHarness(databasePath);
      const retryPrepared = prepare(directory, {
        runId: "release-candidate-002",
        eventId: "event-admission-retry",
        admittedAt: "2026-10-05T12:01:00.000Z",
      });
      const retried = await useTestTask(harness, retryPrepared);
      expect(retried.ok).toBe(true);
      if (!retried.ok) throw new Error(`${retried.failure.kind}: ${retried.failure.message}`);
      expect(retried.value).toEqual({ ...firstValue, duplicate: true });

      const changedSource = `${sourceText}# a formatting-only source change\n`;
      const checked = checkDefinitionText(changedSource, "release.yaml", "release");
      const changedSettings = resolveWorkflowSettings({
        definition: checked.def,
        machine: machineConfig,
        projectCwd: directory,
      });
      const conflicting = await useTestTask(harness, prepare(directory, {
        sourceText: changedSource,
        resolvedSettings: changedSettings,
        runId: "release-candidate-003",
        eventId: "event-admission-conflict",
      }));
      expect(conflicting.ok).toBe(false);
      if (!conflicting.ok) expect(conflicting.failure.kind).toBe("idempotency_conflict");

      const index = await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT);
      expect(index?.state).toBe("ready");
      if (index?.state !== "ready") throw new Error("installation index is absent after retry");
      expect(index.workflows.release?.runs).toHaveLength(1);
      expect(String(index.workflows.release?.requestIndex["request-start-001"])).toBe(firstValue.runId);
      expect(index.workflows.release?.admissionHighWater).toBe(1);
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      expect(inspection.tasks).toHaveLength(1);
      expect(inspection.tasks[0]?.record.kind).toBe(AdmissionReceiptTask.definition.name);

      // SAFETY: the returned ID came directly from the Durable conversation created by this commit.
      const conversationId = firstValue.conversationId as ConversationId;
      const run = await harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT);
      expect(run?.state).toBe("ready");
      if (run?.state !== "ready") throw new Error("canonical run was not retained");
      expect(String(run.runId)).toBe(firstValue.runId);
      expect(run.durable.workflowTaskId).toBe(firstValue.workflowTaskId);
      const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new Error("admitted run conversation was not retained");
      const entries = await conversation.entries({}, 10, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.filter((entry) => entry.kind === "workshop.event")).toHaveLength(1);
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back conversation, task, document, index, and event when SQLite rejects the commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-admission-rollback-"));
    const databasePath = join(directory, "durable.db");
    let harness: Awaited<ReturnType<typeof openAdmissionHarness>> | undefined;
    try {
      const prepared = prepare(directory);
      harness = await openAdmissionHarness(databasePath);
      await initializeInstallation(harness, prepared.canonicalHash);
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      const baseline = tableCounts(databasePath);
      const database = new DatabaseSync(databasePath);
      database.exec(`CREATE TRIGGER reject_workshop_admission
        BEFORE INSERT ON entries
        WHEN json_extract(NEW.record, '$.kind') = 'workshop.event'
        BEGIN SELECT RAISE(ABORT, 'forced admission write failure'); END`);
      database.close();

      harness = await openAdmissionHarness(databasePath);
      const result = await useTestTask(harness, prepared);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("durable_commit_failed");
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;
      harness = await openAdmissionHarness(databasePath);
      const index = await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT);
      expect(index?.state).toBe("ready");
      if (index?.state !== "ready") throw new Error("installation index is absent after rollback");
      expect(index.workflows.release?.runs).toEqual([]);
      expect(index.workflows.release?.openRunId).toBeNull();
      expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;
      expect(tableCounts(databasePath)).toEqual(baseline);
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns the committed start admission when the first protocol response is dropped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-start-retry-"));
    const databasePath = join(directory, "durable.db");
    const requestId = "service-start-retry-001";
    let harness: Awaited<ReturnType<typeof openAdmissionHarness>> | undefined;
    let owner: Awaited<ReturnType<typeof serveWorkshopService>> | undefined;
    let droppedSocket: ReturnType<typeof createConnection> | undefined;
    let releaseFirstResponse: () => void = () => {};
    let markCommitted: () => void = () => {};
    let markResponseReady: () => void = () => {};
    const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    const firstCommitted = new Promise<void>((resolve) => { markCommitted = resolve; });
    const firstResponseReady = new Promise<void>((resolve) => { markResponseReady = resolve; });
    let firstAdmission: DurableRunAdmission | undefined;
    let invocations = 0;
    try {
      const initial = prepare(directory, { requestId });
      harness = await openAdmissionHarness(databasePath);
      await initializeInstallation(harness, initial.canonicalHash);
      owner = await serveWorkshopService({
        stateDirectory: join(directory, "service"),
        openRuntime: async () => ({
          async handleRequest(request) {
            if (request.method !== "start") throw new Error("unexpected method");
            invocations += 1;
            const prepared = prepare(directory, {
              requestId: request.requestId,
              runId: `release-protocol-candidate-${invocations}`,
              eventId: `event-protocol-admission-${invocations}`,
              admittedAt: `2026-10-05T12:0${invocations}:00.000Z`,
            });
            const admission = await useTestTask(harness!, prepared);
            if (!admission.ok) throw new Error(admission.failure.message);
            if (invocations === 1) {
              firstAdmission = admission.value;
              markCommitted();
              await firstResponseGate;
              markResponseReady();
            }
            return admission.value;
          },
          async shutdown() {
            if (harness !== undefined) {
              const closingHarness = harness;
              harness = undefined;
              await closingHarness.close(BACKGROUND_CONTEXT);
            }
          },
        }),
      });

      const requestLine = encodeServiceRequestLine({ version: 1, method: "start", requestId, workflowId: "release" });
      droppedSocket = createConnection(owner.metadata.socketPath);
      await new Promise<void>((resolve, reject) => {
        droppedSocket?.once("connect", () => { droppedSocket?.end(requestLine); resolve(); });
        droppedSocket?.once("error", reject);
      });
      await firstCommitted;
      droppedSocket.destroy();
      releaseFirstResponse();
      await firstResponseReady;
      await new Promise<void>((resolve) => setImmediate(resolve));

      const response = await sendServiceRequest(owner.metadata.socketPath, requestLine);
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      if (firstAdmission === undefined) throw new Error("first admission was not captured");
      expect(response.result).toEqual({ ...firstAdmission, duplicate: true });
      expect(invocations).toBe(2);
      const activeHarness = harness;
      if (activeHarness === undefined) throw new Error("service closed the Harness before inspection");
      const installation = await activeHarness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT);
      expect(installation?.state).toBe("ready");
      if (installation?.state !== "ready") throw new Error("installation index is absent after protocol retry");
      expect(installation.workflows.release?.runs).toHaveLength(1);
      expect(String(installation.workflows.release?.requestIndex[requestId])).toBe(firstAdmission.runId);
      expect((await activeHarness.inspect(BACKGROUND_CONTEXT)).tasks).toHaveLength(1);
    } finally {
      releaseFirstResponse();
      droppedSocket?.destroy();
      if (owner !== undefined) await owner.shutdown();
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function sendServiceRequest(socketPath: string, requestLine: string): Promise<import("../src/service/schema.js").ServiceResponseV1> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    let data = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectResponse(error);
    };
    socket.once("connect", () => socket.end(requestLine));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(0x0a);
      if (newline < 0) return;
      const parsed = parseServiceResponseLine(data.subarray(0, newline));
      if (!parsed.ok) {
        fail(new Error(`${parsed.failure.error.code}: ${parsed.failure.error.message}`));
        return;
      }
      if (settled) return;
      if (!("ok" in parsed.response)) {
        fail(new Error("unexpected fragmented admission response"));
        return;
      }
      settled = true;
      socket.destroy();
      resolveResponse(parsed.response);
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (!settled) fail(new Error("service closed without a response"));
    });
  });
}

function tableCounts(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const count = (table: string) => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
    return {
      conversations: count("conversations"),
      tasks: count("tasks"),
      entries: count("entries"),
      documents: count("documents"),
      revisions: count("document_revisions"),
    };
  } finally {
    database.close();
  }
}
