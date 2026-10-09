import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationId, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { workflowIdV2 } from "../../definition/schema-v2.js";
import { installationDocumentV1Schema } from "../../installation/schema-v2.js";
import { runIdV2Schema } from "../../run/schema-v2.js";
import {
  workflowRunDocumentV1Schema,
  workshopEventV1Schema,
  type WorkflowRunDocumentV1,
} from "../../run/records-v2.js";
import { WorkshopEventEntry, WorkshopInstallationDoc, WorkshopRunDoc } from "./define-workshop-records.js";
import { utcTimestampV2Schema } from "../../util/schema-v2.js";

const positive = z.number().int().positive().refine(Number.isSafeInteger);

export const capacityGateTaskInputV2Schema = z.strictObject({
  runId: runIdV2Schema,
  workflowId: workflowIdV2,
  activationId: z.string().min(1),
  occurrenceId: z.string().min(1),
  workflowTaskId: positive,
});
export type CapacityGateTaskInputV2 = z.infer<typeof capacityGateTaskInputV2Schema>;

export function createCapacityGateTaskInputV2(input: CapacityGateTaskInputV2): CapacityGateTaskInputV2 {
  return capacityGateTaskInputV2Schema.parse(input);
}

const capacityGateCheckpointSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("acquire") }),
  z.strictObject({ phase: z.literal("wait"), wakeAt: utcTimestampV2Schema }),
]);
export type CapacityGateCheckpoint = z.infer<typeof capacityGateCheckpointSchema>;

export const capacityGateOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("acquired") }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);
export type CapacityGateOutcome = z.infer<typeof capacityGateOutcomeSchema>;

export type CapacityGateTaskV2 = Task<CapacityGateTaskInputV2, CapacityGateCheckpoint, CapacityGateOutcome, object>;
type CapacityGateRuntime = TaskRuntime<CapacityGateTaskInputV2, CapacityGateCheckpoint, CapacityGateOutcome, object>;
type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;

export function defineCapacityGateTask(
  refreshViews: (runtime: CapacityGateRuntime, context: Context) => Promise<unknown>,
): CapacityGateTaskV2 {
  return defineTask<CapacityGateTaskInputV2, CapacityGateCheckpoint, CapacityGateOutcome>({
    name: "workshop.capacity-gate",
    version: 1,
    initial: () => ({ phase: "acquire" }),
    phases: {
      acquire: async (task, runtime, context) => {
        const input = parseCapacityGateInput(task.input);
        await runtime.commit(async (tx) => {
          const { draft, run } = await runDraft(tx, runtime.conversationId);
          assertCapacityGateIdentity(input, run, Number(runtime.taskId));
          if (run.durable.capacityGateTaskId !== Number(runtime.taskId) || run.desiredState === "stopped") {
            return { status: "terminal", outcome: { status: "completed", result: { kind: "cancelled" } } };
          }
          if (run.desiredState === "paused" || run.status === "paused") {
            return { status: "running", checkpoint: { phase: "wait", wakeAt: timestamp(runtime.now() + 250) } };
          }
          if (run.status !== "queued") throw new Error("capacity gate requires a queued run");
          const installationDraft = await tx.doc(WorkshopInstallationDoc);
          const installation = installationDocumentV1Schema.parse(installationDraft);
          if (installation.state !== "ready") throw new Error("installation is not initialized");
          const workflow = installation.workflows[input.workflowId];
          const reference = workflow?.runs.find((candidate) => candidate.runId === input.runId);
          if (workflow === undefined || reference === undefined || reference.status !== "queued") {
            throw new Error("capacity gate run reference is missing or inconsistent");
          }
          const reserved = Object.values(installation.workflows)
            .reduce((count, index) => count + index.capacityReservations.length, 0);
          if (!workflow.capacityReservations.includes(input.runId) && reserved >= installation.maxConcurrentRuns) {
            return { status: "running", checkpoint: { phase: "wait", wakeAt: timestamp(runtime.now() + 250) } };
          }
          if (!workflow.capacityReservations.includes(input.runId)) workflow.capacityReservations.push(input.runId);
          const at = timestamp(runtime.now());
          const nextRun = workflowRunDocumentV1Schema.parse({
            ...run,
            status: "running",
            startedAt: run.startedAt ?? at,
            durable: { ...run.durable, capacityGateTaskId: null },
          });
          assign(draft, nextRun);
          reference.status = "running";
          Object.assign(installationDraft, installationDocumentV1Schema.parse(installation));
          await appendEvent(tx, runtime.conversationId, {
            version: 1,
            eventId: randomUUID(),
            type: "run_state_changed",
            runId: input.runId,
            from: "queued",
            to: "running",
            occurredAt: at,
          });
          return { status: "terminal", outcome: { status: "completed", result: { kind: "acquired" } } };
        }, context);
        await refreshViews(runtime, context);
      },
      wait: async (task, runtime, context) => {
        const checkpoint = capacityGateCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "wait") throw new Error("capacity gate checkpoint lacks its persisted wake deadline");
        const wakeAt = Date.parse(checkpoint.wakeAt);
        if (runtime.now() < wakeAt) await runtime.sleep(wakeAt, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "acquire" } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "aborted", reason: "capacity gate stopped before acquiring a slot" },
      }), context);
    },
  });
}

function parseCapacityGateInput(value: unknown): CapacityGateTaskInputV2 {
  const parsed = capacityGateTaskInputV2Schema.safeParse(value);
  if (!parsed.success) throw new Error(`CapacityGate input failed validation: ${parsed.error.message}`);
  return parsed.data;
}

function assertCapacityGateIdentity(input: CapacityGateTaskInputV2, run: ReadyRun, taskId: number): void {
  if (input.runId !== run.runId || input.workflowId !== run.workflowId
    || input.activationId !== run.activationId || input.occurrenceId !== run.occurrenceId
    || run.durable.workflowTaskId !== input.workflowTaskId || !Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("CapacityGate identity differs from the canonical run");
  }
}

async function runDraft(tx: Tx, conversationId: ConversationId) {
  const draft = await tx.doc(WorkshopRunDoc, conversationId);
  return { draft, run: readyRun(draft) };
}

function assign(draft: object, value: unknown): void {
  Object.assign(draft, readyRun(value));
}

async function appendEvent(tx: Tx, conversationId: ConversationId, value: unknown): Promise<void> {
  const checked = workshopEventV1Schema.safeParse(value);
  if (!checked.success) throw new Error(`workshop event failed validation: ${checked.error.message}`);
  await tx.appendEntry(WorkshopEventEntry, conversationId, { data: checked.data });
}

function readyRun(value: unknown): ReadyRun {
  const parsed = workflowRunDocumentV1Schema.safeParse(value);
  if (!parsed.success) throw new Error(`canonical run document failed validation: ${parsed.error.message}`);
  if (parsed.data.state !== "ready") throw new Error("canonical run document is uninitialized");
  return parsed.data;
}

function timestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error("task clock returned an invalid timestamp");
  return utcTimestampV2Schema.parse(new Date(ms).toISOString());
}
