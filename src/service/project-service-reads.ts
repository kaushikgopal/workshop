import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";
import { workflowIdSchema } from "../definition/schema.js";
import {
  installationDocumentV1Schema,
  type RunReference,
} from "../installation/schema.js";
import { loadCheckedWorkflow, type Installation } from "../installation/load-installation.js";
import { runIdSchema } from "../run/schema.js";
import { readRetainedCapture } from "../process/read-retained-capture.js";
import type { ProcessCapture } from "../process/schema.js";
import { workshopEventV1Schema, workshopProcessV1Schema, workflowRunDocumentV1Schema } from "../run/records.js";
import type { PersistedNodeAttempt, PersistedNode, WorkflowRunDocumentV1, WorkshopEventV1 } from "../run/records.js";
import { renderWorklog } from "../storage/durable/render-worklog.js";
import { WorkshopEventEntry, WorkshopInstallationDoc, WorkshopProcessEntry, WorkshopRunDoc } from "../storage/durable/define-workshop-records.js";
import {
  diagramDtoSchema,
  nodeDescriptionDtoSchema,
  runSummaryDtoSchema,
  statusDtoSchema,
  type DiagramDto,
  type NodeDescriptionDto,
  type RunSummaryDto,
  type StatusDto,
  logSectionDtoSchema,
} from "../views/schema.js";
import {
  MAX_LOG_CONTENT_CHUNK_BYTES_V1,
  serviceLogSectionPageV1Schema,
  serviceRunsPageV1Schema,
  type ServiceLogSectionPageV1,
  type ServiceMetadataV1,
  type ServiceRequestV1,
  type ServiceRunsPageV1,
} from "./schema.js";

const MAX_RUN_PAGE_BYTES = 12 * 1024 * 1024;
const LOG_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_LOG_SNAPSHOTS = 32;
const runCursorV1Schema = z.strictObject({
  version: z.literal(1),
  workflowId: workflowIdSchema,
  filter: z.literal("all"),
  highWaterMark: z.number().int().nonnegative().safe(),
  lastAdmittedAt: z.string().datetime({ offset: true }),
  lastRunId: runIdSchema,
  lastAdmissionSequence: z.number().int().positive().safe(),
});
type RunCursorV1 = z.infer<typeof runCursorV1Schema>;
const logsCursorSchema = z.strictObject({
  version: z.literal(1),
  workflowId: workflowIdSchema,
  runId: runIdSchema,
  snapshotId: z.string().uuid(),
  sectionIndex: z.number().int().nonnegative().safe(),
  sectionOffsetBytes: z.number().int().nonnegative().safe(),
});
type LogsCursor = z.infer<typeof logsCursorSchema>;
type ReadyInstallation = Extract<z.infer<typeof installationDocumentV1Schema>, { state: "ready" }>;
type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;
type ProcessEvidenceRecord = ReturnType<typeof workshopProcessV1Schema.parse>;
export type RunEvidenceSnapshot = {
  readonly run: ReadyRun;
  readonly processEvidence: readonly ProcessEvidenceRecord[];
  readonly events: readonly WorkshopEventV1[];
};
type ProcessCaptureLogMetadata = Omit<ProcessCapture, "retained">;
type LogSnapshotSection =
  | {
      readonly kind: "worklog";
      readonly sectionId: "worklog";
      readonly order: 0;
      readonly label: "worklog";
      readonly content: string;
      readonly contentBytes: number;
    }
  | {
      readonly kind: "capture";
      readonly sectionId: string;
      readonly order: number;
      readonly label: string;
      readonly executionId: string;
      readonly incarnationNumber: number;
      readonly capture: ProcessCaptureLogMetadata;
      readonly content: string | null;
      readonly contentBytes: number;
    };
type LogSnapshot = {
  readonly snapshotId: string;
  readonly workflowId: string;
  readonly runId: z.infer<typeof runIdSchema>;
  readonly expiresAt: number;
  readonly sections: readonly LogSnapshotSection[];
};
// Keep one committed projection in memory while its bounded log pages are read.
const logSnapshots = new Map<string, LogSnapshot>();

export async function projectServiceRead(
  harness: Harness,
  installation: Installation,
  metadata: ServiceMetadataV1,
  request: Extract<ServiceRequestV1, { method: "status" | "runs" | "logs.page" | "node.describe" | "diagram" }>,
  ): Promise<StatusDto | ServiceRunsPageV1 | ServiceLogSectionPageV1 | NodeDescriptionDto | DiagramDto> {
  switch (request.method) {
    case "status": return await buildStatusDto(harness, installation, metadata, request.workflowId);
    case "runs": return await buildRunsPage(harness, request.workflowId, request.cursor, request.limit);
    case "logs.page": return await buildLogsSectionPage(harness, request.workflowId, request.runId, request.cursor, request.verbose === true);
    case "node.describe": return await buildNodeDescriptionDto(harness, installation, request.workflowId, request.nodeId, request.runId);
    case "diagram": return await buildDiagramDto(harness, installation, request.workflowId, request.runId);
  }
}


export async function readInstallation(harness: Harness): Promise<ReadyInstallation> {
  const parsed = installationDocumentV1Schema.safeParse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
  if (!parsed.success || parsed.data.state !== "ready") throw new Error("Durable installation document is not initialized");
  return parsed.data;
}

export async function readRun(harness: Harness, reference: RunReference): Promise<ReadyRun> {
  // SAFETY: the installation document schema checks this as a positive safe Durable conversation ID.
  const conversationId = reference.conversationId as ConversationId;
  const parsed = workflowRunDocumentV1Schema.safeParse(await harness.snapshot(WorkshopRunDoc, conversationId, BACKGROUND_CONTEXT));
  if (!parsed.success || parsed.data.state !== "ready") throw new Error(`run record ${reference.runId} is unavailable or invalid`);
  if (parsed.data.runId !== reference.runId || parsed.data.durable.conversationId !== reference.conversationId) {
    throw new Error(`run identity mismatch for ${reference.runId}`);
  }
  return parsed.data;
}

async function buildStatusDto(
  harness: Harness,
  installation: Installation,
  metadata: ServiceMetadataV1,
  selectedWorkflowId: string | undefined,
): Promise<StatusDto> {
  const index = await readInstallation(harness);
  const workflowIds = configuredWorkflowIds(installation, index.workflows);
  if (selectedWorkflowId !== undefined && !workflowIds.includes(selectedWorkflowId)) {
    throw new Error(`workflow ${JSON.stringify(selectedWorkflowId)} is not configured`);
  }
  const selected = selectedWorkflowId === undefined ? workflowIds : [selectedWorkflowId];
  const workflows = [];
  for (const workflowId of selected) {
    const workflowIndex = index.workflows[workflowId];
    let checked: ReturnType<typeof loadCheckedWorkflow> | undefined;
    let configurationError: string | null = null;
    try {
      checked = loadCheckedWorkflow(installation, workflowId);
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error);
    }
    const latestActivation = workflowIndex?.activations.at(-1);
    if (configurationError === null && latestActivation?.admissionError !== null && latestActivation?.admissionError !== undefined) {
      configurationError = latestActivation.admissionError;
    }
    let unresolvedRun: RunSummaryDto | null = null;
    if (workflowIndex?.openRunId !== null && workflowIndex?.openRunId !== undefined) {
      const reference = workflowIndex.runs.find((run) => run.runId === workflowIndex.openRunId);
      if (reference === undefined) throw new Error(`open run ${workflowIndex.openRunId} is missing from the installation index`);
      unresolvedRun = summarizeRun(await readRun(harness, reference));
    }
    workflows.push({
      workflowId,
      description: checked?.definition.description ?? null,
      definitionHash: workflowIndex?.definitionHash ?? checked?.canonicalHash ?? null,
      configurationError,
      activation: latestActivation === undefined ? null : {
        activationId: latestActivation.activationId,
        state: latestActivation.state,
        admittedCount: latestActivation.admittedCount,
        maxRuns: latestActivation.maxRuns,
        activatedAt: latestActivation.activatedAt,
        nextDueAt: latestActivation.nextDueAt,
        skippedSlots: latestActivation.skippedSlots,
        lastSkippedSlotAt: latestActivation.lastSkippedSlotAt,
      },
      unresolvedRun,
    });
  }
  return statusDtoSchema.parse({
    version: 2,
    generatedAt: new Date().toISOString(),
    installationId: index.installationId,
    service: {
      state: metadata.status === "stopping" ? "stopping" : metadata.status === "stopped" ? "stopped" : metadata.status === "shutdown_failed" || metadata.status === "failed" ? "unavailable" : "running",
      pid: metadata.pid,
      bootId: metadata.bootId,
      startedAt: metadata.startedAt,
      socketPath: metadata.socketPath,
      error: null,
    },
    workflows,
  });
}

async function buildNodeDescriptionDto(
  harness: Harness,
  installation: Installation,
  workflowId: string,
  nodeId: string,
  selectedRunId: string | undefined,
 ): Promise<NodeDescriptionDto> {
  const index = await readInstallation(harness);
  const workflow = index.workflows[workflowId];
  const reference = selectedRunId === undefined
    ? workflow?.runs.slice().sort(compareRunReferences)[0]
    : workflow?.runs.find((run) => run.runId === selectedRunId);
  if (reference === undefined) {
    if (selectedRunId !== undefined) throw new Error(`run ${selectedRunId} was not found`);
    const checked = loadCheckedWorkflow(installation, workflowId);
    const position = checked.chain.order.indexOf(nodeId);
    if (position < 0) throw new Error(`step ${nodeId} is not configured in workflow ${workflowId}`);
    const resolvedSettings = checked.resolvedSettings.nodes[nodeId];
    if (resolvedSettings === undefined) throw new Error(`resolved settings for step ${nodeId} are unavailable`);
    return nodeDescriptionDtoSchema.parse({
      version: 2,
      workflowId,
      definitionHash: checked.canonicalHash,
      runId: null,
      runStatus: null,
      runFailure: null,
      node: {
        nodeId,
        position: position + 1,
        predecessorId: checked.chain.prev.get(nodeId) ?? null,
        successorId: checked.chain.next.get(nodeId) ?? null,
        status: "pending",
        block: null,
        resolvedSettings,
        successfulOutput: null,
        attempts: [],
      },
    });
  }
  const snapshot = await readRunEvidenceSnapshot(harness, reference, workflowId);
  const { run, processEvidence: processes, events } = snapshot;
  const position = run.chain.order.indexOf(nodeId);
  if (position < 0) throw new Error(`step ${nodeId} is not part of run ${run.runId}`);
  const persistedNode = run.nodes[position];
  if (persistedNode === undefined || persistedNode.nodeId !== nodeId) throw new Error(`step ${nodeId} is absent from run ${run.runId}`);
  const resolvedSettings = run.resolvedSettings.nodes[nodeId];
  if (resolvedSettings === undefined) throw new Error(`frozen settings for node ${nodeId} are unavailable`);
  const lastAttempt = persistedNode.attempts.at(-1);
  const nodeBlock = persistedNode.status !== "blocked"
    ? null
    : run.block?.nodeId === nodeId
      ? run.block
      : lastAttempt?.result.kind === "settled" && lastAttempt.result.outcome.kind === "blocked"
        ? lastAttempt.result.outcome.block
        : null;
  const successfulAttempt = lastAttempt;
  const successfulOutput = persistedNode.status === "succeeded"
    && successfulAttempt?.result.kind === "settled"
    && successfulAttempt.result.outcome.kind === "succeeded"
    ? successfulAttempt.result.outcome.candidate.output
    : null;
  return nodeDescriptionDtoSchema.parse({
    version: 2,
    workflowId,
    definitionHash: run.canonicalHash,
    runId: run.runId,
    runStatus: run.status,
    runFailure: run.failure,
    node: {
      nodeId,
      position: position + 1,
      predecessorId: run.chain.predecessors[nodeId] ?? null,
      successorId: run.chain.order[position + 1] ?? null,
      status: persistedNode.status,
      block: nodeBlock,
      resolvedSettings,
      successfulOutput,
      attempts: persistedNode.attempts.map((attempt) => projectAttemptDetail(run, persistedNode, attempt, processes, events)),
    },
  });
}

async function buildDiagramDto(
  harness: Harness,
  installation: Installation,
  workflowId: string,
  selectedRunId: string | undefined,
): Promise<DiagramDto> {
  const index = await readInstallation(harness);
  const workflow = index.workflows[workflowId];
  const reference = selectedRunId === undefined
    ? workflow?.runs.slice().sort(compareRunReferences)[0]
    : workflow?.runs.find((run) => run.runId === selectedRunId);
  if (reference === undefined) {
    if (selectedRunId !== undefined) throw new Error(`run ${selectedRunId} was not found`);
    const checked = loadCheckedWorkflow(installation, workflowId);
    return diagramDtoSchema.parse({
      version: 2,
      workflowId,
      definitionHash: checked.canonicalHash,
      runId: null,
      nodes: checked.chain.order.map((nodeId, index) => ({
        nodeId,
        position: index + 1,
        successorId: checked.chain.next.get(nodeId) ?? null,
        status: null,
      })),
    });
  }
  const run = await readRun(harness, reference);
  return diagramDtoSchema.parse({
    version: 2,
    workflowId,
    definitionHash: run.canonicalHash,
    runId: run.runId,
    nodes: run.chain.order.map((nodeId, index) => {
      const node = run.nodes[index];
      if (node === undefined || node.nodeId !== nodeId) throw new Error(`node ${nodeId} is absent from run ${run.runId}`);
      return {
        nodeId,
        position: index + 1,
        successorId: run.chain.order[index + 1] ?? null,
        status: node.status,
      };
    }),
  });
}


export async function readRunEvidenceSnapshot(
  harness: Harness,
  reference: RunReference,
  workflowId: string,
): Promise<RunEvidenceSnapshot> {
  // SAFETY: the installation document schema checks this as a positive safe Durable conversation ID.
  const conversationId = reference.conversationId as ConversationId;
  // Read the run document and its evidence in one Durable transaction.
  return harness.commit(async (tx) => {
    const parsedRun = workflowRunDocumentV1Schema.safeParse(await tx.doc(WorkshopRunDoc, conversationId));
    if (!parsedRun.success || parsedRun.data.state !== "ready") {
      throw new Error(`run record ${reference.runId} is unavailable or invalid`);
    }
    const run = parsedRun.data;
    if (run.runId !== reference.runId || run.workflowId !== workflowId || run.durable.conversationId !== reference.conversationId) {
      throw new Error(`run identity mismatch for ${reference.runId}`);
    }
    const latestProcesses = new Map<string, { record: ProcessEvidenceRecord; firstEntryId: number }>();
    const events: WorkshopEventV1[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId }, 256, cursor);
      for (const entry of page.items) {
        if (WorkshopProcessEntry.is(entry)) {
          const parsed = workshopProcessV1Schema.safeParse(entry.data);
          if (!parsed.success) {
            if (entryBelongsToRun(entry.data, run.runId)) throw new Error(`process evidence ${entry.id} is invalid`);
            continue;
          }
          if (parsed.data.runId !== run.runId) continue;
          assertProcessEvidenceJoin(run, entry, parsed.data);
          const key = `${parsed.data.process.executionId}:${parsed.data.process.incarnationId}`;
          const previous = latestProcesses.get(key);
          if (previous === undefined) latestProcesses.set(key, { record: parsed.data, firstEntryId: entry.id });
          else previous.firstEntryId = entry.id;
          continue;
        }
        if (!WorkshopEventEntry.is(entry)) continue;
        const parsed = workshopEventV1Schema.safeParse(entry.data);
        if (!parsed.success) {
          if (entryBelongsToRun(entry.data, run.runId)) throw new Error(`run event ${entry.id} is invalid`);
          continue;
        }
        if (parsed.data.runId === run.runId) events.push(parsed.data);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    const processEvidence = [...latestProcesses.values()]
      .sort((left, right) => left.firstEntryId - right.firstEntryId)
      .map(({ record }) => record);
    return { run, processEvidence, events };
  }, BACKGROUND_CONTEXT);
}

function entryBelongsToRun(value: unknown, runId: string): boolean {
  return typeof value === "object" && value !== null && "runId" in value && value.runId === runId;
}

function assertProcessEvidenceJoin(
  run: ReadyRun,
  entry: EntryRecord,
  evidence: ProcessEvidenceRecord,
): void {
  if (entry.byTaskId !== undefined && entry.byTaskId !== evidence.taskId) {
    throw new Error(`process evidence ${entry.id} has a mismatched Durable task identity`);
  }
  const process = evidence.process;
  if (process.role === "preflight") {
    const executionIds = run.preflight.kind === "not_configured" ? [] : run.preflight.processExecutionIds;
    if (evidence.nodeId !== null || evidence.attemptId !== null || !executionIds.includes(process.executionId)) {
      throw new Error(`preflight process evidence ${entry.id} does not match its run`);
    }
    return;
  }
  if (evidence.nodeId === null || evidence.attemptId === null) throw new Error(`node process evidence ${entry.id} lacks its attempt identity`);
  const node = run.nodes.find((candidate) => candidate.nodeId === evidence.nodeId);
  const attempt = node?.attempts.find((candidate) => candidate.attemptId === evidence.attemptId);
  const executionId = process.role === "worker" ? attempt?.workerExecutionId : attempt?.validatorExecutionId;
  const reference = attempt?.processIncarnations.find((candidate) => candidate.executionId === process.executionId
    && candidate.incarnationId === process.incarnationId);
  if (executionId !== process.executionId || reference === undefined) {
    throw new Error(`process evidence ${entry.id} does not match its run attempt`);
  }
}

function projectAttemptDetail(
  run: ReadyRun,
  node: PersistedNode,
  attempt: PersistedNodeAttempt,
  processEvidence: readonly ProcessEvidenceRecord[],
  events: readonly WorkshopEventV1[],
 ) {
  const result = attempt.result;
  const candidate = result.kind === "candidate_committed" || result.kind === "validation_committed"
    ? result.candidate
    : result.kind === "settled"
      ? result.outcome.kind === "cancelled" ? result.outcome.candidate ?? null : result.outcome.candidate
      : null;
  const validator = result.kind === "validation_committed" || result.kind === "worker_failure_committed"
    ? result.validator
    : result.kind === "settled"
      ? result.outcome.kind === "cancelled" ? result.outcome.validator ?? null : result.outcome.validator
      : null;
  const failure = result.kind === "settled" && result.outcome.kind === "failed" ? result.outcome.failure : null;
  const blocks = new Map<string, NonNullable<typeof run.block>>();
  if (result.kind === "settled" && result.outcome.kind === "blocked") blocks.set(result.outcome.block.blockId, result.outcome.block);
  for (const event of events) {
    if (event.type === "attempt_settled" && event.attemptId === attempt.attemptId && event.outcome.kind === "blocked") {
      blocks.set(event.outcome.block.blockId, event.outcome.block);
    }
    if (event.type === "run_resolved" && event.resolution.sourceBlock.attemptId === attempt.attemptId) {
      blocks.set(event.resolution.sourceBlock.blockId, event.resolution.sourceBlock);
    }
  }
  if (run.block?.attemptId === attempt.attemptId) blocks.set(run.block.blockId, run.block);
  for (const resolution of run.resolutions) {
    if (resolution.sourceBlock.attemptId === attempt.attemptId) blocks.set(resolution.sourceBlock.blockId, resolution.sourceBlock);
  }
  const attemptProcesses = attempt.processIncarnations.map((reference) => {
    const evidence = processEvidence.find((entry) => entry.nodeId === node.nodeId && entry.attemptId === attempt.attemptId
      && entry.process.executionId === reference.executionId && entry.process.incarnationId === reference.incarnationId);
    if (evidence === undefined) throw new Error(`process evidence ${reference.executionId}/${reference.incarnationId} is missing`);
    return evidence.process;
  });
  const workerEvent = events.find((event) => event.type === "worker_result_committed" && event.attemptId === attempt.attemptId);
  const validatorEvent = events.find((event) => event.type === "validator_result_committed" && event.attemptId === attempt.attemptId);
  const workerFinishedAt = attemptProcesses.flatMap((process) => process.role === "worker" && process.finishedAt !== null
    ? [process.finishedAt]
    : [])
    .sort(compareCodeUnits)
    .at(-1);
  const candidateRecordedAt = workerEvent?.type === "worker_result_committed"
    ? workerEvent.occurredAt
    : workerFinishedAt ?? attempt.startedAt ?? run.admittedAt;
  const candidateEvidence = candidate === null ? null : makeEvidenceReference(
    "candidate",
    workerEvent?.type === "worker_result_committed" ? workerEvent.eventId : `candidate:${attempt.attemptId}`,
    candidate,
    candidate.sourceBytesHash,
    candidateRecordedAt,
  );
  const validatorEvidence = validator?.kind !== "agent" && validator?.kind !== "operator"
    ? null
    : makeEvidenceReference(
      "verdict",
      validatorEvent?.type === "validator_result_committed" ? validatorEvent.eventId : `verdict:${attempt.attemptId}`,
      validator,
      validator.resultBytesHash,
      validatorEvent?.type === "validator_result_committed" ? validatorEvent.occurredAt : attempt.finishedAt ?? candidateRecordedAt,
    );
  const acceptances = [
    ...(candidate?.source === "operator" ? [candidate.acceptance] : []),
    ...(validator?.kind === "operator" ? [validator.acceptance] : []),
  ];
  const judgments = attempt.judgments.flatMap((judgment) => judgment.status !== "decided" || judgment.decision === null || judgment.decidedAt === null
    ? []
    : [makeEvidenceReference(
        "judgment",
        judgment.applicationReceipt?.eventId ?? `judgment:${judgment.judgmentId}`,
        judgment.decision,
        null,
        judgment.decidedAt,
        judgment.decision,
      )]);
  return {
    attemptId: attempt.attemptId,
    number: attempt.number,
    status: attempt.status,
    phase: attempt.phase,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    elapsedMs: attempt.elapsedMs,
    workerExecutionId: attempt.workerExecutionId,
    validatorExecutionId: attempt.validatorExecutionId,
    candidate: candidateEvidence,
    verdict: validatorEvidence,
    judgments,
    operatorAcceptances: acceptances,
    blocks: attempt.blockIds.map((blockId) => {
      const block = blocks.get(blockId);
      if (block === undefined) throw new Error(`block evidence ${blockId} is missing`);
      return block;
    }),
    failure,
    ...(attempt.workerFailure === undefined ? {} : { workerFailure: attempt.workerFailure }),
    processes: attemptProcesses,
  };
}

// Hash the complete checked record so references remain stable across contract versions.
function makeEvidenceReference(
  kind: "candidate" | "verdict" | "judgment",
  evidenceId: string,
  payload: unknown,
  sourceBytesHash: string | null,
  recordedAt: string,
  decision?: unknown,
 ) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const evidence = {
    kind,
    evidenceId,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteCount: bytes.byteLength,
    recordedAt,
    sourceBytesHash,
    ...(decision === undefined ? {} : { decision }),
  };
  return evidence;
}

async function buildRunsPage(
  harness: Harness,
  workflowId: string,
  encodedCursor: string | undefined,
  requestedLimit: number | undefined,
): Promise<ServiceRunsPageV1> {
  const installation = await readInstallation(harness);
  const workflow = installation.workflows[workflowId];
  const refs = workflow?.runs ?? [];
  const currentHighWaterMark = workflow?.admissionHighWater ?? 0;
  const cursor = encodedCursor === undefined ? undefined : decodeRunCursor(encodedCursor, workflowId, currentHighWaterMark);
  const highWaterMark = cursor?.highWaterMark ?? currentHighWaterMark;
  const ordered = refs
    .filter((reference) => reference.admissionSequence <= highWaterMark)
    .sort(compareRunReferences);
  const total = ordered.length;
  let position = 0;
  if (cursor !== undefined) {
    const last = ordered.findIndex((reference) => reference.runId === cursor.lastRunId
      && reference.admissionSequence === cursor.lastAdmissionSequence
      && reference.admittedAt === cursor.lastAdmittedAt);
    if (last < 0 || last === ordered.length - 1) throw new Error("runs cursor ordering key is no longer present");
    position = last + 1;
  }

  const limit = requestedLimit ?? 50;
  const pageRuns: RunSummaryDto[] = [];
  let lastReference: RunReference | undefined;
  for (let index = position; index < ordered.length && pageRuns.length < limit; index += 1) {
    const reference = ordered[index]!;
    const summary = summarizeRun(await readRun(harness, reference));
    const remaining = index + 1 < ordered.length;
    const candidateCursor = remaining ? encodeRunCursor({
      version: 1,
      workflowId,
      filter: "all",
      highWaterMark,
      lastAdmittedAt: reference.admittedAt,
      lastRunId: reference.runId,
      lastAdmissionSequence: reference.admissionSequence,
    }) : null;
    const candidate = {
      version: 1,
      workflowId,
      total,
      highWaterMark,
      nextCursor: candidateCursor,
      runs: [...pageRuns, summary],
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RUN_PAGE_BYTES) {
      if (pageRuns.length === 0) throw new Error(`run summary exceeds the ${MAX_RUN_PAGE_BYTES}-byte page limit`);
      break;
    }
    pageRuns.push(summary);
    lastReference = reference;
  }
  const hasMore = lastReference !== undefined
    ? ordered.indexOf(lastReference) < ordered.length - 1
    : position < ordered.length;
  const nextCursor = hasMore && lastReference !== undefined
    ? encodeRunCursor({
        version: 1,
        workflowId,
        filter: "all",
        highWaterMark,
        lastAdmittedAt: lastReference.admittedAt,
        lastRunId: lastReference.runId,
        lastAdmissionSequence: lastReference.admissionSequence,
      })
    : null;
  return serviceRunsPageV1Schema.parse({ version: 1, workflowId, total, highWaterMark, nextCursor, runs: pageRuns });
}

async function buildLogsSectionPage(
  harness: Harness,
  workflowId: string,
  selectedRunId: string | undefined,
  encodedCursor: string | undefined,
  verbose: boolean,
): Promise<ServiceLogSectionPageV1> {
  const cursor = encodedCursor === undefined ? undefined : decodeLogsCursor(encodedCursor, workflowId);
  if (selectedRunId !== undefined && cursor !== undefined && cursor.runId !== selectedRunId) {
    throw new Error("logs cursor belongs to a different selected run");
  }

  let snapshot: LogSnapshot;
  if (cursor === undefined) {
    const installation = await readInstallation(harness);
    const workflow = installation.workflows[workflowId];
    const reference = selectedRunId === undefined
      ? workflow?.runs.slice().sort(compareRunReferences)[0]
      : workflow?.runs.find((run) => run.runId === selectedRunId);
    if (reference === undefined) {
      throw new Error(selectedRunId === undefined ? `workflow ${workflowId} has no runs` : `run ${selectedRunId} was not found`);
    }
    const evidence = await readRunEvidenceSnapshot(harness, reference, workflowId);
    snapshot = createLogSnapshot(evidence, verbose);
    rememberLogSnapshot(snapshot);
  } else {
    const storedSnapshot = logSnapshots.get(cursor.snapshotId);
    if (storedSnapshot === undefined || storedSnapshot.expiresAt <= Date.now()) {
      logSnapshots.delete(cursor.snapshotId);
      throw new Error("logs cursor expired or its in-memory snapshot is unavailable; request logs again");
    }
    snapshot = storedSnapshot;
    if (snapshot.workflowId !== workflowId || snapshot.runId !== cursor.runId || (selectedRunId !== undefined && snapshot.runId !== selectedRunId)) {
      throw new Error("logs cursor does not match its checked workflow/run identity");
    }
    logSnapshots.delete(snapshot.snapshotId);
    logSnapshots.set(snapshot.snapshotId, snapshot);
  }

  const sectionIndex = cursor?.sectionIndex ?? 0;
  const sectionOffsetBytes = cursor?.sectionOffsetBytes ?? 0;
  const section = snapshot.sections[sectionIndex];
  if (section === undefined) throw new Error("logs cursor is outside its in-memory snapshot");
  if (sectionOffsetBytes > section.contentBytes || (sectionOffsetBytes > 0 && sectionOffsetBytes === section.contentBytes)) {
    throw new Error("logs cursor offset is outside its committed section");
  }

  let content: string | null;
  if (section.kind === "worklog") {
    content = readUtf8StringChunk(section.content, sectionOffsetBytes);
  } else if (section.content === null) {
    content = null;
  } else {
    content = readUtf8StringChunk(section.content, sectionOffsetBytes);
  }
  const totalBytes = section.contentBytes;
  const offsetBytes = content === null ? 0 : sectionOffsetBytes;

  const projected = section.kind === "worklog"
    ? { kind: "worklog" as const, sectionId: section.sectionId, order: section.order, label: section.label, content: content! }
    : {
        kind: "capture" as const, sectionId: section.sectionId, order: section.order, label: section.label,
        executionId: section.executionId, incarnationNumber: section.incarnationNumber, capture: section.capture, content,
      };
  const parsedSection = logSectionDtoSchema.parse(projected);
  const chunkBytes = content === null ? 0 : Buffer.byteLength(content, "utf8");
  const complete = content === null || offsetBytes + chunkBytes === totalBytes;
  let nextCursor: string | null = null;
  if (!complete) {
    nextCursor = encodeLogsCursor({
      version: 1, workflowId, runId: snapshot.runId, snapshotId: snapshot.snapshotId, sectionIndex,
      sectionOffsetBytes: offsetBytes + chunkBytes,
    });
  } else if (sectionIndex + 1 < snapshot.sections.length) {
    nextCursor = encodeLogsCursor({
      version: 1, workflowId, runId: snapshot.runId, snapshotId: snapshot.snapshotId, sectionIndex: sectionIndex + 1,
      sectionOffsetBytes: 0,
    });
  }
  return serviceLogSectionPageV1Schema.parse({
    version: 1, runId: snapshot.runId, sectionIndex, totalSections: snapshot.sections.length, nextCursor,
    section: parsedSection, chunk: { offsetBytes, totalBytes, complete },
  });
}

function createLogSnapshot(snapshot: RunEvidenceSnapshot, verbose: boolean): LogSnapshot {
  const { run, processEvidence } = snapshot;
  const diagnostics = snapshot.events.filter((event) => event.type === "view_projection_failed")
    .map((event) => "[view] " + event.message);
  const worklog = renderWorklog(run, { verbose }) + (diagnostics.length === 0 ? "" : "\n" + diagnostics.join("\n"));
  const sections: LogSnapshotSection[] = [{
    kind: "worklog", sectionId: "worklog", order: 0, label: "worklog",
    content: worklog, contentBytes: Buffer.byteLength(worklog, "utf8"),
  }];
  for (const record of processEvidence) {
    for (const capture of record.process.captures) {
      if (capture.totalBytes === 0) continue;
      const content = readRetainedCapture(capture);
      const { retained: _retained, ...metadata } = capture;
      sections.push({
        kind: "capture",
        sectionId: `${record.process.executionId}-${record.process.incarnationId}-${capture.stream}`,
        order: sections.length,
        label: `${record.nodeId ?? "preflight"} ${record.process.role} ${capture.stream}`,
        executionId: record.process.executionId,
        incarnationNumber: record.process.incarnationNumber,
        capture: metadata,
        content,
        contentBytes: content === null ? 0 : Buffer.byteLength(content, "utf8"),
      });
    }
  }
  return {
    snapshotId: randomUUID(), workflowId: run.workflowId, runId: run.runId,
    expiresAt: Date.now() + LOG_SNAPSHOT_TTL_MS, sections,
  };
}

function rememberLogSnapshot(snapshot: LogSnapshot): void {
  const now = Date.now();
  for (const [snapshotId, current] of logSnapshots) {
    if (current.expiresAt <= now) logSnapshots.delete(snapshotId);
  }
  while (logSnapshots.size >= MAX_LOG_SNAPSHOTS) {
    const oldestId = logSnapshots.keys().next().value;
    if (oldestId === undefined) break;
    logSnapshots.delete(oldestId);
  }
  logSnapshots.set(snapshot.snapshotId, snapshot);
}

function readUtf8StringChunk(value: string, offset: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) throw new Error("logs cursor offset is outside its committed section");
  return decodeUtf8Chunk(bytes, offset);
}

function decodeUtf8Chunk(bytes: Buffer, offset: number): string {
  const maxRead = Math.min(MAX_LOG_CONTENT_CHUNK_BYTES_V1 + 4, bytes.byteLength - offset);
  const window = bytes.subarray(offset, offset + maxRead);
  const chunkBytes = utf8ChunkLength(window, bytes.byteLength - offset);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(window.subarray(0, chunkBytes));
}

function utf8ChunkLength(window: Buffer, remainingBytes: number): number {
  let chunkBytes = Math.min(MAX_LOG_CONTENT_CHUNK_BYTES_V1, remainingBytes);
  if (chunkBytes < remainingBytes) {
    while (chunkBytes > 0 && ((window[chunkBytes] ?? 0) & 0xc0) === 0x80) chunkBytes -= 1;
    if (chunkBytes === 0) throw new Error("log chunk limit cannot contain the next UTF-8 code point");
  }
  return chunkBytes;
}




function summarizeRun(run: ReadyRun): RunSummaryDto {
  const currentNode = run.currentNodeId === null ? undefined : run.nodes.find((node) => node.nodeId === run.currentNodeId);
  const currentAttempt = run.currentAttemptId === null ? undefined : currentNode?.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId);
  return runSummaryDtoSchema.parse({
    runId: run.runId,
    workflowId: run.workflowId,
    activationId: run.activationId,
    occurrenceId: run.occurrenceId,
    definitionHash: run.canonicalHash,
    status: run.status,
    desiredState: run.desiredState,
    waitingForCapacity: run.status === "queued" && run.durable.capacityGateTaskId !== null && run.durable.capacityGateTaskId !== undefined,
    admittedAt: run.admittedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    currentNodeId: run.currentNodeId,
    currentAttemptNumber: currentAttempt?.number ?? null,
    block: run.block,
    failure: run.failure,
    terminalOutput: run.terminalOutput,
  });
}

function configuredWorkflowIds(installation: Installation, indexed: Record<string, unknown>): string[] {
  const ids = new Set(Object.keys(indexed));
  try {
    for (const entry of readdirSync(installation.workflowsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const workflowId = entry.name.slice(0, -5);
      if (workflowIdSchema.safeParse(workflowId).success) ids.add(workflowId);
    }
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return [...ids].sort(compareCodeUnits);
}

function compareRunReferences(left: RunReference, right: RunReference): number {
  return compareCodeUnits(right.admittedAt, left.admittedAt) || compareCodeUnits(left.runId, right.runId);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


function decodeLogsCursor(encoded: string, workflowId: string): LogsCursor {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== encoded) throw new Error("cursor encoding is not canonical");
    const parsed = logsCursorSchema.parse(JSON.parse(json));
    if (parsed.workflowId !== workflowId) throw new Error("cursor belongs to a different workflow");
    return parsed;
  } catch (error) {
    throw new Error(`invalid logs cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeLogsCursor(cursor: LogsCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (encoded.length > 4_096) throw new Error("logs cursor exceeds its protocol bound");
  return encoded;
}
function decodeRunCursor(encoded: string, workflowId: string, currentHighWaterMark: number): RunCursorV1 {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== encoded) throw new Error("cursor encoding is not canonical");
    const parsed = runCursorV1Schema.parse(JSON.parse(json));
    if (parsed.workflowId !== workflowId || parsed.filter !== "all" || parsed.highWaterMark > currentHighWaterMark) {
      throw new Error("cursor belongs to a different workflow or admission snapshot");
    }
    return parsed;
  } catch (error) {
    throw new Error(`invalid runs cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeRunCursor(cursor: RunCursorV1): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (encoded.length > 4_096) throw new Error("runs cursor exceeds its protocol bound");
  return encoded;
}
