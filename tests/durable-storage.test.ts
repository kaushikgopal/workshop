import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolvedNodeSettingsSchema } from "../src/definition/schema-resolved.js";
import {
  installationDocumentV1Schema,
  workflowInstallationIndexSchema,
} from "../src/installation/schema.js";
import {
  workflowRunDocumentV1Schema,
  workshopEventV1Schema,
  workshopJudgmentV1Schema,
} from "../src/run/records.js";
import {
  WorkshopEventEntry,
  WorkshopInstallationDoc,
  WorkshopRunDoc,
} from "../src/storage/durable/define-workshop-records.js";
import { checkpointDurableWal } from "../src/storage/durable/checkpoint-durable-wal.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { sha256Schema } from "../src/util/schema.js";

const HASH = "sha256:" + "a".repeat(64);

type ReceiptCheckpoint = { phase: "settle" };
type ReceiptResult = { retained: true };

const StorageReceiptTask = defineTask<Record<string, never>, ReceiptCheckpoint, ReceiptResult>({
  name: "workshop.test.storage-receipt",
  version: 1,
  initial: () => ({ phase: "settle" }),
  phases: {
    settle: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "completed", result: { retained: true } },
      }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "aborted", reason: "test abort" },
    }), context);
  },
});

function fixtureRun(conversationId: number, workflowTaskId: number, baseDir: string) {
  const sourceText = [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - prepare-report: echo prepare",
    "",
  ].join("\n");
  const checked = checkDefinitionText(sourceText, "release.yaml", "release");
  const resolvedSettings = {
    nodes: {
      "prepare-report": resolvedNodeSettingsSchema.parse({
        run: {
          kind: "command",
          command: "echo prepare",
          shell: "/bin/bash",
          cwd: baseDir,
          timeoutMs: 60_000,
          streamCapBytes: 64 * 1024,
          replay: "never",
        },
        validator: null,
        maxAttempts: 1,
      }),
    },
    preflight: null,
    keepFiles: "failed",
    orchestrator: { model: null, timeoutMs: null },
  };
  const sourceHash = `sha256:${createHash("sha256").update(sourceText, "utf8").digest("hex")}`;
  const predecessors = Object.fromEntries(checked.chain.order.map((nodeId) => [
    nodeId,
    checked.chain.prev.get(nodeId) ?? null,
  ]));
  const run = workflowRunDocumentV1Schema.parse({
    state: "ready",
    runId: "run-storage-contract",
    workflowId: "release",
    activationId: "activation-storage-contract",
    occurrenceId: "occurrence-storage-contract",
    requestId: "request-storage-contract",
    admissionSequence: 1,
    admittedAt: "2026-10-05T12:00:00.000Z",
    sourceText,
    sourceHash,
    canonicalDefinition: checked.def,
    canonicalHash: canonicalHash(checked.def),
    resolvedSettings,
    chain: { order: checked.chain.order, predecessors },
    paths: {
      projectCwd: baseDir,
      workflowDirectory: join(baseDir, "state", "release"),
    },
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: HASH,
      taskVersions: {},
    },
    durable: { conversationId, workflowTaskId },
    status: "queued",
    desiredState: "running",
    startedAt: null,
    finishedAt: null,
    currentNodeId: "prepare-report",
    currentAttemptId: null,
    block: null,
    failure: null,
    preflight: { kind: "not_configured" },
    nodes: [{ nodeId: "prepare-report", status: "pending", successfulAttemptId: null, attempts: [] }],
    resolutions: [],
    terminalOutput: null,
  });
  if (run.state !== "ready") throw new Error("test fixture must be an admitted run");
  return run;
}

async function openHarness(path: string) {
  const opened = await openDurableStorage(path);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const registry = createRegistry();
  registry.install({ name: "workshop-storage-test", tasks: [StorageReceiptTask] });
  return Harness.open(opened.storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
}

describe("Durable storage records", () => {
  test("defines versioned installation and run documents plus typed immutable evidence", () => {
    expect(WorkshopInstallationDoc.definition).toMatchObject({
      kind: "workshop.installation", version: 1, scope: "session",
    });
    expect(WorkshopRunDoc.definition).toMatchObject({
      kind: "workshop.run", version: 1, scope: "conversation", history: "latest", fork: "initial",
    });
    expect(WorkshopEventEntry.kind).toBe("workshop.event");
    expect(sha256Schema.parse(HASH)).toBe(HASH);
    expect(installationDocumentV1Schema.parse({ state: "uninitialized" })).toEqual({ state: "uninitialized" });
    expect(workshopEventV1Schema.parse({
      version: 1,
      eventId: "event-storage-test",
      type: "run_admitted",
      runId: "run-storage-test",
      workflowId: "release",
      activationId: "activation-storage-test",
      occurrenceId: "occurrence-storage-test",
      admissionSequence: 1,
      canonicalHash: HASH,
      occurredAt: "2026-10-05T12:00:00.000Z",
    }).type).toBe("run_admitted");
    const index = workflowInstallationIndexSchema.parse({
      definitionHash: HASH,
      admissionHighWater: 1,
      openRunId: "run-storage-test",
      activations: [{
        activationId: "activation-storage-test", state: "active", admittedCount: 1,
        maxRuns: "unlimited", activatedAt: "2026-10-05T12:00:00.000Z", nextDueAt: null,
      }],
      occurrenceCounters: { "activation-storage-test": 1 },
      runs: [{
        runId: "run-storage-test", activationId: "activation-storage-test",
        occurrenceId: "occurrence-storage-test", conversationId: 12, workflowTaskId: 13,
        admissionSequence: 1, admittedAt: "2026-10-05T12:00:00.000Z",
        status: "queued", requestId: "request-storage-test",
      }],
      requestIndex: { "request-storage-test": "run-storage-test" },
      capacityReservations: ["run-storage-test"],
      preflightCache: {},
    });
    expect(String(index.openRunId)).toBe("run-storage-test");
    expect(() => workflowInstallationIndexSchema.parse({ ...index, openRunId: null }))
      .toThrow(/open-run pointer/);
    expect(workshopJudgmentV1Schema.parse({
      version: 1, runId: "run-storage-test", nodeId: "prepare-report", attemptId: "attempt-storage-test",
      judgmentId: "judgment-storage-test", conversationId: 12, taskId: 13,
      submissionRequestId: "request-judge-storage-test", recordedAt: "2026-10-05T12:00:00.000Z",
      phase: "decision_applied", decision: { action: "retry", reason: "retry within policy" },
      decidedAt: "2026-10-05T12:00:01.000Z",
      applicationReceipt: { eventId: "event-judgment-applied", appliedAt: "2026-10-05T12:00:02.000Z" },
    }).phase).toBe("decision_applied");
  });

  test("rejects inconsistent frozen run topology", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-run-contract-"));
    try {
      const run = fixtureRun(2, 3, directory);
      expect(run.status).toBe("queued");
      expect(() => workflowRunDocumentV1Schema.parse({
        ...run,
        chain: {
          order: ["prepare-report", "unknown-node"],
          predecessors: { "prepare-report": null, "unknown-node": "prepare-report" },
        },
      })).toThrow(/persisted nodes follow the frozen chain order/);
      expect(() => workflowRunDocumentV1Schema.parse({ ...run, sourceText: `${run.sourceText}# changed\\n` }))
        .toThrow(/source hash matches the exact retained UTF-8 bytes/);
      expect(() => workflowRunDocumentV1Schema.parse({ ...run, canonicalHash: HASH }))
        .toThrow(/canonical hash matches the frozen definition/);
      expect(() => workflowRunDocumentV1Schema.parse({
        ...run,
        canonicalDefinition: {
          ...run.canonicalDefinition,
          nodes: {
            "prepare-report": { ...run.canonicalDefinition.nodes["prepare-report"], next: "other-node" },
            "other-node": { run: { command: "echo other" }, next: null },
          },
        },
      })).toThrow(/chain snapshot matches the checked frozen topology/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts pre-dispatch pause/block and resolved preflight failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-run-lifecycle-"));
    try {
      const run = fixtureRun(2, 3, directory);
      const paused = workflowRunDocumentV1Schema.parse({
        ...run, status: "paused", desiredState: "paused",
      });
      expect(paused.state).toBe("ready");
      if (paused.state === "ready") expect(paused.startedAt).toBeNull();

      const beforeStartBlock = {
        blockId: "block-before-start", kind: "orchestrator_unavailable",
        reason: "orchestrator is unavailable", blockedAt: "2026-10-05T12:00:01.000Z",
        nodeId: null, attemptId: null,
      };
      const blockedBeforeStart = workflowRunDocumentV1Schema.parse({
        ...run, status: "blocked", desiredState: "running", block: beforeStartBlock,
      });
      expect(blockedBeforeStart.state).toBe("ready");
      if (blockedBeforeStart.state === "ready") expect(blockedBeforeStart.startedAt).toBeNull();

      const preflightBlock = {
        blockId: "block-preflight", kind: "preflight_failed",
        reason: "preflight command exited with status 2", blockedAt: "2026-10-05T12:00:01.000Z",
        nodeId: null, attemptId: null,
      };
      const preflight = {
        kind: "failed", cacheKeyHash: HASH,
        failure: {
          kind: "runtime_fault", message: "preflight command exited with status 2",
          failedAt: "2026-10-05T12:00:01.000Z", nodeId: null, attemptId: null,
        },
        block: preflightBlock, processExecutionIds: [],
      };
      const failedPreflight = workflowRunDocumentV1Schema.parse({
        ...run, status: "blocked", startedAt: "2026-10-05T12:00:00.500Z",
        block: preflightBlock, preflight,
      });
      expect(failedPreflight.state).toBe("ready");
      if (failedPreflight.state !== "ready") throw new Error("preflight fixture is not admitted");
      expect(() => workflowRunDocumentV1Schema.parse({ ...failedPreflight, block: null }))
        .toThrow(/unresolved preflight failure remains the current run block/);

      const cancelledAfterPreflight = workflowRunDocumentV1Schema.parse({
        ...failedPreflight, status: "cancelled", desiredState: "stopped",
        finishedAt: "2026-10-05T12:00:02.000Z", block: null,
      });
      expect(cancelledAfterPreflight.state).toBe("ready");
      if (cancelledAfterPreflight.state === "ready") {
        expect(cancelledAfterPreflight.preflight.kind).toBe("failed");
        expect(cancelledAfterPreflight.block).toBeNull();
      }

      const resolution = {
        action: "fail", resolutionId: "resolution-preflight-fail",
        provenance: "operator", reason: "stop after failed preflight",
        resolvedAt: "2026-10-05T12:00:02.000Z", processGroupsConfirmedDead: true,
        sourceBlock: preflightBlock,
      };
      const failedAfterPreflight = workflowRunDocumentV1Schema.parse({
        ...failedPreflight, status: "failed", desiredState: "stopped",
        finishedAt: "2026-10-05T12:00:03.000Z", block: null,
        failure: {
          kind: "operator", resolutionId: resolution.resolutionId, provenance: "operator",
          reason: resolution.reason, failedAt: "2026-10-05T12:00:03.000Z",
          processGroupsConfirmedDead: true, sourceBlock: preflightBlock,
        },
        resolutions: [resolution],
      });
      expect(failedAfterPreflight.state).toBe("ready");
      if (failedAfterPreflight.state === "ready") {
        expect(failedAfterPreflight.preflight.kind).toBe("failed");
        expect(failedAfterPreflight.block).toBeNull();
        expect(failedAfterPreflight.failure?.kind).toBe("operator");
        expect(failedAfterPreflight.resolutions[0]?.action).toBe("fail");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains run documents and evidence after an owned task settles and SQLite reopens", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-durable-records-"));
    const databasePath = join(directory, "durable.db");
    let harness: Awaited<ReturnType<typeof openHarness>> | undefined;
    try {
      harness = await openHarness(databasePath);
      const installation = installationDocumentV1Schema.parse({
        state: "ready",
        installationId: "installation-storage-test",
        maxConcurrentRuns: 1,
        workflows: {},
      });
      await harness.commit(async (tx) => {
        const doc = await tx.doc(WorkshopInstallationDoc);
        Object.assign(doc, installation);
      }, BACKGROUND_CONTEXT);

      let workflowTaskId: import("@earendil-works/pi-durable").TaskId<ReceiptResult> | undefined;
      const conversation = await harness.createConversation({
        ownership: { kind: "ownerless" },
        init: async (tx, conversationId) => {
          const taskId = await tx.createTask(
            StorageReceiptTask,
            {},
            { ownership: { kind: "conversation" }, conversationId },
          );
          workflowTaskId = taskId;
          const run = fixtureRun(conversationId, taskId, directory);
          const runDoc = await tx.doc(WorkshopRunDoc, conversationId);
          Object.assign(runDoc, run);
          const admittedEvent = workshopEventV1Schema.parse({
            version: 1,
            eventId: "event-storage-admitted",
            type: "run_admitted",
            runId: run.runId,
            workflowId: run.workflowId,
            activationId: run.activationId,
            occurrenceId: run.occurrenceId,
            admissionSequence: run.admissionSequence,
            canonicalHash: run.canonicalHash,
            occurredAt: run.admittedAt,
          });
          await tx.appendEntry(WorkshopEventEntry, conversationId, { data: admittedEvent });
        },
      }, BACKGROUND_CONTEXT);
      if (workflowTaskId === undefined) throw new Error("test conversation did not create its owned task");

      harness.resume();
      const settled = await harness.waitForTask(workflowTaskId, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      expect(settled.state.outcome.status).toBe("completed");
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      harness = await openHarness(databasePath);
      const runDoc = await harness.snapshot(WorkshopRunDoc, conversation.id, BACKGROUND_CONTEXT);
      expect(runDoc?.state).toBe("ready");
      if (runDoc?.state !== "ready") throw new Error("reopened run document is absent or uninitialized");
      expect(String(runDoc.runId)).toBe("run-storage-contract");
      expect(runDoc.durable.workflowTaskId).toBe(workflowTaskId);
      const installationAfterReopen = await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT);
      expect(installationAfterReopen?.state).toBe("ready");
      const reopenedConversation = await harness.conversation(conversation.id, BACKGROUND_CONTEXT);
      if (reopenedConversation === undefined) throw new Error("run conversation was not retained");
      const entries = await reopenedConversation.entries({}, 10, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.some((entry) => WorkshopEventEntry.is(entry))).toBe(true);
    } finally {
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("truncates an idle WAL without losing committed rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-wal-checkpoint-"));
    const databasePath = join(directory, "durable.db");
    const database = await openNodeSqliteDatabase(databasePath, { walAutoCheckpointPages: 0 });
    try {
      await database.exec("PRAGMA synchronous = FULL; CREATE TABLE wal_fixture (value BLOB NOT NULL);");
      const value = new Uint8Array(256 * 1024).fill(0x5a);
      await database.transaction(async (transaction) => {
        for (let index = 0; index < 32; index++) {
          await transaction.run("INSERT INTO wal_fixture (value) VALUES (?)", value);
        }
      });

      const walPath = `${databasePath}-wal`;
      expect(statSync(walPath).size).toBeGreaterThan(0);
      expect(await checkpointDurableWal(databasePath)).toBe(true);
      expect(statSync(walPath).size).toBe(0);
      expect(await database.get<{ rowCount: number }>("SELECT COUNT(*) AS rowCount FROM wal_fixture"))
        .toEqual({ rowCount: 32 });
    } finally {
      await database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
