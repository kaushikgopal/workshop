import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, LiveDoc, UserEntry, GenerationTask } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { openPausedServiceRuntime } from "../src/service/open-service-runtime.js";
import {
  createServiceRecoveryManifestV1,
  serviceRecoveryManifestDigestV1,
  serviceRecoveryManifestV1Schema,
} from "../src/service/schema-recovery.js";
import { serviceMetadataV1Schema } from "../src/service/schema.js";
import { defineWorkshopTasks } from "../src/storage/durable/define-workshop-tasks.js";
import { WorkshopBotDoc, WorkshopInstallationDoc } from "../src/storage/durable/define-workshop-records.js";
import { processExecutionTaskInputSchema } from "../src/storage/durable/define-process-execution-task.js";
import { admitRecoveryIntent, initializeRecoveryIndex } from "../src/storage/durable/commit-recovery-intent.js";
import { inspectServiceRecovery } from "../src/service/inspect-service-recovery.js";
import { applyRecoveryInstallation } from "../src/service/recover-service-tasks.js";
import type { PausedWorkshopServiceRuntime } from "../src/service/open-service-runtime.js";

const EMPTY_SHA256 = `sha256:${createHash("sha256").update("").digest("hex")}`;

describe("paused service recovery inspection", () => {
  test("creates a stable canonical digest that changes with the payload", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const manifest = await inspectServiceRecovery(runtime, installation);
      const { digest, ...payload } = manifest;

      expect(serviceRecoveryManifestDigestV1(payload)).toBe(digest);
      await Bun.sleep(5);
      const repeated = await inspectServiceRecovery(runtime, installation);
      expect(repeated.createdAt).not.toBe(manifest.createdAt);
      expect(repeated.digest).toBe(digest);

      const changedPayload = { ...payload, stateDirectoryHash: `sha256:${"0".repeat(64)}` };
      expect(serviceRecoveryManifestDigestV1(changedPayload)).not.toBe(digest);
      expect(serviceRecoveryManifestV1Schema.safeParse({ ...manifest, complete: !manifest.complete }).success).toBe(false);
      expect(createServiceRecoveryManifestV1(payload).digest).toBe(digest);
    });
  });

  test("reports an active request without withholding a fresh action policy", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const { taskId, conversationId } = await createProcessTask(runtime, installation.stateDirectory, true);
      await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT });
      const before = await inspectServiceRecovery(runtime, installation);
      const task = before.tasks.find((candidate) => candidate.taskId === taskId)!;
      expect(task.policy.permittedActions).toContain("abort");
      const requestId = randomUUID();
      const admitted = await admitRecoveryIntent({
        harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId,
        manifestDigest: before.digest, reason: "review", confirmedAt: new Date().toISOString(),
        resumeInstallation: true, actions: [{
          taskId, taskKind: task.kind, taskVersion: task.version, action: "abort",
          owner: { conversationId, taskOwnerId: null, conversationOwner: null, ownershipHash: EMPTY_SHA256 },
          inputHash: task.inputHash, checkpointHash: task.checkpointHash!, process: null, replaySafety: "unknown",
        }],
      });
      expect(admitted.kind).toBe("admitted");
      const after = await inspectServiceRecovery(runtime, installation);
      expect(after.activeRequest?.requestId).toBe(requestId);
      expect(after.complete).toBe(true);
      expect(after.tasks.find((candidate) => candidate.taskId === taskId)?.policy).toEqual(task.policy);
      const { digest, ...payload } = after;
      expect(serviceRecoveryManifestDigestV1({
        ...payload, activeRequest: { ...payload.activeRequest!, createdAt: "2000-01-01T00:00:00.000Z" },
      })).toBe(digest);
    });
  });

  test("inspects a paused service without invoking progress APIs", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const calls: string[] = [];
      const harness = runtime.harness as any;
      for (const name of ["resume", "retryTask", "abortTask"]) {
        const original = harness[name].bind(harness);
        harness[name] = (...args: unknown[]) => {
          calls.push(name);
          return original(...args);
        };
      }

      const manifest = await inspectServiceRecovery(runtime, installation);

      expect(manifest.scheduling).toBe("paused");
      expect(manifest.limitations).toEqual([]);
      expect(manifest.tasks).toEqual([]);
      expect(calls).toEqual([]);
      expect((await runtime.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
    });
  });

  test("fails closed for unknown ownership and reports only intent-stage process evidence", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const { taskId } = await createProcessTask(runtime, installation.stateDirectory, false);
      const manifest = await inspectServiceRecovery(runtime, installation);
      const task = manifest.tasks.find((candidate) => candidate.taskId === taskId);

      expect(manifest.complete).toBe(false);
      expect(manifest.limitations).toContain("attribution_incomplete");
      expect(task).toBeDefined();
      expect(task?.processEvidence).toEqual({
        checkpointPhase: "intent",
        identityKnown: false,
        processStatus: null,
        launchBootIdPresent: false,
      });
      expect(task?.policy.abortEvidence).toBeNull();
      expect(task?.policy.abortUnavailableReason).toBe("unknown_ownership");
      expect(task?.policy.permittedActions).not.toContain("abort");
      expect(task?.policy.permittedActions).not.toContain("retry");
      expect(task?.policy.retryUnavailableReason).toBe("not_restart_limited");
    });
  });

  test("unknown ownership cannot release unrelated ready tasks", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const unknown = await createProcessTask(runtime, installation.stateDirectory, false);
      const unrelated = await createProcessTask(runtime, installation.stateDirectory, true);
      const unrelatedBefore = await runtime.harness.getTask(unrelated.taskId as never, BACKGROUND_CONTEXT);
      if (unrelatedBefore === undefined) throw new Error("unrelated ready task is missing");
      const manifest = await inspectServiceRecovery(runtime, installation);
      expect(manifest.complete).toBe(false);
      expect(manifest.limitations).toContain("attribution_incomplete");
      expect(manifest.tasks.find((task) => task.taskId === unknown.taskId)?.attribution.kind).toBe("unknown");
      expect(manifest.tasks.find((task) => task.taskId === unrelated.taskId)?.attribution.kind).toBe("bot");

      const originalOpen = Harness.open;
      let resumeCalls = 0;
      Harness.open = async (storage, options, context) => {
        const harness = await originalOpen(storage, options, context);
        const resume = harness.resume.bind(harness);
        Object.defineProperty(harness, "resume", {
          configurable: true,
          value: () => { resumeCalls += 1; return resume(); },
        });
        return harness;
      };
      let confirmationCalls = 0;
      try {
        await expect(applyRecoveryInstallation(installation, {
          requestId: randomUUID(), diagnosticDigest: manifest.digest, actions: [],
          resumeInstallation: true, reason: "review ownership", supersedesRequestId: null,
        }, {
          isTerminal: () => true,
          readConfirmation: async () => { confirmationCalls += 1; return "unused"; },
          write: () => {},
        })).rejects.toMatchObject({ code: "inspection_incomplete" });
      } finally {
        Harness.open = originalOpen;
      }
      const unrelatedAfter = await runtime.harness.getTask(unrelated.taskId as never, BACKGROUND_CONTEXT);
      expect(confirmationCalls).toBe(0);
      expect(resumeCalls).toBe(0);
      expect(unrelatedAfter?.state).toEqual(unrelatedBefore.state);
    });
  });

  test("marks an allowlisted restart-limited task retry-safe but withholds retry when ownership is unverified", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const { taskId } = await createProcessTask(runtime, installation.stateDirectory, false);
      const harness = runtime.harness as any;
      const inspect = harness.inspect.bind(harness);
      harness.inspect = async (context: unknown) => {
        const current = await inspect(context);
        return {
          ...current,
          tasks: current.tasks.map((task: any) => ({
            ...task,
            record: {
              ...task.record,
              kind: "workshop.workflow-run",
              version: 11,
              state: { ...task.record.state, status: "blocked" },
            },
            state: { kind: "blocked", reason: "restart_limit" },
          })),
        };
      };
      const manifest = await inspectServiceRecovery(runtime, installation);
      const task = manifest.tasks.find((candidate) => candidate.taskId === taskId);

      expect(task?.policy.retryEligibility).toBe("safe");
      expect(task?.policy.retryUnavailableReason).toBeNull();
      expect(task?.attribution.kind).toBe("unknown");
      expect(task?.policy.permittedActions).not.toContain("retry");
    });
  });

  test("blocks abort when a queued submission shares the task conversation", async () => {
    await withPausedRuntime(async ({ runtime, installation }) => {
      const { taskId, conversationId } = await createProcessTask(runtime, installation.stateDirectory, true);
      const harness = runtime.harness as any;
      const inspect = harness.inspect.bind(harness);
      harness.inspect = async (context: unknown) => {
        const current = await inspect(context);
        const submission = {
          id: 900_001 as (typeof current.submissions)[number]["id"],
          conversationId: conversationId as (typeof current.submissions)[number]["conversationId"],
          status: "queued",
        } as (typeof current.submissions)[number];
        return { ...current, submissions: [submission] };
      };

      const manifest = await inspectServiceRecovery(runtime, installation);
      const task = manifest.tasks.find((candidate) => candidate.taskId === taskId);

      expect(task?.attribution).toEqual({ kind: "bot" });
      expect(task?.policy.pendingSubmissionCount).toBe(1);
      expect(task?.policy.abortUnavailableReason).toBe("pending_submission");
      expect(task?.policy.permittedActions).not.toContain("abort");
      expect(manifest.queuedSubmissions).toEqual([{
        submissionId: 900_001,
        conversationId,
        state: "queued",
      }]);
    });
  });
});

async function withPausedRuntime(
  run: (fixture: { readonly runtime: PausedWorkshopServiceRuntime; readonly installation: ReturnType<typeof loadInstallation> }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workshop-recovery-inspection-"));
  const config = join(root, ".workshop");
  mkdirSync(join(config, "workflows"), { recursive: true });
  writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n", "utf8");
  const installation = loadInstallation(root);
  const metadata = serviceMetadataV1Schema.parse({
    version: 1,
    status: "starting",
    pid: process.pid,
    startIdentity: "recovery-inspection-test",
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
    socketPath: join(installation.stateDirectory, "service.sock"),
  });
  const runtime = await openPausedServiceRuntime(installation, metadata, createModels());
  try {
    await runtime.harness.commit(async (tx) => {
      const document = await tx.doc(WorkshopInstallationDoc);
      Object.assign(document, { state: "ready", installationId: randomUUID(), maxConcurrentRuns: 1, workflows: {} });
    }, BACKGROUND_CONTEXT);
    await run({ runtime, installation });
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function createProcessTask(
  runtime: PausedWorkshopServiceRuntime,
  stateDirectory: string,
  botOwned: boolean,
): Promise<{ readonly taskId: number; readonly conversationId: number }> {
  const task = defineWorkshopTasks().ProcessExecutionTask;
  let taskId = 0;
  const conversation = await runtime.harness.createConversation({
    ownership: { kind: "ownerless" },
    init: async (tx, conversationId) => {
      const input = processExecutionTaskInputSchema.parse({
        runId: randomUUID(),
        workflowId: "recovery-inspection",
        activationId: randomUUID(),
        occurrenceId: randomUUID(),
        workflowTaskId: 1,
        nodeTaskId: 2,
        nodeId: null,
        attemptId: null,
        executionId: randomUUID(),
        incarnationId: randomUUID(),
        incarnationNumber: 1,
        serviceBootId: randomUUID(),
        role: "preflight",
        ioVersion: 1,
        stdinSha256: EMPTY_SHA256,
        stdinByteCount: 0,
        launchIntentAt: new Date().toISOString(),
        deadlineAt: null,
        shell: "/bin/sh",
        command: "true",
        cwd: stateDirectory,
        timeoutMs: null,
        streamCapBytes: 1024,
        replay: "never",
        stdoutPath: join(stateDirectory, "stdout.txt"),
        stderrPath: join(stateDirectory, "stderr.txt"),
        env: {},
      });
      taskId = Number(await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId }));
    },
  }, BACKGROUND_CONTEXT);

  if (botOwned) {
    await runtime.harness.commit(async (tx) => {
      const bot = await tx.doc(WorkshopBotDoc);
      Object.assign(bot, {
        state: "ready",
        conversationId: Number(conversation.id),
        cursorInitialized: false,
        eventCursors: {},
      });
    }, BACKGROUND_CONTEXT);
  }

  return { taskId, conversationId: Number(conversation.id) };
}
