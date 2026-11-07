import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, GenerationTask, Harness, LiveDoc, UserEntry, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, test } from "bun:test";
import { loadInstallation, type Installation } from "../src/installation/load-installation.js";
import { processIncarnationSchema } from "../src/process/schema.js";
import { verifyProcessDeath } from "../src/process/verify-process-death.js";
import { acquireServiceLock, ServiceOwnershipConflict } from "../src/service/acquire-service-lock.js";
import { openPausedServiceRuntime, startWorkshopService } from "../src/service/open-service-runtime.js";
import { applyRecoveryInstallation, inspectRecoveryInstallation, readRecoveryReceipt, RecoveryRefusal } from "../src/service/recover-service-tasks.js";
import { ServiceShutdownError, type WorkshopServiceOwner } from "../src/service/serve-workshop-service.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { serviceStartResultV1Schema } from "../src/service/schema.js";
import {
  admitRecoveryIntent,
  initializeRecoveryIndex,
  markRecoveryActionDispatching,
  markRecoveryGlobalDispatching,
  recordRecoveryActionReceipt,
  recordRecoveryDeathEvidence,
  recordRecoveryGlobalDispatchReceipt,
  settleRecoveryAction,
} from "../src/storage/durable/commit-recovery-intent.js";
import { WorkshopRecoveryIndexDoc, WorkshopRecoveryRequestDoc } from "../src/storage/durable/define-recovery-records.js";
import { processExecutionTaskInputSchema, recoverRetainedProcessCaptureRecords } from "../src/storage/durable/define-process-execution-task.js";
import { WorkshopBotDoc, WorkshopInstallationDoc } from "../src/storage/durable/define-workshop-records.js";
import type { RecoveryActionIntentV1 } from "../src/storage/durable/schema-recovery.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { retainStreamWindow } from "../src/storage/disk/cap-streams.js";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { REPO_ROOT } from "./helpers.js";

const HASH = `sha256:${"a".repeat(64)}`;

  test("startup refuses a malformed latest process entry despite earlier valid evidence", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      const database = await openNodeSqliteDatabase(fixture.installation.databasePath);
      try {
        const entries = await database.all<{ id: number; record: string }>(
          "SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id", fixture.processConversationId,
        );
        const processEntries = entries.filter((entry) => {
          const record = JSON.parse(entry.record) as { kind?: unknown };
          return record.kind === "workshop.process";
        });
        expect(processEntries.length).toBeGreaterThan(1);
        const latest = processEntries.at(-1);
        if (latest === undefined) throw new Error("process evidence entries are missing");
        const record = JSON.parse(latest.record) as Record<string, unknown>;
        const { data: _data, ...withoutData } = record;
        await database.run("UPDATE entries SET record = ? WHERE id = ?", JSON.stringify(withoutData), latest.id);
      } finally {
        await database.close();
      }
      const manifest = await inspectRecoveryInstallation(fixture.installation);
      expect(manifest.complete).toBe(false);
      expect(manifest.limitations).toContain("process_evidence_unavailable");
      const startup = Bun.spawn([process.execPath, join(REPO_ROOT, "src/cli/main.ts"), "service", "serve"], {
        cwd: fixture.installation.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [status, error] = await Promise.all([startup.exited, new Response(startup.stderr).text()]);
      expect(status).not.toBe(0);
      expect(error).toContain("Durable startup was refused");
      const diagnostic = JSON.parse(readFileSync(join(fixture.installation.stateDirectory, "startup-failure.json"), "utf8")) as { limitations?: string[] };
      expect(diagnostic.limitations).toContain("process_evidence_uncertain");
    });
  }, 20_000);

  test("retained captures do not authorize process-death evidence", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      const manifest = await inspectRecoveryInstallation(fixture.installation);
      const requestId = randomUUID();
      const result = await applyRecoveryInstallation(fixture.installation, {
        requestId, diagnosticDigest: manifest.digest, actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the dead process", supersedesRequestId: null,
      }, confirmingTerminal(requestId, manifest.digest));
      if (result.owner === null) throw new Error("successful apply did not promote a service owner");
      fixture.owner = result.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;

      const database = await openNodeSqliteDatabase(fixture.installation.databasePath);
      try {
        const taskRow = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", fixture.processTaskId);
        if (taskRow === undefined) throw new Error("process task row is missing");
        const task = JSON.parse(taskRow.record) as { input: unknown };
        const input = processExecutionTaskInputSchema.parse(task.input);
        if (input.streamCapBytes === "unlimited") throw new Error("fixture requires bounded process captures");
        mkdirSync(dirname(input.stderrPath), { recursive: true });
        writeFileSync(input.stderrPath, Buffer.alloc(input.streamCapBytes + 64, "x"));
        retainStreamWindow(input.stderrPath, input.streamCapBytes);
        const captures = await recoverRetainedProcessCaptureRecords(input);
        expect(captures.length).toBeGreaterThan(0);
        const entries = await database.all<{ id: number; record: string }>(
          "SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id", fixture.processConversationId,
        );
        let updated = 0;
        for (const entry of entries) {
          const record = JSON.parse(entry.record) as Record<string, unknown>;
          if (record.kind !== "workshop.process" || typeof record.data !== "object" || record.data === null) continue;
          const data = record.data as Record<string, unknown>;
          if (data.taskId !== fixture.processTaskId || data.runId !== input.runId) continue;
          const process = processIncarnationSchema.safeParse(data.process);
          if (!process.success || process.data.executionId !== input.executionId || process.data.incarnationId !== input.incarnationId) continue;
          const uncertain = processIncarnationSchema.parse({
            ...process.data, status: "blocked", finishedAt: null, exit: null, cleanupState: "unconfirmed", captures,
          });
          await database.run("UPDATE entries SET record = ? WHERE id = ?", JSON.stringify({
            ...record, data: { ...data, process: uncertain },
          }), entry.id);
          updated += 1;
        }
        expect(updated).toBeGreaterThan(0);
      } finally {
        await database.close();
      }

      let startupError: unknown;
      try { fixture.owner = await startWorkshopService(fixture.installation, fixture.models); }
      catch (error) { startupError = error; }
      expect(startupError).toBeInstanceOf(ServiceShutdownError);
      if (fixture.owner !== undefined) {
        await fixture.owner.shutdown();
        fixture.owner = undefined;
        throw new Error("startup accepted retained captures without death proof");
      }
    });
  }, 25_000);
describe("local service recovery", () => {
  test("inspection holds the service lock and never resumes scheduling", async () => {
    await withInstallation(async (installation) => {
      const manifest = await inspectRecoveryInstallation(installation);
      expect(manifest.scheduling).toBe("paused");
      expect(manifest.complete).toBe(true);
      expect(manifest.tasks).toEqual([]);
      const lock = acquireServiceLock(join(installation.stateDirectory, "service.lock"));
      try {
        await expect(inspectRecoveryInstallation(installation)).rejects.toBeInstanceOf(ServiceOwnershipConflict);
      } finally {
        lock.release();
      }
    });
  });

  test("unchanged state has the same diagnostic digest across inspections", async () => {
    await withInstallation(async (installation) => {
      const first = await inspectRecoveryInstallation(installation);
      await Bun.sleep(10);
      const second = await inspectRecoveryInstallation(installation);
      expect(second.digest).toBe(first.digest);
    });
  });

  test("a wrong typed confirmation cannot admit a recovery intent", async () => {
    await withInstallation(async (installation) => {
      const manifest = await inspectRecoveryInstallation(installation);
      const requestId = randomUUID();
      let prompts = 0;
      await expect(applyRecoveryInstallation(installation, {
        requestId, diagnosticDigest: manifest.digest, actions: [], resumeInstallation: true,
        reason: "reviewed", supersedesRequestId: null,
      }, {
        isTerminal: () => true,
        readConfirmation: async () => { prompts += 1; return "incorrect"; },
        write: () => {},
      })).rejects.toMatchObject({ code: "confirmation_mismatch" });
      expect(prompts).toBe(1);
      await withRuntime(installation, async (runtime) => {
        const index = await runtime.harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
        expect(index?.state).toBe("ready");
        if (index?.state !== "ready") throw new Error("recovery index was not initialized");
        expect(index.activeRequestId).toBeNull();
        expect(index.requests[requestId]).toBeUndefined();
      });
    });
  });

  test("a wrong diagnostic refuses before confirmation or intent", async () => {
    await withInstallation(async (installation) => {
      const manifest = await inspectRecoveryInstallation(installation);
      const requestId = randomUUID();
      let prompts = 0;
      await expect(applyRecoveryInstallation(installation, {
        requestId, diagnosticDigest: HASH, actions: [], resumeInstallation: true,
        reason: "reviewed", supersedesRequestId: null,
      }, {
        isTerminal: () => true,
        readConfirmation: async () => { prompts += 1; return "unused"; },
        write: () => {},
      })).rejects.toMatchObject({ code: "diagnostic_changed" });
      expect(prompts).toBe(0);
      await withRuntime(installation, async (runtime) => {
        const index = await runtime.harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
        expect(index?.state).toBe("ready");
        if (index?.state !== "ready") throw new Error("recovery index was not initialized");
        expect(index.activeRequestId).toBeNull();
        expect(index.requests[requestId]).toBeUndefined();
      });
      expect(manifest.complete).toBe(true);
    });
  });


  test("receipt shows an interrupted dispatch as indeterminate without writing the journal", async () => {
    await withInstallation(async (installation) => {
      const requestId = randomUUID();
      await withRuntime(installation, async (runtime) => {
        await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT });
        const admitted = await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId, manifestDigest: HASH,
          reason: "reviewed", confirmedAt: new Date().toISOString(), resumeInstallation: true,
          actions: [{ taskId: 1, taskKind: "workshop.test", taskVersion: 1, action: "abort",
            owner: { conversationId: 1, taskOwnerId: null, conversationOwner: null, ownershipHash: HASH },
            inputHash: HASH, checkpointHash: HASH, process: null, replaySafety: "unknown" }],
        });
        expect(admitted.kind).toBe("admitted");
        expect((await markRecoveryActionDispatching({ harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId, taskId: 1 })).kind).toBe("updated");
      });
      const receipt = await readRecoveryReceipt(installation, requestId);
      expect(receipt).toMatchObject({ version: 1, requestId, state: "active", actions: [{ taskId: 1, state: "indeterminate", dispatch: "indeterminate" }] });
      await withRuntime(installation, async (runtime) => {
        const request = await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, requestId, BACKGROUND_CONTEXT);
        expect(request?.actions[0]?.state).toBe("dispatching");
      });
    });
  });

  test("retires a dead prior-boot process and promotes the same runtime", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      const manifest = await inspectRecoveryInstallation(fixture.installation);
      const required = recoveryRequiredTasks(manifest);
      expect(required.map((task) => task.taskId)).toEqual([fixture.processTaskId]);
      expect(required[0]?.policy.permittedActions).toContain("abort");
      const requestId = randomUUID();
      const result = await applyRecoveryInstallation(fixture.installation, {
        requestId, diagnosticDigest: manifest.digest, actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the dead process", supersedesRequestId: null,
      }, confirmingTerminal(requestId, manifest.digest));
      if (result.owner === null) throw new Error("successful apply did not promote a service owner");
      fixture.owner = result.owner;
      expect(result.receipt).toMatchObject({
        requestId, state: "complete",
        actions: [{ taskId: fixture.processTaskId, action: "abort", state: "settled", evidence: "confirmed_dead", dispatch: "applied" }],
      });
      expect(await probeServiceHealth(fixture.installation.stateDirectory)).toMatchObject({ kind: "ready" });
      expect(existsSync(fixture.processMarkerPath)).toBe(false);
      await fixture.owner!.shutdown();
      fixture.owner = undefined;
    });
  }, 20_000);


  test("verifies a retained terminal process entry before unrelated work starts", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      fixture.state.trackAbortCalls = true;
      const firstManifest = await inspectRecoveryInstallation(fixture.installation);
      const firstRequestId = randomUUID();
      const first = await applyRecoveryInstallation(fixture.installation, {
        requestId: firstRequestId, diagnosticDigest: firstManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the active process", supersedesRequestId: null,
      }, confirmingTerminal(firstRequestId, firstManifest.digest));
      if (first.owner === null) throw new Error("initial recovery did not promote a service owner");
      fixture.owner = first.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;
      expect(fixture.state.abortTaskCalls).toBe(1);

      const database = await openNodeSqliteDatabase(fixture.installation.databasePath);
      try {
        const taskRow = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", fixture.processTaskId);
        if (taskRow === undefined) throw new Error("process task row is missing");
        const processInput = processExecutionTaskInputSchema.parse((JSON.parse(taskRow.record) as { input: unknown }).input);
        const entries = await database.all<{ id: number; record: string }>(
          "SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id", fixture.processConversationId,
        );
        const latest = entries.filter((entry) => {
          const record = JSON.parse(entry.record) as { kind?: unknown; data?: { taskId?: unknown; runId?: unknown } };
          return record.kind === "workshop.process" && record.data?.taskId === fixture.processTaskId
            && record.data.runId === processInput.runId;
        }).at(-1);
        if (latest === undefined) throw new Error("retained process evidence is missing");
        const record = JSON.parse(latest.record) as Record<string, unknown> & { data: Record<string, unknown> };
        const process = processIncarnationSchema.parse(record.data.process);
        const unresolved = processIncarnationSchema.parse({ ...process, cleanupState: "unconfirmed" });
        await database.run("UPDATE entries SET record = ? WHERE id = ?", JSON.stringify({
          ...record, data: { ...record.data, process: unresolved },
        }), latest.id);
      } finally {
        await database.close();
      }

      const faux = fauxProvider({ provider: "recovery-order-fixture", models: [{ id: "marker" }] });
      fixture.models.setProvider(faux.provider);
      const generationMarker = join(fixture.root, "retired-process-generation.txt");
      const generationTaskId = await seedUnrelatedGeneration(fixture.installation, fixture.models);
      const manifest = await inspectRecoveryInstallation(fixture.installation);
      expect(manifest.complete).toBe(true);
      expect(manifest.tasks.some((task) => task.taskId === generationTaskId)).toBe(true);
      expect(manifest.processIncarnations).toContainEqual(expect.objectContaining({
        taskId: fixture.processTaskId, action: "verify_retired",
      }));
      let taskOutcomeHash = "";
      await withRuntime(fixture.installation, async (runtime) => {
        const task = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (task === undefined || task.state.status !== "terminal") throw new Error("process task is not terminal");
        taskOutcomeHash = canonicalHash(task.state.outcome);
      });
      let evidenceCommittedBeforeGeneration = false;
      faux.setResponses([async () => {
        const harness = fixture.state.harness;
        if (harness === undefined) throw new Error("recovery Harness was not captured");
        const index = await harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
        if (index?.state !== "ready" || index.requests[requestId] === undefined) throw new Error("recovery intent was not committed before generation");
        const request = await harness.snapshot(WorkshopRecoveryRequestDoc, requestId, BACKGROUND_CONTEXT);
        const action = request?.actions.find((entry) => entry.taskId === fixture.processTaskId);
        if (action?.action !== "verify_retired" || action.state !== "settled"
          || action.deathEvidence?.kind !== "confirmed_dead") {
          throw new Error("terminal process evidence was not verified and settled before generation");
        }
        evidenceCommittedBeforeGeneration = true;
        appendFileSync(generationMarker, "generated\n", "utf8");
        return fauxAssistantMessage("unrelated generation completed");
      }]);
      const requestId = randomUUID();
      const result = await applyRecoveryInstallation(fixture.installation, {
        requestId, diagnosticDigest: manifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "verify_retired" }],
        resumeInstallation: true, reason: "verify the retained terminal process", supersedesRequestId: null,
      }, confirmingTerminal(requestId, manifest.digest));
      if (result.owner === null) throw new Error("retirement verification did not promote a service owner");
      fixture.owner = result.owner;
      expect(result.receipt).toMatchObject({
        requestId, state: "complete", globalDispatch: "applied",
        actions: [{ taskId: fixture.processTaskId, action: "verify_retired", state: "settled",
          evidence: "confirmed_dead", dispatch: "not_started" }],
      });
      expect(fixture.state.abortTaskCalls).toBe(1);
      const generated = await waitForFile(generationMarker, 3_000);
      if (!generated) {
        const task = await fixture.state.harness?.getTask(generationTaskId as never, BACKGROUND_CONTEXT);
        throw new Error(`unrelated generation did not run: ${JSON.stringify(task?.state)}`);
      }
      expect(generated).toBe(true);
      expect(evidenceCommittedBeforeGeneration).toBe(true);
      const task = await fixture.state.harness!.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
      if (task === undefined || task.state.status !== "terminal") throw new Error("process task ceased to be terminal");
      expect(canonicalHash(task.state.outcome)).toBe(taskOutcomeHash);
      await fixture.owner.shutdown();
      fixture.owner = undefined;
    });
  }, 25_000);

  test("supersedes a retry-applied request after its global receipt", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      fixture.state.trackAbortCalls = true;
      const firstManifest = await inspectRecoveryInstallation(fixture.installation);
      const firstRequestId = randomUUID();
      const first = await applyRecoveryInstallation(fixture.installation, {
        requestId: firstRequestId, diagnosticDigest: firstManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the active process", supersedesRequestId: null,
      }, confirmingTerminal(firstRequestId, firstManifest.digest));
      if (first.owner === null) throw new Error("initial recovery did not promote a service owner");
      fixture.owner = first.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;
      expect(fixture.state.abortTaskCalls).toBe(1);

      fixture.state.trackRetryCalls = true;
      const retryRequestId = randomUUID();
      await withRuntime(fixture.installation, async (runtime) => {
        const task = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (task === undefined || task.state.status !== "terminal") throw new Error("retry task is not terminal");
        const action = await recoveryActionIntentForTask(runtime.harness, fixture.processTaskId, "retry", "safe");
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: retryRequestId, manifestDigest: HASH,
          reason: "retain an applied retry before readiness commit",
          confirmedAt: new Date(Date.now() - 10_000).toISOString(), resumeInstallation: true, actions: [action],
        })).kind).toBe("admitted");
        expect((await markRecoveryGlobalDispatching({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: retryRequestId, firstRetryTaskId: fixture.processTaskId,
        })).kind).toBe("updated");
        await runtime.harness.retryTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        const retried = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (retried === undefined || retried.state.status !== "terminal") throw new Error("retry fixture task did not remain terminal");
        expect((await recordRecoveryGlobalDispatchReceipt({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: retryRequestId, method: "retryTask",
          taskId: fixture.processTaskId, taskSnapshotHash: canonicalHash({
            id: Number(retried.id), kind: retried.kind, version: retried.version, state: retried.state,
          }),
        })).kind).toBe("updated");
        const interrupted = await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, retryRequestId, BACKGROUND_CONTEXT);
        expect(interrupted?.globalDispatch).toMatchObject({ state: "applied", receipt: { method: "retryTask", taskId: fixture.processTaskId } });
      });

      const manifest = await inspectRecoveryInstallation(fixture.installation);
      expect(manifest.complete).toBe(true);
      expect(manifest.activeRequest?.requestId).toBe(retryRequestId);
      const retryReceipt = await readRecoveryReceipt(fixture.installation, retryRequestId);
      expect(retryReceipt).toMatchObject({ state: "active", globalDispatch: "applied", actions: [
        { taskId: fixture.processTaskId, action: "retry", state: "applied", dispatch: "applied" },
      ] });

      const replacementRequestId = randomUUID();
      const replacement = await applyRecoveryInstallation(fixture.installation, {
        requestId: replacementRequestId, diagnosticDigest: manifest.digest, actions: [],
        resumeInstallation: true, reason: "replace the completed retry request", supersedesRequestId: retryRequestId,
      }, confirmingTerminal(replacementRequestId, manifest.digest));
      if (replacement.owner === null) throw new Error("retry recovery did not promote a service owner");
      fixture.owner = replacement.owner;
      expect(replacement.receipt).toMatchObject({ requestId: replacementRequestId, state: "complete", actions: [], globalDispatch: "applied" });
      expect(fixture.state.retryTaskCalls).toBe(1);
      expect(fixture.state.abortTaskCalls).toBe(1);
      const replacementJournal = await fixture.state.harness!.snapshot(WorkshopRecoveryRequestDoc, replacementRequestId, BACKGROUND_CONTEXT);
      expect(replacementJournal?.globalDispatch).toMatchObject({ state: "applied", receipt: { method: "resume", taskId: null } });
      expect(await probeServiceHealth(fixture.installation.stateDirectory)).toMatchObject({ kind: "ready" });
      await fixture.owner.shutdown();
      fixture.owner = undefined;
    });
  }, 25_000);


  test("reopens a settled retired process without a predecessor global receipt", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      fixture.state.trackAbortCalls = true;
      const firstManifest = await inspectRecoveryInstallation(fixture.installation);
      const firstRequestId = randomUUID();
      const first = await applyRecoveryInstallation(fixture.installation, {
        requestId: firstRequestId, diagnosticDigest: firstManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the active process", supersedesRequestId: null,
      }, confirmingTerminal(firstRequestId, firstManifest.digest));
      if (first.owner === null) throw new Error("initial recovery did not promote a service owner");
      fixture.owner = first.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;

      const database = await openNodeSqliteDatabase(fixture.installation.databasePath);
      try {
        const taskRow = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", fixture.processTaskId);
        if (taskRow === undefined) throw new Error("process task row is missing");
        const processInput = processExecutionTaskInputSchema.parse((JSON.parse(taskRow.record) as { input: unknown }).input);
        const entries = await database.all<{ id: number; record: string }>(
          "SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id", fixture.processConversationId,
        );
        const latest = entries.filter((entry) => {
          const record = JSON.parse(entry.record) as { kind?: unknown; data?: { taskId?: unknown; runId?: unknown } };
          return record.kind === "workshop.process" && record.data?.taskId === fixture.processTaskId
            && record.data.runId === processInput.runId;
        }).at(-1);
        if (latest === undefined) throw new Error("retained process evidence is missing");
        const record = JSON.parse(latest.record) as Record<string, unknown> & { data: Record<string, unknown> };
        const process = processIncarnationSchema.parse(record.data.process);
        await database.run("UPDATE entries SET record = ? WHERE id = ?", JSON.stringify({
          ...record, data: { ...record.data, process: processIncarnationSchema.parse({ ...process, cleanupState: "unconfirmed" }) },
        }), latest.id);
      } finally {
        await database.close();
      }

      const manifest = await inspectRecoveryInstallation(fixture.installation);
      const retired = manifest.processIncarnations.find((item) => item.taskId === fixture.processTaskId);
      if (retired === undefined || retired.action !== "verify_retired") throw new Error("terminal process evidence was not retained for verification");
      const priorRequestId = randomUUID();
      await withRuntime(fixture.installation, async (runtime) => {
        const task = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (task === undefined || task.state.status !== "terminal") throw new Error("process task is not terminal");
        const attached = await runtime.harness.taskGraph(BACKGROUND_CONTEXT);
        let conversationOwner: { conversationId: number; taskId: number } | null = null;
        const conversationId = Number(task.conversationId);
        try {
          for (const node of Object.values(attached.value.tasks)) {
            if (node.conversations.some((id) => Number(id) === conversationId)) {
              conversationOwner = { conversationId, taskId: Number(node.id) };
            }
          }
        } finally {
          attached.dispose();
        }
        const taskOwnerId = task.owner === undefined ? null : Number(task.owner);
        const owner = { conversationId, taskOwnerId, conversationOwner };
        const action: RecoveryActionIntentV1 = {
          taskId: fixture.processTaskId, taskKind: task.kind, taskVersion: retired.taskVersion, action: "verify_retired",
          owner: { ...owner, ownershipHash: canonicalHash({ taskId: fixture.processTaskId, ...owner }) },
          inputHash: retired.inputHash, checkpointHash: retired.checkpointHash, process: retired.process,
          processEntryHash: retired.processEntryHash, replaySafety: "unknown",
        };
        expect((await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT })).kind)
          .toBeOneOf(["initialized", "already_initialized"]);
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: priorRequestId,
          manifestDigest: manifest.digest, reason: "retain terminal process evidence",
          confirmedAt: new Date().toISOString(), resumeInstallation: true, actions: [action],
        })).kind).toBe("admitted");
        const identity = retired.process.identity;
        const launchServiceBootId = retired.process.launchServiceBootId;
        if (identity === null || launchServiceBootId === null) throw new Error("fixture process identity is missing");
        const verification = await verifyProcessDeath({ identity, launchServiceBootId });
        if (verification.kind === "refused") throw new Error(`process-death verification failed: ${verification.reason}`);
        expect((await recordRecoveryDeathEvidence({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: priorRequestId,
          taskId: fixture.processTaskId, evidence: {
            kind: "confirmed_dead",
            method: verification.kind === "confirmed_absent" ? "process_group_absent" : "process_group_retired",
            hostBootId: verification.hostBootId, observedAt: verification.observedAt, identity: verification.checkedIdentity,
            executionId: retired.process.executionId, incarnationId: retired.process.incarnationId,
            launchServiceBootId, inputHash: retired.inputHash, checkpointHash: retired.checkpointHash,
            processEntryHash: retired.processEntryHash,
          },
        })).kind).toBe("updated");
        expect((await settleRecoveryAction({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: priorRequestId,
          taskId: fixture.processTaskId, taskOutcome: task.state.outcome,
          processEvidenceHash: canonicalHash((await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, priorRequestId, BACKGROUND_CONTEXT))!.actions[0]!.deathEvidence),
        })).kind).toBe("updated");
        const prior = await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, priorRequestId, BACKGROUND_CONTEXT);
        expect(prior?.globalDispatch).toBeNull();
      });

      const activeManifest = await inspectRecoveryInstallation(fixture.installation);
      expect(activeManifest.complete).toBe(true);
      expect(activeManifest.activeRequest?.requestId).toBe(priorRequestId);
      expect(activeManifest.processIncarnations).toEqual([]);
      const replacementRequestId = randomUUID();
      const replacement = await applyRecoveryInstallation(fixture.installation, {
        requestId: replacementRequestId, diagnosticDigest: activeManifest.digest, actions: [],
        resumeInstallation: true, reason: "replace the verified retirement request", supersedesRequestId: priorRequestId,
      }, confirmingTerminal(replacementRequestId, activeManifest.digest));
      if (replacement.owner === null) throw new Error("zero-action supersession did not promote a service owner");
      fixture.owner = replacement.owner;
      expect(replacement.receipt).toMatchObject({
        requestId: replacementRequestId, state: "complete", actions: [], globalDispatch: "applied",
      });
      const replacementJournal = await fixture.state.harness!.snapshot(WorkshopRecoveryRequestDoc, replacementRequestId, BACKGROUND_CONTEXT);
      expect(replacementJournal?.globalDispatch).toMatchObject({ state: "applied", receipt: { method: "resume", taskId: null } });
      expect(await probeServiceHealth(fixture.installation.stateDirectory)).toMatchObject({ kind: "ready" });
      expect(fixture.state.abortTaskCalls).toBe(1);
      await fixture.owner.shutdown();
      fixture.owner = undefined;
      expect((await readRecoveryReceipt(fixture.installation, priorRequestId)).state).toBe("superseded");
    });
  }, 25_000);

  test("supersedes an admitted zero-action request after a crash", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      fixture.state.trackAbortCalls = true;
      const firstManifest = await inspectRecoveryInstallation(fixture.installation);
      const firstRequestId = randomUUID();
      const first = await applyRecoveryInstallation(fixture.installation, {
        requestId: firstRequestId, diagnosticDigest: firstManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the prior process", supersedesRequestId: null,
      }, confirmingTerminal(firstRequestId, firstManifest.digest));
      if (first.owner === null) throw new Error("initial recovery did not promote a service owner");
      fixture.owner = first.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;
      expect(fixture.state.abortTaskCalls).toBe(1);

      const settledRequestId = randomUUID();
      const intermediateRequestId = randomUUID();
      const replacementRequestId = randomUUID();
      await withRuntime(fixture.installation, async (runtime) => {
        const task = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (task === undefined || task.state.status !== "terminal") throw new Error("process task did not settle");
        await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT });
        const action: RecoveryActionIntentV1 = {
          taskId: fixture.processTaskId, taskKind: task.kind, taskVersion: task.version, action: "abort",
          owner: {
            conversationId: Number(task.conversationId),
            taskOwnerId: task.owner === undefined ? null : Number(task.owner),
            conversationOwner: null, ownershipHash: HASH,
          },
          inputHash: canonicalHash(task.input), checkpointHash: canonicalHash(null), process: null, replaySafety: "unknown",
        };
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: settledRequestId, manifestDigest: HASH,
          reason: "retain the completed abort before clearing", confirmedAt: new Date(Date.now() - 10_000).toISOString(),
          resumeInstallation: true, actions: [action],
        })).kind).toBe("admitted");
        expect((await markRecoveryActionDispatching({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: settledRequestId, taskId: fixture.processTaskId,
        })).kind).toBe("updated");
        expect((await recordRecoveryActionReceipt({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: settledRequestId, taskId: fixture.processTaskId,
          method: "abortTask", taskSnapshotHash: canonicalHash({
            id: Number(task.id), kind: task.kind, version: task.version, state: task.state,
          }),
        })).kind).toBe("updated");
        expect((await settleRecoveryAction({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: settledRequestId,
          taskId: fixture.processTaskId, taskOutcome: task.state.outcome, processEvidenceHash: null,
        })).kind).toBe("updated");
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: intermediateRequestId, manifestDigest: HASH,
          reason: "simulate a crash after zero-action admission", confirmedAt: new Date(Date.now() - 5_000).toISOString(),
          resumeInstallation: true, supersedesRequestId: settledRequestId, actions: [],
        })).kind).toBe("admitted");
      });

      const manifest = await inspectRecoveryInstallation(fixture.installation);
      expect(recoveryRequiredTasks(manifest)).toEqual([]);
      expect(manifest.activeRequest?.requestId).toBe(intermediateRequestId);
      const replacement = await applyRecoveryInstallation(fixture.installation, {
        requestId: replacementRequestId, diagnosticDigest: manifest.digest, actions: [],
        resumeInstallation: true, reason: "supersede the interrupted zero-action recovery", supersedesRequestId: intermediateRequestId,
      }, confirmingTerminal(replacementRequestId, manifest.digest));
      if (replacement.owner === null) throw new Error("settlement recovery did not promote a service owner");
      fixture.owner = replacement.owner;
      const replacementJournal = await fixture.state.harness!.snapshot(WorkshopRecoveryRequestDoc, replacementRequestId, BACKGROUND_CONTEXT);
      expect(replacementJournal?.globalDispatch).toMatchObject({ state: "applied", receipt: { method: "resume", taskId: null } });
      expect((await fixture.state.harness!.snapshot(WorkshopRecoveryRequestDoc, settledRequestId, BACKGROUND_CONTEXT))?.state).toBe("superseded");
      expect(await probeServiceHealth(fixture.installation.stateDirectory)).toMatchObject({ kind: "ready" });
      expect(fixture.state.abortTaskCalls).toBe(1);
      await fixture.owner.shutdown();
      fixture.owner = undefined;
      expect((await readRecoveryReceipt(fixture.installation, intermediateRequestId)).state).toBe("superseded");
    });
  }, 25_000);
  test("refuses zero-action replacement without death proof or a completed dispatch", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      fixture.state.trackAbortCalls = true;
      const firstManifest = await inspectRecoveryInstallation(fixture.installation);
      const firstRequestId = randomUUID();
      const first = await applyRecoveryInstallation(fixture.installation, {
        requestId: firstRequestId, diagnosticDigest: firstManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the active process", supersedesRequestId: null,
      }, confirmingTerminal(firstRequestId, firstManifest.digest));
      if (first.owner === null) throw new Error("initial recovery did not promote a service owner");
      fixture.owner = first.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;

      const predecessorRequestId = randomUUID();
      await withRuntime(fixture.installation, async (runtime) => {
        const base = await recoveryActionIntentForTask(runtime.harness, fixture.processTaskId, "abort", "unknown");
        const action: RecoveryActionIntentV1 = {
          ...base,
          process: { executionId: randomUUID(), incarnationId: randomUUID(), launchServiceBootId: null, identity: null },
          processEntryHash: HASH,
        };
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: predecessorRequestId,
          manifestDigest: HASH, reason: "retain an abort without death evidence",
          confirmedAt: new Date(Date.now() - 10_000).toISOString(), resumeInstallation: true, actions: [action],
        })).kind).toBe("admitted");
        const prior = await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, predecessorRequestId, BACKGROUND_CONTEXT);
        if (prior === undefined || prior.actions.length !== 1) throw new Error("abort predecessor is missing");
        const priorAction = prior.actions[0]!;
        const dispatchMarkedAt = new Date().toISOString();
        // Exercise a journal state with a returned abort receipt but no process-death proof.
        await runtime.harness.commit(async (tx) => {
          const draft = await tx.doc(WorkshopRecoveryRequestDoc, predecessorRequestId, predecessorRequestId);
          Object.assign(draft, {
            ...prior,
            actions: [{
              ...priorAction, state: "applied", dispatchMarkedAt,
              receipt: { method: "abortTask", returnedAt: dispatchMarkedAt, taskSnapshotHash: HASH },
            }],
          });
        }, BACKGROUND_CONTEXT);
      });

      const manifest = await inspectRecoveryInstallation(fixture.installation);
      expect(manifest.complete).toBe(true);
      expect(manifest.processIncarnations).toEqual([]);
      const replacementRequestId = randomUUID();
      await expect(applyRecoveryInstallation(fixture.installation, {
        requestId: replacementRequestId, diagnosticDigest: manifest.digest, actions: [],
        resumeInstallation: true, reason: "refuse missing death proof", supersedesRequestId: predecessorRequestId,
      }, confirmingTerminal(replacementRequestId, manifest.digest))).rejects.toMatchObject({ code: "settlement_evidence_required" });
      expect(fixture.state.abortTaskCalls).toBe(1);
    });

    await withInterruptedProcess(true, async (fixture) => {
      fixture.state.trackAbortCalls = true;
      const firstManifest = await inspectRecoveryInstallation(fixture.installation);
      const firstRequestId = randomUUID();
      const first = await applyRecoveryInstallation(fixture.installation, {
        requestId: firstRequestId, diagnosticDigest: firstManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "retire the active process", supersedesRequestId: null,
      }, confirmingTerminal(firstRequestId, firstManifest.digest));
      if (first.owner === null) throw new Error("initial recovery did not promote a service owner");
      fixture.owner = first.owner;
      await fixture.owner.shutdown();
      fixture.owner = undefined;

      const predecessorRequestId = randomUUID();
      const replacementRequestId = randomUUID();
      await withRuntime(fixture.installation, async (runtime) => {
        const task = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (task === undefined || task.state.status !== "terminal") throw new Error("dispatch task is not terminal");
        const action = await recoveryActionIntentForTask(runtime.harness, fixture.processTaskId, "abort", "unknown");
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: predecessorRequestId, manifestDigest: HASH,
          reason: "retain an unresolved dispatch marker", confirmedAt: new Date(Date.now() - 10_000).toISOString(),
          resumeInstallation: true, actions: [action],
        })).kind).toBe("admitted");
        expect((await markRecoveryActionDispatching({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: predecessorRequestId, taskId: fixture.processTaskId,
        })).kind).toBe("updated");
        const prior = await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, predecessorRequestId, BACKGROUND_CONTEXT);
        if (prior?.intent === null || prior?.intent === undefined) throw new Error("dispatch predecessor is missing its intent");
        const rejected = await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: replacementRequestId, manifestDigest: HASH,
          reason: "replace an unresolved dispatch", confirmedAt: new Date(Date.now() + 1_000).toISOString(),
          resumeInstallation: true, supersedesRequestId: predecessorRequestId, actions: [],
        });
        expect(rejected).toMatchObject({ kind: "conflict", code: "settlement_evidence_required" });
        expect((await runtime.harness.snapshot(WorkshopRecoveryRequestDoc, predecessorRequestId, BACKGROUND_CONTEXT))?.actions[0]?.state)
          .toBe("dispatching");
      });
      expect(fixture.state.abortTaskCalls).toBe(1);
    });
  }, 60_000);


  test("replays a completed apply and rejects a conflicting payload without dispatch", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      const manifest = await inspectRecoveryInstallation(fixture.installation);
      const input = {
        requestId: randomUUID(), diagnosticDigest: manifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" as const }],
        resumeInstallation: true as const, reason: "retire the dead process", supersedesRequestId: null,
      };
      fixture.state.trackAbortCalls = true;
      const first = await applyRecoveryInstallation(fixture.installation, input, confirmingTerminal(input.requestId, input.diagnosticDigest));
      if (first.owner === null) throw new Error("successful apply did not promote a service owner");
      fixture.owner = first.owner;
      expect(fixture.state.abortTaskCalls).toBe(1);
      await fixture.owner.shutdown();
      fixture.owner = undefined;

      const replay = await applyRecoveryInstallation(fixture.installation, input, confirmingTerminal(input.requestId, input.diagnosticDigest));
      expect(replay.owner).toBeNull();
      expect(replay.receipt).toMatchObject({ requestId: input.requestId, state: "complete" });
      await expect(applyRecoveryInstallation(
        fixture.installation, { ...input, reason: "a conflicting reason" },
        confirmingTerminal(input.requestId, input.diagnosticDigest),
      )).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(fixture.state.abortTaskCalls).toBe(1);
    });
  }, 20_000);


  test("attests an identity-free launch before unrelated faux work starts", async () => {
    await withInterruptedProcess(false, async (fixture) => {
      const faux = fauxProvider({ provider: "recovery-order-fixture", models: [{ id: "marker" }] });
      fixture.models.setProvider(faux.provider);
      const generationMarker = join(fixture.root, "unrelated-generation.txt");
      const generationTaskId = await seedUnrelatedGeneration(fixture.installation, fixture.models);
      const manifest = await inspectRecoveryInstallation(fixture.installation);
      expect(manifest.tasks.some((task) => task.taskId === generationTaskId)).toBe(true);
      const required = recoveryRequiredTasks(manifest);
      expect(required.map((task) => task.taskId)).toEqual([fixture.processTaskId]);
      let evidenceCommittedBeforeGeneration = false;
      faux.setResponses([async () => {
        const harness = fixture.state.harness;
        if (harness === undefined) throw new Error("recovery Harness was not captured");
        const index = await harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
        if (index?.state !== "ready" || index.activeRequestId === null) throw new Error("recovery intent was not committed before generation");
        const request = await harness.snapshot(WorkshopRecoveryRequestDoc, index.activeRequestId, BACKGROUND_CONTEXT);
        const action = request?.actions.find((entry) => entry.taskId === fixture.processTaskId);
        if (request?.intent === null || action?.deathEvidence?.kind !== "operator_attested_absent") {
          throw new Error("operator attestation was not committed before generation");
        }
        evidenceCommittedBeforeGeneration = true;
        appendFileSync(generationMarker, "generated\n", "utf8");
        return fauxAssistantMessage("unrelated generation completed");
      }]);
      const requestId = randomUUID();
      const result = await applyRecoveryInstallation(fixture.installation, {
        requestId, diagnosticDigest: manifest.digest, actions: [{ taskId: fixture.processTaskId, action: "abort" }],
        resumeInstallation: true, reason: "attest the absent launch", supersedesRequestId: null,
      }, confirmingTerminal(requestId, manifest.digest));
      if (result.owner === null) throw new Error("successful apply did not promote a service owner");
      fixture.owner = result.owner;
      expect(result.receipt).toMatchObject({
        requestId, state: "complete",
        actions: [{ taskId: fixture.processTaskId, state: "settled", evidence: "operator_attested_absent" }],
      });
      expect(await waitForFile(generationMarker, 3_000)).toBe(true);
      expect(evidenceCommittedBeforeGeneration).toBe(true);
      await fixture.owner!.shutdown();
      fixture.owner = undefined;
    });
  }, 20_000);


  test("supersedes an indeterminate process abort without replaying its prior request", async () => {
    await withInterruptedProcess(true, async (fixture) => {
      const initialManifest = await inspectRecoveryInstallation(fixture.installation);
      const initialTask = initialManifest.tasks.find((task) => task.taskId === fixture.processTaskId);
      if (initialTask === undefined || initialTask.checkpointHash === null) throw new Error("interrupted process is missing from inspection");
      const oldRequestId = randomUUID();
      await withRuntime(fixture.installation, async (runtime) => {
        const storedTask = await runtime.harness.getTask(fixture.processTaskId as never, BACKGROUND_CONTEXT);
        if (storedTask === undefined || storedTask.state.status === "terminal" || !("checkpoint" in storedTask.state)) throw new Error("interrupted process task is unavailable");
        const checkpoint = storedTask.state.checkpoint as { phase: string; process: ReturnType<typeof processIncarnationSchema.parse> };
        const input = processExecutionTaskInputSchema.parse(storedTask.input);
        const process = checkpoint.process;
        if (process.identity === null) throw new Error("crash fixture needs a recorded process identity");
        const processEntryHash = initialManifest.processIncarnations.find((item) => item.taskId === fixture.processTaskId)?.processEntryHash;
        if (processEntryHash === undefined) throw new Error("crash fixture lacks retained process evidence");
        const action: RecoveryActionIntentV1 = {
          taskId: fixture.processTaskId, taskKind: initialTask.kind, taskVersion: initialTask.version, action: "abort",
          owner: {
            conversationId: Number(storedTask.conversationId),
            taskOwnerId: storedTask.owner === undefined ? null : Number(storedTask.owner),
            conversationOwner: null, ownershipHash: HASH,
          },
          inputHash: initialTask.inputHash, checkpointHash: initialTask.checkpointHash!,
          process: {
            executionId: process.executionId, incarnationId: process.incarnationId,
            launchServiceBootId: process.launchServiceBootId ?? input.serviceBootId, identity: process.identity,
          },
          processEntryHash,
          replaySafety: "unknown"
        };
        expect(["initialized", "already_initialized"]).toContain(
          (await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT })).kind,
        );
        expect((await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: oldRequestId,
          manifestDigest: initialManifest.digest, reason: "prior reviewed request",
          confirmedAt: new Date().toISOString(), resumeInstallation: true, actions: [action],
        })).kind).toBe("admitted");
        const evidence = {
          kind: "confirmed_dead" as const, method: "process_group_absent" as const,
          hostBootId: randomUUID(), observedAt: new Date().toISOString(), identity: process.identity,
          executionId: process.executionId, incarnationId: process.incarnationId,
          launchServiceBootId: action.process!.launchServiceBootId!, inputHash: action.inputHash,
          checkpointHash: action.checkpointHash, processEntryHash,
        };
        expect((await recordRecoveryDeathEvidence({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: oldRequestId,
          taskId: fixture.processTaskId, evidence,
        })).kind).toBe("updated");
        expect((await markRecoveryActionDispatching({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId: oldRequestId, taskId: fixture.processTaskId,
        })).kind).toBe("updated");
      });
      const oldReceipt = await readRecoveryReceipt(fixture.installation, oldRequestId);
      expect(oldReceipt.actions[0]).toMatchObject({ state: "indeterminate", dispatch: "indeterminate" });
      const startup = Bun.spawn([process.execPath, join(REPO_ROOT, "src/cli/main.ts"), "service", "serve"], {
        cwd: fixture.installation.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [startupStatus, startupError] = await Promise.all([startup.exited, new Response(startup.stderr).text()]);
      expect(startupStatus).not.toBe(0);
      expect(startupError).toContain("Durable startup was refused");
      const currentManifest = await inspectRecoveryInstallation(fixture.installation);
      const input = {
        requestId: randomUUID(), diagnosticDigest: currentManifest.digest,
        actions: [{ taskId: fixture.processTaskId, action: "abort" as const }],
        resumeInstallation: true as const, reason: "replace indeterminate request",
        supersedesRequestId: oldRequestId,
      };
      const staleRequestId = randomUUID();
      await expect(applyRecoveryInstallation(fixture.installation, {
        ...input, requestId: staleRequestId, supersedesRequestId: null,
      }, confirmingTerminal(staleRequestId, currentManifest.digest))).rejects.toMatchObject({ code: "supersedes_required" });
      fixture.state.trackAbortCalls = true;
      const result = await applyRecoveryInstallation(fixture.installation, input, confirmingTerminal(input.requestId, currentManifest.digest));
      if (result.owner === null) throw new Error("successful apply did not promote a service owner");
      fixture.owner = result.owner;
      expect(result.receipt).toMatchObject({
        requestId: input.requestId, state: "complete",
        actions: [{ taskId: fixture.processTaskId, state: "settled", evidence: "confirmed_dead" }],
      });
      expect(fixture.state.abortTaskCalls).toBe(1);
      await fixture.owner!.shutdown();
      fixture.owner = undefined;
    });
  }, 25_000);


  test("ordinary startup refuses an active recovery request", async () => {
    await withInstallation(async (installation) => {
      const requestId = randomUUID();
      await withRuntime(installation, async (runtime) => {
        await initializeRecoveryIndex({ harness: runtime.harness, context: BACKGROUND_CONTEXT });
        const result = await admitRecoveryIntent({
          harness: runtime.harness, context: BACKGROUND_CONTEXT, requestId, manifestDigest: HASH,
          reason: "reviewed", confirmedAt: new Date().toISOString(), resumeInstallation: true,
          actions: [{ taskId: 1, taskKind: "workshop.test", taskVersion: 1, action: "abort",
            owner: { conversationId: 1, taskOwnerId: null, conversationOwner: null, ownershipHash: HASH },
            inputHash: HASH, checkpointHash: HASH, process: null, replaySafety: "unknown" }],
        });
        expect(result.kind).toBe("admitted");
      });
      const child = Bun.spawn([process.execPath, join(REPO_ROOT, "src/cli/main.ts"), "service", "serve"], {
        cwd: installation.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status).not.toBe(0);
      expect(error).toContain("Durable startup was refused");
      const diagnostic = JSON.parse(readFileSync(join(installation.stateDirectory, "startup-failure.json"), "utf8"));
      expect(diagnostic.limitations).toContain("recovery_request_active");
      expect((await readRecoveryReceipt(installation, requestId)).state).toBe("active");
    });
  });
});

async function withInstallation(work: (installation: Installation) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workshop-service-recovery-"));
  try {
    const workshop = join(root, ".workshop");
    mkdirSync(join(workshop, "workflows"), { recursive: true });
    mkdirSync(join(workshop, ".state"), { mode: 0o700 });
    writeFileSync(join(workshop, "workshop.yaml"), "shell: /bin/sh\n");
    const installation = loadInstallation(root);
    await withRuntime(installation, async (runtime) => {
      await runtime.harness.commit(async (tx) => {
        Object.assign(await tx.doc(WorkshopInstallationDoc), { state: "ready", installationId: randomUUID(), maxConcurrentRuns: 1, workflows: {} });
      }, BACKGROUND_CONTEXT);
    });
    await work(installation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withRuntime(installation: Installation, work: (runtime: Awaited<ReturnType<typeof openPausedServiceRuntime>>) => Promise<void>): Promise<void> {
  const runtime = await openPausedServiceRuntime(installation, {
    version: 1, status: "starting", pid: process.pid, startIdentity: "test",
    bootId: randomUUID(), startedAt: new Date().toISOString(), socketPath: join(installation.stateDirectory, "service.sock"),
  }, createModels());
  try { await work(runtime); } finally { await runtime.close(); }
}

type InterruptedProcessFixture = {
  readonly root: string;
  readonly installation: Installation;
  readonly models: ReturnType<typeof createModels>;
  processTaskId: number;
  readonly processMarkerPath: string;
  readonly state: {
    harness: HarnessType | undefined;
    trackAbortCalls: boolean;
    abortTaskCalls: number;
    trackRetryCalls: boolean;
    retryTaskCalls: number;
  };
  owner: WorkshopServiceOwner | undefined;
  processConversationId: number;
};

async function withInterruptedProcess(
  identityRequired: boolean,
  work: (fixture: InterruptedProcessFixture) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workshop-recovery-process-"));
  const config = join(root, ".workshop");
  const workflowDirectory = join(config, "workflows");
  const processMarkerPath = join(root, "process-completed.txt");
  mkdirSync(workflowDirectory, { recursive: true });
  mkdirSync(join(config, ".state"), { mode: 0o700 });
  writeFileSync(join(config, "workshop.yaml"), "shell: /bin/sh\n");
  writeFileSync(join(workflowDirectory, "recovery-process.yaml"), [
    "version: 4",
    "defaults: { retries: 0, replay: never }",
    "steps:",
    "  - hold:",`      run: sleep 30; printf x >> '${processMarkerPath}'`,
    "",
  ].join("\n"));
  const installation = loadInstallation(root);
  const models = createModels();
  const state = { harness: undefined as HarnessType | undefined, trackAbortCalls: false, abortTaskCalls: 0, trackRetryCalls: false, retryTaskCalls: 0 };
  const fixture: InterruptedProcessFixture = {
    root, installation, models, processTaskId: 0, processConversationId: 0, processMarkerPath, state, owner: undefined,
  };
  const originalOpen = Harness.open;
  Harness.open = async (storage, options, context) => {
    const harness = await originalOpen(storage, { ...options, models }, context);
    state.harness = harness;
    if (state.trackAbortCalls) {
      const abortTask = harness.abortTask.bind(harness);
      Object.defineProperty(harness, "abortTask", {
        configurable: true,
        value: async (...args: Parameters<HarnessType["abortTask"]>) => {
          state.abortTaskCalls += 1;
          return abortTask(...args);
        },
      });
    }
    if (state.trackRetryCalls) {
      const retryTask = harness.retryTask.bind(harness);
      Object.defineProperty(harness, "retryTask", {
        configurable: true,
        value: async (...args: Parameters<HarnessType["retryTask"]>) => {
          state.retryTaskCalls += 1;
          return retryTask(...args);
        },
      });
    }
    return harness;
  };
  try {
    fixture.owner = await startWorkshopService(installation, models);
    const response = await sendServiceRequest(fixture.owner.metadata.socketPath, {
      version: 1, method: "start", requestId: randomUUID(), workflowId: "recovery-process",
    });
    if (!response.ok) throw new Error(response.error.message);
    const started = serviceStartResultV1Schema.parse(response.result);
    const running = await waitForProcessTask(state.harness!, started.runId);
    fixture.processTaskId = Number(running.id);
    const conversationId = Number(running.conversationId);
    fixture.processConversationId = conversationId;
    const input = processExecutionTaskInputSchema.parse(running.input);
    if (running.state.status !== "running" || !("checkpoint" in running.state)) throw new Error("worker did not reach a live process checkpoint");
    const originalProcess = processIncarnationSchema.parse((running.state.checkpoint as { process: unknown }).process);
    if (identityRequired && originalProcess.identity === null) throw new Error("worker process identity was not recorded");
    await fixture.owner.shutdown();
    fixture.owner = undefined;
    const process = processIncarnationSchema.parse({
      ...originalProcess,
      status: identityRequired ? "running" : "launching",
      startedAt: identityRequired ? originalProcess.startedAt : null,
      finishedAt: null,
      identity: identityRequired ? originalProcess.identity : null,
      exit: null,
      cleanupState: "pending",
    });
    await restorePriorBootProcess(installation.databasePath, {
      taskId: fixture.processTaskId, conversationId, executionId: input.executionId,
      phase: identityRequired ? "monitor" : "launch", process,
    });
    await work(fixture);
  } finally {
    if (fixture.owner !== undefined) await fixture.owner.shutdown().catch(() => undefined);
    Harness.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitForProcessTask(harness: HarnessType, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const task = inspection.tasks.find((entry) => entry.record.kind === "workshop.process-execution"
      && typeof entry.record.input === "object" && entry.record.input !== null
      && "runId" in entry.record.input && entry.record.input.runId === runId);
    if (task?.record.state.status === "running" && "checkpoint" in task.record.state
      && typeof task.record.state.checkpoint === "object" && task.record.state.checkpoint !== null
      && "phase" in task.record.state.checkpoint && task.record.state.checkpoint.phase === "monitor") return task.record;
    await Bun.sleep(10);
  }
  throw new Error("worker process did not reach its monitor checkpoint");
}

async function restorePriorBootProcess(
  databasePath: string,
  input: { taskId: number; conversationId: number; executionId: string; phase: "launch" | "monitor"; process: ReturnType<typeof processIncarnationSchema.parse> },
): Promise<void> {
  const database = await openNodeSqliteDatabase(databasePath);
  try {
    const row = await database.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", input.taskId);
    if (row === undefined) throw new Error("process task row is missing");
    const task = JSON.parse(row.record) as Record<string, any>;
    const { endedAt: _endedAt, abortReason: _abortReason, ...liveTask } = task;
    const restored = {
      ...liveTask, abortRequested: false,
      state: { status: "pending", checkpoint: { phase: input.phase, process: input.process } },
    };
    await database.run("UPDATE tasks SET status = 'pending', abort_requested = 0, record = ? WHERE id = ?", JSON.stringify(restored), input.taskId);
    const entries = await database.all<{ id: number; record: string }>("SELECT id, record FROM entries WHERE conversation_id = ?", input.conversationId);
    let updated = 0;
    for (const entry of entries) {
      const record = JSON.parse(entry.record) as Record<string, any>;
      const data = record.data as Record<string, any> | undefined;
      if (record.kind !== "workshop.process" || data?.process?.executionId !== input.executionId) continue;
      await database.run("UPDATE entries SET record = ? WHERE id = ?", JSON.stringify({ ...record, data: { ...data, process: input.process } }), entry.id);
      updated += 1;
    }
    if (updated === 0) throw new Error("process evidence entries are missing");
  } finally {
    await database.close();
  }
}

function recoveryRequiredTasks(manifest: Awaited<ReturnType<typeof inspectRecoveryInstallation>>) {
  return manifest.tasks.filter((task) => task.state === "blocked" || (task.processEvidence !== null
    && task.state !== "completing" && task.processEvidence.checkpointPhase !== "intent"));
}

function confirmingTerminal(requestId: string, digest: string) {
  return {
    isTerminal: () => true,
    readConfirmation: async () => `recover ${requestId} ${digest} resume-installation`,
    write: () => {},
  };
}

async function seedUnrelatedGeneration(
  installation: Installation,
  models: ReturnType<typeof createModels>,
): Promise<number> {
  const opened = await openDurableStorage(installation.databasePath);
  if (!opened.ok) throw new Error(opened.failure.message);
  const harness = await Harness.open(opened.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  let taskId = 0;
  try {
    await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "recovery-order-fixture", modelId: "marker" }, thinkingLevel: "off", tools: [] },
      init: async (tx, conversationId) => {
        await tx.appendEntry(UserEntry, conversationId, {
          model: [{ role: "user", content: "Run one unrelated faux generation after recovery consent.", timestamp: Date.now() }],
        });
        const live = await tx.doc(LiveDoc, conversationId);
        const task = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId });
        live.run = { taskId: task, inputs: [] };
        taskId = Number(task);
        const bot = await tx.doc(WorkshopBotDoc);
        Object.assign(bot, {
          state: "ready", conversationId: Number(conversationId), cursorInitialized: false, eventCursors: {},
        });
      },
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  return taskId;
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(10);
  }
  return existsSync(path);
}

async function recoveryActionIntentForTask(
  harness: HarnessType,
  taskId: number,
  action: "abort" | "retry",
  replaySafety: RecoveryActionIntentV1["replaySafety"],
): Promise<RecoveryActionIntentV1> {
  const task = await harness.getTask(taskId as never, BACKGROUND_CONTEXT);
  if (task === undefined) throw new Error(`task ${taskId} is missing`);
  const conversationId = Number(task.conversationId);
  const attached = await harness.taskGraph(BACKGROUND_CONTEXT);
  let conversationOwner: { conversationId: number; taskId: number } | null = null;
  try {
    for (const node of Object.values(attached.value.tasks)) {
      if (node.conversations.some((id) => Number(id) === conversationId)) {
        conversationOwner = { conversationId, taskId: Number(node.id) };
      }
    }
  } finally {
    attached.dispose();
  }
  const taskOwnerId = task.owner === undefined ? null : Number(task.owner);
  const owner = { conversationId, taskOwnerId, conversationOwner };
  const checkpoint = "checkpoint" in task.state ? task.state.checkpoint : null;
  return {
    taskId, taskKind: task.kind, taskVersion: task.version, action,
    owner: { ...owner, ownershipHash: canonicalHash({ taskId, ...owner }) },
    inputHash: canonicalHash(task.input), checkpointHash: canonicalHash(checkpoint),
    process: null, replaySafety,
  };
}
