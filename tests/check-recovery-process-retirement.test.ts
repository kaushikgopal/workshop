import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { reconstructProcessStdin } from "../src/attempt/build-process-stdin.js";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { executionIdSchema, incarnationIdSchema, processIdentitySchema, processIncarnationSchema } from "../src/process/schema.js";
import { processGroupId, processStartIdOrThrow } from "../src/process/identify-process.js";
import { probeProcessGroup, terminateProcessGroup } from "../src/process/kill-process-tree.js";
import { verifyProcessDeath } from "../src/process/verify-process-death.js";
import { locateWorkflowDirectory } from "../src/run/locate-run-files.js";
import { loadInstallation } from "../src/installation/load-installation.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";
import { workflowRunDocumentV1Schema, workshopProcessV1Schema } from "../src/run/records.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { ServiceShutdownError } from "../src/service/serve-workshop-service.js";
import { WorkshopInstallationDoc, WorkshopProcessEntry, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { WorkshopRecoveryRequestDoc } from "../src/storage/durable/define-recovery-records.js";
import {
  buildProcessExecutionEnvironment,
  defineProcessExecutionTask,
  processExecutionFiles,
  processExecutionTaskInputSchema,
  processExecutionTaskResultSchema,
  type ProcessExecutionTaskInput,
  type ProcessExecutionTaskResult,
} from "../src/storage/durable/define-process-execution-task.js";
import {
  admitRecoveryIntent,
  initializeRecoveryIndex,
  markRecoveryActionDispatching,
  recordRecoveryActionReceipt,
  recordRecoveryDeathEvidence,
  settleRecoveryAction,
} from "../src/storage/durable/commit-recovery-intent.js";
import { recoveryDeathEvidenceV1Schema, type RecoveryActionIntentV1, type RecoveryDeathEvidenceV1 } from "../src/storage/durable/schema-recovery.js";
import { DEFAULT_STREAM_CAP_BYTES } from "../src/util/parse-units.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";

const PROCESS_TASK_KIND = "workshop.process-execution";
const PROCESS_TASK_VERSION = 4;
const TIME = "2026-11-06T12:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
type SeedCheckpoint = { readonly phase: "launch" | "monitor"; readonly process: ReturnType<typeof processIncarnationSchema.parse> };
type SeedState = { readonly phase: "seed" } | SeedCheckpoint;

describe("recovery-backed ProcessExecution retirement", () => {
  test("settles a proof-backed prior-boot task as blocked without replay or a successful exit", async () => {
    await withRetirementFixture("monitor", async (fixture) => {
      const settled = await retireTask(fixture, "confirmed_dead");

      expect(settled.state.status).toBe("terminal");
      if (settled.state.status !== "terminal") throw new Error("recovery abort did not settle the process task");
      expect(settled.state.outcome.status).toBe("completed");
      if (settled.state.outcome.status !== "completed") throw new Error("recovery retirement did not return a process result");
      expect(processExecutionTaskResultSchema.parse(settled.state.outcome.result)).toMatchObject({
        kind: "blocked",
        block: { kind: "external_outcome_unknown" },
      });
      const process = await latestProcess(fixture);
      expect(process).toMatchObject({ status: "blocked", cleanupState: "confirmed_dead", exit: null });
      expect(process.identity).toEqual(fixture.checkpoint.process.identity);
      expect(existsSync(fixture.markerPath)).toBe(false);
    });
  });

  test("retires an identity-free launch only under its attestation and never upgrades it to confirmed death", async () => {
    await withRetirementFixture("launch", async (fixture) => {
      const settled = await retireTask(fixture, "operator_attested_absent");

      expect(settled.state.status).toBe("terminal");
      if (settled.state.status !== "terminal") throw new Error("attested abort did not settle the process task");
      expect(settled.state.outcome.status).toBe("completed");
      if (settled.state.outcome.status !== "completed") throw new Error("attested retirement did not return a process result");
      expect(processExecutionTaskResultSchema.parse(settled.state.outcome.result)).toMatchObject({
        kind: "blocked",
        block: { kind: "external_outcome_unknown" },
      });
      const process = await latestProcess(fixture);
      expect(process).toMatchObject({
        status: "blocked",
        cleanupState: "operator_attested_absent",
        identity: null,
        exit: null,
      });
      expect(existsSync(fixture.markerPath)).toBe(false);
    });
  });

  test("keeps the ordinary abort path when recovery evidence is not present", async () => {
    await withRetirementFixture("launch", async (fixture) => {
      await fixture.harness.abortTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);
      fixture.harness.resume();
      const settled = await fixture.harness.waitForTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);

      expect(settled.state.status).toBe("terminal");
      if (settled.state.status !== "terminal") throw new Error("ordinary abort did not settle the process task");
      expect(settled.state.outcome.status).toBe("aborted");
      const process = await latestProcess(fixture);
      expect(process).toMatchObject({ status: "blocked", cleanupState: "unconfirmed", identity: null, exit: null });
      expect(existsSync(fixture.markerPath)).toBe(false);
    });
  });

  for (const binding of ["input", "checkpoint", "process identity", "process entry", "incarnation"] as const) {
    test(`rejects a confirmed-death receipt with a mismatched ${binding} binding`, async () => {
      await withRetirementFixture("monitor", async (fixture) => {
        const settled = await retireTask(fixture, "confirmed_dead", binding);

        expect(settled.state.status).toBe("terminal");
        if (settled.state.status !== "terminal") throw new Error("mismatched recovery abort did not settle");
        if (settled.state.outcome.status === "completed") {
          expect(processExecutionTaskResultSchema.parse(settled.state.outcome.result).kind).toBe("blocked");
        }
        const process = await latestProcess(fixture);
        expect(process.status).toBe("blocked");
        expect(process.exit).toBeNull();
        expect(process.cleanupState).not.toBe("confirmed_dead");
        expect(existsSync(fixture.markerPath)).toBe(false);
      });
    });
  }

  test("verifies a detached process group before recording proof and settling the abort", async () => {
    const child = await spawnDetachedChild();
    try {
      await withRetirementFixture("monitor", async (fixture) => {
        const recovery = await admitRecoveryAbort(fixture);
        const process = recovery.action.process;
        if (process === null || process.identity === null || process.launchServiceBootId === null) {
          throw new Error("test process task lacks its recorded identity");
        }
        const verification = await verifyProcessDeath({
          identity: process.identity,
          launchServiceBootId: process.launchServiceBootId,
        });
        expect(verification.kind).toBe("retired_after_identity_match");
        if (verification.kind !== "retired_after_identity_match") throw new Error("real process group was not retired by identity");
        expect(verification.checkedIdentity).toEqual(process.identity);
        expect(probeProcessGroup(child.pgid).state).toBe("absent");
        const evidence = confirmedDeathEvidence(fixture, recovery, verification);
        expect(evidence).toMatchObject({ hostBootId: verification.hostBootId });
        const proof = await recordRecoveryDeathEvidence({
          harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId, evidence,
        });
        expect(proof.kind).toBe("updated");
        if (proof.kind !== "updated") throw new Error("real process-death proof was not recorded");
        expect(proof.request.actions[0]).toMatchObject({ state: "death_verified", deathEvidence: evidence, dispatchMarkedAt: null });
        expect((await markRecoveryActionDispatching({
          harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId, markedAt: TIME,
        })).kind).toBe("updated");
        await fixture.harness.abortTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);
        expect((await recordRecoveryActionReceipt({
          harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId,
          method: "abortTask", returnedAt: TIME, taskSnapshotHash: null,
        })).kind).toBe("updated");
        fixture.harness.resume();
        const settled = await fixture.harness.waitForTask(fixture.taskId as TaskId<ProcessExecutionTaskResult>, BACKGROUND_CONTEXT);
        expect(settled.state.status).toBe("terminal");
        if (settled.state.status !== "terminal" || settled.state.outcome.status !== "completed") {
          throw new Error("proof-backed process abort did not settle with a completed result");
        }
        expect(processExecutionTaskResultSchema.parse(settled.state.outcome.result)).toMatchObject({
          kind: "blocked", block: { kind: "external_outcome_unknown" },
        });
        const journalSettlement = await settleRecoveryAction({
          harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId,
          settledAt: TIME, taskOutcome: settled.state.outcome, processEvidenceHash: canonicalHash(evidence),
        });
        expect(journalSettlement.kind).toBe("updated");
        const request = await fixture.harness.snapshot(WorkshopRecoveryRequestDoc, recovery.requestId, BACKGROUND_CONTEXT);
        expect(request?.actions[0]).toMatchObject({
          state: "settled",
          settlement: { processEvidenceHash: canonicalHash(evidence), taskOutcome: settled.state.outcome },
        });
        expect(await latestProcess(fixture)).toMatchObject({ status: "blocked", cleanupState: "confirmed_dead", exit: null });
      }, (serviceBootId) => ({
        pid: child.pid, pgid: child.pgid, startIdentity: child.startIdentity, serviceBootId,
      }));
    } finally {
      await terminateProcessGroup(child.pgid, 50);
    }
  }, 20_000);

  test("settles a monitor checkpoint from an active dispatch marker without aborting the task", async () => {
    await withRetirementFixture("monitor", async (fixture) => {
      const recovery = await admitRecoveryAbort(fixture);
      const process = recovery.action.process;
      if (process === null || process.identity === null || process.launchServiceBootId === null) {
        throw new Error("monitor fixture lacks its recorded process identity");
      }
      const verification = await verifyProcessDeath({ identity: process.identity, launchServiceBootId: process.launchServiceBootId });
      expect(verification.kind).toBe("confirmed_absent");
      if (verification.kind !== "confirmed_absent") throw new Error("absent monitor process group was not confirmed");
      const evidence = confirmedDeathEvidence(fixture, recovery, verification);
      expect((await recordRecoveryDeathEvidence({
        harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId, evidence,
      })).kind).toBe("updated");
      expect((await markRecoveryActionDispatching({
        harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId, markedAt: TIME,
      })).kind).toBe("updated");
      const marked = await fixture.harness.snapshot(WorkshopRecoveryRequestDoc, recovery.requestId, BACKGROUND_CONTEXT);
      expect(marked?.actions[0]).toMatchObject({ state: "dispatching", dispatchMarkedAt: TIME, receipt: null });
      expect((await fixture.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
      fixture.harness.resume();
      const settled = await fixture.harness.waitForTask(fixture.taskId as TaskId<ProcessExecutionTaskResult>, BACKGROUND_CONTEXT);
      expect(settled.state.status).toBe("terminal");
      if (settled.state.status !== "terminal" || settled.state.outcome.status !== "completed") {
        throw new Error("monitor branch did not consume the active recovery dispatch marker");
      }
      expect(processExecutionTaskResultSchema.parse(settled.state.outcome.result)).toMatchObject({
        kind: "blocked", block: { kind: "external_outcome_unknown" },
      });
      const request = await fixture.harness.snapshot(WorkshopRecoveryRequestDoc, recovery.requestId, BACKGROUND_CONTEXT);
      expect(request?.actions[0]).toMatchObject({
        state: "dispatching", dispatchMarkedAt: TIME, receipt: null, deathEvidence: evidence,
      });
      expect(await latestProcess(fixture)).toMatchObject({ status: "blocked", cleanupState: "confirmed_dead", exit: null });
    });
  });

  test("rejects confirmed-death evidence for a mismatched incarnation", async () => {
    await withRetirementFixture("monitor", async (fixture) => {
      const recovery = await admitRecoveryAbort(fixture);
      const process = recovery.action.process;
      if (process === null || process.identity === null || process.launchServiceBootId === null) {
        throw new Error("monitor fixture lacks its recorded process identity");
      }
      const verification = await verifyProcessDeath({ identity: process.identity, launchServiceBootId: process.launchServiceBootId });
      if (verification.kind !== "confirmed_absent") throw new Error("absent monitor process group was not confirmed");
      const evidence = { ...confirmedDeathEvidence(fixture, recovery, verification), incarnationId: randomUUID() };
      expect(recoveryDeathEvidenceV1Schema.safeParse(evidence).success).toBe(true);
      const recorded = await recordRecoveryDeathEvidence({
        harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId: recovery.requestId, taskId: fixture.taskId, evidence,
      });
      expect(recorded).toMatchObject({ kind: "conflict", code: "death_proof_mismatch" });
      const request = await fixture.harness.snapshot(WorkshopRecoveryRequestDoc, recovery.requestId, BACKGROUND_CONTEXT);
      expect(request?.actions[0]).toMatchObject({ state: "authorized", deathEvidence: null, dispatchMarkedAt: null });
      expect(await latestProcess(fixture)).toMatchObject({ status: "running", cleanupState: "pending", exit: null });
      expect(existsSync(fixture.markerPath)).toBe(false);
    });
  });

  test("rejects identity fields on operator attestation and attestation fields on host proof", () => {
    const identity = { pid: 123, pgid: 123, startIdentity: "test-start", serviceBootId: randomUUID() };
    expect(recoveryDeathEvidenceV1Schema.safeParse({
      kind: "operator_attested_absent", method: "typed_terminal_confirmation", attestingRequestId: randomUUID(),
      attestedAt: TIME, manifestDigest: HASH, evidenceHash: HASH, identity, executionId: "execution",
      incarnationId: "incarnation", launchServiceBootId: identity.serviceBootId,
    }).success).toBe(false);
    expect(recoveryDeathEvidenceV1Schema.safeParse({
      kind: "confirmed_dead", method: "process_group_absent", hostBootId: randomUUID(), observedAt: TIME, identity,
      executionId: "execution", incarnationId: "incarnation", launchServiceBootId: identity.serviceBootId,
      inputHash: HASH, checkpointHash: HASH, processEntryHash: HASH, attestingRequestId: randomUUID(),
    }).success).toBe(false);
  });

  test("process cleanup attestation cannot describe a recorded identity or a live process", async () => {
    await withRetirementFixture("monitor", async (fixture) => {
      const process = fixture.checkpoint.process;
      expect(processIncarnationSchema.safeParse({
        ...process, status: "blocked", cleanupState: "operator_attested_absent",
      }).success).toBe(false);
    });
    await withRetirementFixture("launch", async (fixture) => {
      expect(processIncarnationSchema.safeParse({
        ...fixture.checkpoint.process, cleanupState: "operator_attested_absent",
      }).success).toBe(false);
    });
  });

  for (const [phase, evidence] of [["monitor", "confirmed_dead"], ["launch", "operator_attested_absent"]] as const) {
    test(`public startup accepts ${evidence} process evidence before refusing the active request`, async () => {
      await withRetirementFixture(phase, async (fixture) => {
        await retireTask(fixture, evidence);
        const installation = await prepareStartupInstallation(fixture);
        await fixture.closeHarness();
        const startupError = await startWorkshopService(installation, createModels()).then(
          () => undefined, (error: unknown) => error,
        );
        expect(startupError).toBeInstanceOf(ServiceShutdownError);
        const causes = (startupError as ServiceShutdownError).cause;
        expect(causes).toBeInstanceOf(AggregateError);
        expect((causes as AggregateError).errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ message: "active recovery request exists; ordinary startup remains stopped" }),
        ]));
      });
    });
  }

  for (const mismatch of ["missing request", "wrong incarnation", "wrong task", "wrong identity"] as const) {
    test(`public startup rejects an attestation with ${mismatch}`, async () => {
      await withRetirementFixture("launch", async (fixture) => {
        if (mismatch === "missing request") {
          await fixture.harness.commit(async (tx) => {
            await tx.appendEntry(WorkshopProcessEntry, fixture.conversationId as never, {
              data: { ...fixture.processEntryData, process: { ...fixture.checkpoint.process, status: "blocked", cleanupState: "operator_attested_absent" } },
            });
          }, BACKGROUND_CONTEXT);
        } else {
          await retireTask(fixture, "operator_attested_absent");
          const index = await fixture.harness.snapshot((await import("../src/storage/durable/define-recovery-records.js")).WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
          if (index?.state !== "ready" || index.activeRequestId === null) throw new Error("missing recovery request");
          const requestId = index.activeRequestId;
          await fixture.harness.commit(async (tx) => {
            const request = await tx.doc(WorkshopRecoveryRequestDoc, requestId, requestId);
            const action = request.actions[0]!;
            if (action.process === null) throw new Error("missing recovery process");
            if (mismatch === "wrong incarnation") action.process.incarnationId = randomUUID();
            else if (mismatch === "wrong task") action.taskId += 1;
            else action.process.identity = { pid: 100, pgid: 100, startIdentity: "other", serviceBootId: fixture.oldBootId };
          }, BACKGROUND_CONTEXT);
        }
        const installation = await prepareStartupInstallation(fixture);
        await fixture.closeHarness();
        const error = await startWorkshopService(installation, createModels()).then(() => undefined, (failure: unknown) => failure);
        expect(error).toBeInstanceOf(ServiceShutdownError);
        expect((error as ServiceShutdownError).cause).toBeInstanceOf(AggregateError);
        expect(((error as ServiceShutdownError).cause as AggregateError).errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("has no confirmed-death receipt at service startup or shutdown") }),
        ]));
      });
    });
  }

  test("public service startup rejects unresolved process evidence", async () => {
    await withRetirementFixture("monitor", async (fixture) => {
      const installation = await prepareStartupInstallation(fixture);
      const expected = `process group ${fixture.checkpoint.process.executionId}:${fixture.checkpoint.process.incarnationId} has no confirmed-death receipt at service startup or shutdown`;
      await fixture.closeHarness();
      const startupError = await startWorkshopService(installation, createModels()).then(
        () => undefined, (error: unknown) => error,
      );
      expect(startupError).toBeInstanceOf(ServiceShutdownError);
      const causes = (startupError as ServiceShutdownError).cause;
      expect(causes).toBeInstanceOf(AggregateError);
      expect((causes as AggregateError).errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expected })]));
    });
  });
});

async function prepareStartupInstallation(fixture: RetirementFixture) {
  const input = fixture.input;
  await fixture.harness.commit(async (tx) => {
    Object.assign(await tx.doc(WorkshopInstallationDoc), {
      state: "ready", installationId: randomUUID(), maxConcurrentRuns: 1, workflows: {
        [input.workflowId]: {
          definitionHash: HASH, admissionHighWater: 1, openRunId: input.runId,
          activations: [{
            activationId: input.activationId, state: "exhausted", admittedCount: 1, maxRuns: 1,
            activatedAt: TIME, nextDueAt: null, scheduleEveryMs: null, schedulerTaskId: null,
            skippedSlots: 0, lastSkippedSlotAt: null, admissionError: null,
          }],
          occurrenceCounters: { [input.activationId]: 1 },
          runs: [{
            runId: input.runId, activationId: input.activationId, occurrenceId: input.occurrenceId,
            conversationId: fixture.conversationId, workflowTaskId: input.workflowTaskId,
            admissionSequence: 1, admittedAt: TIME, status: "running", requestId: "retirement-request-001",
          }],
          requestIndex: { "retirement-request-001": input.runId }, capacityReservations: [input.runId], preflightCache: {},
        },
      },
    });
  }, BACKGROUND_CONTEXT);
  const workshop = join(fixture.directory, ".workshop");
  mkdirSync(join(workshop, "workflows"), { recursive: true });
  writeFileSync(join(workshop, "workshop.yaml"), "shell: /bin/sh\n", "utf8");
  const loaded = loadInstallation(fixture.directory);
  const installation = { ...loaded, databasePath: join(fixture.directory, "durable.sqlite") };
  chmodSync(installation.stateDirectory, 0o700);
  return installation;
}

type RetirementFixture = {
  readonly directory: string;
  readonly harness: Harness;
  readonly taskId: number;
  readonly conversationId: number;
  readonly markerPath: string;
  readonly input: ProcessExecutionTaskInput;
  readonly checkpoint: SeedCheckpoint;
  readonly processEntryData: ReturnType<typeof workshopProcessV1Schema.parse>;
  readonly processEntryId: number;
  readonly oldBootId: string;
  readonly closeHarness: () => Promise<void>;
};

async function withRetirementFixture(
  phase: "launch" | "monitor",
  work: (fixture: RetirementFixture) => Promise<void>,
  identityForBoot?: (serviceBootId: string) => ReturnType<typeof processIdentitySchema.parse>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "workshop-recovery-process-retirement-"));
  const markerPath = join(directory, "process-launched.txt");
  const oldBootId = randomUUID();
  const newBootId = randomUUID();
  const databasePath = join(directory, "durable.sqlite");
  let harness: Harness | undefined;
  try {
    mkdirSync(join(directory, ".workshop", ".state"), { recursive: true });
    const prepared = prepare(directory, markerPath);
    const executionId = randomUUID();
    const incarnationId = randomUUID();
    const launchIntentAt = new Date(Date.now() - 1_000).toISOString();
    const run = buildRun(prepared, executionId);
    const input = buildInput(prepared, run, executionId, incarnationId, oldBootId, launchIntentAt);
    const identity = phase === "monitor"
      ? identityForBoot?.(oldBootId) ?? processIdentitySchema.parse({
        pid: 987_654_321,
        pgid: 987_654_321,
        startIdentity: "identity-from-prior-boot",
        serviceBootId: oldBootId,
      })
      : null;
    const process = processIncarnationSchema.parse({
      executionId,
      incarnationId,
      incarnationNumber: 1,
      role: "preflight",
      status: phase === "monitor" ? "running" : "launching",
      replay: "safe",
      commandHash: processCommandHash(input),
      launchIntentAt,
      launchServiceBootId: oldBootId,
      startedAt: phase === "monitor" ? launchIntentAt : null,
      finishedAt: null,
      deadlineAt: input.deadlineAt,
      identity,
      exit: null,
      cleanupState: "pending",
      captures: [],
      stdio: {
        version: 1,
        stdinSha256: input.stdinSha256,
        stdinByteCount: input.stdinByteCount,
        write: { kind: "pending", queuedBytes: 0 },
      },
    });
    const checkpoint: SeedCheckpoint = { phase, process };
    const seedTask = defineTask<ProcessExecutionTaskInput, SeedState, ProcessExecutionTaskResult>({
      name: PROCESS_TASK_KIND,
      version: PROCESS_TASK_VERSION,
      initial: () => ({ phase: "seed" }),
      phases: {
        seed: async (_task, runtime, context) => {
          await runtime.commit(() => ({ status: "running", checkpoint }), context);
          await new Promise<void>((resolve) => {
            if (runtime.signal.aborted) return resolve();
            runtime.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        launch: async () => {},
        monitor: async () => {},
      },
      abort: async () => {},
    });
    const processEntryData = workshopProcessV1Schema.parse({
      version: 1,
      runId: run.runId,
      nodeId: null,
      attemptId: null,
      taskId: 1,
      recordedAt: launchIntentAt,
      process,
    });

    const firstStorage = await openDurableStorage(databasePath);
    if (!firstStorage.ok) throw new Error(`${firstStorage.failure.message}: ${String(firstStorage.failure.cause)}`);
    const firstRegistry = createRegistry();
    firstRegistry.install({ name: "recovery-process-retirement-seed", tasks: [seedTask] });
    const firstHarness = await Harness.open(firstStorage.storage, {
      models: createModels(),
      registry: firstRegistry,
    }, BACKGROUND_CONTEXT);
    let taskId = 0;
    let conversationId = 0;
    let processEntryId = 0;
    try {
      await firstHarness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        conversationId = Number(conversation.id);
        Object.assign(await tx.doc(WorkshopRunDoc, conversation.id), {
          ...run,
          durable: { conversationId: Number(conversation.id), workflowTaskId: 1 },
        });
        taskId = Number(await tx.createTask(seedTask, input, {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
        }));
        processEntryData.taskId = taskId;
        processEntryId = Number((await tx.appendEntry(WorkshopProcessEntry, conversation.id, { data: processEntryData })).id);
      }, BACKGROUND_CONTEXT);
      firstHarness.resume();
      await waitForSeedCheckpoint(firstHarness, taskId, phase);
    } finally {
      await firstHarness.close(BACKGROUND_CONTEXT);
    }

    const currentStorage = await openDurableStorage(databasePath);
    if (!currentStorage.ok) throw new Error(`${currentStorage.failure.message}: ${String(currentStorage.failure.cause)}`);
    const currentTasks = defineProcessExecutionTask(newBootId);
    const registry = createRegistry();
    registry.install({ name: "recovery-process-retirement", tasks: [currentTasks.task] });
    harness = await Harness.open(currentStorage.storage, {
      models: createModels(),
      registry,
    }, BACKGROUND_CONTEXT);
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    expect(inspection.scheduling).toBe("paused");
    expect(inspection.tasks.some((task) => Number(task.record.id) === taskId)).toBe(true);
    await work({
      directory,
      harness,
      taskId,
      conversationId,
      markerPath,
      input,
      checkpoint,
      processEntryData,
      processEntryId,
      oldBootId,
      closeHarness: async () => {
        const currentHarness = harness;
        if (currentHarness === undefined) return;
        harness = undefined;
        await currentHarness.close(BACKGROUND_CONTEXT);
      },
    });
  } finally {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForSeedCheckpoint(harness: Harness, taskId: number, phase: "launch" | "monitor"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
    const checkpoint = task?.state.checkpoint as SeedCheckpoint | undefined;
    if (task?.state.status === "running" && checkpoint?.phase === phase) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`seed task did not commit its ${phase} checkpoint`);
}

async function retireTask(
  fixture: RetirementFixture,
  evidenceKind: "confirmed_dead" | "operator_attested_absent",
  mismatch?: "input" | "checkpoint" | "process identity" | "process entry" | "incarnation",
) {
  const task = await fixture.harness.getTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);
  if (task === undefined) throw new Error("prior-boot process task is missing");
  if (task.state.status === "terminal") throw new Error(`seeded task settled before retirement: ${JSON.stringify(task.state)}`);
  const recordInput = processExecutionTaskInputSchema.parse(task.input);
  const checkpoint = task.state.checkpoint as SeedCheckpoint;
  const requestId = randomUUID();
  const inputHash = mismatch === "input" ? canonicalHash({ changed: true }) : canonicalHash(recordInput);
  const checkpointHash = mismatch === "checkpoint" ? canonicalHash({ changed: true }) : canonicalHash(checkpoint);
  const process = checkpoint.process;
  const actionProcess = {
    executionId: process.executionId,
    incarnationId: mismatch === "incarnation" ? randomUUID() : process.incarnationId,
    launchServiceBootId: process.launchServiceBootId ?? null,
    identity: mismatch === "process identity" && process.identity !== null
      ? { ...process.identity, pid: process.identity.pid - 1, pgid: process.identity.pgid - 1 }
      : process.identity,
  };
  const action: RecoveryActionIntentV1 = {
    taskId: fixture.taskId,
    taskKind: PROCESS_TASK_KIND,
    taskVersion: PROCESS_TASK_VERSION,
    action: "abort",
    owner: {
      conversationId: fixture.conversationId,
      taskOwnerId: null,
      conversationOwner: null,
      ownershipHash: canonicalHash({ taskId: fixture.taskId, conversationId: fixture.conversationId, owner: null }),
    },
    inputHash,
    checkpointHash,
    process: actionProcess,
    processEntryHash: processEntryHash(fixture),
    replaySafety: "unknown",
  };
  const initialized = await initializeRecoveryIndex({
    harness: fixture.harness,
    context: BACKGROUND_CONTEXT,
    installationId: randomUUID(),
  });
  expect(initialized.kind).toBe("initialized");
  const admitted = await admitRecoveryIntent({
    harness: fixture.harness,
    context: BACKGROUND_CONTEXT,
    requestId,
    manifestDigest: HASH,
    reason: "Retire the prior-boot process task after evidence review",
    confirmedAt: TIME,
    resumeInstallation: true,
    actions: [action],
    committedAt: TIME,
  });
  expect(admitted.kind).toBe("admitted");

  let evidence;
  if (evidenceKind === "confirmed_dead") {
    if (process.identity === null || process.launchServiceBootId === undefined) throw new Error("monitor task lacks a recorded process identity");
    const proofIdentity = actionProcess.identity ?? process.identity;
    const verification = await verifyProcessDeath({
      identity: proofIdentity,
      launchServiceBootId: process.launchServiceBootId,
    }, { probeGroup: () => ({ state: "absent" }) });
    if (verification.kind !== "confirmed_absent") throw new Error("test process-death verifier did not confirm group absence");
    evidence = {
      kind: "confirmed_dead" as const,
      method: "process_group_absent" as const,
      hostBootId: verification.hostBootId,
      observedAt: verification.observedAt,
      identity: verification.checkedIdentity,
      executionId: actionProcess.executionId,
      incarnationId: actionProcess.incarnationId,
      launchServiceBootId: actionProcess.launchServiceBootId as string,
      inputHash,
      checkpointHash,
      processEntryHash: mismatch === "process entry" ? HASH : processEntryHash(fixture),
    };
  } else {
    evidence = {
      kind: "operator_attested_absent" as const,
      method: "typed_terminal_confirmation" as const,
      attestingRequestId: requestId,
      attestedAt: TIME,
      manifestDigest: HASH,
      processEntryHash: processEntryHash(fixture),
      evidenceHash: canonicalHash({
        confirmationLine: `recover ${requestId} ${HASH} resume-installation`,
        taskId: fixture.taskId, executionId: actionProcess.executionId, incarnationId: actionProcess.incarnationId,
        inputHash, checkpointHash, processEntryHash: processEntryHash(fixture),
      }),
    };
  }
  const recorded = await recordRecoveryDeathEvidence({
    harness: fixture.harness,
    context: BACKGROUND_CONTEXT,
    requestId,
    taskId: fixture.taskId,
    evidence,
  });
  if (mismatch === "process entry") {
    expect(recorded).toMatchObject({ kind: "conflict", code: "death_proof_mismatch" });
    expect(await markRecoveryActionDispatching({
      harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId, taskId: fixture.taskId, markedAt: TIME,
    })).toMatchObject({ kind: "conflict", code: "death_proof_required" });
    await fixture.harness.abortTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);
    fixture.harness.resume();
    return await fixture.harness.waitForTask(fixture.taskId as TaskId<ProcessExecutionTaskResult>, BACKGROUND_CONTEXT);
  }
  expect(recorded.kind).toBe("updated");
  expect((await markRecoveryActionDispatching({
    harness: fixture.harness,
    context: BACKGROUND_CONTEXT,
    requestId,
    taskId: fixture.taskId,
    markedAt: TIME,
  })).kind).toBe("updated");
  await fixture.harness.abortTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);
  expect((await recordRecoveryActionReceipt({
    harness: fixture.harness,
    context: BACKGROUND_CONTEXT,
    requestId,
    taskId: fixture.taskId,
    method: "abortTask",
    returnedAt: TIME,
    taskSnapshotHash: null,
  })).kind).toBe("updated");
  fixture.harness.resume();
  return await fixture.harness.waitForTask(fixture.taskId as TaskId<ProcessExecutionTaskResult>, BACKGROUND_CONTEXT);
}

type DetachedChildIdentity = { readonly pid: number; readonly pgid: number; readonly startIdentity: string };
type RecoveryAbort = {
  readonly requestId: string;
  readonly action: RecoveryActionIntentV1;
};

async function spawnDetachedChild(): Promise<DetachedChildIdentity> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error("detached child has no PID");
  child.unref();
  const pgid = processGroupId(child.pid);
  if (pgid === null) throw new Error(`cannot read process group for pid ${child.pid}`);
  return { pid: child.pid, pgid, startIdentity: processStartIdOrThrow(child.pid) };
}

async function admitRecoveryAbort(fixture: RetirementFixture): Promise<RecoveryAbort> {
  const task = await fixture.harness.getTask(fixture.taskId as TaskId, BACKGROUND_CONTEXT);
  if (task === undefined || task.state.status === "terminal") throw new Error("prior-boot process task is not available");
  const input = processExecutionTaskInputSchema.parse(task.input);
  const checkpoint = task.state.checkpoint as SeedCheckpoint;
  const process = checkpoint.process;
  const requestId = randomUUID();
  const action: RecoveryActionIntentV1 = {
    taskId: fixture.taskId, taskKind: PROCESS_TASK_KIND, taskVersion: PROCESS_TASK_VERSION, action: "abort",
    owner: {
      conversationId: fixture.conversationId, taskOwnerId: null, conversationOwner: null,
      ownershipHash: canonicalHash({ taskId: fixture.taskId, conversationId: fixture.conversationId, owner: null }),
    },
    inputHash: canonicalHash(input), checkpointHash: canonicalHash(checkpoint),
    process: {
      executionId: process.executionId, incarnationId: process.incarnationId,
      launchServiceBootId: process.launchServiceBootId ?? null, identity: process.identity,
    },
    processEntryHash: processEntryHash(fixture),
    replaySafety: "unknown"
  };
  expect((await initializeRecoveryIndex({
    harness: fixture.harness, context: BACKGROUND_CONTEXT, installationId: randomUUID(),
  })).kind).toBe("initialized");
  const admitted = await admitRecoveryIntent({
    harness: fixture.harness, context: BACKGROUND_CONTEXT, requestId, manifestDigest: HASH,
    reason: "Retire the prior-boot process task after evidence review", confirmedAt: TIME,
    resumeInstallation: true, actions: [action], committedAt: TIME,
  });
  expect(admitted.kind).toBe("admitted");
  return { requestId, action };
}

function confirmedDeathEvidence(
  fixture: RetirementFixture,
  recovery: RecoveryAbort,
  verification: Awaited<ReturnType<typeof verifyProcessDeath>>,
): RecoveryDeathEvidenceV1 {
  if (verification.kind === "refused") throw new Error(`process-death verification refused: ${verification.reason}`);
  const process = recovery.action.process;
  if (process === null || process.launchServiceBootId === null) throw new Error("recovery action lacks a process incarnation");
  return recoveryDeathEvidenceV1Schema.parse({
    kind: "confirmed_dead",
    method: verification.kind === "confirmed_absent" ? "process_group_absent" : "process_group_retired",
    hostBootId: verification.hostBootId, observedAt: verification.observedAt, identity: verification.checkedIdentity,
    executionId: process.executionId, incarnationId: process.incarnationId,
    launchServiceBootId: process.launchServiceBootId, inputHash: recovery.action.inputHash,
    checkpointHash: recovery.action.checkpointHash, processEntryHash: processEntryHash(fixture),
  });
}

async function latestProcess(fixture: RetirementFixture) {
  const conversation = await fixture.harness.conversation(fixture.conversationId as never, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("process task conversation is missing");
  const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  const latest = entries.items.find((entry) => entry.kind === "workshop.process");
  if (latest?.data === undefined) throw new Error("process retirement evidence is missing");
  return workshopProcessV1Schema.parse(latest.data).process;
}

function processEntryHash(fixture: RetirementFixture): string {
  return canonicalHash({ id: fixture.processEntryId, data: fixture.processEntryData });
}

function prepare(directory: string, markerPath: string) {
  const workflowId = "retirement";
  const sourceText = [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "environment:",
    "  preflight:",
    "    timeout: 30s",
    "    command: >-",
    `      printf launched >> '${markerPath}'; exec sleep 60`,
    "steps:",
    "  - first:",
    "      run: \"printf worker\"",
    "",
  ].join("\n");
  const checked = checkDefinitionText(sourceText, "retirement.yaml", workflowId);
  const machineConfig = { shell: "/bin/sh" } as const;
  const resolvedSettings = resolveWorkflowSettings({ definition: checked.def, machine: machineConfig, projectCwd: directory });
  const result = prepareRunAdmission({
    sourceText,
    sourceLabel: "retirement.yaml",
    workflowId,
    machineConfig,
    projectCwd: directory,
    stateDirectory: join(directory, ".workshop", ".state"),
    resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.4.0",
      integrationManifestHash: HASH,
      taskVersions: { workflowRun: 11, nodeAttempt: 5, agentExecution: 1, processExecution: PROCESS_TASK_VERSION, capacityGate: 1, scheduleWakeup: 1 },
    },
    runId: "retirement-run-001",
    eventId: "retirement-admission-001",
    activationId: "activation-retirement-001",
    occurrenceId: "occurrence-retirement-001",
    requestId: "retirement-request-001",
    admittedAt: TIME,
  });
  if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

type ReadyRun = Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { readonly state: "ready" }>;

function buildRun(prepared: ReturnType<typeof prepare>, executionId: string): ReadyRun {
  if (prepared.preflightCacheKey === null || prepared.resolvedSettings.preflight === null) {
    throw new Error("test workflow lacks a preflight command");
  }
  const run = workflowRunDocumentV1Schema.parse({
    state: "ready",
    runId: prepared.runId,
    workflowId: prepared.workflowId,
    activationId: prepared.activationId,
    occurrenceId: prepared.occurrenceId,
    requestId: prepared.requestId,
    admissionSequence: 1,
    admittedAt: prepared.admittedAt,
    sourceText: prepared.sourceText,
    sourceHash: prepared.sourceHash,
    canonicalDefinition: prepared.definition,
    canonicalHash: prepared.canonicalHash,
    resolvedSettings: prepared.resolvedSettings,
    chain: prepared.chain,
    paths: prepared.paths,
    runtimeManifest: prepared.runtimeManifest,
    durable: { conversationId: 1, workflowTaskId: 1 },
    status: "running",
    desiredState: "running",
    startedAt: prepared.admittedAt,
    finishedAt: null,
    currentNodeId: null,
    currentAttemptId: null,
    block: null,
    failure: null,
    preflight: {
      kind: "pending",
      cacheKeyHash: prepared.preflightCacheKey,
      processExecutionIds: [executionId],
    },
    nodes: prepared.chain.order.map((nodeId) => ({
      nodeId,
      status: "pending",
      successfulAttemptId: null,
      attempts: [],
    })),
    resolutions: [],
    terminalOutput: null,
  });
  if (run.state !== "ready") throw new Error("test run failed to initialize");
  return run;
}

function buildInput(
  prepared: ReturnType<typeof prepare>,
  run: ReadyRun,
  executionId: string,
  incarnationId: string,
  serviceBootId: string,
  launchIntentAt: string,
): ProcessExecutionTaskInput {
  const site = prepared.resolvedSettings.preflight;
  if (site === null) throw new Error("test workflow lacks preflight settings");
  const checkedExecutionId = executionIdSchema.parse(executionId);
  const checkedIncarnationId = incarnationIdSchema.parse(incarnationId);
  const deadlineAt = site.timeoutMs === null ? null : new Date(Date.parse(launchIntentAt) + site.timeoutMs).toISOString();
  const paths = processExecutionFiles({ role: "preflight", nodeId: null, incarnationNumber: 1, executionId: checkedExecutionId }, locateWorkflowDirectory(run), run.runId, null);
  const stdin = reconstructProcessStdin({ role: "preflight", nodeId: null, attemptId: null, executionId: checkedExecutionId }, run);
  const base = {
    runId: run.runId,
    workflowId: run.workflowId,
    activationId: run.activationId,
    occurrenceId: run.occurrenceId,
    workflowTaskId: run.durable.workflowTaskId,
    nodeTaskId: run.durable.workflowTaskId,
    nodeId: null,
    attemptId: null,
    executionId: checkedExecutionId,
    incarnationId: checkedIncarnationId,
    incarnationNumber: 1,
    serviceBootId,
    role: "preflight" as const,
    ioVersion: 1 as const,
    stdinSha256: stdin.sha256,
    stdinByteCount: stdin.byteCount,
    launchIntentAt,
    deadlineAt,
    shell: site.shell,
    command: site.command,
    cwd: site.cwd,
    timeoutMs: site.timeoutMs,
    streamCapBytes: DEFAULT_STREAM_CAP_BYTES,
    replay: "safe" as const,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  };
  return processExecutionTaskInputSchema.parse({
    ...base,
    env: buildProcessExecutionEnvironment(base, run, null),
  });
}

function processCommandHash(input: ProcessExecutionTaskInput): string {
  return canonicalHash({
    role: input.role,
    ioVersion: input.ioVersion,
    stdinSha256: input.stdinSha256,
    stdinByteCount: input.stdinByteCount,
    command: input.command,
    shell: input.shell,
    cwd: input.cwd,
    env: input.env,
  });
}
