import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createWorkshopModels } from "../model/create-workshop-models.js";
import { createRegistry, Harness, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import { loadCheckedWorkflow, type CheckedWorkflow, type Installation } from "../installation/load-installation.js";
import {
  activationIndexSchema,
  installationDocumentV1Schema,
  serviceMutationReceiptV1Schema,
  serviceMutationReceiptsDocumentV1Schema,
  workflowInstallationIndexSchema,
  type ActivationIndex,
} from "../installation/schema.js";
import {
  activationIdSchema,
  nodeAttemptOutcomeSchema,
  nodeResultSchema,
  operatorAcceptanceSchema,
  type NodeResult,
  type ValidatorOutcome,
  operatorResolutionSchema,
  runFailureInfoSchema,
  validatorOutcomeSchema,
} from "../run/schema.js";
import { prepareRunAdmission } from "../run/prepare-admission.js";
import { firstFixedRateDeadline } from "../run/decide-fixed-rate-schedule.js";
import { parseDuration } from "../util/parse-units.js";
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
import { parseValidatorVerdictFile, parseWorkerResultFile } from "../attempt/parse-result.js";
import { workflowRunDocumentV1Schema, workshopEventV1Schema, workshopProcessV1Schema } from "../run/records.js";
import { WorkshopEventEntry, WorkshopInstallationDoc, WorkshopRunDoc, WorkshopServiceReceiptsDoc } from "../storage/durable/define-workshop-records.js";
import { openDurableStorage } from "../storage/durable/open-durable-storage.js";
import { readInstallation, readRun, projectServiceRead } from "./project-service-reads.js";
import { ServiceRequestError, ServiceShutdownError, serveWorkshopService, type WorkshopServiceRuntime } from "./serve-workshop-service.js";
import type { ServiceMetadataV1, ServiceRequestV1 } from "./schema.js";

const TASK_VERSIONS = { workflowRun: 10, nodeAttempt: 4, processExecution: 4, capacityGate: 1, failureJudgment: 1, scheduleWakeup: 1 } as const;
const STARTUP_RECONCILIATION_MS = 10_000;

export function startWorkshopService(installation: Installation, options: { readonly models?: Models } = {}) {
  const models = options.models ?? createWorkshopModels();
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
  const opened = await openDurableStorage(installation.databasePath);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const storage = opened.storage;
  let harness: Harness | undefined;
  let tasks: ReturnType<typeof defineWorkshopTasks> | undefined;
  const openCleanupErrors: unknown[] = [];
  let opening = true;

  try {
    tasks = defineWorkshopTasks(metadata.bootId, { startupLaunchGate: "closed" });
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
      // Durable can store extension names in conversation state, so existing installations keep this v4 literal.
      name: "workshop-v4-service-runtime",
      tasks: [tasks.WorkflowRunTask, tasks.NodeAttemptTask, tasks.ProcessExecutionTask, tasks.CapacityGateTask, tasks.FailureJudgmentTask, scheduleWakeupTask],
    });
    registry.install(tasks.FailureJudgmentExtension);
    harness = await Harness.open(storage, {
      models,
      registry,
      onReport(error) {
        if (opening) openCleanupErrors.push(error);
        else console.error(`Durable harness reported an extension failure: ${errorText(error)}`);
      },
    }, BACKGROUND_CONTEXT);
    await ensureInstallationReady(harness, installation);
    await reconcileStartupProcessTasks(harness, tasks, Date.now() + STARTUP_RECONCILIATION_MS);
    await assertNoUnreconciledProcessEvidence(harness, Date.now() + STARTUP_RECONCILIATION_MS, metadata.bootId);
    tasks.openStartupLaunchGate();
    harness.resume();
    opening = false;

    const activeHarness = harness;
    const activeTasks = tasks;
    let closed = false;
    return {
      async handleRequest(request) {
        if (closed) throw new Error("service runtime is closed");
        switch (request.method) {
          case "start": return await startWorkflow(activeHarness, activeTasks, scheduleWakeupTask, installation, request);
          case "pause":
          case "resume":
          case "stop": return await controlWorkflow(activeHarness, activeTasks, request);
          case "resolve": return await resolveBlockedWorkflow(activeHarness, activeTasks, installation, request);
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
        activeTasks.stopLaunching();
        await reconcileLiveProcessTasks(activeHarness, activeTasks, deadlineMs);
        await assertNoUnreconciledProcessEvidence(activeHarness, deadlineMs);
        try {
          await beforeDeadline(activeHarness.close(BACKGROUND_CONTEXT), deadlineMs, "Durable Harness and storage close");
          closed = true;
        } catch (error) {
          throw new ServiceShutdownError("Durable Harness and storage did not close before the service deadline", { cause: error });
        }
      },
    };
  } catch (error) {
    opening = false;
    tasks?.stopLaunching();
    const cleanupErrors = [...openCleanupErrors];
    if (harness !== undefined) {
      try {
        if (tasks !== undefined) await reconcileLiveProcessTasks(harness, tasks, Date.now() + STARTUP_RECONCILIATION_MS, true);
        await assertNoUnreconciledProcessEvidence(harness, Date.now() + STARTUP_RECONCILIATION_MS);
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
    machineConfig: installation.machine,
    projectCwd: installation.projectCwd,
    runsDirectory: installation.runsDirectory,
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
        const cancelCapacityWait = action === "stop" && run.status === "queued"
          && run.currentAttemptId === null && run.durable.capacityGateTaskId !== null
          && run.durable.capacityGateTaskId !== undefined;
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
              durable: { ...run.durable, capacityGateTaskId: null },
              nodes: run.currentNodeId === null ? run.nodes : run.nodes.map((node) =>
                node.nodeId === run.currentNodeId && node.status === "pending" ? { ...node, status: "cancelled" } : node),
            };
            workflow.openRunId = null;
            workflow.capacityReservations = workflow.capacityReservations.filter((runId) => runId !== run.runId);
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

async function resolveBlockedWorkflow(
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
  let location: ReturnType<typeof findRunAttempt>;
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
    const needsRepeat = !judgmentRetry && (source.kind === "external_outcome_unknown"
      || sourceProcesses.some((entry) => entry.process.replay === "never"));
    const needsExtraAttempt = !judgmentRetry && attemptLocation !== null
      && attemptLocation.attempt.number >= selectedRun.resolvedSettings.nodes[attemptLocation.node.nodeId]!.maxAttempts;
    if (judgmentRetry) assertJudgmentRetrySource(selectedRun, source, attemptLocation);
    if (request.action === "retry" && !judgmentRetry
      && ((request.allowRepeat ?? false) !== needsRepeat
        || (request.extraAttempt ?? false) !== needsExtraAttempt)) {
      throw new ServiceRequestError("resolution_rejected", `retry flags required by this block: --allow-repeat ${needsRepeat ? "required" : "not allowed"}; --extra-attempt ${needsExtraAttempt ? "required" : "not allowed"}`);
    }
    if (request.action === "retry" && !judgmentRetry && attemptLocation === null && source.kind !== "preflight_failed") {
      throw new ServiceRequestError("resolution_rejected", "retry requires a preflight block or a block tied to a semantic attempt");
    }
    if (request.action === "accept" && (source.kind !== "external_outcome_unknown" || attemptLocation === null)) {
      throw new ServiceRequestError("resolution_rejected", "accept applies only to an unknown worker or validator outcome tied to an attempt");
    }
    const resolvedAt = new Date().toISOString();
    const newResolutionId = randomUUID();
    const resolution = request.action === "accept" ? null : operatorResolutionSchema.parse({
      resolutionId: newResolutionId,
      provenance: "operator",
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
    location = attemptLocation;
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
          provenance: "operator",
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
      if (request.action === "retry" && currentLocation !== null) {
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
      const preflight = request.action === "retry" && sourceBlock.kind === "preflight_failed" && currentRun.preflight.kind === "failed"
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
