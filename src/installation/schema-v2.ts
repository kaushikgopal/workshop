import { z } from "zod";
import {
  activationIdV2Schema,
  occurrenceIdV2Schema,
  runIdV2Schema,
  runStatusV2Schema,
} from "../run/schema-v2.js";
import { workflowIdV2 } from "../definition/schema-v2.js";
import { sha256V2Schema, utcTimestampV2Schema } from "../util/schema-v2.js";

const nonnegativeSafeIntegerV2 = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positiveSafeIntegerV2 = z.number().int().positive().refine(Number.isSafeInteger);
const unresolvedRunStatusesV2 = new Set(["queued", "running", "paused", "blocked"]);

export const activationIndexV2Schema = z.strictObject({
  activationId: activationIdV2Schema,
  state: z.enum(["active", "paused", "stopped", "exhausted"]),
  admittedCount: nonnegativeSafeIntegerV2,
  maxRuns: z.union([positiveSafeIntegerV2, z.literal("unlimited")]),
  activatedAt: utcTimestampV2Schema,
  nextDueAt: utcTimestampV2Schema.nullable(),
  scheduleEveryMs: positiveSafeIntegerV2.nullable().default(null),
  schedulerTaskId: positiveSafeIntegerV2.nullable().default(null),
  skippedSlots: nonnegativeSafeIntegerV2.default(0),
  admissionError: z.string().max(4 * 1024).nullable().default(null),
  lastSkippedSlotAt: utcTimestampV2Schema.nullable().default(null),
}).superRefine((activation, context) => {
  if (activation.maxRuns !== "unlimited" && activation.admittedCount > activation.maxRuns) {
    context.addIssue({ code: "custom", path: ["admittedCount"], message: "admitted count cannot exceed max runs" });
  }
  if (activation.scheduleEveryMs === null && activation.nextDueAt !== null) {
    context.addIssue({ code: "custom", path: ["nextDueAt"], message: "one-shot activations cannot have a due schedule deadline" });
  }
  if (activation.state === "active" && activation.scheduleEveryMs !== null && activation.nextDueAt === null) {
    context.addIssue({ code: "custom", path: ["nextDueAt"], message: "active recurring activations require a persisted due deadline" });
  }
  if ((activation.skippedSlots === 0) !== (activation.lastSkippedSlotAt === null)) {
    context.addIssue({ code: "custom", path: ["lastSkippedSlotAt"], message: "last skipped slot is present exactly when slots were skipped" });
  }
  const limitReached = activation.maxRuns !== "unlimited" && activation.admittedCount === activation.maxRuns;
  if ((activation.state === "exhausted") !== limitReached && activation.state !== "stopped") {
    context.addIssue({ code: "custom", path: ["state"], message: "exhausted state matches an admitted finite run limit" });
  }
});

export const runReferenceV2Schema = z.strictObject({
  runId: runIdV2Schema,
  activationId: activationIdV2Schema,
  occurrenceId: occurrenceIdV2Schema,
  conversationId: positiveSafeIntegerV2,
  workflowTaskId: positiveSafeIntegerV2,
  admissionSequence: positiveSafeIntegerV2,
  admittedAt: utcTimestampV2Schema,
  status: runStatusV2Schema,
  requestId: z.string().min(1).nullable(),
});

export const preflightCacheEntryV2Schema = z.strictObject({
  cacheKeyHash: sha256V2Schema,
  sourceRunId: runIdV2Schema,
  passedAt: utcTimestampV2Schema,
});

export const workflowInstallationIndexV2Schema = z.strictObject({
  definitionHash: sha256V2Schema.nullable(),
  admissionHighWater: nonnegativeSafeIntegerV2,
  openRunId: runIdV2Schema.nullable(),
  activations: z.array(activationIndexV2Schema),
  occurrenceCounters: z.record(activationIdV2Schema, nonnegativeSafeIntegerV2),
  runs: z.array(runReferenceV2Schema),
  requestIndex: z.record(z.string().min(1), runIdV2Schema),
  capacityReservations: z.array(runIdV2Schema),
  preflightCache: z.record(sha256V2Schema, preflightCacheEntryV2Schema),
}).superRefine((workflow, context) => {
  const runIds = new Set<string>();
  const sequences = new Set<number>();
  const activations = new Map<string, z.infer<typeof activationIndexV2Schema>>();
  for (const [index, activation] of workflow.activations.entries()) {
    if (activations.has(activation.activationId)) {
      context.addIssue({ code: "custom", path: ["activations", index, "activationId"], message: "activation IDs are unique within a workflow" });
    }
    activations.set(activation.activationId, activation);
  }
  const runCounts = new Map<string, number>();
  const occurrenceIds = new Map<string, Set<string>>();
  let unresolvedRun: z.infer<typeof runReferenceV2Schema> | undefined;

  for (const [index, run] of workflow.runs.entries()) {
    if (runIds.has(run.runId)) {
      context.addIssue({ code: "custom", path: ["runs", index, "runId"], message: "run references must be unique" });
    }
    runIds.add(run.runId);
    if (run.admissionSequence > workflow.admissionHighWater || sequences.has(run.admissionSequence)) {
      context.addIssue({ code: "custom", path: ["runs", index, "admissionSequence"], message: "admission sequence is unique and no greater than its high-water mark" });
    }
    sequences.add(run.admissionSequence);
    if (!activations.has(run.activationId)) {
      context.addIssue({ code: "custom", path: ["runs", index, "activationId"], message: "run references a known activation" });
    }
    runCounts.set(run.activationId, (runCounts.get(run.activationId) ?? 0) + 1);
    const activationOccurrences = occurrenceIds.get(run.activationId) ?? new Set<string>();
    if (activationOccurrences.has(run.occurrenceId)) {
      context.addIssue({ code: "custom", path: ["runs", index, "occurrenceId"], message: "occurrence IDs are unique within an activation" });
    }
    activationOccurrences.add(run.occurrenceId);
    occurrenceIds.set(run.activationId, activationOccurrences);
    if (unresolvedRunStatusesV2.has(run.status)) {
      if (unresolvedRun !== undefined) {
        context.addIssue({ code: "custom", path: ["runs", index, "status"], message: "a workflow has at most one unresolved run" });
      }
      unresolvedRun = run;
    }
    if (run.requestId !== null && workflow.requestIndex[run.requestId] !== run.runId) {
      context.addIssue({ code: "custom", path: ["runs", index, "requestId"], message: "request identity points to its admitted run" });
    }
  }

  if (workflow.openRunId !== (unresolvedRun?.runId ?? null)) {
    context.addIssue({ code: "custom", path: ["openRunId"], message: "open-run pointer matches the sole unresolved run" });
  }
  for (const activation of workflow.activations) {
    if ((runCounts.get(activation.activationId) ?? 0) !== activation.admittedCount) {
      context.addIssue({ code: "custom", path: ["activations", activation.activationId], message: "admitted count matches retained occurrence history" });
    }
  }
  for (const [requestId, runId] of Object.entries(workflow.requestIndex)) {
    const run = workflow.runs.find((candidate) => candidate.runId === runId);
    if (run === undefined || run.requestId !== requestId) {
      context.addIssue({ code: "custom", path: ["requestIndex", requestId], message: "request index points to matching retained run history" });
    }
  }

  const reservations = new Set<string>();
  for (const [index, runId] of workflow.capacityReservations.entries()) {
    const run = workflow.runs.find((candidate) => candidate.runId === runId);
    if (reservations.has(runId) || run === undefined || !["queued", "running", "blocked"].includes(run.status)) {
      context.addIssue({ code: "custom", path: ["capacityReservations", index], message: "capacity reservations uniquely reference queued, running, or unconfirmed blocked runs" });
    }
    reservations.add(runId);
  }

  for (const [activationId, count] of Object.entries(workflow.occurrenceCounters)) {
    const activation = activations.get(activationId);
    if (activation === undefined || count !== activation.admittedCount) {
      context.addIssue({ code: "custom", path: ["occurrenceCounters", activationId], message: "occurrence counter matches a retained activation" });
    }
  }

  for (const [key, entry] of Object.entries(workflow.preflightCache)) {
    if (key !== entry.cacheKeyHash || !runIds.has(entry.sourceRunId)) {
      context.addIssue({ code: "custom", path: ["preflightCache", key], message: "preflight cache key and source run match retained evidence" });
    }
  }
});

export const installationDocumentV1Schema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("uninitialized") }),
  z.strictObject({
    state: z.literal("ready"),
    installationId: z.string().min(1),
    maxConcurrentRuns: positiveSafeIntegerV2,
    workflows: z.record(workflowIdV2, workflowInstallationIndexV2Schema),
  }),
]);

export const serviceMutationReceiptV1Schema = z.strictObject({
  requestId: z.string().min(1).max(128).refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
  method: z.enum(["start", "pause", "resume", "stop", "resolve"]),
  requestHash: sha256V2Schema,
  retention: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("service") }),
    z.strictObject({ kind: z.literal("run"), runId: runIdV2Schema }),
  ]),
  committedAt: utcTimestampV2Schema,
  response: z.json(),
});

export const serviceMutationReceiptsDocumentV1Schema = z.strictObject({
  state: z.literal("ready"),
  receipts: z.array(serviceMutationReceiptV1Schema),
}).superRefine((document, context) => {
  const requestIds = new Set<string>();
  let serviceReceiptCount = 0;
  for (const [index, receipt] of document.receipts.entries()) {
    if (requestIds.has(receipt.requestId)) {
      context.addIssue({ code: "custom", path: ["receipts", index, "requestId"], message: "request IDs are unique" });
    }
    requestIds.add(receipt.requestId);
    if (receipt.retention.kind === "service") serviceReceiptCount += 1;
  }
  if (serviceReceiptCount > 1_000) {
    context.addIssue({ code: "custom", path: ["receipts"], message: "service-only receipts retain at most the latest 1,000" });
  }
});

export type ServiceMutationReceiptV1 = z.infer<typeof serviceMutationReceiptV1Schema>;
export type ServiceMutationReceiptsDocumentV1 = z.infer<typeof serviceMutationReceiptsDocumentV1Schema>;
export type ActivationIndexV2 = z.infer<typeof activationIndexV2Schema>;
export type RunReferenceV2 = z.infer<typeof runReferenceV2Schema>;
export type PreflightCacheEntryV2 = z.infer<typeof preflightCacheEntryV2Schema>;
export type WorkflowInstallationIndexV2 = z.infer<typeof workflowInstallationIndexV2Schema>;
export type InstallationDocumentV1 = z.infer<typeof installationDocumentV1Schema>;
