import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineWorkflowTool } from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata } from "eve/workflow";
import { z } from "zod";
import { appendRunIndex } from "../../run/append-run-index.ts";
import { buildDecisionToken } from "../../run/build-decision-token.ts";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { removeBlockedStep } from "../../run/remove-blocked-step.ts";
import { writeBlockedStep } from "../../run/write-blocked-step.ts";
import { createWorkflowSnapshot } from "../../workflow/create-workflow-snapshot.ts";
import { interpretWorkflow } from "../../workflow/interpret-workflow.ts";
import { parseWorkflowDecision } from "../../workflow/parse-workflow-decision.ts";
import type { WorkflowDecision, WorkflowSnapshot } from "../../workflow/types.ts";
import { executeWorkflowProcess } from "../lib/execute-workflow-process.ts";
import { checkProfileCommands, readConfig } from "../lib/read-config.ts";

type WorkflowStartInput = { workflowName: string; scheduledSlot?: string | null };
type BlockedDecisionInput = {
  workflow: string;
  runId: string;
  step: string;
  stepKind: "agent" | "command";
  retryProfiles: string[];
  lastError: string;
  decisionNumber: number;
};

const workflowNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

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
      return { status: "skipped" as const, workflowRunId, conflictRunId: conflict.runId };
    }

    let snapshot: WorkflowSnapshot | undefined;
    try {
      const prepared = await prepareWorkflow({ workflowName: input.workflowName, runId: workflowRunId, slot: input.scheduledSlot ?? null });
      snapshot = prepared;
      const result = await interpretWorkflow({
        workflow: prepared.workflow,
        documents: prepared.documents,
        files: prepared.files,
        workflowRunId,
        profileCommands: prepared.profileCommands,
        executeProcess: (request) => executeWorkflowProcess({
          ...request,
          workflow: input.workflowName,
          runId: workflowRunId,
          dataDirectory: prepared.dataDirectory,
          cwd: prepared.dataDirectory,
        }),
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
  description: "Start a named workflow. Each run uses a snapshot of its numbered steps and resumes safely after a restart.",
  inputSchema: z.object({ workflowName: workflowNameSchema }),
  execute: executeWorkflow,
});

async function prepareWorkflow(input: { workflowName: string; runId: string; slot: string | null }): Promise<WorkflowSnapshot> {
  "use step";

  const stateRoot = resolve(process.cwd(), "state");
  appendRunIndex(resolve(stateRoot, "runs.jsonl"), {
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
    return snapshot;
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
    token: input.token
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
