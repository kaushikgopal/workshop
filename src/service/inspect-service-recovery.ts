import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import type { Installation } from "../installation/load-installation.js";
import { installationDocumentV1Schema } from "../installation/schema.js";
import { processIncarnationSchema } from "../process/schema.js";
import { processExecutionTaskInputSchema } from "../storage/durable/define-process-execution-task.js";
import { WorkshopInstallationDoc } from "../storage/durable/define-workshop-records.js";
import { WorkshopRecoveryIndexDoc, WorkshopRecoveryRequestDoc } from "../storage/durable/define-recovery-records.js";
import { recoveryIndexV1Schema, recoveryRequestV1Schema } from "../storage/durable/schema-recovery.js";
import type { PausedWorkshopServiceRuntime } from "./open-service-runtime.js";
import {
  hasJournalBackedAttestation,
  hasJournalBackedRetiredProcessEvidence,
  inspectRetainedProcessEvidence,
  processEvidenceNeedsDeathVerification,
  verifyStartupParkAttributions,
} from "./open-service-runtime.js";
import {
  createServiceRecoveryManifestV1,
  MAX_SERVICE_RECOVERY_PROCESS_INCARNATIONS_V1,
  MAX_SERVICE_RECOVERY_SCHEDULES_V1,
  MAX_SERVICE_RECOVERY_SUBMISSIONS_V1,
  MAX_SERVICE_RECOVERY_TASKS_V1,
  type ServiceRecoveryAttributionV1,
  type ServiceRecoveryManifestV1,
  type ServiceRecoveryTaskV1,
} from "./schema-recovery.js";

const WORKFLOW_RUN_TASK_KIND = "workshop.workflow-run";
const SCHEDULER_WAKEUP_TASK_KIND = "workshop.schedule-wakeup";
const PROCESS_EXECUTION_TASK_KIND = "workshop.process-execution";
const SERVICE_RECOVERY_ATTRIBUTION_DEADLINE_MS = 5_000;
type TaskInspection = Awaited<ReturnType<Harness["inspect"]>>["tasks"][number];

interface GraphTask {
  readonly id: number;
  readonly kind: string;
  readonly conversationId: number;
  readonly ownerTaskId: number | null;
  readonly state: string;
  readonly blockedReason: string | null;
  readonly conversations: readonly number[];
}

interface TaskView {
  readonly task: TaskInspection;
  readonly id: number;
  readonly kind: string;
  readonly conversationId: number;
  readonly ownerTaskId: number | null;
  readonly state: ServiceRecoveryTaskV1["state"];
  readonly blockedReason: ServiceRecoveryTaskV1["blockedReason"];
  readonly checkpoint: unknown;
  readonly input: unknown;
}

function graphMatchesInspection(tasks: readonly TaskView[], graph: readonly GraphTask[]): boolean {
  if (tasks.length !== graph.length) return false;
  const graphById = new Map(graph.map((task) => [task.id, task]));
  if (graphById.size !== graph.length) return false;
  const taskIds = new Set(tasks.map((task) => task.id));
  if (taskIds.size !== tasks.length) return false;
  const conversationOwners = new Map<number, number>();
  for (const node of graph) {
    if (!taskIds.has(node.id) || (node.ownerTaskId !== null && !taskIds.has(node.ownerTaskId))) return false;
    for (const conversationId of node.conversations) {
      const priorOwner = conversationOwners.get(conversationId);
      if (priorOwner !== undefined && priorOwner !== node.id) return false;
      conversationOwners.set(conversationId, node.id);
    }
  }
  for (const task of tasks) {
    const node = graphById.get(task.id);
    if (node === undefined || node.kind !== task.kind || node.conversationId !== task.conversationId
      || node.ownerTaskId !== task.ownerTaskId || node.state !== task.task.record.state.status) return false;
    const blockedReason = task.task.state.kind === "blocked" ? task.task.state.reason : null;
    if (node.blockedReason !== blockedReason) return false;
  }
  return true;
}

function descendantsByTaskId(graph: readonly GraphTask[]): Map<number, number> | undefined {
  const graphIds = new Set(graph.map((task) => task.id));
  const children = new Map<number, Set<number>>();
  const addEdge = (ownerId: number, childId: number): void => {
    if (ownerId === childId || !graphIds.has(ownerId)) return;
    const values = children.get(ownerId) ?? new Set<number>();
    values.add(childId);
    children.set(ownerId, values);
  };
  const conversationOwners = new Map<number, number>();
  for (const task of graph) {
    for (const conversationId of task.conversations) conversationOwners.set(conversationId, task.id);
  }
  for (const task of graph) {
    if (task.ownerTaskId !== null) addEdge(task.ownerTaskId, task.id);
    const conversationOwner = conversationOwners.get(task.conversationId);
    if (conversationOwner !== undefined) addEdge(conversationOwner, task.id);
  }

  const counts = new Map<number, number>();
  for (const task of graph) {
    const visited = new Set<number>();
    const visit = (taskId: number, ancestors: Set<number>): boolean => {
      for (const childId of children.get(taskId) ?? []) {
        if (ancestors.has(childId)) return false;
        if (visited.has(childId)) continue;
        visited.add(childId);
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(childId);
        if (!visit(childId, nextAncestors)) return false;
      }
      return true;
    };
    if (!visit(task.id, new Set([task.id]))) return undefined;
    counts.set(task.id, visited.size);
  }
  return counts;
}

function inspectProcessCheckpoint(checkpoint: unknown): {
  readonly checkpointPhase: "intent" | "launch" | "monitor" | "unknown";
  readonly identityKnown: boolean;
  readonly processStatus: "prepared" | "launching" | "running" | "reconciling" | "exited" | "blocked" | null;
  readonly launchBootIdPresent: boolean;
} {
  if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { checkpointPhase: "unknown", identityKnown: false, processStatus: null, launchBootIdPresent: false };
  }
  const value = checkpoint as Record<string, unknown>;
  if (value.phase === "intent" && Object.keys(value).length === 1) {
    return { checkpointPhase: "intent", identityKnown: false, processStatus: null, launchBootIdPresent: false };
  }
  if ((value.phase !== "launch" && value.phase !== "monitor") || Object.keys(value).length !== 2 || !("process" in value)) {
    return { checkpointPhase: "unknown", identityKnown: false, processStatus: null, launchBootIdPresent: false };
  }
  const parsed = processIncarnationSchema.safeParse(value.process);
  if (!parsed.success) {
    return { checkpointPhase: value.phase, identityKnown: false, processStatus: null, launchBootIdPresent: false };
  }
  const process = parsed.data;
  return {
    checkpointPhase: value.phase,
    identityKnown: process.identity !== null,
    processStatus: process.status,
    launchBootIdPresent: process.launchServiceBootId !== undefined,
  };
}

function retryPolicy(task: TaskView): Pick<ServiceRecoveryTaskV1["policy"], "retryEligibility" | "retryUnavailableReason"> {
  if (task.state !== "blocked" || task.blockedReason !== "restart_limit") {
    return { retryEligibility: "not_applicable", retryUnavailableReason: "not_restart_limited" };
  }
  const knownVersions = new Map([
    ["workshop.workflow-run", 11],
    ["workshop.node-attempt", 5],
    ["workshop.capacity-gate", 1],
    ["workshop.schedule-wakeup", 1],
  ]);
  const allowedVersion = knownVersions.get(task.kind);
  if (allowedVersion === undefined) {
    return {
      retryEligibility: task.kind === "pi.tool" ? "unsafe" : "unknown",
      retryUnavailableReason: "task_kind_not_allowlisted",
    };
  }
  if (task.task.record.version !== allowedVersion) {
    return { retryEligibility: "unknown", retryUnavailableReason: "definition_version_not_allowlisted" };
  }
  // Child process and agent tasks keep their own launch and unsafe-tool replay guards.
  // retryTask() resumes the whole installation; apply requires resume-installation consent.
  return { retryEligibility: "safe", retryUnavailableReason: null };
}

function policyForTask(
  task: TaskView,
  attribution: ServiceRecoveryAttributionV1,
  descendantCount: number | undefined,
  pendingSubmissionCount: number,
  substrateComplete: boolean,
): ServiceRecoveryTaskV1["policy"] {
  const retry = retryPolicy(task);
  const permittedActions: Array<"abort" | "retry"> = [];
  const ownershipVerified = attribution.kind !== "unknown";
  const processEvidence = task.kind === PROCESS_EXECUTION_TASK_KIND ? inspectProcessCheckpoint(task.checkpoint) : null;
  let abortEvidence: ServiceRecoveryTaskV1["policy"]["abortEvidence"] = null;
  let abortUnavailableReason: ServiceRecoveryTaskV1["policy"]["abortUnavailableReason"] = null;

  if (!substrateComplete) abortUnavailableReason = "inspection_incomplete";
  else if (!ownershipVerified) abortUnavailableReason = "unknown_ownership";
  else if (descendantCount === undefined) abortUnavailableReason = "inspection_incomplete";
  else if (descendantCount > 0) abortUnavailableReason = "owned_work_live";
  else if (pendingSubmissionCount > 0) abortUnavailableReason = "pending_submission";
  else if (task.state === "running") abortUnavailableReason = "task_execution_live";
  else if (task.state === "completing") abortUnavailableReason = "task_already_completing";
  else if (processEvidence !== null) {
    if (processEvidence.checkpointPhase === "intent") abortEvidence = "launch_not_started";
    else if (processEvidence.checkpointPhase === "unknown") abortUnavailableReason = "unsupported_process_checkpoint";
    // Apply verifies death on the host, or requires an operator attestation when no identity was recorded.
    else abortEvidence = processEvidence.identityKnown ? "host_death_proof_required" : "operator_attestation_required";
  } else {
    abortEvidence = "none";
  }

  if (abortUnavailableReason === null) permittedActions.push("abort");
  if (retry.retryEligibility === "safe" && substrateComplete && ownershipVerified && descendantCount !== undefined) permittedActions.push("retry");
  return {
    permittedActions,
    retryEligibility: retry.retryEligibility,
    retryUnavailableReason: retry.retryUnavailableReason,
    abortEvidence,
    abortUnavailableReason,
    ownedDescendantCount: descendantCount ?? 0,
    pendingSubmissionCount,
  };
}

function mapTask(
  task: TaskView,
  attribution: ServiceRecoveryAttributionV1,
  descendants: Map<number, number> | undefined,
  pendingSubmissionCount: number,
  substrateComplete: boolean,
): ServiceRecoveryTaskV1 {
  const record = task.task.record;
  const checkpoint = task.checkpoint;
  const processEvidence = task.kind === PROCESS_EXECUTION_TASK_KIND ? inspectProcessCheckpoint(checkpoint) : null;
  return {
    taskId: task.id,
    kind: task.kind,
    version: record.version,
    state: task.state,
    blockedReason: task.blockedReason,
    ownerTaskId: task.ownerTaskId,
    conversationId: task.conversationId,
    attribution,
    ownershipVerified: attribution.kind !== "unknown",
    inputHash: canonicalHash(task.input),
    checkpointHash: checkpoint === null ? null : canonicalHash(checkpoint),
    processEvidence: processEvidence === null ? null : {
      checkpointPhase: processEvidence.checkpointPhase,
      identityKnown: processEvidence.identityKnown,
      processStatus: processEvidence.processStatus,
      launchBootIdPresent: processEvidence.launchBootIdPresent,
    },
    policy: policyForTask(task, attribution, descendants?.get(task.id), pendingSubmissionCount, substrateComplete),
  };
}

/** Build a bounded, read-only recovery manifest for an already paused service runtime. */
export async function inspectServiceRecovery(
  runtime: PausedWorkshopServiceRuntime,
  installation: Installation,
): Promise<ServiceRecoveryManifestV1> {
  const harness: Harness = runtime.harness;
  const limitations = new Set<
    | "scheduling_not_paused"
    | "task_inspection_unavailable"
    | "task_graph_unavailable"
    | "task_graph_disagreement"
    | "attribution_incomplete"
    | "task_limit_exceeded"
    | "installation_state_unavailable"
    | "recovery_index_unavailable"
    | "recovery_request_active_unavailable"
    | "schedule_limit_exceeded"
    | "submission_limit_exceeded"
    | "process_evidence_unavailable"
    | "process_incarnation_limit_exceeded"
  >();

  let taskInspection: Awaited<ReturnType<Harness["inspect"]>> | undefined;
  try {
    taskInspection = await harness.inspect(BACKGROUND_CONTEXT);
  } catch {
    limitations.add("task_inspection_unavailable");
  }
  const scheduling: "paused" | "running" | "closing" | "unavailable" = taskInspection?.scheduling ?? "unavailable";
  if (scheduling !== "paused") limitations.add("scheduling_not_paused");

  let graph: GraphTask[] | undefined;
  try {
    const attached = await harness.taskGraph(BACKGROUND_CONTEXT);
    try {
      graph = Object.values(attached.value.tasks).map((node) => ({
        id: Number(node.id),
        kind: node.kind,
        conversationId: Number(node.conversationId),
        ownerTaskId: node.owner === undefined ? null : Number(node.owner),
        state: node.state.status,
        blockedReason: node.blocked ?? null,
        conversations: node.conversations.map(Number),
      })).sort((left, right) => left.id - right.id);
    } finally {
      attached.dispose();
    }
  } catch {
    limitations.add("task_graph_unavailable");
  }

  const allTaskViews: TaskView[] = (taskInspection?.tasks ?? []).map((task) => ({
    task,
    id: Number(task.record.id),
    kind: task.record.kind,
    conversationId: Number(task.record.conversationId),
    ownerTaskId: task.record.owner === undefined ? null : Number(task.record.owner),
    state: task.state.kind,
    blockedReason: task.state.kind === "blocked" ? task.state.reason : null,
    checkpoint: "checkpoint" in task.record.state ? task.record.state.checkpoint : null,
    input: task.record.input,
  })).sort((left, right) => left.id - right.id);
  const taskCount = allTaskViews.length;
  const omittedTaskCount = Math.max(0, taskCount - MAX_SERVICE_RECOVERY_TASKS_V1);
  if (omittedTaskCount > 0) limitations.add("task_limit_exceeded");
  const selectedTaskViews = allTaskViews.slice(0, MAX_SERVICE_RECOVERY_TASKS_V1);

  let graphMatches = false;
  if (graph !== undefined && taskInspection !== undefined && omittedTaskCount === 0) {
    graphMatches = graphMatchesInspection(allTaskViews, graph);
    if (!graphMatches) limitations.add("task_graph_disagreement");
  }
  const descendants = graphMatches && graph !== undefined ? descendantsByTaskId(graph) : undefined;
  if (graphMatches && descendants === undefined) limitations.add("task_graph_disagreement");

  let attributionComplete = false;
  const attributionByTaskId = new Map<number, ServiceRecoveryAttributionV1>();
  if (taskInspection !== undefined && graph !== undefined && omittedTaskCount === 0) {
    try {
      const result = await verifyStartupParkAttributions(
        harness,
        selectedTaskViews.map((task) => task.id),
        SCHEDULER_WAKEUP_TASK_KIND,
        WORKFLOW_RUN_TASK_KIND,
        Date.now() + SERVICE_RECOVERY_ATTRIBUTION_DEADLINE_MS,
      );
      attributionComplete = result.complete && graphMatches;
      for (const [taskId, attribution] of result.byTaskId) attributionByTaskId.set(taskId, attribution);
      if (!result.complete || !graphMatches) limitations.add("attribution_incomplete");
    } catch {
      limitations.add("attribution_incomplete");
    }
  } else if (selectedTaskViews.length > 0) {
    limitations.add("attribution_incomplete");
  } else {
    attributionComplete = taskInspection !== undefined && graph !== undefined && graphMatches;
  }

  let installationState: "unavailable" | "ready" = "unavailable";
  let installationId: string | null = null;
  let schedules: Array<{
    workflowId: string;
    activationId: string;
    state: "active" | "paused" | "stopped" | "exhausted";
    nextDueAt: string | null;
    schedulerTaskId: number | null;
  }> = [];
  try {
    const stored = await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT);
    const parsed = installationDocumentV1Schema.safeParse(stored);
    if (parsed.success && parsed.data.state === "ready") {
      installationState = "ready";
      installationId = parsed.data.installationId;
      schedules = Object.entries(parsed.data.workflows).flatMap(([workflowId, workflow]) =>
        workflow.activations.map((activation) => ({
          workflowId,
          activationId: activation.activationId,
          state: activation.state,
          nextDueAt: activation.nextDueAt,
          schedulerTaskId: activation.schedulerTaskId,
        })),
      ).sort((left, right) => left.workflowId.localeCompare(right.workflowId) || left.activationId.localeCompare(right.activationId));
    } else {
      limitations.add("installation_state_unavailable");
    }
  } catch {
    limitations.add("installation_state_unavailable");
  }
  const omittedScheduleCount = Math.max(0, schedules.length - MAX_SERVICE_RECOVERY_SCHEDULES_V1);
  if (omittedScheduleCount > 0) limitations.add("schedule_limit_exceeded");
  schedules = schedules.slice(0, MAX_SERVICE_RECOVERY_SCHEDULES_V1);

  let recoveryIndexState: "uninitialized" | "ready" | "unavailable" = "unavailable";
  let recoveryInstallationId: string | null = null;
  let activeRequest: ServiceRecoveryManifestV1["activeRequest"] = null;
  try {
    const stored = await harness.snapshot(WorkshopRecoveryIndexDoc, BACKGROUND_CONTEXT);
    const parsed = recoveryIndexV1Schema.safeParse(stored ?? { state: "uninitialized" });
    if (!parsed.success) {
      limitations.add("recovery_index_unavailable");
    } else if (parsed.data.state === "uninitialized") {
      recoveryIndexState = "uninitialized";
    } else {
      recoveryIndexState = "ready";
      recoveryInstallationId = parsed.data.installationId;
      const activeRequestId = parsed.data.activeRequestId;
      if (activeRequestId !== null) {
        try {
          const requestStored = await harness.snapshot(WorkshopRecoveryRequestDoc, activeRequestId, BACKGROUND_CONTEXT);
          const requestParsed = recoveryRequestV1Schema.safeParse(requestStored);
          if (!requestParsed.success || requestParsed.data.requestId !== activeRequestId
            || requestParsed.data.state !== "active" || requestParsed.data.createdAt === null) {
            limitations.add("recovery_request_active_unavailable");
          } else {
            activeRequest = {
              requestId: requestParsed.data.requestId,
              createdAt: requestParsed.data.createdAt,
              actionCount: requestParsed.data.actions.length,
              globalDispatch: requestParsed.data.globalDispatch?.state ?? "not_started",
            };
          }
        } catch {
          limitations.add("recovery_request_active_unavailable");
        }
      }
    }
  } catch {
    limitations.add("recovery_index_unavailable");
  }

  let processIncarnations: ServiceRecoveryManifestV1["processIncarnations"] = [];
  try {
    const retained = await inspectRetainedProcessEvidence(harness, Date.now() + SERVICE_RECOVERY_ATTRIBUTION_DEADLINE_MS);
    const seenTaskIds = new Set<number>();
    for (const item of retained) {
      const record = item.record;
      const process = record.process;
      if (!processEvidenceNeedsDeathVerification(process)) continue;
      if (process.cleanupState === "operator_attested_absent"
        && await hasJournalBackedAttestation(
          harness, record, item.conversationId, Date.now() + SERVICE_RECOVERY_ATTRIBUTION_DEADLINE_MS, true,
        )) continue;
      if (await hasJournalBackedRetiredProcessEvidence(harness, item, Date.now() + SERVICE_RECOVERY_ATTRIBUTION_DEADLINE_MS)) continue;
      if (seenTaskIds.has(record.taskId)) {
        limitations.add("process_evidence_unavailable");
        continue;
      }
      seenTaskIds.add(record.taskId);
      const durableTask = await harness.getTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
      const taskInput = processExecutionTaskInputSchema.safeParse(durableTask?.input);
      if (durableTask === undefined || durableTask.kind !== PROCESS_EXECUTION_TASK_KIND || !taskInput.success
        || taskInput.data.runId !== record.runId || taskInput.data.executionId !== process.executionId
        || taskInput.data.incarnationId !== process.incarnationId
        || taskInput.data.incarnationNumber !== process.incarnationNumber) {
        limitations.add("process_evidence_unavailable");
        continue;
      }
      const inputHash = canonicalHash(durableTask.input);
      let action: "abort" | "verify_retired";
      let checkpointHash: string;
      if (durableTask.state.status === "terminal") {
        if (allTaskViews.some((task) => task.id === record.taskId)) {
          limitations.add("process_evidence_unavailable");
          continue;
        }
        action = "verify_retired";
        checkpointHash = canonicalHash(null);
      } else {
        const taskView = allTaskViews.find((task) => task.id === record.taskId);
        if (taskView === undefined || taskView.kind !== PROCESS_EXECUTION_TASK_KIND || taskView.state === "completing"
          || taskView.task.record.version !== durableTask.version || canonicalHash(taskView.input) !== inputHash) {
          limitations.add("process_evidence_unavailable");
          continue;
        }
        const checkpoint = taskView.checkpoint as { phase?: unknown; process?: unknown };
        const currentProcess = processIncarnationSchema.safeParse(checkpoint.process);
        if ((checkpoint.phase !== "launch" && checkpoint.phase !== "monitor") || !currentProcess.success
          || currentProcess.data.executionId !== process.executionId
          || currentProcess.data.incarnationId !== process.incarnationId) {
          limitations.add("process_evidence_unavailable");
          continue;
        }
        action = "abort";
        checkpointHash = taskView.checkpoint === null ? canonicalHash(null) : canonicalHash(taskView.checkpoint);
      }
      processIncarnations.push({
        taskId: record.taskId, taskKind: PROCESS_EXECUTION_TASK_KIND, taskVersion: Number(durableTask.version),
        conversationId: item.conversationId, runId: record.runId, action, inputHash, checkpointHash,
        processEntryHash: item.processEntryHash,
        process: {
          executionId: process.executionId, incarnationId: process.incarnationId,
          launchServiceBootId: process.launchServiceBootId ?? taskInput.data.serviceBootId, identity: process.identity,
        },
        processStatus: process.status, cleanupState: process.cleanupState,
      });
    }
  } catch {
    limitations.add("process_evidence_unavailable");
  }
  const omittedProcessIncarnationCount = Math.max(0, processIncarnations.length - MAX_SERVICE_RECOVERY_PROCESS_INCARNATIONS_V1);
  if (omittedProcessIncarnationCount > 0) limitations.add("process_incarnation_limit_exceeded");
  processIncarnations = processIncarnations.slice(0, MAX_SERVICE_RECOVERY_PROCESS_INCARNATIONS_V1);

  const submissions = (taskInspection?.submissions ?? [])
    .filter((submission) => submission.status === "queued" || submission.status === "placed")
    .map((submission) => ({
      submissionId: Number(submission.id),
      conversationId: Number(submission.conversationId),
      state: submission.status as "queued" | "placed",
    }))
    .sort((left, right) => left.submissionId - right.submissionId);
  const omittedSubmissionCount = Math.max(0, submissions.length - MAX_SERVICE_RECOVERY_SUBMISSIONS_V1);
  if (omittedSubmissionCount > 0) limitations.add("submission_limit_exceeded");

  const substrateComplete = scheduling === "paused"
    && taskInspection !== undefined
    && graph !== undefined
    && graphMatches
    && descendants !== undefined
    && omittedTaskCount === 0
    && omittedSubmissionCount === 0
    && omittedProcessIncarnationCount === 0
    && !limitations.has("process_evidence_unavailable")
    && omittedScheduleCount === 0
    && installationState === "ready"
    && recoveryIndexState !== "unavailable"
    && !limitations.has("recovery_request_active_unavailable");
  const submissionsByConversation = new Map<number, number>();
  for (const submission of submissions) {
    submissionsByConversation.set(submission.conversationId, (submissionsByConversation.get(submission.conversationId) ?? 0) + 1);
  }
  const tasks = selectedTaskViews.map((task) => mapTask(
    task,
    attributionByTaskId.get(task.id) ?? { kind: "unknown" },
    descendants,
    submissionsByConversation.get(task.conversationId) ?? 0,
    substrateComplete,
  ));
  const complete = limitations.size === 0;
  const payload = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    complete,
    limitations: [...limitations].sort(),
    scheduling,
    stateDirectoryHash: canonicalHash({ kind: "workshop-state-directory", path: resolve(installation.stateDirectory) }),
    installationId,
    recoveryInstallationId,
    recoveryIndexState,
    taskCount,
    omittedTaskCount,
    attributionComplete,
    tasks,
    processIncarnations,
    queuedSubmissions: submissions.slice(0, MAX_SERVICE_RECOVERY_SUBMISSIONS_V1),
    omittedSubmissionCount,
    schedules,
    omittedScheduleCount,
    activeRequest,
    retryControl: "retryTask_may_resume_unrelated_work" as const,
  };
  return createServiceRecoveryManifestV1(payload);
}
