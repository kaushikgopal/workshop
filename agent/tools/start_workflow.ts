import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineWorkflowTool } from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata, sleep } from "eve/workflow";
import { start } from "eve/workflow/api";
import { z } from "zod";
import { recordActionLog } from "../../run/record-action-log.ts";
import { decideWorkflowAdmission } from "../../run/admit-workflow-run.ts";
import { appendRunIndex } from "../../run/append-run-index.ts";
import { buildDecisionToken } from "../../run/build-decision-token.ts";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { readPausedWorkflows } from "../../workflow/read-paused-workflows.ts";
import { readRunIndex } from "../../run/read-run-index.ts";
import { removeBlockedStep } from "../../run/remove-blocked-step.ts";
import { writeBlockedStep } from "../../run/write-blocked-step.ts";
import { createWorkflowSnapshot } from "../../workflow/create-workflow-snapshot.ts";
import { interpretWorkflow, type AutomaticDecisionLog } from "../../workflow/interpret-workflow.ts";
import { parseWorkflowDecision } from "../../workflow/parse-workflow-decision.ts";
import type { AttemptHistoryEntry, WorkflowDecision, WorkflowSnapshot } from "../../workflow/types.ts";
import { executeWorkflowProcess } from "../lib/execute-workflow-process.ts";
import { checkProfileCommands, readConfig } from "../lib/read-config.ts";

type WorkflowStartInput = { workflowName: string; scheduledSlot?: string | null; maxRuns?: number };
type PreparedWorkflowResult =
  | { kind: "prepared"; snapshot: WorkflowSnapshot; orchestrator: { profile: string; escalationProfile: string } }
  | { kind: "skipped"; reason: string };
type BlockedDecisionInput = {
  workflow: string;
  runId: string;
  step: string;
  stepKind: "agent" | "command";
  retryProfiles: string[];
  lastError: string;
  lastOutput: string;
  attemptHistory: AttemptHistoryEntry[];
  decisionNumber: number;
};

const workflowNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export async function startWorkflowForChat(
  workflowName: string,
  ports: {
    isPaused(name: string): boolean;
    start(name: string): Promise<string>;
    recordStart?(name: string, runId: string): Promise<void> | void;
  },
): Promise<{ status: "started"; workflow: string; runId: string }> {
  if (ports.isPaused(workflowName)) throw new Error(`Workflow "${workflowName}" is paused; resume it before starting manually.`);
  const runId = await ports.start(workflowName);
  await ports.recordStart?.(workflowName, runId);
  return { status: "started", workflow: workflowName, runId };
}

export async function executeWorkflow(input: WorkflowStartInput) {
  "use workflow";

  if (!workflowNameSchema.safeParse(input.workflowName).success) throw new FatalError(`Invalid workflow name: ${input.workflowName}`);
  const { workflowRunId } = getWorkflowMetadata();
  const lock = createHook<string>({
    token: `workshop-lock:${input.workflowName}`,
    metadata: { workflow: input.workflowName },
  });

  try {
    const conflict = await lock.getConflict();
    if (conflict) {
      await recordLockSkip({ workflow: input.workflowName, slot: input.scheduledSlot ?? null, runId: workflowRunId, conflictRunId: conflict.runId });
      return { status: "skipped" as const, workflowRunId, reason: `workflow lock held by ${conflict.runId}` };
    }

    let snapshot: WorkflowSnapshot | undefined;
    try {
      const prepared = await prepareWorkflow({
        workflowName: input.workflowName,
        runId: workflowRunId,
        slot: input.scheduledSlot ?? null,
        manual: input.scheduledSlot === undefined || input.scheduledSlot === null,
        ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
      });
      if (prepared.kind === "skipped") {
        return { status: "skipped" as const, workflowRunId, reason: prepared.reason };
      }
      const preparedSnapshot = prepared.snapshot;
      snapshot = preparedSnapshot;
      const result = await interpretWorkflow({
        workflow: preparedSnapshot.workflow,
        documents: preparedSnapshot.documents,
        files: preparedSnapshot.files,
        contents: preparedSnapshot.contents,
        workflowRunId,
        profileCommands: preparedSnapshot.profileCommands,
        orchestrator: {
          ...prepared.orchestrator,
          recordDecision: recordAutomaticDecision,
        },
        executeProcess: (request) => executeWorkflowProcess({
          ...request,
          workflow: input.workflowName,
          runId: workflowRunId,
          dataDirectory: preparedSnapshot.dataDirectory,
          cwd: preparedSnapshot.dataDirectory,
        }),
        waitBeforeRetry: (duration) => sleep(duration),
        waitForDecision: (blocked) => waitForWorkflowDecision(blocked),
      });
      return { ...result, workflowRunId };
    } finally {
      try {
        await clearBlockedStep(workflowRunId);
      } finally {
        if (snapshot) await removeWorkflowSnapshot(snapshot.runDirectory);
      }
    }
  } finally {
    lock.dispose();
  }
}

export default defineWorkflowTool({
  description: "Start a named workflow and return its run id. Use list_runs and read_run to inspect progress.",
  inputSchema: z.object({ workflowName: workflowNameSchema }),
  async task({ workflowName }) {
    "use workflow";
    if (!workflowNameSchema.safeParse(workflowName).success) throw new FatalError(`Invalid workflow name: ${workflowName}`);
    return await startManualWorkflow(workflowName);
  },
});

async function startManualWorkflow(workflowName: string): Promise<{ status: "started"; workflow: string; runId: string }> {
  "use step";
  const stateRoot = resolve(process.cwd(), "state");
  return startWorkflowForChat(workflowName, {
    isPaused: (name) => readPausedWorkflows(resolve(stateRoot, "paused.json")).has(name),
    start: async (name) => (await start(executeWorkflow, [{ workflowName: name }])).runId,
    recordStart: recordManualStart,
  });
}

async function recordManualStart(workflow: string, runId: string): Promise<void> {
  "use step";
  recordActionLog(resolve(process.cwd(), "state", "actions.jsonl"), {
    workflow,
    run_id: runId,
    step: null,
    source: "chat",
    decision: { action: "start" },
    note: "Workflow run started from chat.",
  });
}

async function prepareWorkflow(input: { workflowName: string; runId: string; slot: string | null; manual: boolean; maxRuns?: number }): Promise<PreparedWorkflowResult> {
  "use step";

  const stateRoot = resolve(process.cwd(), "state");
  const indexFile = resolve(stateRoot, "runs.jsonl");
  if (readPausedWorkflows(resolve(stateRoot, "paused.json")).has(input.workflowName)) {
    const reason = `workflow ${input.workflowName} is paused`;
    if (input.manual) throw new FatalError(`Workflow "${input.workflowName}" is paused; resume it before starting manually.`);
    appendRunIndex(indexFile, {
      workflow: input.workflowName,
      slot: input.slot,
      run_id: input.runId,
      outcome: "skipped",
      reason,
    });
    return { kind: "skipped", reason };
  }
  const admission = decideWorkflowAdmission({
    entries: readRunIndex(indexFile),
    workflow: input.workflowName,
    runId: input.runId,
    slot: input.slot,
    ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
  });
  if (admission.kind === "skip") {
    appendRunIndex(indexFile, {
      workflow: input.workflowName,
      slot: input.slot,
      run_id: input.runId,
      outcome: "skipped",
      reason: admission.reason,
    });
    return { kind: "skipped", reason: admission.reason };
  }
  appendRunIndex(indexFile, {
    workflow: input.workflowName,
    slot: input.slot,
    run_id: input.runId,
    outcome: "started",
  });

  const config = readConfig();
  const commandIssues = checkProfileCommands(config);
  if (commandIssues.length > 0) {
    throw new FatalError(commandIssues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
  }
  const profileCommands = Object.fromEntries(
    Object.entries(config.agent_profiles).map(([name, profile]) => [name, profile.command]),
  );
  const dataDirectory = resolve(process.cwd(), "data", input.workflowName);
  let snapshot: WorkflowSnapshot | undefined;
  try {
    snapshot = createWorkflowSnapshot({
      workflowName: input.workflowName,
      runId: input.runId,
      workflowRoot: resolve(process.cwd(), "workflows"),
      stateRoot,
      dataDirectory,
      profileCommands,
    });
    mkdirSync(dataDirectory, { recursive: true });
    return {
      kind: "prepared",
      snapshot,
      orchestrator: {
        profile: config.orchestrator.profile,
        escalationProfile: config.orchestrator.escalation_profile,
      },
    };
  } catch (error) {
    rmSync(resolve(stateRoot, "snapshots", input.runId), { recursive: true, force: true });
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
}

async function recordLockSkip(input: { workflow: string; slot: string | null; runId: string; conflictRunId: string }): Promise<void> {
  "use step";
  appendRunIndex(resolve(process.cwd(), "state", "runs.jsonl"), {
    workflow: input.workflow,
    slot: input.slot,
    run_id: input.runId,
    outcome: "skipped",
    reason: `workflow lock held by ${input.conflictRunId}`,
  });
}

async function recordAutomaticDecision(input: AutomaticDecisionLog): Promise<void> {
  "use step";
  recordActionLog(resolve(process.cwd(), "state", "actions.jsonl"), {
    workflow: input.workflow,
    run_id: input.runId,
    step: input.step,
    source: input.round === 1 ? "round-1" : "round-2",
    decision: input.decision,
    note: input.note,
  });
}

async function persistBlockedStep(input: BlockedDecisionInput & { token: string }): Promise<void> {
  "use step";
  const file = locateBlockedStep(resolve(process.cwd(), "state"), input.runId);
  writeBlockedStep(file, {
    workflow: input.workflow,
    run_id: input.runId,
    step: input.step,
    step_kind: input.stepKind,
    retry_profiles: input.retryProfiles,
    last_error: input.lastError,
    last_output: input.lastOutput,
    attempt_history: input.attemptHistory,
    token: input.token,
  });
}

async function clearBlockedStep(runId: string): Promise<void> {
  "use step";
  removeBlockedStep(locateBlockedStep(resolve(process.cwd(), "state"), runId));
}

async function removeWorkflowSnapshot(runDirectory: string): Promise<void> {
  "use step";
  rmSync(runDirectory, { recursive: true, force: true });
}

async function waitForWorkflowDecision(input: BlockedDecisionInput): Promise<WorkflowDecision> {
  const token = buildDecisionToken(input.runId, input.step, input.decisionNumber);
  const hook = createHook<unknown>({
    token,
    metadata: { workflow: input.workflow, runId: input.runId, step: input.step, lastError: input.lastError },
  });
  try {
    const conflict = await hook.getConflict();
    if (conflict) throw new FatalError(`Decision hook for ${input.step} is already held by run ${conflict.runId}`);
    await persistBlockedStep({ ...input, token });
    return parseWorkflowDecision(await hook);
  } finally {
    hook.dispose();
    await clearBlockedStep(input.runId);
  }
}
