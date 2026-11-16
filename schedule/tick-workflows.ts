import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, type Cursor, type Harness, type TaskRecord, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { checkProfileCommands, readConfig } from "../config/read-workshop-config.ts";
import { startWorkflow, type WorkflowStartPort } from "../run/start-workflow.ts";
import { workshopStateDocument, type WorkshopState } from "../workflow/define-workshop-state.ts";
import { decideWorkflowSlot } from "./decide-workflow-slot.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";

export const WORKFLOW_TICK_TASK_NAME = "workshop.schedule-tick";
const tickIntervalMs = 60_000;

type WorkflowTickInput = { projectRoot: string; at: number };
type WorkflowTickCheckpoint = { phase: "wait" | "tick" };
type WorkflowTickRuntime = TaskRuntime<WorkflowTickInput, WorkflowTickCheckpoint, null, object>;
type WorkflowTickTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

export type WorkflowTickResult = {
  workflow: string;
  kind: "already-indexed" | "skip" | "start";
  slot: string;
  reason?: string;
  run_id?: string;
};


function nextMinute(now: number): number {
  return Math.floor(now / tickIntervalMs) * tickIntervalMs + tickIntervalMs;
}

function isLive(record: WorkflowTickTaskRecord): boolean {
  return ["pending", "running", "waiting", "sleeping", "completing"].includes(record.state.status);
}

async function tickerTasks(tx: Tx): Promise<WorkflowTickTaskRecord[]> {
  const records: WorkflowTickTaskRecord[] = [];
  for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ kind: WORKFLOW_TICK_TASK_NAME, status }, 1_000, cursor);
      records.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return records;
}

function startPort(runtime: WorkflowTickRuntime, context: typeof BACKGROUND_CONTEXT): WorkflowStartPort {
  return {
    conversationId: runtime.conversationId,
    async commit<T extends object>(change: (tx: Tx) => Promise<T>): Promise<T> {
      let result: T | undefined;
      await runtime.commit(async (tx) => {
        result = await change(tx);
      }, context);
      if (result === undefined) throw new Error("Workflow start transaction returned no result");
      return result;
    },
    readState: async (): Promise<WorkshopState | undefined> => await runtime.snapshot(workshopStateDocument, context),
  };
}

export async function tickWorkflows(input: {
  projectRoot: string;
  port: WorkflowStartPort;
  now?: Date;
}): Promise<WorkflowTickResult[]> {
  const now = input.now ?? new Date();
  const configFile = process.env.WORKSHOP_CONFIG ?? resolve(input.projectRoot, "workshop.yaml");
  const config = readConfig(configFile);
  const commandIssues = checkProfileCommands(config, process.env.PATH, configFile);
  if (commandIssues.length > 0) throw new Error(commandIssues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
  const loaded = loadWorkflows(resolve(input.projectRoot, "workflows"), new Set(Object.keys(config.agent_profiles)));
  for (const issue of loaded.errors) console.error(`[workshop] workflow skipped (${issue.file}): ${issue.reason}`);
  const state = await input.port.readState() ?? { admissions: [], actions: [], paused: [], receipts: [], startedCounts: {}, lastSlots: {} };
  const results: WorkflowTickResult[] = [];

  for (const workflow of loaded.workflows) {
    if (workflow.enabled === false) continue;
    let slot: string | undefined;
    try {
      const lastSlot = Object.hasOwn(state.lastSlots, workflow.name) ? state.lastSlots[workflow.name] : undefined;
      const startedCount = Object.hasOwn(state.startedCounts, workflow.name) ? state.startedCounts[workflow.name] ?? 0 : 0;
      const decision = decideWorkflowSlot({
        cron: workflow.cron,
        now,
        ...(lastSlot === undefined ? {} : { lastSlot }),
        startedCount,
        ...(workflow.max_runs === undefined ? {} : { maxRuns: workflow.max_runs }),
        paused: state.paused.includes(workflow.name),
      });
      slot = decision.slot;
      if (decision.kind === "already-indexed") {
        results.push({ workflow: workflow.name, kind: "already-indexed", slot: decision.slot });
        continue;
      }
      const admission = await startWorkflow({
        workflowName: workflow.name,
        projectRoot: input.projectRoot,
        port: input.port,
        slot: decision.slot,
        at: now,
      });
      if (admission.kind === "started") {
        results.push({ workflow: workflow.name, kind: "start", slot: decision.slot, run_id: admission.run_id });
      } else if (admission.kind === "skipped") {
        results.push({ workflow: workflow.name, kind: "skip", slot: decision.slot, reason: admission.reason });
      } else if (admission.kind === "already-indexed") {
        results.push({ workflow: workflow.name, kind: "already-indexed", slot: decision.slot });
      } else {
        results.push({ workflow: workflow.name, kind: "skip", slot: decision.slot, reason: admission.reason });
      }
    } catch (error) {
      const reason = "admission failed";
      console.error(`[workshop] scheduled admission failed (${workflow.name}${slot === undefined ? "" : ` at ${slot}`}): ${error instanceof Error ? error.message : String(error)}`);
      if (slot !== undefined) results.push({ workflow: workflow.name, kind: "skip", slot, reason });
    }
  }
  return results;
}

async function executeTick(input: WorkflowTickInput, runtime: WorkflowTickRuntime, context: typeof BACKGROUND_CONTEXT): Promise<void> {
  try {
    const results = await tickWorkflows({
      projectRoot: input.projectRoot,
      port: startPort(runtime, context),
      now: new Date(runtime.now()),
    });
    if (results.length > 0) console.info(`[workshop] scheduled tick: ${JSON.stringify(results)}`);
  } catch (error) {
    console.error(`[workshop] scheduled tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await runtime.commit(async (tx, task) => {
    await tx.createTask(WorkflowTickTask, {
      projectRoot: task.input.projectRoot,
      at: nextMinute(runtime.now()),
    }, {
      ownership: { kind: "conversation" },
      conversationId: task.conversationId,
    });
    return { status: "terminal", outcome: { status: "completed", result: null } };
  }, context);
}

export const WorkflowTickTask = defineTask<WorkflowTickInput, WorkflowTickCheckpoint, null, object>({
  name: WORKFLOW_TICK_TASK_NAME,
  version: 1,
  initial: (): WorkflowTickCheckpoint => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      if (runtime.now() >= task.input.at) {
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "tick" } }), context);
      } else {
        await runtime.sleepUntil(task.input.at, { phase: "tick" }, context);
      }
    },
    tick: async (task, runtime, context) => await executeTick(task.input, runtime, context),
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), context);
  },
});

export async function ensureWorkflowTicker(input: { projectRoot: string; harness: Harness }): Promise<void> {
  const root = await input.harness.root(BACKGROUND_CONTEXT);
  await root.commit(async (tx) => {
    const records = await tickerTasks(tx);
    if (records.some(isLive)) return;
    await tx.createTask(WorkflowTickTask, {
      projectRoot: resolve(input.projectRoot),
      at: nextMinute(Date.now()),
    }, {
      ownership: { kind: "conversation" },
      conversationId: root.id,
    });
  }, BACKGROUND_CONTEXT);
}
