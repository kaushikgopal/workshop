import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, utimesSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";
import { nodeIdV2, workflowIdV2 } from "../definition/schema-v2.js";
import {
  installationDocumentV1Schema,
  type RunReferenceV2,
} from "../installation/schema-v2.js";
import { loadCheckedV2Workflow, type V2Installation } from "../installation/load-v2-installation.js";
import { runIdV2Schema } from "../run/schema-v2.js";
import { processCaptureV2Schema } from "../process/schema-v2.js";
import { workshopEventV1Schema, workshopProcessV1Schema, workflowRunDocumentV1Schema } from "../run/records-v2.js";
import type { PersistedNodeAttemptV2, PersistedNodeV2, WorkflowRunDocumentV1, WorkshopEventV1 } from "../run/records-v2.js";
import { renderV2Worklog } from "../storage/durable/render-v2-worklog.js";
import { atomicWriteFileSync } from "../storage/disk/write-crash-safe.js";
import { WorkshopEventEntry, WorkshopInstallationDoc, WorkshopProcessEntry, WorkshopRunDoc } from "../storage/durable/define-workshop-records.js";
import {
  diagramDtoV2Schema,
  nodeDescriptionDtoV2Schema,
  runSummaryDtoV2Schema,
  statusDtoV2Schema,
  type DiagramDtoV2,
  type NodeDescriptionDtoV2,
  type RunSummaryDtoV2,
  type StatusDtoV2,
  logSectionDtoV2Schema,
} from "../views/schema-v2.js";
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
const LOG_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const LOG_SNAPSHOT_DIRECTORY = ".log-snapshots";
// Eviction forces a fresh digest scan; the cache never limits section length.
const MAX_VERIFIED_LOG_FILE_CACHE_ENTRIES = 256;
type VerifiedLogFile = {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly contentHash: string;
};
const verifiedLogFiles = new Map<string, VerifiedLogFile>();
const runCursorV1Schema = z.strictObject({
  version: z.literal(1),
  workflowId: workflowIdV2,
  filter: z.literal("all"),
  highWaterMark: z.number().int().nonnegative().safe(),
  lastAdmittedAt: z.string().datetime({ offset: true }),
  lastRunId: runIdV2Schema,
  lastAdmissionSequence: z.number().int().positive().safe(),
});
type RunCursorV1 = z.infer<typeof runCursorV1Schema>;
const logsCursorV2Schema = z.strictObject({
  version: z.literal(2),
  workflowId: workflowIdV2,
  runId: runIdV2Schema,
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  sectionIndex: z.number().int().nonnegative().safe(),
  sectionOffsetBytes: z.number().int().nonnegative().safe(),
  totalSections: z.number().int().positive().safe(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  contentBytes: z.number().int().nonnegative().safe().nullable(),
  expiresAt: z.number().int().positive().safe(),
});
type LogsCursorV2 = z.infer<typeof logsCursorV2Schema>;
type ReadyInstallation = Extract<z.infer<typeof installationDocumentV1Schema>, { state: "ready" }>;
type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;
type ProcessEvidenceRecord = ReturnType<typeof workshopProcessV1Schema.parse>;
type RunEvidenceSnapshot = {
  readonly run: ReadyRun;
  readonly processEvidence: readonly ProcessEvidenceRecord[];
  readonly events: readonly WorkshopEventV1[];
  readonly asOfEntryId: number | null;
};
type LogSection = ServiceLogSectionPageV1["section"];
type LogSnapshotManifestV1 = z.infer<typeof logSnapshotManifestV1Schema>;
const logSnapshotManifestV1Schema = z.strictObject({
  version: z.literal(1),
  workflowId: workflowIdV2,
  runId: runIdV2Schema,
  sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  canonicalHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  conversationId: z.number().int().positive().safe(),
  asOfEntryId: z.number().int().positive().safe().nullable().optional(),
  sections: z.array(z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("worklog"),
      sectionId: z.literal("worklog"),
      order: z.literal(0),
      label: z.literal("WORKLOG.md"),
      contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      contentBytes: z.number().int().nonnegative().safe(),
    }),
    z.strictObject({
      kind: z.literal("capture"),
      sectionId: z.string().min(1),
      order: z.number().int().positive().safe(),
      label: z.string().min(1),
      executionId: z.string().min(1),
      incarnationNumber: z.number().int().positive().safe(),
      capture: processCaptureV2Schema,
      contentPath: z.string().min(1),
      contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
      contentBytes: z.number().int().nonnegative().safe(),
      unavailableReason: z.enum(["capture file is missing", "capture contains invalid UTF-8"]).nullable(),
    }),
  ])),
}).superRefine((manifest, context) => {
  if (manifest.sections.length === 0 || manifest.sections[0]?.kind !== "worklog") {
    context.addIssue({ code: "custom", path: ["sections", 0], message: "log snapshot starts with its worklog" });
  }
  const sectionIds = new Set<string>();
  for (const [index, section] of manifest.sections.entries()) {
    if (section.order !== index) context.addIssue({ code: "custom", path: ["sections", index, "order"], message: "log snapshot sections are contiguous and ordered" });
    if (sectionIds.has(section.sectionId)) context.addIssue({ code: "custom", path: ["sections", index, "sectionId"], message: "log snapshot section IDs are unique" });
    sectionIds.add(section.sectionId);
    if (section.kind === "capture") {
      if (section.contentHash === null && section.unavailableReason !== "capture file is missing") {
        context.addIssue({ code: "custom", path: ["sections", index, "contentHash"], message: "available captures require a content digest" });
      }
      if (section.unavailableReason === null && section.contentHash === null) {
        context.addIssue({ code: "custom", path: ["sections", index, "unavailableReason"], message: "missing capture digests require an unavailable reason" });
      }
    }
  }
});

export async function projectV2ServiceRead(
  harness: Harness,
  installation: V2Installation,
  metadata: ServiceMetadataV1,
  request: Extract<ServiceRequestV1, { method: "status" | "runs" | "logs.page" | "node.describe" | "diagram" }>,
  ): Promise<StatusDtoV2 | ServiceRunsPageV1 | ServiceLogSectionPageV1 | NodeDescriptionDtoV2 | DiagramDtoV2> {
  switch (request.method) {
    case "status": return await buildStatusDto(harness, installation, metadata, request.workflowId);
    case "runs": return await buildRunsPage(harness, request.workflowId, request.cursor, request.limit);
    case "logs.page": return await buildLogsSectionPage(harness, request.workflowId, request.runId, request.cursor);
    case "node.describe": return await buildNodeDescriptionDto(harness, installation, request.workflowId, request.nodeId, request.runId);
    case "diagram": return await buildDiagramDto(harness, installation, request.workflowId, request.runId);
  }
}


export async function readInstallation(harness: Harness): Promise<ReadyInstallation> {
  const parsed = installationDocumentV1Schema.safeParse(await harness.snapshot(WorkshopInstallationDoc, BACKGROUND_CONTEXT));
  if (!parsed.success || parsed.data.state !== "ready") throw new Error("Durable installation document is not initialized");
  return parsed.data;
}

export async function readRun(harness: Harness, reference: RunReferenceV2): Promise<ReadyRun> {
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
  installation: V2Installation,
  metadata: ServiceMetadataV1,
  selectedWorkflowId: string | undefined,
): Promise<StatusDtoV2> {
  const index = await readInstallation(harness);
  const workflowIds = configuredWorkflowIds(installation, index.workflows);
  if (selectedWorkflowId !== undefined && !workflowIds.includes(selectedWorkflowId)) {
    throw new Error(`workflow ${JSON.stringify(selectedWorkflowId)} is not configured`);
  }
  const selected = selectedWorkflowId === undefined ? workflowIds : [selectedWorkflowId];
  const workflows = [];
  for (const workflowId of selected) {
    const workflowIndex = index.workflows[workflowId];
    let checked: ReturnType<typeof loadCheckedV2Workflow> | undefined;
    let configurationError: string | null = null;
    try {
      checked = loadCheckedV2Workflow(installation, workflowId);
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error);
    }
    const latestActivation = workflowIndex?.activations.at(-1);
    if (configurationError === null && latestActivation?.admissionError !== null && latestActivation?.admissionError !== undefined) {
      configurationError = latestActivation.admissionError;
    }
    let unresolvedRun: RunSummaryDtoV2 | null = null;
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
  return statusDtoV2Schema.parse({
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
  installation: V2Installation,
  workflowId: string,
  nodeId: string,
  selectedRunId: string | undefined,
 ): Promise<NodeDescriptionDtoV2> {
  const index = await readInstallation(harness);
  const workflow = index.workflows[workflowId];
  const reference = selectedRunId === undefined
    ? workflow?.runs.slice().sort(compareRunReferences)[0]
    : workflow?.runs.find((run) => run.runId === selectedRunId);
  if (reference === undefined) {
    if (selectedRunId !== undefined) throw new Error(`run ${selectedRunId} was not found`);
    const checked = loadCheckedV2Workflow(installation, workflowId);
    const position = checked.chain.order.indexOf(nodeId);
    if (position < 0) throw new Error(`node ${nodeId} is not configured in workflow ${workflowId}`);
    const resolvedSettings = checked.resolvedSettings.nodes[nodeId];
    if (resolvedSettings === undefined) throw new Error(`resolved settings for node ${nodeId} are unavailable`);
    return nodeDescriptionDtoV2Schema.parse({
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
  if (position < 0) throw new Error(`node ${nodeId} is not part of run ${run.runId}`);
  const persistedNode = run.nodes[position];
  if (persistedNode === undefined || persistedNode.nodeId !== nodeId) throw new Error(`node ${nodeId} is absent from run ${run.runId}`);
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
  return nodeDescriptionDtoV2Schema.parse({
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
  installation: V2Installation,
  workflowId: string,
  selectedRunId: string | undefined,
): Promise<DiagramDtoV2> {
  const index = await readInstallation(harness);
  const workflow = index.workflows[workflowId];
  const reference = selectedRunId === undefined
    ? workflow?.runs.slice().sort(compareRunReferences)[0]
    : workflow?.runs.find((run) => run.runId === selectedRunId);
  if (reference === undefined) {
    if (selectedRunId !== undefined) throw new Error(`run ${selectedRunId} was not found`);
    const checked = loadCheckedV2Workflow(installation, workflowId);
    return diagramDtoV2Schema.parse({
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
  return diagramDtoV2Schema.parse({
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


async function readRunEvidenceSnapshot(
  harness: Harness,
  reference: RunReferenceV2,
  workflowId: string,
): Promise<RunEvidenceSnapshot> {
  // SAFETY: the installation document schema checks this as a positive safe Durable conversation ID.
  const conversationId = reference.conversationId as ConversationId;
  // Pin the run document and newest-first entry high-water to one Durable state.
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
    let asOfEntryId: number | null = null;
    let firstPage = true;
    do {
      const page = await tx.scanEntries({ conversationId }, 256, cursor);
      if (firstPage) {
        asOfEntryId = page.items[0]?.id ?? null;
        firstPage = false;
      }
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
    return { run, processEvidence, events, asOfEntryId };
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
  node: PersistedNodeV2,
  attempt: PersistedNodeAttemptV2,
  processEvidence: readonly ProcessEvidenceRecord[],
  events: readonly WorkshopEventV1[],
 ) {
  const result = attempt.result;
  const candidate = result.kind === "candidate_committed" || result.kind === "validation_committed"
    ? result.candidate
    : result.kind === "settled"
      ? result.outcome.kind === "cancelled" ? result.outcome.candidate ?? null : result.outcome.candidate
      : null;
  const validator = result.kind === "validation_committed"
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
    processes: attemptProcesses,
  };
}

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
  const pageRuns: RunSummaryDtoV2[] = [];
  let lastReference: RunReferenceV2 | undefined;
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
): Promise<ServiceLogSectionPageV1> {
  const cursor = encodedCursor === undefined ? undefined : decodeLogsCursor(encodedCursor, workflowId);
  if (selectedRunId !== undefined && cursor !== undefined && cursor.runId !== selectedRunId) {
    throw new Error("logs cursor belongs to a different selected run");
  }
  const installation = await readInstallation(harness);
  const workflow = installation.workflows[workflowId];
  const runId = selectedRunId ?? cursor?.runId;
  const reference = runId === undefined
    ? workflow?.runs.slice().sort(compareRunReferences)[0]
    : workflow?.runs.find((run) => run.runId === runId);
  if (reference === undefined) throw new Error(runId === undefined ? `workflow ${workflowId} has no runs` : `run ${runId} was not found`);
  let evidenceSnapshot: RunEvidenceSnapshot | undefined;
  const run = cursor === undefined
    ? (evidenceSnapshot = await readRunEvidenceSnapshot(harness, reference, workflowId)).run
    : await readRun(harness, reference);
  if (run.workflowId !== workflowId || (cursor !== undefined && cursor.runId !== run.runId)) {
    throw new Error("logs cursor does not match its checked workflow/run identity");
  }
  let manifest: LogSnapshotManifestV1;
  let manifestHash: string;
  let expiresAt: number;
  if (cursor === undefined) {
    if (evidenceSnapshot === undefined) throw new Error("new log snapshots require a Durable evidence boundary");
    const snapshot = createLogSnapshotManifest(evidenceSnapshot);
    manifest = snapshot.manifest;
    manifestHash = snapshot.manifestHash;
    expiresAt = Date.now() + LOG_SNAPSHOT_TTL_MS;
  } else {
    const now = Date.now();
    if (cursor.expiresAt < now) throw new Error("logs snapshot continuation expired; request logs again");
    if (cursor.expiresAt > now + LOG_SNAPSHOT_TTL_MS + 5_000) throw new Error("logs cursor expiry exceeds its snapshot lifetime");
    manifestHash = cursor.manifestHash;
    expiresAt = cursor.expiresAt;
    manifest = readLogSnapshotManifest(run.paths.captureDirectory, manifestHash, workflowId, run.runId, run.sourceHash, run.canonicalHash, run.durable.conversationId);
    if (manifest.sections.length !== cursor.totalSections) throw new Error("logs cursor section count does not match its frozen manifest");
  }
  const sectionIndex = cursor?.sectionIndex ?? 0;
  const sectionOffsetBytes = cursor?.sectionOffsetBytes ?? 0;
  const section = manifest.sections[sectionIndex];
  if (section === undefined) throw new Error("logs cursor section is outside its frozen manifest");
  if (cursor !== undefined) {
    if (cursor.contentHash !== section.contentHash || cursor.contentBytes !== section.contentBytes) {
      throw new Error("logs cursor content reference does not match its frozen section");
    }
    if (sectionOffsetBytes > section.contentBytes
      || (sectionOffsetBytes > 0 && sectionOffsetBytes === section.contentBytes)) {
      throw new Error("logs cursor offset is outside its frozen section");
    }
  }
  let projected: unknown;
  let chunkText: string | null;
  let totalBytes: number;
  let offsetBytes: number;
  if (section.kind === "worklog") {
    const snapshotPath = worklogSnapshotPath(run.paths.captureDirectory, section.contentHash);
    chunkText = readVerifiedUtf8Chunk(snapshotPath, section.contentBytes, section.contentHash, sectionOffsetBytes);
    totalBytes = section.contentBytes;
    offsetBytes = sectionOffsetBytes;
    projected = { kind: "worklog", sectionId: section.sectionId, order: section.order, label: section.label, content: chunkText, omittedBytes: 0 };
  } else if (section.unavailableReason !== null) {
    chunkText = null;
    totalBytes = 0;
    offsetBytes = 0;
    projected = {
      kind: "capture", sectionId: section.sectionId, order: section.order, label: section.label,
      executionId: section.executionId, incarnationNumber: section.incarnationNumber, capture: section.capture,
      content: null, unavailableReason: section.unavailableReason, omittedBytes: 0,
    };
  } else {
    const absolute = resolveCapturePath(run.paths.captureDirectory, section.contentPath);
    chunkText = readVerifiedUtf8Chunk(absolute, section.contentBytes, section.contentHash!, sectionOffsetBytes);
    totalBytes = section.contentBytes;
    offsetBytes = sectionOffsetBytes;
    projected = {
      kind: "capture", sectionId: section.sectionId, order: section.order, label: section.label,
      executionId: section.executionId, incarnationNumber: section.incarnationNumber, capture: section.capture,
      content: chunkText, unavailableReason: null, omittedBytes: 0,
    };
  }
  const parsedSection = logSectionDtoV2Schema.parse(projected);
  const chunkBytes = chunkText === null ? 0 : Buffer.byteLength(chunkText, "utf8");
  const complete = chunkText === null || offsetBytes + chunkBytes === totalBytes;
  let nextCursor: string | null = null;
  if (!complete) {
    nextCursor = encodeLogsCursor({
      version: 2, workflowId, runId: run.runId, manifestHash, sectionIndex,
      sectionOffsetBytes: offsetBytes + chunkBytes, totalSections: manifest.sections.length,
      contentHash: section.contentHash, contentBytes: section.contentBytes, expiresAt,
    });
  } else if (sectionIndex + 1 < manifest.sections.length) {
    const nextSection = manifest.sections[sectionIndex + 1];
    if (nextSection === undefined) throw new Error("next log section is outside its frozen manifest");
    nextCursor = encodeLogsCursor({
      version: 2, workflowId, runId: run.runId, manifestHash, sectionIndex: sectionIndex + 1,
      sectionOffsetBytes: 0, totalSections: manifest.sections.length,
      contentHash: nextSection.contentHash, contentBytes: nextSection.contentBytes, expiresAt,
    });
  }
  return serviceLogSectionPageV1Schema.parse({
    version: 1, runId: run.runId, sectionIndex, totalSections: manifest.sections.length, nextCursor,
    section: parsedSection, chunk: { offsetBytes, totalBytes, complete },
    projection: { truncated: false, omittedSections: 0, omittedBytes: 0 },
  });
}

function createLogSnapshotManifest(
  snapshot: RunEvidenceSnapshot,
): { manifest: LogSnapshotManifestV1; manifestHash: string } {
  const { run, processEvidence, asOfEntryId } = snapshot;
  const root = run.paths.captureDirectory;
  const snapshotsDirectory = logSnapshotsDirectory(root);
  mkdirSync(snapshotsDirectory, { recursive: true });
  pruneLogSnapshots(snapshotsDirectory, Date.now());
  const worklog = readWorklog(run);
  const worklogBytes = Buffer.byteLength(worklog, "utf8");
  const worklogHash = `sha256:${createHash("sha256").update(worklog, "utf8").digest("hex")}`;
  ensureLogSnapshotTextFile(worklogSnapshotPath(root, worklogHash), worklog, worklogHash, worklogBytes);
  const sections: LogSnapshotManifestV1["sections"][number][] = [{
    kind: "worklog", sectionId: "worklog", order: 0, label: "WORKLOG.md",
    contentHash: worklogHash, contentBytes: worklogBytes,
  }];
  for (const record of processEvidence) {
    for (const capture of record.process.captures) {
      const absolute = resolveCaptureAbsolutePath(root, capture.path);
      const contentPath = relative(resolve(root), absolute);
      let contentHash: string | null = null;
      let contentBytes = 0;
      let unavailableReason: "capture file is missing" | "capture contains invalid UTF-8" | null = null;
      try {
        const inspected = inspectUtf8File(absolute, capture.retainedBytes);
        if (capture.sha256 !== null && inspected.contentHash !== capture.sha256) {
          throw new Error("process capture digest does not match its committed metadata");
        }
        contentHash = inspected.contentHash;
        if (inspected.validUtf8) contentBytes = capture.retainedBytes;
        else unavailableReason = "capture contains invalid UTF-8";
      } catch (error) {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
        if (capture.retainedBytes === 0) contentHash = `sha256:${createHash("sha256").digest("hex")}`;
        else unavailableReason = "capture file is missing";
      }
      sections.push({
        kind: "capture",
        sectionId: `${record.process.executionId}-${record.process.incarnationId}-${capture.stream}`,
        order: sections.length,
        label: `${record.nodeId ?? "preflight"} ${record.process.role} ${capture.stream}`,
        executionId: record.process.executionId,
        incarnationNumber: record.process.incarnationNumber,
        capture, contentPath, contentHash, contentBytes, unavailableReason,
      });
    }
  }
  const manifest = logSnapshotManifestV1Schema.parse({
    version: 1, workflowId: run.workflowId, runId: run.runId,
    sourceHash: run.sourceHash, canonicalHash: run.canonicalHash,
    conversationId: run.durable.conversationId, asOfEntryId, sections,
  });
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = createHash("sha256").update(manifestJson, "utf8").digest("hex");
  ensureLogSnapshotTextFile(logManifestPath(root, manifestHash), manifestJson, `sha256:${manifestHash}`, Buffer.byteLength(manifestJson, "utf8"));
  return { manifest, manifestHash };
}

function readLogSnapshotManifest(
  captureDirectory: string, manifestHash: string, workflowId: string, runId: string,
  sourceHash: string, canonicalHash: string, conversationId: number,
): LogSnapshotManifestV1 {
  const path = logManifestPath(captureDirectory, manifestHash);
  const fd = openRegularFile(path);
  let bytes: Buffer;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== `sha256:${manifestHash}`) {
    throw new Error("logs snapshot manifest digest does not match its cursor");
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("logs snapshot manifest is not valid JSON"); }
  const manifest = logSnapshotManifestV1Schema.parse(value);
  if (manifest.workflowId !== workflowId || manifest.runId !== runId || manifest.conversationId !== conversationId
    || manifest.sourceHash !== sourceHash || manifest.canonicalHash !== canonicalHash) {
    throw new Error("logs snapshot manifest belongs to a different checked workflow source or run");
  }
  return manifest;
}

function logSnapshotsDirectory(captureDirectory: string): string {
  return join(resolve(captureDirectory), LOG_SNAPSHOT_DIRECTORY);
}

function worklogSnapshotPath(captureDirectory: string, contentHash: string): string {
  const digest = contentHash.slice("sha256:".length);
  return join(logSnapshotsDirectory(captureDirectory), `worklog-${digest}.utf8`);
}

function logManifestPath(captureDirectory: string, manifestHash: string): string {
  return join(logSnapshotsDirectory(captureDirectory), `manifest-${manifestHash}.json`);
}

function resolveCaptureAbsolutePath(captureDirectory: string, capturePath: string): string {
  const absolute = resolve(capturePath);
  const root = resolve(captureDirectory);
  const pathFromRoot = relative(root, absolute);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "" || resolve(root, pathFromRoot) !== absolute) {
    throw new Error("process capture path escapes its run capture directory");
  }
  return absolute;
}

function resolveCapturePath(captureDirectory: string, contentPath: string): string {
  const root = resolve(captureDirectory);
  const absolute = resolve(root, contentPath);
  const pathFromRoot = relative(root, absolute);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "" || resolve(root, pathFromRoot) !== absolute) {
    throw new Error("logs snapshot capture reference escapes its run capture directory");
  }
  return absolute;
}

function ensureLogSnapshotTextFile(path: string, content: string, expectedHash: string, expectedBytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const existing = hashRegularFile(path);
    if (existing.size === expectedBytes && `sha256:${existing.hash}` === expectedHash) {
      const now = new Date();
      utimesSync(path, now, now);
      return;
    }
  } catch { /* replace missing, malformed, or tampered derived snapshots */ }
  atomicWriteFileSync(path, content);
}

function pruneLogSnapshots(directory: string, nowMs: number): void {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (isNodeErrorCode(error, "ENOENT")) return; throw error; }
  const cutoff = nowMs - LOG_SNAPSHOT_TTL_MS;
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.startsWith("manifest-") && !entry.name.startsWith("worklog-"))) continue;
    const path = join(directory, entry.name);
    if (lstatSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
  }
}

function hashRegularFile(path: string): { size: number; hash: string } {
  const fd = openRegularFile(path);
  try {
    const before = fstatSync(fd);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - offset));
      const count = readSync(fd, buffer, 0, buffer.byteLength, offset);
      if (count === 0) throw new Error("log snapshot file changed while hashing");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    assertFileUnchanged(fd, before);
    return { size: offset, hash: hash.digest("hex") };
  } finally { closeSync(fd); }
}

function inspectUtf8File(path: string, expectedBytes: number): { contentHash: string; validUtf8: boolean } {
  const fd = openRegularFile(path);
  try {
    const before = fstatSync(fd);
    if (before.size !== expectedBytes) throw new Error("process capture size does not match its committed metadata");
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let validUtf8 = true;
    let offset = 0;
    while (offset < before.size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - offset));
      const count = readSync(fd, buffer, 0, buffer.byteLength, offset);
      if (count === 0) throw new Error("process capture changed while reading");
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      if (validUtf8) { try { decoder.decode(chunk, { stream: true }); } catch { validUtf8 = false; } }
      offset += count;
    }
    if (validUtf8) { try { decoder.decode(); } catch { validUtf8 = false; } }
    assertFileUnchanged(fd, before);
    const contentHash = `sha256:${hash.digest("hex")}`;
    if (validUtf8) rememberVerifiedLogFile(path, before, contentHash);
    return { contentHash, validUtf8 };
  } finally { closeSync(fd); }
}

function readVerifiedUtf8Chunk(path: string, expectedBytes: number, expectedHash: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > expectedBytes) throw new Error("logs cursor offset is outside its verified content");
  if (expectedBytes === 0) return "";
  const fd = openRegularFile(path);
  try {
    const before = fstatSync(fd);
    if (before.size !== expectedBytes) throw new Error("logs snapshot content size changed");
    const cached = verifiedLogFiles.get(path);
    if (cached !== undefined && matchesVerifiedLogFile(cached, before)) {
      if (cached.contentHash !== expectedHash) throw new Error("logs snapshot content digest does not match its frozen reference");
      verifiedLogFiles.delete(path);
      verifiedLogFiles.set(path, cached);
    } else {
      const hash = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let validUtf8 = true;
      let position = 0;
      while (position < before.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - position));
        const count = readSync(fd, buffer, 0, buffer.byteLength, position);
        if (count === 0) throw new Error("logs snapshot content changed while verifying");
        const bytes = buffer.subarray(0, count);
        hash.update(bytes);
        if (validUtf8) { try { decoder.decode(bytes, { stream: true }); } catch { validUtf8 = false; } }
        position += count;
      }
      if (validUtf8) { try { decoder.decode(); } catch { validUtf8 = false; } }
      assertFileUnchanged(fd, before);
      const actualHash = `sha256:${hash.digest("hex")}`;
      if (actualHash !== expectedHash) throw new Error("logs snapshot content digest changed");
      if (!validUtf8) throw new Error("logs snapshot content is no longer valid UTF-8");
      rememberVerifiedLogFile(path, before, actualHash);
    }
    const maxRead = Math.min(MAX_LOG_CONTENT_CHUNK_BYTES_V1 + 4, expectedBytes - offset);
    const window = Buffer.allocUnsafe(maxRead);
    let windowBytes = 0;
    while (windowBytes < maxRead) {
      const count = readSync(fd, window, windowBytes, maxRead - windowBytes, offset + windowBytes);
      if (count === 0) throw new Error("logs snapshot ended inside a UTF-8 chunk");
      windowBytes += count;
    }
    assertFileUnchanged(fd, before);
    let chunkBytes = Math.min(MAX_LOG_CONTENT_CHUNK_BYTES_V1, expectedBytes - offset);
    if (offset + chunkBytes < expectedBytes) {
      while (chunkBytes > 0 && ((window[chunkBytes] ?? 0) & 0xc0) === 0x80) chunkBytes -= 1;
      if (chunkBytes === 0) throw new Error("log chunk limit cannot contain the next UTF-8 code point");
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(window.subarray(0, chunkBytes));
    if (Buffer.byteLength(text, "utf8") !== chunkBytes) throw new Error("log chunk boundary does not match its UTF-8 byte range");
    return text;
  } finally { closeSync(fd); }
}

function rememberVerifiedLogFile(path: string, stat: Stats, contentHash: string): void {
  const current = verifiedLogFiles.get(path);
  if (current === undefined && verifiedLogFiles.size >= MAX_VERIFIED_LOG_FILE_CACHE_ENTRIES) {
    const oldestPath = verifiedLogFiles.keys().next().value;
    if (oldestPath !== undefined) verifiedLogFiles.delete(oldestPath);
  }
  verifiedLogFiles.delete(path);
  verifiedLogFiles.set(path, {
    device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, contentHash,
  });
}

function matchesVerifiedLogFile(cached: VerifiedLogFile, stat: Stats): boolean {
  return cached.device === stat.dev && cached.inode === stat.ino && cached.size === stat.size
    && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs;
}

function openRegularFile(path: string): number {
  const linkStat = lstatSync(path);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error("log snapshot reference is not a regular file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("log snapshot reference is not a regular file");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertFileUnchanged(fd: number, before: ReturnType<typeof fstatSync>): void {
  const after = fstatSync(fd);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("log snapshot file changed while reading");
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}


function readWorklog(run: ReadyRun): string {
  return renderV2Worklog(run);
}

function summarizeRun(run: ReadyRun): RunSummaryDtoV2 {
  const currentNode = run.currentNodeId === null ? undefined : run.nodes.find((node) => node.nodeId === run.currentNodeId);
  const currentAttempt = run.currentAttemptId === null ? undefined : currentNode?.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId);
  return runSummaryDtoV2Schema.parse({
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

function configuredWorkflowIds(installation: V2Installation, indexed: Record<string, unknown>): string[] {
  const ids = new Set(Object.keys(indexed));
  try {
    for (const entry of readdirSync(installation.workflowsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const workflowId = entry.name.slice(0, -5);
      if (workflowIdV2.safeParse(workflowId).success) ids.add(workflowId);
    }
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return [...ids].sort(compareCodeUnits);
}

function compareRunReferences(left: RunReferenceV2, right: RunReferenceV2): number {
  return compareCodeUnits(right.admittedAt, left.admittedAt) || compareCodeUnits(left.runId, right.runId);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


function decodeLogsCursor(encoded: string, workflowId: string): LogsCursorV2 {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== encoded) throw new Error("cursor encoding is not canonical");
    const parsed = logsCursorV2Schema.parse(JSON.parse(json));
    if (parsed.workflowId !== workflowId) throw new Error("cursor belongs to a different workflow");
    return parsed;
  } catch (error) {
    throw new Error(`invalid logs cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeLogsCursor(cursor: LogsCursorV2): string {
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
