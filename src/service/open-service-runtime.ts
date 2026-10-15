import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation, type ConversationId, type TaskGraph, type TaskGraphWatch, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import { parseModel } from "../definition/parse-model.js";
import { createWorkshopModels } from "../model/create-workshop-models.js";
import { BOT_TOOL_OUTPUT_LIMITS, createBotExtension, BOT_INSTRUCTIONS } from "../bot/create-bot-tools.js";
import { initializeBotEventCursors, scanCommittedBotEvents, type BotRunCursorTarget } from "../bot/scan-bot-events.js";
import { buildBotChatEntries, decodeBotChatCursor, encodeBotChatCursor, pendingDecisionActions } from "../bot/build-bot-feed.js";
import { botDocumentV1Schema, botChatViewV1Schema } from "../bot/schema.js";
import { resolveRetryLimit } from "../definition/resolve-retry-limit.js";
import { replyHumanWait } from "./reply-human-wait.js";
import { checkInstallationHasNoOpenLegacyRuns } from "./check-legacy-runs.js";
import { loadCheckedWorkflow, type CheckedWorkflow, type Installation } from "../installation/load-installation.js";
import {
  activationIndexSchema,
  installationDocumentV1Schema,
  serviceMutationReceiptV1Schema,
  serviceMutationReceiptsDocumentV1Schema,
  type ActivationIndex,
} from "../installation/schema.js";
import {
  activationIdSchema,
  runIdSchema,
  nodeAttemptOutcomeSchema,
  nodeResultSchema,
  operatorAcceptanceSchema,
  type NodeResult,
  type ValidatorOutcome,
  operatorResolutionSchema,
  runFailureInfoSchema,
  validatorOutcomeSchema,
} from "../run/schema.js";
import { checkBlockResolution } from "../run/check-block-resolution.js";
import { parseTextResult, parseTaggedWorkerResult } from "../attempt/parse-tagged-result.js";
import { prepareRunAdmission } from "../run/prepare-admission.js";
import { firstFixedRateDeadline } from "../run/decide-fixed-rate-schedule.js";
import { parseDuration } from "../util/parse-units.js";
import { createWorkflowContinuation } from "../storage/durable/create-workflow-continuation.js";
import { admitPreparedRun } from "../storage/durable/admit-run.js";
import { commitServiceMutation, findServiceMutationReceipt } from "../storage/durable/commit-service-mutation.js";
import { defineWorkshopTasks, createWorkflowRunTaskInput, parseWorkflowRunTaskInput } from "../storage/durable/define-workshop-tasks.js";
import { createCapacityGateTaskInput } from "../storage/durable/define-capacity-gate-task.js";
import { createScheduleWakeupTaskInput, defineScheduleWakeupTask } from "../storage/durable/define-scheduler-wakeup-task.js";
import {
  processExecutionTaskInputSchema,
  processExecutionTaskResultSchema,
  recoverRetainedProcessCaptureRecords,
} from "../storage/durable/define-process-execution-task.js";
import { resolveWorkerArtifacts } from "../storage/durable/define-node-attempt-task.js";
import { parseValidatorVerdictFile, parseWorkerResultFile, readResultFileBytes } from "../attempt/parse-result.js";
import { workflowRunDocumentV1Schema, workshopEventV1Schema, workshopProcessV1Schema } from "../run/records.js";
import { WorkshopBotDoc, WorkshopEventEntry, WorkshopInstallationDoc, WorkshopRunDoc, WorkshopServiceReceiptsDoc } from "../storage/durable/define-workshop-records.js";
import { checkpointDurableWal } from "../storage/durable/checkpoint-durable-wal.js";
import { openDurableStorage } from "../storage/durable/open-durable-storage.js";
import { createRunFileWriter } from "./project-run-files.js";
import { locateWorkflowDirectory } from "../run/locate-run-files.js";
import { removeProcessCaptures } from "../storage/disk/remove-process-captures.js";
import { readRunEvidenceSnapshot, readInstallation, readRun, projectServiceRead } from "./project-service-reads.js";
import { ServiceRequestError, ServiceShutdownError, serveWorkshopService, type WorkshopServiceRuntime } from "./serve-workshop-service.js";
import { serviceLogSectionPageV1Schema, serviceRunsPageV1Schema, type ServiceMetadataV1, type ServiceRequestV1 } from "./schema.js";
import { diagramDtoSchema } from "../views/schema.js";

const TASK_VERSIONS = { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, scheduleWakeup: 1 } as const;
const STARTUP_RECONCILIATION_MS = 10_000;

export function startWorkshopService(installation: Installation, models: Models = createWorkshopModels()) {
  return serveWorkshopService({
    stateDirectory: installation.stateDirectory,
    openRuntime: (metadata) => openServiceRuntime(installation, metadata, models),
  });
}

async function openServiceRuntime(
  installation: Installation,
  metadata: ServiceMetadataV1,
  models: Models,
): Promise<WorkshopServiceRuntime> {
  const botModel = installation.machine.bot === undefined ? undefined : resolveBotModel(installation.machine.bot.model, models);
  const opened = await openDurableStorage(installation.databasePath);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const storage = opened.storage;
  let harness: Harness | undefined;
  let tasks: ReturnType<typeof defineWorkshopTasks> | undefined;
  let taskGraphWatch: TaskGraphWatch | undefined;
  let idleCheckpoint = Promise.resolve();
  let idleRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let taskGraphIdle = false;
  let shuttingDown = false;
  const openCleanupErrors: unknown[] = [];
  let opening = true;
  let projectionWriter: ReturnType<typeof createRunFileWriter> | undefined;
  let projectionRefresh = Promise.resolve();
  let projectionTimer: ReturnType<typeof setTimeout> | undefined;
  const requireHarness = (): Harness => {
    if (harness === undefined) throw new Error("Durable Harness is unavailable");
    return harness;
  };
  const requireTasks = (): ReturnType<typeof defineWorkshopTasks> => {
    if (tasks === undefined) throw new Error("Workshop tasks are unavailable");
    return tasks;
  };

  try {
    tasks = defineWorkshopTasks(metadata.bootId, {
      startupLaunchGate: "closed",
      beforeLaunch: async (conversationId, signal) => {
        if (projectionWriter === undefined) throw new Error("projection writer is not initialized");
        while (!signal.aborted) {
          const result = await projectionWriter.project(conversationId);
          if (result.available) return;
          await waitForProjectionRetry(signal);
        }
        throw signal.reason ?? new Error("projection wait was aborted");
      },
    });
    const scheduleWakeupTask = defineScheduleWakeupTask({
      installation,
      workflowRunTask: tasks.WorkflowRunTask,
      canAdmit: tasks.canLaunch,
      runtimeManifest: {
        durableVersion: "1.0.2",
        integrationManifestHash: canonicalHash({ taskVersions: TASK_VERSIONS }),
        taskVersions: TASK_VERSIONS,
      },
    });
    const registry = createRegistry();
    registry.install({
      name: "workshop-service-runtime",
      tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, scheduleWakeupTask],
    });
    const botExtension = createBotExtension({
      readStatus: async workflowId => await projectServiceRead(requireHarness(), installation, metadata, { version: 1, method: "status", ...(workflowId === undefined ? {} : { workflowId }) }),
      readRun: async (workflowId, runId) => await readBotRun(requireHarness(), installation, metadata, workflowId, runId),
      readLogs: async (workflowId, runId) => await readBotLogs(requireHarness(), installation, metadata, workflowId, runId),
      startWorkflow: async workflowId => await startWorkflow(requireHarness(), requireTasks(), scheduleWakeupTask, installation, { version: 1, method: "start", requestId: randomUUID(), workflowId }),
      resolveBlock: async ({ runId, ...request }) => await resolveBlockedWorkflow(requireHarness(), requireTasks(), installation, { version: 1, method: "resolve", requestId: randomUUID(), ...request, ...(runId === undefined ? {} : { runId: runIdSchema.parse(runId) }), resolver: "bot" }),
    });
    registry.install(botExtension);
    harness = await Harness.open(storage, {
      models,
      registry,
      onReport(error) {
        if (opening) openCleanupErrors.push(error);
        else console.error(`Durable harness reported an extension failure: ${errorText(error)}`);
      },
    }, BACKGROUND_CONTEXT);
    await ensureInstallationReady(harness, installation);
    await checkInstallationHasNoOpenLegacyRuns(harness, BACKGROUND_CONTEXT);
    await reconcileStartupProcessTasks(harness, tasks, Date.now() + STARTUP_RECONCILIATION_MS);
    await assertNoUnreconciledProcessEvidence(harness, Date.now() + STARTUP_RECONCILIATION_MS, metadata.bootId);
    const runtimeHarness = harness;
    let botConversation: Conversation | undefined;
    if (botModel !== undefined) {
      botConversation = await ensureBotConversation(runtimeHarness, botExtension, botModel.full);
      const index = await readInstallation(runtimeHarness);
      await initializeBotEventCursors(runtimeHarness, botRunTargets(index));
    } else {
      const botState = botDocumentV1Schema.parse(await runtimeHarness.snapshot(WorkshopBotDoc, BACKGROUND_CONTEXT)
        ?? { state: "ready", conversationId: null, cursorInitialized: false, eventCursors: {} });
      if (botState.conversationId !== null) {
        botConversation = await runtimeHarness.conversation(botState.conversationId as ConversationId, BACKGROUND_CONTEXT);
        await botConversation?.configure({ model: null }, BACKGROUND_CONTEXT);
      }
    }
    const writerHarness = harness;
    const diagnosticKeys = new Set<string>();
    const pendingCaptureCleanup = new Set<number>();
    projectionWriter = createRunFileWriter({
      load: async (conversationId) => {
        const index = await readInstallation(writerHarness);
        const owner = Object.entries(index.workflows).find(([, workflow]) => workflow.runs.some((run) => run.conversationId === Number(conversationId)));
        const reference = owner?.[1].runs.find((run) => run.conversationId === Number(conversationId));
        if (reference === undefined || owner === undefined) throw new Error("projection run reference is unavailable");
        const snapshot = await readRunEvidenceSnapshot(writerHarness, reference, owner[0]);
        for (const event of snapshot.events) {
          if (event.type === "view_projection_failed") diagnosticKeys.add(Number(conversationId) + ":" + event.nodeId + ":" + event.message);
        }
        return snapshot;
      },
      diagnostic: async (conversationId, message, nodeId) => {
        const boundedMessage = message.slice(0, 4096);
        const key = Number(conversationId) + ":" + nodeId + ":" + boundedMessage;
        if (diagnosticKeys.has(key)) return;
        console.error(boundedMessage);
        await writerHarness.commit(async (tx) => {
          const run = workflowRunDocumentV1Schema.parse(await tx.doc(WorkshopRunDoc, conversationId));
          if (run.state !== "ready") return;
          await tx.appendEntry(WorkshopEventEntry, conversationId, { data: workshopEventV1Schema.parse({
            version: 1, eventId: randomUUID(), type: "view_projection_failed", runId: run.runId,
            nodeId, message: boundedMessage, occurredAt: new Date().toISOString(),
          }) });
        }, BACKGROUND_CONTEXT);
        diagnosticKeys.add(key);
      },
      settled: async (snapshot) => {
        for (const record of snapshot.processEvidence) {
          const process = record.process;
          const task = await writerHarness.getTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
          const superseded = snapshot.processEvidence.some((other) => other.process.executionId === process.executionId
            && other.process.incarnationNumber > process.incarnationNumber);
          const settled = task?.state.status === "terminal" && (process.status === "exited" || superseded
            || ["completed", "failed", "cancelled"].includes(snapshot.run.status));
          removeProcessCaptures(process, settled);
        }
        // A failed disk removal must remain retryable even when the run is terminal.
        const pending = snapshot.processEvidence.some(record => record.process.captures.some(capture =>
          [capture.path, capture.path + ".retention.json", capture.path + ".retention-tmp"].some(path => existsSync(path))));
        if (pending) pendingCaptureCleanup.add(snapshot.run.durable.conversationId);
        else pendingCaptureCleanup.delete(snapshot.run.durable.conversationId);
      },
    });
    const activeWriter = projectionWriter;
    let refreshing = false;
    let refreshAgain = false;
    let projectionGraph = "";
    const projectedTerminalRuns = new Map<number, { directory: string; identity: string }>();
    const readProjectionIdentity = (directory: string): string | null => {
      try {
        const identities: string[] = [];
        for (const name of ["results.md", "execution.log"]) {
          const stat = lstatSync(join(directory, name));
          if (!stat.isFile()) return null;
          identities.push([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"));
        }
        return identities.join("|");
      } catch { return null; }
    };
    const refreshProjections = (): Promise<void> => {
      if (shuttingDown) return projectionRefresh;
      if (refreshing) { refreshAgain = true; return projectionRefresh; }
      refreshing = true;
      projectionRefresh = (async () => {
        let unavailable = false;
        try {
          do {
            refreshAgain = false;
            const index = await readInstallation(writerHarness);
            for (const reference of Object.values(index.workflows).flatMap((workflow) => workflow.runs)) {
              // Terminal evidence is immutable. Polling and log pages must not rewrite all history.
              const projected = projectedTerminalRuns.get(reference.conversationId);
              if (projected !== undefined && !pendingCaptureCleanup.has(reference.conversationId)
                && readProjectionIdentity(projected.directory) === projected.identity) continue;
              // History is retained but never reinterpreted or executed by the format 4 engine.
              const stored: unknown = await writerHarness.snapshot(WorkshopRunDoc, reference.conversationId as ConversationId, BACKGROUND_CONTEXT);
              if (isArchivedRunSnapshot(stored)) continue;
              const run = await readRun(writerHarness, reference);
              if (!("formatVersion" in run.resolvedSettings) || run.resolvedSettings.formatVersion !== 4) continue;
              const result = await activeWriter.project(reference.conversationId as ConversationId);
              if (!result.available) unavailable = true;
              else if (["completed", "failed", "cancelled"].includes(run.status)) {
                const directory = locateWorkflowDirectory(run);
                const identity = readProjectionIdentity(directory);
                if (identity !== null) projectedTerminalRuns.set(reference.conversationId, { directory, identity });
              }
            }
          } while (refreshAgain && !shuttingDown);
        } catch (error) {
          unavailable = true;
          console.error("unavailable view: " + errorText(error));
        } finally {
          refreshing = false;
          if (unavailable && !shuttingDown && projectionTimer === undefined) {
            projectionTimer = setTimeout(() => { projectionTimer = undefined; void refreshProjections(); }, 250);
          }
        }
      })();
      return projectionRefresh;
    };
    await refreshProjections();
    tasks.openStartupLaunchGate();
    harness.resume();

    const activeHarness = harness;
    const activeTasks = tasks;
    const schedulerWakeupKind = scheduleWakeupTask.definition.name;
    let botScanPromise: Promise<void> | undefined;
    let botScanAgain = false;
    const kickBot = (): void => {
      if (shuttingDown || installation.machine.bot === undefined || botConversation === undefined) return;
      if (botScanPromise !== undefined) { botScanAgain = true; return; }
      botScanPromise = (async () => {
        do {
          botScanAgain = false;
          try {
            const index = await readInstallation(activeHarness);
            await scanCommittedBotEvents({
              harness: activeHarness,
              botConversation: botConversation!,
              targets: botRunTargets(index),
              submit: async (requestId, message) => await botConversation!.submit({ type: "input", requestId, content: message }, BACKGROUND_CONTEXT),
            });
          } catch (error) {
            console.error("shared bot event scan failed: " + errorText(error));
          }
        } while (botScanAgain && !shuttingDown);
      })().finally(() => { botScanPromise = undefined; });
    };
    const checkpointIfTaskGraphIdle = async (graph: TaskGraph): Promise<void> => {
      if (shuttingDown) return;
      const nextGraph = JSON.stringify(graph);
      if (nextGraph !== projectionGraph) { projectionGraph = nextGraph; void refreshProjections(); kickBot(); }
      // The scheduler's durable timer is not active workflow work and must not keep an idle WAL alive.
      const hasRunnableWork = Object.values(graph.tasks).some((task) =>
        task.kind !== schedulerWakeupKind && task.state.status !== "waiting",
      );
      if (hasRunnableWork) {
        taskGraphIdle = false;
        if (idleRetryTimer !== undefined) {
          clearTimeout(idleRetryTimer);
          idleRetryTimer = undefined;
        }
        return;
      }
      if (taskGraphIdle) return;
      taskGraphIdle = true;
      idleCheckpoint = (async () => {
        try {
          const checkpointed = await checkpointDurableWal(installation.databasePath);
          if (!checkpointed) {
            taskGraphIdle = false;
            idleRetryTimer = setTimeout(() => {
              idleRetryTimer = undefined;
              if (taskGraphWatch !== undefined) void checkpointIfTaskGraphIdle(taskGraphWatch.value);
            }, 250);
          }
        } catch (error) {
          console.error(`Durable idle WAL checkpoint failed: ${errorText(error)}`);
        }
      })();
      await idleCheckpoint;
    };
    taskGraphWatch = await activeHarness.watchTaskGraph(BACKGROUND_CONTEXT);
    taskGraphWatch.start(checkpointIfTaskGraphIdle);
    kickBot();
    void checkpointIfTaskGraphIdle(taskGraphWatch.value);
    opening = false;

    let closed = false;
    return {
      async handleRequest(request) {
        if (closed) throw new Error("service runtime is closed");
        await refreshProjections();
        switch (request.method) {
          case "start": {
            const result = await startWorkflow(activeHarness, activeTasks, scheduleWakeupTask, installation, request);
            await refreshProjections();
            kickBot();
            return result;
          }
          case "pause":
          case "resume":
          case "stop": {
            const result = await controlWorkflow(activeHarness, activeTasks, request);
            await refreshProjections();
            kickBot();
            return result;
          }
          case "human.reply": {
            const result = await replyHumanWait(activeHarness, activeTasks, request);
            await refreshProjections();
            kickBot();
            return result;
          }
          case "resolve": {
            const result = await resolveBlockedWorkflow(activeHarness, activeTasks, installation, request);
            await refreshProjections();
            kickBot();
            return result;
          }
          case "chat.submit": {
            if (botModel === undefined || botConversation === undefined) {
              throw new ServiceRequestError("bot_not_configured", "Bot not configured; set bot.model in machine configuration");
            }
            const submission = await botConversation.submit({ type: "input", requestId: request.requestId, content: request.text }, BACKGROUND_CONTEXT);
            return { submitted: true, submissionId: String(submission.id) };
          }
          case "chat.view": {
            return await readBotChat(activeHarness, installation, botConversation, request.cursor, request.limit ?? 50, botModel);
          }
          case "status":
          case "runs":
          case "logs.page":
          case "node.describe":
          case "diagram":
            return await projectServiceRead(activeHarness, installation, metadata, request);
          default:
            throw new Error(`service method ${request.method} is not available yet`);
        }
      },
      async shutdown(deadlineMs) {
        if (closed) return;
        shuttingDown = true;
        activeTasks.stopLaunching();
        if (botScanPromise !== undefined) await beforeDeadline(botScanPromise, deadlineMs, "shared bot event scan");
        if (projectionTimer !== undefined) { clearTimeout(projectionTimer); projectionTimer = undefined; }
        if (idleRetryTimer !== undefined) {
          clearTimeout(idleRetryTimer);
          idleRetryTimer = undefined;
        }
        if (taskGraphWatch !== undefined) {
          await beforeDeadline(taskGraphWatch.stop().then(() => undefined), deadlineMs, "idle WAL checkpoint observer close");
          taskGraphWatch = undefined;
        }
        await beforeDeadline(idleCheckpoint, deadlineMs, "idle WAL checkpoint");
        await beforeDeadline(projectionRefresh, deadlineMs, "run projections");
        await beforeDeadline(activeWriter.drain(), deadlineMs, "projection writer");
        await reconcileLiveProcessTasks(activeHarness, activeTasks, deadlineMs);
        await assertNoUnreconciledProcessEvidence(activeHarness, deadlineMs);
        try {
          await beforeDeadline(activeHarness.close(BACKGROUND_CONTEXT), deadlineMs, "Durable Harness and storage close");
          await beforeDeadline(checkpointDurableWal(installation.databasePath), deadlineMs, "shutdown WAL checkpoint");
          closed = true;
        } catch (error) {
          throw new ServiceShutdownError("Durable runtime and shutdown WAL checkpoint did not close before the service deadline", { cause: error });
        }
      },
    };
  } catch (error) {
    opening = false;
    shuttingDown = true;
    tasks?.stopLaunching();
    if (projectionTimer !== undefined) { clearTimeout(projectionTimer); projectionTimer = undefined; }
    if (idleRetryTimer !== undefined) {
      clearTimeout(idleRetryTimer);
      idleRetryTimer = undefined;
    }
    const cleanupErrors = [...openCleanupErrors];
    if (taskGraphWatch !== undefined) {
      try {
        await taskGraphWatch.stop();
        await beforeDeadline(idleCheckpoint, Date.now() + STARTUP_RECONCILIATION_MS, "partial idle WAL checkpoint");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      taskGraphWatch = undefined;
    }
    if (harness !== undefined) {
      try {
        if (tasks !== undefined) await reconcileLiveProcessTasks(harness, tasks, Date.now() + STARTUP_RECONCILIATION_MS, true);
        await assertNoUnreconciledProcessEvidence(harness, Date.now() + STARTUP_RECONCILIATION_MS);
        await projectionRefresh;
        await projectionWriter?.drain();
        await beforeDeadline(harness.close(BACKGROUND_CONTEXT), Date.now() + STARTUP_RECONCILIATION_MS, "partial Harness close");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else {
      try {
        await storage.close(BACKGROUND_CONTEXT);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new ServiceShutdownError("Durable runtime open failed and partial resources could not be safely closed", {
        cause: new AggregateError([error, ...cleanupErrors]),
      });
    }
    throw error;
  }
}

function resolveBotModel(modelText: string, models: Models): ReturnType<typeof parseModel> {
  const model = parseModel(modelText);
  if (models.getProvider(model.provider) === undefined) {
    throw new Error("bot.model provider " + JSON.stringify(model.provider) + " is not available in the model registry");
  }
  if (models.getModel(model.provider, model.modelId) === undefined) {
    throw new Error("bot.model " + JSON.stringify(model.full) + " is not available from provider " + JSON.stringify(model.provider));
  }
  return model;
}

async function ensureBotConversation(harness: Harness, extension: ReturnType<typeof createBotExtension>, modelText: string): Promise<Conversation> {
  await harness.commit(async tx => {
    const raw = await tx.doc(WorkshopBotDoc);
    const draft = botDocumentV1Schema.parse(raw);
    if (draft.conversationId !== null) return;
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    Object.assign(raw, { ...draft, conversationId: Number(conversation.id) });
  }, BACKGROUND_CONTEXT);
  const botState = botDocumentV1Schema.parse(await harness.snapshot(WorkshopBotDoc, BACKGROUND_CONTEXT));
  if (botState.conversationId === null) throw new Error("shared bot conversation was not persisted");
  const conversation = await harness.conversation(botState.conversationId as ConversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error("shared bot conversation is unavailable");
  const model = parseModel(modelText);
  await conversation.configure({
    model: { provider: model.provider, modelId: model.modelId },
    thinkingLevel: model.thinking,
    extensions: [extension],
    tools: null,
    instructions: BOT_INSTRUCTIONS,
  }, BACKGROUND_CONTEXT);
  return conversation;
}

function botRunTargets(installation: Awaited<ReturnType<typeof readInstallation>>): BotRunCursorTarget[] {
  return Object.entries(installation.workflows).flatMap(([workflowId, workflow]) => workflow.runs.map(reference => ({
    workflowId, runId: reference.runId, conversationId: reference.conversationId,
  })));
}

async function readBotChat(
  harness: Harness,
  installation: Installation,
  conversation: Conversation | undefined,
  encodedCursor: string | undefined,
  limit: number,
  botModel: ReturnType<typeof parseModel> | undefined,
): Promise<unknown> {
  const cursor = decodeBotChatCursor(encodedCursor);
  let page: Awaited<ReturnType<Conversation["entries"]>> | undefined;
  if (conversation !== undefined) page = await conversation.entries({}, limit, cursor, BACKGROUND_CONTEXT);
  const index = await readInstallation(harness);
  const pending: unknown[] = [];
  const botPermitted = new Set(["verifier_block", "verifier_failed", "repeated_failure", "preflight_failed"]);
  for (const [workflowId, workflow] of Object.entries(index.workflows)) {
    const reference = workflow.openRunId === null ? undefined : workflow.runs.find(run => run.runId === workflow.openRunId);
    if (reference === undefined || (reference.status !== "waiting" && reference.status !== "blocked")) continue;
    const run = await readRun(harness, reference);
    if (run.status === "waiting") {
      const wait = run.waits?.find(entry => entry.settlement.kind === "pending");
      if (wait !== undefined) pending.push({ kind: "wait", workflowId, runId: run.runId, waitId: wait.waitId, question: wait.question, proposal: wait.output });
    } else if (run.status === "blocked" && run.block !== null && !botPermitted.has(run.block.kind)) {
      pending.push({ kind: "block", workflowId, runId: run.runId, blockId: run.block.blockId, blockKind: run.block.kind,
        reason: run.block.reason, actions: pendingDecisionActions(run.block.kind) });
    }
  }
  return botChatViewV1Schema.parse({
    configured: botModel !== undefined,
    bot: botModel === undefined ? null : { providerId: botModel.provider, modelId: botModel.modelId },
    entries: page === undefined ? [] : buildBotChatEntries(page.items),
    nextCursor: encodeBotChatCursor(page?.next),
    pending: pending.slice(0, 100),
  });
}

async function readBotLogs(
  harness: Harness,
  installation: Installation,
  metadata: ServiceMetadataV1,
  workflowId: string,
  runId: string | undefined,
): Promise<string> {
  const truncationLabel = "[truncated: Workshop bot log output reached its 16 KiB or 100-line limit]";
  const reservedBytes = Buffer.byteLength(truncationLabel, "utf8") + 1;
  const maxContentBytes = BOT_TOOL_OUTPUT_LIMITS.maxBytes - reservedBytes;
  const maxContentLines = BOT_TOOL_OUTPUT_LIMITS.maxLines - 2;
  const lineBreak = "\n";
  let cursor: string | undefined;
  let output = "";
  let lastSectionIndex = -1;
  let truncated = false;
  let lineCount = 0;

  const append = (value: string): boolean => {
    let piece = "";
    let bytes = Buffer.byteLength(output, "utf8");
    for (const character of value) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + characterBytes > maxContentBytes) break;
      if (character === lineBreak && lineCount + 1 > maxContentLines) break;
      piece += character;
      bytes += characterBytes;
      if (character === lineBreak) lineCount += 1;
    }
    output += piece;
    return piece.length === value.length;
  };

  do {
    const page = serviceLogSectionPageV1Schema.parse(await projectServiceRead(harness, installation, metadata, {
      version: 1, method: "logs.page", workflowId, ...(runId === undefined ? {} : { runId: runIdSchema.parse(runId) }),
      ...(cursor === undefined ? {} : { cursor }), verbose: true,
    }));
    if (page.sectionIndex !== lastSectionIndex) {
      const prefix = output.length === 0 ? "" : lineBreak;
      if (!append(prefix + "--- " + page.section.label + " ---" + lineBreak)) {
        truncated = true;
        break;
      }
      lastSectionIndex = page.sectionIndex;
    }
    const content = page.section.content ?? "[retained capture content is unavailable]";
    if (!append(content)) {
      truncated = true;
      break;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  if (output.length === 0) return "No retained log text is available.";
  if (truncated || cursor !== undefined) {
    const separator = output.endsWith(lineBreak) ? "" : lineBreak;
    return output + separator + truncationLabel;
  }
  return output;
}

async function readBotRun(
  harness: Harness,
  installation: Installation,
  metadata: ServiceMetadataV1,
  workflowId: string,
  runId: string | undefined,
): Promise<unknown> {
  const diagram = diagramDtoSchema.parse(await projectServiceRead(harness, installation, metadata, {
    version: 1, method: "diagram", workflowId, ...(runId === undefined ? {} : { runId: runIdSchema.parse(runId) }),
  }));
  let cursor: string | undefined;
  do {
    const page = serviceRunsPageV1Schema.parse(await projectServiceRead(harness, installation, metadata, {
      version: 1, method: "runs", workflowId, ...(cursor === undefined ? {} : { cursor }), limit: 100,
    }));
    const summary = page.runs.find((run) => run.runId === diagram.runId);
    if (summary !== undefined) {
      return { ...diagram, status: summary.status, failure: summary.failure, terminalOutput: summary.terminalOutput };
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  if (diagram.runId === null) return { ...diagram, status: null, failure: null, terminalOutput: null };
  throw new Error("run " + diagram.runId + " is absent from the run read projection");
}

async function ensureInstallationReady(harness: Harness, installation: Installation): Promise<void> {
  await harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopInstallationDoc);
    const checked = installationDocumentV1Schema.parse(draft);
    if (checked.state === "ready") return;
    Object.assign(draft, installationDocumentV1Schema.parse({
      state: "ready",
      installationId: randomUUID(),
      maxConcurrentRuns: installation.machine.max_concurrent_runs ?? 1,
      workflows: {},
    }));
  }, BACKGROUND_CONTEXT);
}

async function startWorkflow(
  harness: Harness,
  tasks: ReturnType<typeof defineWorkshopTasks>,
  scheduleWakeupTask: ReturnType<typeof defineScheduleWakeupTask>,
  installation: Installation,
  request: Extract<ServiceRequestV1, { method: "start" }>,
): Promise<unknown> {
  const requestArguments = { workflowId: request.workflowId };
  const requestHash = canonicalHash({ method: "start", arguments: requestArguments });
  const receiptSnapshot = await harness.snapshot(WorkshopServiceReceiptsDoc, BACKGROUND_CONTEXT);
  const receiptDocument = serviceMutationReceiptsDocumentV1Schema.parse(receiptSnapshot ?? { state: "ready", receipts: [] });
  const prior = receiptDocument.receipts.find((receipt) => receipt.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.method !== "start" || prior.requestHash !== requestHash) throw new Error("idempotency_conflict: request ID was used with different arguments");
    return prior.response;
  }

  const checked = loadCheckedWorkflow(installation, request.workflowId);
  const indexed = await readInstallation(harness);
  for (const [workflowId, workflow] of Object.entries(indexed.workflows)) {
    const existingRunId = workflow.requestIndex[request.requestId];
    if (existingRunId !== undefined) {
      if (workflowId !== request.workflowId) throw new Error("idempotency_conflict: request ID belongs to another workflow");
      const reference = workflow.runs.find((run) => run.runId === existingRunId);
      if (reference === undefined) throw new Error("request index points to a missing run");
      const response = admissionFromReference(reference, request.workflowId, true);
      return persistNoopStartReceipt(harness, request, response, reference.runId);
    }
  }
  const workflowBeforeActivation = indexed.workflows[request.workflowId];
  if (workflowBeforeActivation?.openRunId !== null && workflowBeforeActivation?.openRunId !== undefined) {
    const reference = workflowBeforeActivation.runs.find((run) => run.runId === workflowBeforeActivation.openRunId);
    if (reference === undefined) throw new Error(`open run ${workflowBeforeActivation.openRunId} is missing from the installation index`);
    await readRun(harness, reference);
    const response = admissionFromReference(reference, request.workflowId, true);
    return persistNoopStartReceipt(harness, request, response, reference.runId);
  }
  const activeActivation = workflowBeforeActivation?.activations.find((entry) => entry.state === "active");
  const scheduleEveryMs = checked.definition.schedule === undefined
    ? null
    : parseDuration(checked.definition.schedule.every);
  const maxRuns = checked.definition.schedule?.max_runs ?? 1;
  const replaceActiveActivation = activeActivation !== undefined
    && (activeActivation.scheduleEveryMs !== scheduleEveryMs || activeActivation.maxRuns !== maxRuns);
  const activationProposal = activeActivation === undefined || replaceActiveActivation ? createActivationProposal(checked) : undefined;
  const activationId = (replaceActiveActivation ? activationProposal : activeActivation)?.activationId
    ?? activationProposal?.activationId;
  if (activationId === undefined) throw new Error("workflow activation could not be selected");

  const runId = `${request.workflowId}-${randomUUID()}`;
  const prepared = prepareRunAdmission({
    sourceText: checked.sourceText,
    sourceLabel: checked.sourcePath,
    workflowId: checked.workflowId,
    machineConfig: installation.machine,
    projectCwd: installation.projectCwd,
    stateDirectory: installation.stateDirectory,
    resolvedSettings: checked.resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: canonicalHash({ taskVersions: TASK_VERSIONS }),
      taskVersions: TASK_VERSIONS,
    },
    runId,
    eventId: randomUUID(),
    activationId,
    occurrenceId: randomUUID(),
    requestId: request.requestId,
    admittedAt: new Date().toISOString(),
  });
  if (!prepared.ok) throw new Error(`${prepared.failure.kind}: ${prepared.failure.message}`);
  const admitted = await admitPreparedRun({
    harness,
    prepared: prepared.value,
    workflowRunTask: tasks.WorkflowRunTask,
    createTaskInput: createWorkflowRunTaskInput,
    parseTaskInput: parseWorkflowRunTaskInput,
    context: BACKGROUND_CONTEXT,
    activationProposal,
    replaceActiveActivation,
    createScheduleWakeupTask: async (tx, conversationId, workflowId, scheduledActivationId) => await tx.createTask(
      scheduleWakeupTask,
      createScheduleWakeupTaskInput({ workflowId, activationId: activationIdSchema.parse(scheduledActivationId) }),
      { ownership: { kind: "conversation" }, conversationId, background: true },
    ),
    serviceMutation: {
      request: { requestId: request.requestId, method: "start", arguments: requestArguments },
      retain: () => ({ kind: "run", runId }),
      committedAt: prepared.value.admittedAt,
    },
  });
  if (!admitted.ok) throw new Error(`${admitted.failure.kind}: ${admitted.failure.message}`);
  return admitted.value;
}
async function controlWorkflow(
  harness: Harness,
  tasks: ReturnType<typeof defineWorkshopTasks>,
  request: Extract<ServiceRequestV1, { method: "pause" | "resume" | "stop" }>,
): Promise<unknown> {
  const action = request.method;
  const result = await commitServiceMutation({
    harness,
    context: BACKGROUND_CONTEXT,
    request: { requestId: request.requestId, method: action, arguments: { workflowId: request.workflowId } },
    retain: (response) => typeof response === "object" && response !== null && !Array.isArray(response)
      && "runId" in response && typeof response.runId === "string"
      ? { kind: "run", runId: response.runId }
      : { kind: "service" },
    apply: async (tx) => {
      const installationDraft = await tx.doc(WorkshopInstallationDoc);
      const parsedInstallation = installationDocumentV1Schema.safeParse(installationDraft);
      if (!parsedInstallation.success || parsedInstallation.data.state !== "ready") {
        throw new Error("installation document is invalid or uninitialized");
      }
      const installation = parsedInstallation.data;
      const workflow = installation.workflows[request.workflowId];
      if (workflow === undefined) throw new Error(`workflow is not registered: ${request.workflowId}`);
      const activation = workflow.activations.at(-1);
      if (action !== "stop" && activation?.state === "stopped") {
        throw new ServiceRequestError("run_stopped", "run_stopped: stopped intent is final; start a new run after stop completes");
      }
      const at = new Date().toISOString();
      if (activation !== undefined) {
        if (action === "pause" && activation.state === "active") activation.state = "paused";
        if (action === "stop") {
          activation.state = "stopped";
          activation.nextDueAt = null;
        }
        if (action === "resume" && activation.state === "paused"
          && (activation.maxRuns === "unlimited" || activation.admittedCount < activation.maxRuns)) {
          activation.state = "active";
        }
      }

      let response: { workflowId: string; runId: string | null; status: string; desiredState: string };
      if (workflow.openRunId === null) {
        response = { workflowId: request.workflowId, runId: null, status: "idle", desiredState: action === "pause" ? "paused" : action === "stop" ? "stopped" : "running" };
      } else {
        const reference = workflow.runs.find((run) => run.runId === workflow.openRunId);
        if (reference === undefined) throw new Error(`open run ${workflow.openRunId} is missing from the installation index`);
        // SAFETY: the checked installation index stores the conversation ID committed with this run.
        const conversationId = reference.conversationId as ConversationId;
        const runDraft = await tx.doc(WorkshopRunDoc, conversationId);
        const parsedRun = workflowRunDocumentV1Schema.safeParse(runDraft);
        if (!parsedRun.success || parsedRun.data.state !== "ready") throw new Error("open run document is invalid");
        const run = parsedRun.data;
        if (run.runId !== reference.runId || run.workflowId !== request.workflowId) {
          throw new Error("open run identity differs from the installation index");
        }
        if (action !== "stop" && run.desiredState === "stopped") {
          throw new ServiceRequestError("run_stopped", "run_stopped: stopped intent is final; start a new run after stop completes");
        }
        const restartingFailedPreflight = action === "resume" && run.status === "blocked"
          && run.preflight.kind === "failed" && run.block?.kind === "preflight_failed"
          && run.currentAttemptId === null;
        if (action === "resume" && run.status === "blocked" && !restartingFailedPreflight) {
          throw new ServiceRequestError("run_blocked", "run_blocked: resolve the current block before resuming");
        }
        if (action === "resume" && run.desiredState === "stopped") {
          throw new Error("run_stopped: start a new run after stop completes");
        }

        const desiredState = action === "pause" ? "paused" : action === "stop" ? "stopped" : "running";
        const cancelTasklessWait = action === "stop" && (run.status === "waiting" || run.durable.continuationPending === true);
        const resumeContinuation = action === "resume" && run.durable.continuationPending === true;
        const cancelCapacityWait = cancelTasklessWait || (action === "stop" && run.status === "queued"
          && run.currentAttemptId === null && run.durable.capacityGateTaskId !== null
          && run.durable.capacityGateTaskId !== undefined);
        const status = cancelCapacityWait ? "cancelled" : restartingFailedPreflight ? "queued"
          : action === "resume" && run.status === "paused" ? "queued" : run.status;
        if ((action === "pause" && (run.status === "queued" || run.status === "paused"))
          || (action === "stop" && status === "paused")) {
          workflow.capacityReservations = workflow.capacityReservations.filter((runId) => runId !== run.runId);
        }
        const needsCapacityGate = action === "resume" && status === "queued"
          && !workflow.capacityReservations.includes(run.runId)
          && (run.durable.capacityGateTaskId === null || run.durable.capacityGateTaskId === undefined);
        if (status !== run.status || desiredState !== run.desiredState || restartingFailedPreflight || needsCapacityGate) {
          let workflowTaskId = run.durable.workflowTaskId;
          let capacityGateTaskId = run.durable.capacityGateTaskId ?? null;
          let nextRun = { ...run, status, desiredState };
          if (cancelCapacityWait) {
            capacityGateTaskId = null;
            nextRun = {
              ...run,
              status: "cancelled",
              desiredState,
              finishedAt: at,
              block: null,
              failure: null,
              terminalOutput: null,
              currentAttemptId: null,
              durable: { ...run.durable, capacityGateTaskId: null, continuationPending: false },
              waits: run.waits?.map((wait) => wait.settlement.kind === "pending"
                ? { ...wait, settlement: { kind: "stopped" as const, resolvedAt: at } } : wait),
              nodes: run.currentNodeId === null ? run.nodes : run.nodes.map((node) =>
                node.nodeId === run.currentNodeId && (node.status === "pending" || node.status === "waiting")
                  ? { ...node, status: "cancelled" } : node),
            };
            workflow.openRunId = null;
            workflow.capacityReservations = workflow.capacityReservations.filter((runId) => runId !== run.runId);
          }
          if (resumeContinuation) {
            const durable = await createWorkflowContinuation(tx, tasks, run, conversationId);
            workflowTaskId = durable.workflowTaskId;
            capacityGateTaskId = durable.capacityGateTaskId ?? null;
            nextRun = { ...nextRun, durable };
            reference.workflowTaskId = workflowTaskId;
          }
          if (restartingFailedPreflight) {
            if (run.preflight.kind !== "failed") throw new Error("failed preflight state changed before resume");
            workflowTaskId = Number(await tx.createTask(
              tasks.WorkflowRunTask,
              createWorkflowRunTaskInput({
                runId: run.runId,
                workflowId: run.workflowId,
                activationId: run.activationId,
                occurrenceId: run.occurrenceId,
              }),
              { ownership: { kind: "conversation" }, conversationId },
            ));
            capacityGateTaskId = null;
            nextRun = {
              ...run,
              status: "queued",
              desiredState,
              startedAt: null,
              finishedAt: null,
              block: null,
              failure: null,
              terminalOutput: null,
              preflight: {
                kind: "pending",
                cacheKeyHash: run.preflight.cacheKeyHash,
                processExecutionIds: run.preflight.processExecutionIds,
              },
              durable: { ...run.durable, workflowTaskId, capacityGateTaskId },
            };
            reference.workflowTaskId = workflowTaskId;
          }
          if (action === "resume" && status === "queued" && !workflow.capacityReservations.includes(run.runId)
            && capacityGateTaskId === null) {
            const gateTaskId = await tx.createTask(
              tasks.CapacityGateTask,
              createCapacityGateTaskInput({
                runId: run.runId,
                workflowId: run.workflowId,
                activationId: run.activationId,
                occurrenceId: run.occurrenceId,
                workflowTaskId,
              }),
              { ownership: { kind: "task", taskId: checkedTaskId(workflowTaskId) }, conversationId },
            );
            capacityGateTaskId = Number(gateTaskId);
          }
          nextRun = { ...nextRun, durable: { ...nextRun.durable, workflowTaskId, capacityGateTaskId } };
          Object.assign(runDraft, workflowRunDocumentV1Schema.parse(nextRun));
          reference.status = status;
          if (restartingFailedPreflight) reference.workflowTaskId = workflowTaskId;
          if (desiredState !== run.desiredState) {
            await appendRunEvent(tx, conversationId, {
              version: 1,
              eventId: randomUUID(),
              type: "run_control_requested",
              runId: run.runId,
              action,
              previousDesiredState: run.desiredState,
              desiredState,
              occurredAt: at,
            });
          }
          if (status !== run.status) {
            await appendRunEvent(tx, conversationId, {
              version: 1,
              eventId: randomUUID(),
              type: "run_state_changed",
              runId: run.runId,
              from: run.status,
              to: status,
              occurredAt: at,
            });
          }
          if (cancelCapacityWait) {
            await appendRunEvent(tx, conversationId, {
              version: 1,
              eventId: randomUUID(),
              type: "run_settled",
              runId: run.runId,
              outcome: { kind: "cancelled" },
              occurredAt: at,
            });
          }
        }
        response = { workflowId: request.workflowId, runId: run.runId, status, desiredState };
      }
      const checkedInstallation = installationDocumentV1Schema.parse(installation);
      Object.assign(installationDraft, checkedInstallation);
      return response;
    },
  });
  if (result.kind === "idempotency_conflict") throw new Error("idempotency_conflict: request ID was used with different arguments");
  const controlResult = result.response;
  if (action === "stop") {
    const index = await readInstallation(harness);
    const activation = index.workflows[request.workflowId]?.activations.at(-1);
    if (activation?.schedulerTaskId !== null && activation?.schedulerTaskId !== undefined) {
      await harness.abortTask(checkedTaskId(activation.schedulerTaskId), BACKGROUND_CONTEXT);
    }
    if (controlResult !== null && typeof controlResult === "object"
      && !Array.isArray(controlResult) && typeof controlResult.runId === "string") {
      const runId = controlResult.runId;
      const reference = index.workflows[request.workflowId]?.runs.find((run) => run.runId === runId);
      if (reference !== undefined) {
        const conversation = await harness.conversation(reference.conversationId as ConversationId, BACKGROUND_CONTEXT);
        if (conversation !== undefined) {
          await beforeDeadline(
            conversation.abort(BACKGROUND_CONTEXT, { background: true }),
            Date.now() + STARTUP_RECONCILIATION_MS,
            "run stop cleanup",
          );
        }
        await releaseStoppedRunCapacityAfterReconciliation(
          harness,
          request.workflowId,
          runId,
          reference.conversationId as ConversationId,
          Date.now() + STARTUP_RECONCILIATION_MS,
        );
        const settled = await readInstallation(harness);
        const finalReference = settled.workflows[request.workflowId]?.runs.find((run) => run.runId === runId);
        if (finalReference !== undefined) return { ...controlResult, status: finalReference.status };
      }
    }
  }
  return result.response;
}

function checkFormat4Resolution(run: ReadyRunForResolution, request: Extract<ServiceRequestV1, { method: "resolve" }>): void {
  const formatVersion = "formatVersion" in run.resolvedSettings && typeof run.resolvedSettings.formatVersion === "number"
    ? run.resolvedSettings.formatVersion
    : undefined;
  const rejection = checkBlockResolution({
    formatVersion, blockKind: run.block?.kind, action: request.action, resolver: request.resolver ?? "human",
    allowRepeat: request.allowRepeat, extraAttempt: request.extraAttempt, target: request.target,
    botAlreadyResolved: run.resolutions.some((resolution) => resolution.provenance === "bot"
      && resolution.sourceBlock.nodeId === run.block?.nodeId),
  });
  if (rejection !== null) throw new ServiceRequestError("resolution_rejected", rejection);
}

export async function resolveBlockedWorkflow(
  harness: Harness,
  tasks: ReturnType<typeof defineWorkshopTasks>,
  installation: Installation,
  request: Extract<ServiceRequestV1, { method: "resolve" }>,
): Promise<unknown> {
  const judgmentRetry = request.target === "judgment";
  const arguments_ = {
    workflowId: request.workflowId,
    runId: request.runId ?? null,
    action: request.action,
    resolver: request.resolver ?? "human",
    reason: request.reason,
    allowRepeat: request.allowRepeat ?? false,
    extraAttempt: request.extraAttempt ?? false,
    acknowledgeEffects: request.acknowledgeEffects ?? false,
    resultFile: request.resultFile ?? null,
    ...(request.target === undefined ? {} : { target: request.target }),
  };
  const mutationRequest = { requestId: request.requestId, method: "resolve" as const, arguments: arguments_ };
  const prior = await findServiceMutationReceipt({ harness, context: BACKGROUND_CONTEXT, request: mutationRequest });
  if (prior.kind === "idempotency_conflict") throw new ServiceRequestError("idempotency_conflict", "request ID was used with different resolution arguments");
  if (prior.kind === "replayed") return prior.response;

  let runId: ReadyRunForResolution["runId"];
  let run: ReadyRunForResolution;
  let processRecords: RunProcessEvidence[];
  let sourceBlock: NonNullable<ReadyRunForResolution["block"]>;
  let repeatRequired: boolean;
  let extraAttemptRequired: boolean;
  let at: string;
  let resolutionId: string;
  let operatorResolution: ReturnType<typeof operatorResolutionSchema.parse> | null;
  let accepted: ReturnType<typeof buildOperatorAcceptance> | null;
  try {
    if (request.reason.trim() === "") throw new ServiceRequestError("resolution_rejected", "resolution reason must contain visible text");
    if (request.action === "accept") {
      if (request.resultFile === undefined || request.acknowledgeEffects !== true
        || request.allowRepeat !== undefined || request.extraAttempt !== undefined) {
        throw new ServiceRequestError("resolution_rejected", "accept requires --result-file and --acknowledge-effects, with no retry flags");
      }
    } else if (request.resultFile !== undefined || request.acknowledgeEffects !== undefined) {
      throw new ServiceRequestError("resolution_rejected", "--result-file and --acknowledge-effects apply only to accept");
    }
    if (request.action !== "retry" && (request.allowRepeat !== undefined || request.extraAttempt !== undefined || judgmentRetry)) {
      throw new ServiceRequestError("resolution_rejected", "retry-only options apply only to retry");
    }
    if (judgmentRetry && (request.allowRepeat !== undefined || request.extraAttempt !== undefined)) {
      throw new ServiceRequestError("resolution_rejected", "judgment-only retry cannot repeat process work or consume an extra attempt");
    }

    const index = await readInstallation(harness);
    const workflow = index.workflows[request.workflowId];
    if (workflow === undefined) throw new ServiceRequestError("resolution_rejected", `workflow is not registered: ${request.workflowId}`);
    const selectedRunId = request.runId ?? workflow.openRunId;
    if (selectedRunId === null || selectedRunId === undefined) throw new ServiceRequestError("resolution_rejected", "workflow has no blocked run to resolve");
    const reference = workflow.runs.find((value) => value.runId === selectedRunId);
    if (reference === undefined) throw new ServiceRequestError("resolution_rejected", `run ${selectedRunId} is not retained by workflow ${request.workflowId}`);
    const selectedRun = await readRun(harness, reference);
    if (selectedRun.status !== "blocked" || selectedRun.block === null) throw new ServiceRequestError("resolution_rejected", "run_blocked: only the current blocked run can be resolved");
    const source = selectedRun.block;
    const format4 = "formatVersion" in selectedRun.resolvedSettings && selectedRun.resolvedSettings.formatVersion === 4;
    checkFormat4Resolution(selectedRun, request);
    const attemptLocation = source.attemptId === null ? null : findRunAttempt(selectedRun, source.nodeId, source.attemptId);
    if (source.attemptId !== null && attemptLocation === null) throw new ServiceRequestError("resolution_rejected", "resolution source attempt is missing");
    if (selectedRun.resolutions.some((resolution) => resolution.sourceBlock.blockId === source.blockId)
      || hasAcceptanceForBlock(selectedRun, source.blockId)) {
      throw new ServiceRequestError("resolution_rejected", "source block already has an operator resolution");
    }
    const checkedProcesses = await latestRunProcessEvidence(harness, selectedRun.durable.conversationId as ConversationId, selectedRun.runId);
    assertRunProcessGroupsConfirmedDead(selectedRun, checkedProcesses);
    const sourceProcesses = attemptLocation === null
      ? checkedProcesses.filter((entry) => entry.process.role === "preflight")
      : attemptProcesses(attemptLocation.attempt, checkedProcesses);
    const needsRepeat = format4
      ? source.kind === "external_outcome_unknown" || source.kind === "process_death_unconfirmed"
      : !judgmentRetry && (source.kind === "external_outcome_unknown" || sourceProcesses.some((entry) => entry.process.replay === "never"));
    const retryLimit = attemptLocation === null ? 0 : resolveRetryLimit(selectedRun.resolvedSettings.nodes[attemptLocation.node.nodeId]!);
    const needsExtraAttempt = !format4 && !judgmentRetry && attemptLocation !== null
      && retryLimit !== "unlimited" && attemptLocation.attempt.number > retryLimit;
    if (judgmentRetry) assertJudgmentRetrySource(selectedRun, source, attemptLocation);
    if (request.action === "retry" && !judgmentRetry
      && ((request.allowRepeat ?? false) !== needsRepeat
        || (request.extraAttempt ?? false) !== needsExtraAttempt)) {
      throw new ServiceRequestError("resolution_rejected", `retry flags required by this block: --allow-repeat ${needsRepeat ? "required" : "not allowed"}; --extra-attempt ${needsExtraAttempt ? "required" : "not allowed"}`);
    }
    if (request.action === "retry" && !judgmentRetry && attemptLocation === null && source.kind !== "preflight_failed"
      && !(format4 && selectedRun.resolvedSettings.preflight !== null && ["external_outcome_unknown", "process_death_unconfirmed"].includes(source.kind))) {
      throw new ServiceRequestError("resolution_rejected", "retry requires a preflight block or a block tied to a semantic attempt");
    }
    if (request.action === "accept" && (source.kind !== "external_outcome_unknown" || attemptLocation === null)) {
      throw new ServiceRequestError("resolution_rejected", "accept applies only to an unknown worker or validator outcome tied to an attempt");
    }
    const resolvedAt = new Date().toISOString();
    const newResolutionId = randomUUID();
    const resolution = request.action === "accept" ? null : operatorResolutionSchema.parse({
      resolutionId: newResolutionId,
      provenance: format4 ? request.resolver ?? "human" : "operator",
      reason: request.reason,
      resolvedAt,
      processGroupsConfirmedDead: true,
      sourceBlock: source,
      action: request.action,
      ...(request.action === "retry" ? {
        ...(judgmentRetry ? { target: "judgment" as const } : {}),
        allowRepeat: needsRepeat,
        extraAttempt: needsExtraAttempt,
      } : {}),
    });
    const acceptance = request.action === "accept"
      ? buildOperatorAcceptance(installation, selectedRun, attemptLocation!.node, attemptLocation!.attempt, source, {
        resolutionId: newResolutionId,
        reason: request.reason,
        resolvedAt,
        resultFile: request.resultFile!,
        acknowledgeEffects: true,
        processGroupsConfirmedDead: true,
      })
      : null;

    runId = selectedRun.runId;
    run = selectedRun;
    processRecords = checkedProcesses;
    sourceBlock = source;
    repeatRequired = needsRepeat;
    extraAttemptRequired = needsExtraAttempt;
    at = resolvedAt;
    resolutionId = newResolutionId;
    operatorResolution = resolution;
    accepted = acceptance;
  } catch (error) {
    const lateReceipt = await findServiceMutationReceipt({ harness, context: BACKGROUND_CONTEXT, request: mutationRequest });
    if (lateReceipt.kind === "replayed") return lateReceipt.response;
    if (lateReceipt.kind === "idempotency_conflict") throw new ServiceRequestError("idempotency_conflict", "request ID was used with different resolution arguments");
    throw error;
  }

  const result = await commitServiceMutation({
    harness,
    context: BACKGROUND_CONTEXT,
    request: mutationRequest,
    retain: (response) => typeof response === "object" && response !== null && !Array.isArray(response)
      && "runId" in response && typeof response.runId === "string"
      ? { kind: "run", runId: response.runId }
      : { kind: "service" },
    apply: async (tx) => {
      const installationDraft = await tx.doc(WorkshopInstallationDoc);
      const currentInstallation = installationDocumentV1Schema.parse(installationDraft);
      if (currentInstallation.state !== "ready") throw new Error("installation is not initialized");
      const currentWorkflow = currentInstallation.workflows[request.workflowId];
      const currentReference = currentWorkflow?.runs.find((value) => value.runId === runId);
      if (currentWorkflow === undefined || currentReference === undefined || currentWorkflow.openRunId !== runId) {
        throw new ServiceRequestError("resolution_rejected", "run is no longer the workflow's open run");
      }
      const conversationId = currentReference.conversationId as ConversationId;
      const runDraft = await tx.doc(WorkshopRunDoc, conversationId);
      const parsedRun = workflowRunDocumentV1Schema.safeParse(runDraft);
      if (!parsedRun.success || parsedRun.data.state !== "ready") throw new ServiceRequestError("resolution_rejected", "open run document is invalid");
      const currentRun = parsedRun.data;
      checkFormat4Resolution(currentRun, request);
      if (canonicalHash(currentRun) !== canonicalHash(run)) throw new ServiceRequestError("resolution_rejected", "run state changed before resolution; inspect status and retry");
      if (currentRun.status !== "blocked" || currentRun.block === null) throw new ServiceRequestError("resolution_rejected", "run_blocked: only the current blocked run can be resolved");
      if (request.runId !== undefined && request.runId !== currentRun.runId) throw new ServiceRequestError("resolution_rejected", "requested run ID differs from the open run");
      const currentProcesses = processRecords;
      assertRunProcessGroupsConfirmedDead(currentRun, currentProcesses);
      const currentBlock = currentRun.block;
      if (currentBlock.blockId !== sourceBlock.blockId) throw new ServiceRequestError("resolution_rejected", "resolution source block changed before commit");
      const currentLocation = currentBlock.attemptId === null ? null : findRunAttempt(currentRun, currentBlock.nodeId, currentBlock.attemptId);
      if (currentBlock.attemptId !== null && currentLocation === null) throw new ServiceRequestError("resolution_rejected", "resolution source attempt is missing");
      if (currentRun.resolutions.some((resolution) => resolution.sourceBlock.blockId === currentBlock.blockId)
        || hasAcceptanceForBlock(currentRun, currentBlock.blockId)) {
        throw new ServiceRequestError("resolution_rejected", "source block already has an operator resolution");
      }
      if (request.action === "retry" && !judgmentRetry && ((request.allowRepeat ?? false) !== repeatRequired || (request.extraAttempt ?? false) !== extraAttemptRequired)) {
        throw new ServiceRequestError("resolution_rejected", "retry flags changed before resolution commit");
      }
      if (judgmentRetry) assertJudgmentRetrySource(currentRun, currentBlock, currentLocation);
      if (request.action === "accept" && (currentLocation === null || accepted === null)) {
        throw new ServiceRequestError("resolution_rejected", "accept source attempt or checked result is missing");
      }

      if (request.action === "fail") {
        if (operatorResolution === null) throw new ServiceRequestError("resolution_rejected", "fail resolution record was not prepared");
        const failure = runFailureInfoSchema.parse({
          kind: "operator",
          resolutionId,
          provenance: operatorResolution.provenance,
          reason: request.reason,
          failedAt: at,
          processGroupsConfirmedDead: true,
          sourceBlock,
        });
        const nextNodes = currentRun.nodes.map((node) => node.status !== "blocked" ? node : {
          ...node,
          status: node.attempts.at(-1)?.status === "failed" || node.attempts.at(-1)?.status === "interrupted" ? "failed" as const : "pending" as const,
        });
        Object.assign(runDraft, workflowRunDocumentV1Schema.parse({
          ...currentRun,
          status: "failed",
          finishedAt: at,
          block: null,
          failure,
          terminalOutput: null,
          resolutions: [...currentRun.resolutions, operatorResolution],
          nodes: nextNodes,
        }));
        currentWorkflow.openRunId = null;
        currentWorkflow.capacityReservations = currentWorkflow.capacityReservations.filter((value) => value !== runId);
        currentReference.status = "failed";
        await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "run_resolved", runId, resolution: operatorResolution, occurredAt: at });
        await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "run_state_changed", runId, from: "blocked", to: "failed", occurredAt: at });
        await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "run_settled", runId, outcome: { kind: "failed", failure }, occurredAt: at });
        Object.assign(installationDraft, installationDocumentV1Schema.parse(currentInstallation));
        return { workflowId: request.workflowId, runId, status: "failed", desiredState: currentRun.desiredState, resolutionId };
      }

      const stopped = currentRun.desiredState === "stopped";
      let nodes = currentRun.nodes;
      let currentAttemptId = currentRun.currentAttemptId;
      const verifierRetry = request.action === "retry" && sourceBlock.kind === "verifier_failed";
      if (verifierRetry && currentLocation !== null) {
        const attempt = currentLocation.attempt;
        if (attempt.result.kind !== "settled" || attempt.result.outcome.kind !== "blocked"
          || (attempt.result.outcome.candidate === null && attempt.workerFailure === undefined)) {
          throw new ServiceRequestError("resolution_rejected", "verifier retry requires saved worker candidate or failure evidence");
        }
        const candidate = attempt.result.outcome.candidate;
        nodes = currentRun.nodes.map((node) => node.nodeId !== currentLocation.node.nodeId ? node : {
          ...node, status: "running" as const,
          attempts: node.attempts.map((value) => value.attemptId !== attempt.attemptId ? value : {
            ...value, status: "executing" as const, phase: "captureCandidate" as const, finishedAt: null, elapsedMs: null,
            validatorExecutionId: null,
            supersededValidatorExecutionIds: [...(value.supersededValidatorExecutionIds ?? []),
              ...(value.validatorExecutionId === null ? [] : [value.validatorExecutionId])],
            result: candidate === null
              // SAFETY: a null saved candidate requires workerFailure in the guard above.
              ? { kind: "worker_failure_committed" as const, failure: attempt.workerFailure!, validator: null }
              : { kind: "candidate_committed" as const, candidate },
          }),
        });
      }
      if (request.action === "retry" && currentLocation !== null && !verifierRetry) {
        nodes = currentRun.nodes.map((node) => node.nodeId === currentLocation.node.nodeId ? { ...node, status: "failed" } : node);
        if (!judgmentRetry) currentAttemptId = null;
      } else if (accepted !== null && currentLocation !== null) {
        nodes = currentRun.nodes.map((node) => {
          if (node.nodeId !== currentLocation.node.nodeId) return node;
          const updatedAttempt = stopped
            ? { ...currentLocation.attempt, status: "interrupted" as const, phase: null, result: { kind: "settled" as const, outcome: nodeAttemptOutcomeSchema.parse({ kind: "blocked", block: sourceBlock, candidate: accepted!.candidate, validator: accepted!.validator }) } }
            : accepted!.target === "worker"
              ? { ...currentLocation.attempt, status: "executing" as const, phase: "captureCandidate" as const, finishedAt: null, elapsedMs: null, result: { kind: "candidate_committed" as const, candidate: accepted!.candidate } }
              : { ...currentLocation.attempt, status: "validating" as const, phase: "finish" as const, finishedAt: null, elapsedMs: null, result: { kind: "validation_committed" as const, candidate: accepted!.candidate, validator: accepted!.validator! } };
          return {
            ...node,
            status: stopped ? "failed" as const : "running" as const,
            attempts: node.attempts.map((attempt) => attempt.attemptId === currentLocation!.attempt.attemptId ? updatedAttempt : attempt),
          };
        });
        if (stopped) currentAttemptId = null;
      }

      const resumeCheckpoint = judgmentRetry && currentLocation !== null
        ? { phase: "decide" as const, nodeIndex: currentRun.chain.order.indexOf(currentLocation.node.nodeId), nodeId: currentLocation.node.nodeId, attemptId: currentLocation.attempt.attemptId }
        : undefined;
      if (resumeCheckpoint !== undefined && resumeCheckpoint.nodeIndex < 0) throw new ServiceRequestError("resolution_rejected", "judgment retry target is absent from the frozen node chain");
      const workflowTaskId = Number(await tx.createTask(
        tasks.WorkflowRunTask,
        createWorkflowRunTaskInput(
          { runId, workflowId: currentRun.workflowId, activationId: currentRun.activationId, occurrenceId: currentRun.occurrenceId },
          resumeCheckpoint,
        ),
        { ownership: { kind: "conversation" }, conversationId },
      ));
      let capacityGateTaskId: number | null = null;
      if (!stopped) {
        const gateId = await tx.createTask(
          tasks.CapacityGateTask,
          createCapacityGateTaskInput({ runId, workflowId: currentRun.workflowId, activationId: currentRun.activationId, occurrenceId: currentRun.occurrenceId, workflowTaskId }),
          { ownership: { kind: "task", taskId: workflowTaskId as TaskId }, conversationId },
        );
        capacityGateTaskId = Number(gateId);
      }
      const preflight = request.action === "retry" && sourceBlock.nodeId === null
        && (currentRun.preflight.kind === "failed" || currentRun.preflight.kind === "pending")
        ? { kind: "pending" as const, cacheKeyHash: currentRun.preflight.cacheKeyHash, processExecutionIds: currentRun.preflight.processExecutionIds }
        : currentRun.preflight;
      const nextRun = workflowRunDocumentV1Schema.parse({
        ...currentRun,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        currentAttemptId,
        block: null,
        failure: null,
        terminalOutput: null,
        preflight,
        nodes,
        ...(operatorResolution === null ? {} : { resolutions: [...currentRun.resolutions, operatorResolution] }),
        durable: { ...currentRun.durable, workflowTaskId, capacityGateTaskId },
      });
      Object.assign(runDraft, nextRun);
      currentWorkflow.capacityReservations = currentWorkflow.capacityReservations.filter((value) => value !== runId);
      currentReference.status = "queued";
      currentReference.workflowTaskId = workflowTaskId;
      if (operatorResolution !== null) {
        await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "run_resolved", runId, resolution: operatorResolution, occurredAt: at });
      }
      await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "run_state_changed", runId, from: "blocked", to: "queued", occurredAt: at });
      if (accepted !== null) {
        if (accepted.target === "worker") {
          await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "worker_result_committed", runId, nodeId: currentLocation!.node.nodeId, attemptId: currentLocation!.attempt.attemptId, candidate: accepted.candidate, occurredAt: at });
        } else {
          await appendRunEvent(tx, conversationId, { version: 1, eventId: randomUUID(), type: "validator_result_committed", runId, nodeId: currentLocation!.node.nodeId, attemptId: currentLocation!.attempt.attemptId, validator: accepted.validator!, occurredAt: at });
        }
      }
      Object.assign(installationDraft, installationDocumentV1Schema.parse(currentInstallation));
      return { workflowId: request.workflowId, runId, status: "queued", desiredState: currentRun.desiredState, resolutionId };
    },
  });
  if (result.kind === "idempotency_conflict") throw new ServiceRequestError("idempotency_conflict", "request ID was used with different resolution arguments");
  return result.response;
}

type RunProcessEvidence = ReturnType<typeof workshopProcessV1Schema.parse>;
type ReadyRunForResolution = Extract<ReturnType<typeof workflowRunDocumentV1Schema.parse>, { state: "ready" }>;

async function latestRunProcessEvidence(
  harness: Harness,
  conversationId: ConversationId,
  runId: string,
): Promise<RunProcessEvidence[]> {
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new ServiceRequestError("resolution_rejected", "run conversation is unavailable; operator resolution is unsafe");
  const latest = new Map<string, RunProcessEvidence>();
  let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (entry.kind !== "workshop.process") continue;
      const parsed = workshopProcessV1Schema.safeParse(entry.data);
      if (!parsed.success) {
        if (typeof entry.data === "object" && entry.data !== null && "runId" in entry.data && entry.data.runId === runId) {
          throw new ServiceRequestError("process_evidence_invalid", "process evidence for this run is invalid; operator resolution is unsafe");
        }
        continue;
      }
      if (parsed.data.runId !== runId) continue;
      const process = parsed.data.process;
      const key = `${process.executionId}:${process.incarnationId}`;
      if (!latest.has(key)) latest.set(key, parsed.data);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return [...latest.values()];
}

function assertRunProcessGroupsConfirmedDead(run: ReadyRunForResolution, records: readonly RunProcessEvidence[]): void {
  const byKey = new Map(records.map((entry) => [`${entry.process.executionId}:${entry.process.incarnationId}`, entry.process]));
  for (const node of run.nodes) for (const attempt of node.attempts) for (const reference of attempt.processIncarnations) {
    if (!byKey.has(`${reference.executionId}:${reference.incarnationId}`)) throw new ServiceRequestError("process_evidence_invalid", "process history is incomplete; operator resolution is unsafe");
  }
  for (const process of records.map((entry) => entry.process)) {
    if (process.launchIntentAt === null) continue;
    if (process.identity === null || process.cleanupState !== "confirmed_dead" || !["blocked", "exited"].includes(process.status)) {
      throw new ServiceRequestError("process_cleanup_unconfirmed", "every launched process group must have checked confirmed-death evidence before resolution");
    }
  }
}

function attemptProcesses(
  attempt: ReadyRunForResolution["nodes"][number]["attempts"][number],
  records: readonly RunProcessEvidence[],
): RunProcessEvidence[] {
  const byKey = new Map(records.map((entry) => [`${entry.process.executionId}:${entry.process.incarnationId}`, entry]));
  return attempt.processIncarnations.map((reference) => {
    const entry = byKey.get(`${reference.executionId}:${reference.incarnationId}`);
    if (entry === undefined) throw new ServiceRequestError("process_evidence_invalid", "source attempt process history is incomplete");
    return entry;
  });
}

function findRunAttempt(run: ReadyRunForResolution, nodeId: string | null, attemptId: string) {
  if (nodeId === null) return null;
  const node = run.nodes.find((value) => value.nodeId === nodeId);
  const attempt = node?.attempts.find((value) => value.attemptId === attemptId);
  return node === undefined || attempt === undefined ? null : { node, attempt };
}

function assertJudgmentRetrySource(
  run: ReadyRunForResolution,
  source: NonNullable<ReadyRunForResolution["block"]>,
  location: ReturnType<typeof findRunAttempt>,
): void {
  if (run.desiredState === "stopped" || location === null || source.attemptId === null
    || !["orchestrator_unavailable", "orchestrator_invalid"].includes(source.kind)
    || source.nodeId !== location.node.nodeId || source.attemptId !== location.attempt.attemptId
    || run.currentNodeId !== location.node.nodeId || run.currentAttemptId !== location.attempt.attemptId
    || location.attempt.status !== "failed" || location.attempt.result.kind !== "settled"
    || location.attempt.result.outcome.kind !== "failed" || !location.attempt.blockIds.includes(source.blockId)) {
    throw new ServiceRequestError("resolution_rejected", "--target judgment requires the current known failed attempt blocked by an unavailable or invalid native judgment");
  }
  const latestJudgment = location.attempt.judgments.at(-1);
  if (latestJudgment === undefined || latestJudgment.status !== "failed"
    || source.blockId !== `judgment-${latestJudgment.judgmentId}`) {
    throw new ServiceRequestError("resolution_rejected", "--target judgment requires the latest failed native judgment and its exact source block");
  }
}

function hasAcceptanceForBlock(run: ReadyRunForResolution, blockId: string): boolean {
  return run.nodes.some((node) => node.attempts.some((attempt) => {
    if (attempt.result.kind !== "settled") return false;
    const outcome = attempt.result.outcome;
    return outcome.kind !== "cancelled"
      && (outcome.candidate?.source === "operator" && outcome.candidate.acceptance.sourceBlock.blockId === blockId
        || outcome.validator?.kind === "operator" && outcome.validator.acceptance.sourceBlock.blockId === blockId);
  }));
}

function buildOperatorAcceptance(
  installation: Installation,
  run: ReadyRunForResolution,
  node: ReadyRunForResolution["nodes"][number],
  attempt: ReadyRunForResolution["nodes"][number]["attempts"][number],
  sourceBlock: NonNullable<ReadyRunForResolution["block"]>,
  input: { resolutionId: string; reason: string; resolvedAt: string; resultFile: string; acknowledgeEffects: true; processGroupsConfirmedDead: true },
 ): { target: "worker"; candidate: NodeResult; validator: null } | { target: "validator"; candidate: NodeResult; validator: ValidatorOutcome } {
  if (attempt.result.kind !== "settled" || attempt.result.outcome.kind !== "blocked") throw new ServiceRequestError("resolution_rejected", "accept requires an interrupted attempt with an unknown outcome");
  const sourceOutcome = attempt.result.outcome;
  const target = sourceOutcome.candidate === null ? "worker" : "validator";
  const settings = run.resolvedSettings.nodes[node.nodeId];
  if (settings === undefined) throw new ServiceRequestError("resolution_rejected", "frozen node settings are missing");
  const resultPath = resolvePath(installation.root, input.resultFile);
  if ("formatVersion" in run.resolvedSettings && run.resolvedSettings.formatVersion === 4) {
    if (target !== "worker" || attempt.workerExecutionId === null) {
      throw new ServiceRequestError("resolution_rejected", "format 4 accept supplies a worker result, never a verifier verdict; retry the verifier or fail");
    }
    const loaded = readResultFileBytes(resultPath);
    if (!loaded.ok) throw new ServiceRequestError("accept_result_invalid", loaded.failure.kind + ": " + loaded.failure.message);
    const bytes = loaded.bytes;
    const mode = run.resolvedSettings.nodes[node.nodeId]?.result;
    if (mode === undefined) throw new ServiceRequestError("resolution_rejected", "frozen result mode is missing");
    const parsed = mode === "text" ? parseTextResult(bytes) : parseTaggedWorkerResult(bytes);
    if (!parsed.ok) throw new ServiceRequestError("accept_result_invalid", parsed.failure.kind + ": " + parsed.failure.message);
    const result = parsed.value;
    const reason = "reason" in result ? result.reason : null;
    const question = "question" in result ? result.question : null;
    const acceptance = operatorAcceptanceSchema.parse({
      kind: "operator_acceptance", resolutionId: input.resolutionId, provenance: "human", target, reason: input.reason,
      resolvedAt: input.resolvedAt, processGroupsConfirmedDead: true, acknowledgedEffects: true,
      sourceBlock, resultBytesHash: parsed.sourceBytesHash,
    });
    return { target, validator: null, candidate: nodeResultSchema.parse({
      version: 2, source: "operator", workerKind: settings.run.kind, exit: null, acceptance,
      output: result.output, summary: reason ?? "", artifacts: [], sourceBytesHash: parsed.sourceBytesHash,
      stdioResult: { version: 1, mode, status: result.status, reason, question },
    }) };
  }
  if (target === "worker") {
    if (attempt.workerExecutionId === null) throw new ServiceRequestError("resolution_rejected", "unknown worker outcome has no launched worker execution");
    const parsed = parseWorkerResultFile(resultPath);
    if (!parsed.ok) throw new ServiceRequestError("accept_result_invalid", `${parsed.failure.kind}: ${parsed.failure.message}`);
    const acceptance = operatorAcceptanceSchema.parse({
      kind: "operator_acceptance", resolutionId: input.resolutionId, provenance: "operator", target, reason: input.reason,
      resolvedAt: input.resolvedAt, processGroupsConfirmedDead: input.processGroupsConfirmedDead, acknowledgedEffects: input.acknowledgeEffects,
      sourceBlock, resultBytesHash: parsed.sourceBytesHash,
    });
    const candidate = nodeResultSchema.parse({
      version: 1, source: "operator", workerKind: settings.run.kind, output: parsed.value.output, summary: parsed.value.summary,
      artifacts: resolveWorkerArtifacts(settings.run.cwd, parsed.value.artifacts), sourceBytesHash: parsed.sourceBytesHash, exit: null, acceptance,
    });
    return { target, candidate, validator: null };
  }
  if (attempt.validatorExecutionId === null || settings.validator === null) {
    throw new ServiceRequestError("resolution_rejected", "validator acceptance requires a launched validator execution");
  }
  const parsed = parseValidatorVerdictFile(resultPath);
  if (!parsed.ok) throw new ServiceRequestError("accept_result_invalid", `${parsed.failure.kind}: ${parsed.failure.message}`);
  const acceptance = operatorAcceptanceSchema.parse({
    kind: "operator_acceptance", resolutionId: input.resolutionId, provenance: "operator", target, reason: input.reason,
    resolvedAt: input.resolvedAt, processGroupsConfirmedDead: input.processGroupsConfirmedDead, acknowledgedEffects: input.acknowledgeEffects,
    sourceBlock, resultBytesHash: parsed.sourceBytesHash,
  });
  const validator = validatorOutcomeSchema.parse({
    kind: "operator", verdict: parsed.value, resultBytesHash: parsed.sourceBytesHash, acceptance,
  });
  if (sourceOutcome.candidate === null) throw new ServiceRequestError("resolution_rejected", "validator acceptance requires a committed worker candidate");
  return { target: "validator", candidate: sourceOutcome.candidate, validator };
}


async function releaseStoppedRunCapacityAfterReconciliation(
  harness: Harness,
  workflowId: string,
  runId: string,
  conversationId: ConversationId,
  deadlineMs: number,
): Promise<void> {
  const conversation = await beforeDeadline(
    harness.conversation(conversationId, BACKGROUND_CONTEXT),
    deadlineMs,
    "stopped run process-evidence lookup",
  );
  if (conversation === undefined) return;

  const latest = new Map<string, { status: string; cleanupState: string }>();
  let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
  do {
    const page = await beforeDeadline(
      conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT),
      deadlineMs,
      "stopped run process-evidence scan",
    );
    for (const entry of page.items) {
      if (entry.kind !== "workshop.process") continue;
      const parsed = workshopProcessV1Schema.safeParse(entry.data);
      if (!parsed.success) {
        if (typeof entry.data === "object" && entry.data !== null
          && "runId" in entry.data && entry.data.runId === runId) return;
        continue;
      }
      const process = parsed.data.process;
      if (parsed.data.runId === runId) {
        const key = `${process.executionId}:${process.incarnationId}`;
        if (!latest.has(key)) latest.set(key, { status: process.status, cleanupState: process.cleanupState });
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);

  if ([...latest.values()].some((process) =>
    ["launching", "running", "reconciling"].includes(process.status) || process.cleanupState === "unconfirmed")) return;

  await beforeDeadline(harness.commit(async (tx) => {
    const draft = await tx.doc(WorkshopInstallationDoc);
    const installation = installationDocumentV1Schema.parse(draft);
    if (installation.state !== "ready") throw new Error("installation is not initialized");
    const workflow = installation.workflows[workflowId];
    const reference = workflow?.runs.find((item) => item.runId === runId);
    if (workflow === undefined || reference === undefined || !["blocked", "cancelled"].includes(reference.status)) return undefined;
    workflow.capacityReservations = workflow.capacityReservations.filter((reservedRunId) => reservedRunId !== runId);
    Object.assign(draft, installationDocumentV1Schema.parse(installation));
    return undefined;
  }, BACKGROUND_CONTEXT), deadlineMs, "stopped run capacity release");
}


async function appendRunEvent(tx: Tx, conversationId: ConversationId, value: unknown): Promise<void> {
  await tx.appendEntry(WorkshopEventEntry, conversationId, { data: workshopEventV1Schema.parse(value) });
}




function createActivationProposal(checked: CheckedWorkflow): ActivationIndex {
  const activatedAt = new Date().toISOString();
  const scheduleEveryMs = checked.definition.schedule === undefined
    ? null
    : parseDuration(checked.definition.schedule.every);
  const nextDueAt = scheduleEveryMs === null ? null : firstFixedRateDeadline(activatedAt, scheduleEveryMs);
  return activationIndexSchema.parse({
    activationId: activationIdSchema.parse(randomUUID()),
    state: "active",
    admittedCount: 0,
    maxRuns: checked.definition.schedule?.max_runs ?? 1,
    activatedAt,
    nextDueAt,
    scheduleEveryMs,
    schedulerTaskId: null,
    skippedSlots: 0,
    lastSkippedSlotAt: null,
    admissionError: null,
  });
}

async function persistNoopStartReceipt(
  harness: Harness,
  request: Extract<ServiceRequestV1, { method: "start" }>,
  response: unknown,
  runId: string,
): Promise<unknown> {
  const checkedResponse = serviceMutationReceiptV1Schema.shape.response.parse(response);
  const result = await commitServiceMutation({
    harness,
    context: BACKGROUND_CONTEXT,
    request: {
      requestId: request.requestId,
      method: "start",
      arguments: { workflowId: request.workflowId },
    },
    retain: () => ({ kind: "run", runId }),
    apply: async () => checkedResponse,
  });
  if (result.kind === "idempotency_conflict") throw new Error("idempotency_conflict: request ID was already used with different arguments");
  return result.response;
}

function admissionFromReference(reference: {
  readonly runId: string;
  readonly admissionSequence: number;
  readonly activationId: string;
  readonly occurrenceId: string;
  readonly conversationId: number;
  readonly workflowTaskId: number;
}, workflowId: string, duplicate: boolean) {
  return {
    runId: reference.runId,
    workflowId,
    activationId: reference.activationId,
    occurrenceId: reference.occurrenceId,
    admissionSequence: reference.admissionSequence,
    conversationId: reference.conversationId,
    workflowTaskId: reference.workflowTaskId,
    duplicate,
  };
}

async function reconcileStartupProcessTasks(
  harness: Harness,
  tasks: ReturnType<typeof defineWorkshopTasks>,
  deadlineMs: number,
): Promise<void> {
  const inspection = await beforeDeadline(harness.inspect(BACKGROUND_CONTEXT), deadlineMs, "Durable startup task inspection");
  const blocked = inspection.tasks.find((task) => task.state.kind === "blocked");
  if (blocked !== undefined && blocked.state.kind === "blocked") {
    throw new Error(`Durable task ${blocked.record.id} cannot be reconciled: ${blocked.state.reason}`);
  }
  const uncertainProcesses = inspection.tasks.filter((task) => {
    if (task.record.kind !== tasks.ProcessExecutionTask.definition.name) return false;
    const state = task.record.state;
    if (state.status === "completing") return false;
    const checkpoint = state.checkpoint;
    return typeof checkpoint !== "object" || checkpoint === null
      || !("phase" in checkpoint) || checkpoint.phase !== "intent";
  });
  if (uncertainProcesses.length === 0) return;
  harness.resume();
  await Promise.all(uncertainProcesses.map((task) =>
    beforeDeadline(harness.waitForTask(task.record.id as TaskId, BACKGROUND_CONTEXT), deadlineMs, "process-task reconciliation"),
  ));
}

async function reconcileLiveProcessTasks(
  harness: Harness,
  tasks: ReturnType<typeof defineWorkshopTasks>,
  deadlineMs: number,
  resumeScheduler = false,
 ): Promise<void> {
  const inspection = await beforeDeadline(harness.inspect(BACKGROUND_CONTEXT), deadlineMs, "Durable task inspection");
  const blocked = inspection.tasks.find((task) => task.state.kind === "blocked");
  if (blocked !== undefined && blocked.state.kind === "blocked") {
    throw new Error(`Durable task ${blocked.record.id} cannot be reconciled: ${blocked.state.reason}`);
  }
  const processTasks = inspection.tasks.filter((task) => {
    if (task.record.kind !== tasks.ProcessExecutionTask.definition.name || task.record.state.status === "completing") return false;
    const checkpoint = task.record.state.checkpoint;
    return typeof checkpoint !== "object" || checkpoint === null
      || !("phase" in checkpoint) || checkpoint.phase !== "intent";
  });
  if (processTasks.length === 0) return;
  if (resumeScheduler) harness.resume();
  for (const task of processTasks) {
    await beforeDeadline(harness.abortTask(task.record.id as TaskId, BACKGROUND_CONTEXT), deadlineMs, "process-task abort");
  }
  await Promise.all(processTasks.map((task) =>
    waitForTaskTerminal(harness, task.record.id as TaskId, deadlineMs),
  ));
}

async function waitForTaskTerminal(harness: Harness, taskId: TaskId, deadlineMs: number): Promise<void> {
  for (;;) {
    const task = await beforeDeadline(harness.getTask(taskId, BACKGROUND_CONTEXT), deadlineMs, "process task state lookup");
    if (task === undefined || task.state.status === "terminal") return;
    await beforeDeadline(new Promise<void>((resolve) => setTimeout(resolve, 10)), deadlineMs, "process task reconciliation");
  }
}

async function assertNoUnreconciledProcessEvidence(
  harness: Harness,
  deadlineMs: number,
  activeBootId?: string,
): Promise<void> {
  const installation = await beforeDeadline(readInstallation(harness), deadlineMs, "installation reconciliation read");
  for (const workflow of Object.values(installation.workflows)) {
    for (const reference of workflow.runs) {
      const conversation = await beforeDeadline(
        harness.conversation(reference.conversationId as never, BACKGROUND_CONTEXT),
        deadlineMs,
        "run conversation lookup",
      );
      if (conversation === undefined) throw new Error(`run conversation for ${reference.runId} is unavailable during shutdown`);
      const latest = new Map<string, import("../run/records.js").WorkshopProcessV1>();
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
      do {
        const page = await beforeDeadline(conversation.entries({}, 256, cursor, BACKGROUND_CONTEXT), deadlineMs, "process evidence scan");
        for (const entry of page.items) {
          if (entry.kind !== "workshop.process" || entry.data === undefined) continue;
          const parsed = workshopProcessV1Schema.safeParse(entry.data);
          if (!parsed.success || parsed.data.runId !== reference.runId) continue;
          const process = parsed.data.process;
          const key = `${process.executionId}:${process.incarnationId}`;
          if (!latest.has(key)) latest.set(key, parsed.data);
        }
        cursor = page.next;
      } while (cursor !== undefined);
      for (const [identity, record] of latest) {
        const process = record.process;
        if (!["launching", "running", "reconciling"].includes(process.status) && process.cleanupState !== "unconfirmed") continue;
        if (await hasReceiptBackedBlockedCapture(harness, record, deadlineMs)) continue;
        if (activeBootId !== undefined) {
          const task = await beforeDeadline(harness.getTask(record.taskId as TaskId, BACKGROUND_CONTEXT), deadlineMs, "process task lookup");
          const input = processExecutionTaskInputSchema.safeParse(task?.input);
          if (task !== undefined && task.state.status !== "terminal" && input.success && input.data.serviceBootId === activeBootId) continue;
        }
        throw new Error(`process group ${identity} has no confirmed-death receipt at service startup or shutdown`);
      }
    }
  }
}

async function hasReceiptBackedBlockedCapture(
  harness: Harness,
  record: import("../run/records.js").WorkshopProcessV1,
  deadlineMs: number,
): Promise<boolean> {
  const process = record.process;
  if (process.status !== "blocked" || process.cleanupState !== "unconfirmed" || process.captures.length === 0) return false;
  const task = await beforeDeadline(harness.getTask(record.taskId as TaskId, BACKGROUND_CONTEXT), deadlineMs, "blocked process task lookup");
  const input = processExecutionTaskInputSchema.safeParse(task?.input);
  if (task === undefined || task.state.status !== "terminal" || !input.success
    || input.data.runId !== record.runId || input.data.executionId !== process.executionId
    || input.data.incarnationId !== process.incarnationId || input.data.incarnationNumber !== process.incarnationNumber) return false;
  if (task.state.outcome.status !== "completed") return false;
  const result = processExecutionTaskResultSchema.safeParse(task.state.outcome.result);
  if (!result.success || result.data.kind !== "blocked") return false;
  const captures = await beforeDeadline(
    recoverRetainedProcessCaptureRecords(input.data),
    deadlineMs,
    "retained process capture verification",
  );
  return canonicalHash(captures) === canonicalHash(process.captures);
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new ServiceShutdownError(`timed out during ${label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ServiceShutdownError(`timed out during ${label}`)), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function checkedTaskId(value: number): TaskId {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("persisted WorkflowRun task ID is invalid");
  // SAFETY: runDocumentV1Schema validates workflowTaskId as a positive safe integer before this boundary.
  return value as TaskId;
}

function isArchivedRunSnapshot(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("resolvedSettings" in value)) return false;
  const settings = value.resolvedSettings;
  return typeof settings === "object" && settings !== null && !("formatVersion" in settings);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForProjectionRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("projection wait was aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
