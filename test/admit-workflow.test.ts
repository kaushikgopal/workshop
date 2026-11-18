import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { test } from "node:test";
import { createWorkflowStartPort, startWorkflow, type WorkflowStartPort } from "../run/start-workflow.ts";
import { tickWorkflows } from "../service/tick-workflows.ts";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { createStepAttemptTask } from "../workflow/define-step-attempt-task.ts";
import { workshopStateDocument } from "../workflow/define-workshop-state.ts";
import { WorkflowTask } from "../workflow/define-workflow-task.ts";

type TestProject = { root: string; configFile: string };

function createProject(workflows: string[]): TestProject {
  const root = mkdtempSync(join(tmpdir(), "workshop-admission-test-"));
  const configFile = join(root, "workshop.yaml");
  writeFileSync(configFile, [
    "agent_profiles:",
    `  writer:\n    command: [${JSON.stringify(process.execPath)}]`,
    "orchestrator: {}",
    "",
  ].join("\n"));
  for (const name of workflows) writeWorkflow(root, name, "* * * * *");
  return { root, configFile };
}

function writeWorkflow(root: string, name: string, cron: string, enabled = true): void {
  const directory = join(root, "workflows", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workflow.md"), [
    "---",
    `cron: '${cron}'`,
    ...(enabled ? [] : ["enabled: false"]),
    "---",
    `Admission test workflow ${name}.`,
    "",
  ].join("\n"));
  writeFileSync(join(directory, "10-task.sh"), "printf 'admitted'\n");
}

async function createHarness() {
  const registry = createRegistry();
  registry.install({ name: "workshop-test", tasks: [WorkflowTask, createStepAttemptTask(executeWorkflowProcess)] });
  return await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
}

function useConfig(file: string): () => void {
  const previous = process.env.WORKSHOP_CONFIG;
  process.env.WORKSHOP_CONFIG = file;
  return () => {
    if (previous === undefined) delete process.env.WORKSHOP_CONFIG;
    else process.env.WORKSHOP_CONFIG = previous;
  };
}

function startInput(project: TestProject, port: WorkflowStartPort, idempotency = true) {
  return {
    workflowName: "clock",
    projectRoot: project.root,
    port,
    at: new Date("2026-11-16T12:00:30.000Z"),
    ...(idempotency ? {
      idempotency: {
        requestId: "start-request",
        fingerprint: "same-payload",
        response: (outcome: { kind: string; run_id?: string }) => ({
          ok: true,
          run_id: outcome.run_id ?? null,
        }),
      },
    } : {}),
  };
}

test("a retained start receipt replays before changed config is loaded", async () => {
  const project = createProject(["clock"]);
  const restoreConfig = useConfig(project.configFile);
  const harness = await createHarness();
  try {
    const port = await createWorkflowStartPort(harness);
    const input = startInput(project, port);
    const first = await startWorkflow(input);
    assert.equal(first.kind, "started");

    writeFileSync(project.configFile, "agent_profiles: [invalid\n");
    const replay = await startWorkflow(input);
    assert.deepEqual(replay, { kind: "replayed", response: { ok: true, run_id: first.kind === "started" ? first.run_id : null } });
  } finally {
    restoreConfig();
    await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a concurrent start rechecks its receipt inside the admission transaction", async () => {
  const project = createProject(["clock"]);
  const restoreConfig = useConfig(project.configFile);
  const harness = await createHarness();
  try {
    const port = await createWorkflowStartPort(harness);
    const input = startInput(project, port);
    const results = await Promise.all([startWorkflow(input), startWorkflow(input)]);
    assert.deepEqual(results.map(({ kind }) => kind).sort(), ["replayed", "started"]);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.receipts.length, 1);
  } finally {
    restoreConfig();
    await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a failed admission is recorded without suppressing later workflows", async () => {
  const project = createProject(["first", "second"]);
  const restoreConfig = useConfig(project.configFile);
  const harness = await createHarness();
  try {
    const basePort = await createWorkflowStartPort(harness);
    let changed = false;
    const port: WorkflowStartPort = {
      conversationId: basePort.conversationId,
      commit: basePort.commit,
      readState: async () => {
        const state = await basePort.readState();
        if (!changed) {
          changed = true;
          writeFileSync(join(project.root, "workflows", "first", "workflow.md"), "---\ncron: [invalid\n---\nBroken during tick.\n");
        }
        return state;
      },
    };

    const results = await tickWorkflows({
      projectRoot: project.root,
      port,
      now: new Date("2026-11-16T12:00:30.000Z"),
    });
    assert.deepEqual(results.map(({ workflow, kind, reason }) => [workflow, kind, reason]), [
      ["first", "skip", "admission failed"],
      ["second", "start", undefined],
    ]);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.deepEqual(state?.admissions.map(({ workflow, outcome, reason }) => [workflow, outcome, reason]), [
      ["first", "skipped", "admission failed"],
      ["second", "started", undefined],
    ]);
  } finally {
    restoreConfig();
    await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
});

async function assertReloadedSkip(input: {
  name: string;
  now: Date;
  rewrite(root: string): void;
  reason: string;
}): Promise<void> {
  const project = createProject(["clock"]);
  const restoreConfig = useConfig(project.configFile);
  const harness = await createHarness();
  try {
    const basePort = await createWorkflowStartPort(harness);
    let changed = false;
    const port: WorkflowStartPort = {
      conversationId: basePort.conversationId,
      commit: basePort.commit,
      readState: async () => {
        const state = await basePort.readState();
        if (!changed) {
          changed = true;
          input.rewrite(project.root);
        }
        return state;
      },
    };
    const results = await tickWorkflows({ projectRoot: project.root, port, now: input.now });
    assert.deepEqual(results.map(({ workflow, kind, reason }) => [workflow, kind, reason]), [
      ["clock", "skip", input.reason],
    ], input.name);
    const state = await harness.snapshot(workshopStateDocument, BACKGROUND_CONTEXT);
    assert.equal(state?.admissions.at(-1)?.outcome, "skipped");
    assert.equal(state?.admissions.at(-1)?.reason, input.reason);
  } finally {
    restoreConfig();
    await harness.close(BACKGROUND_CONTEXT);
    rmSync(project.root, { recursive: true, force: true });
  }
}

test("a workflow disabled after tick discovery is skipped at admission", async () => {
  await assertReloadedSkip({
    name: "disabled after discovery",
    now: new Date("2026-11-16T12:00:30.000Z"),
    rewrite: (root) => writeWorkflow(root, "clock", "* * * * *", false),
    reason: "workflow is disabled",
  });
});

test("a slot that no longer matches the reloaded cron is recorded as skipped", async () => {
  await assertReloadedSkip({
    name: "cron changed after discovery",
    now: new Date("2026-11-16T12:03:30.000Z"),
    rewrite: (root) => writeWorkflow(root, "clock", "*/5 * * * *"),
    reason: "schedule slot is no longer due",
  });
});
