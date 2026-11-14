import { resolve } from "node:path";
import { defineSchedule } from "eve/schedules";
import { start } from "eve/workflow/api";
import { appendRunIndex } from "../../run/append-run-index.ts";
import { lastSlotForWorkflow, readRunIndex, startedCountForWorkflow } from "../../run/read-run-index.ts";
import type { RunIndexEntry } from "../../run/types.ts";
import { decideWorkflowSlot } from "../../schedule/decide-workflow-slot.ts";
import { loadWorkflows } from "../../workflow/load-workflows.ts";
import { readPausedWorkflows } from "../../workflow/read-paused-workflows.ts";
import { checkProfileCommands, readConfig, type WorkshopConfig } from "../lib/read-config.ts";
import { executeWorkflow } from "../tools/start_workflow.ts";

export default defineSchedule({
  cron: "* * * * *",
  timezone: "UTC",
  async run() {
    let config: WorkshopConfig;
    try {
      config = readConfig();
    } catch (error) {
      console.error(`[workshop] schedule skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const commandIssues = checkProfileCommands(config);
    if (commandIssues.length > 0) {
      for (const issue of commandIssues) console.error(`[workshop] schedule skipped: ${issue.file}: ${issue.reason}`);
      return;
    }

    const loaded = loadWorkflows(resolve(process.cwd(), "workflows"), new Set(Object.keys(config.agent_profiles)));
    for (const issue of loaded.errors) console.error(`[workshop] workflow skipped (${issue.file}): ${issue.reason}`);

    const stateRoot = resolve(process.cwd(), "state");
    let paused: Set<string>;
    try {
      paused = readPausedWorkflows(resolve(stateRoot, "paused.json"));
    } catch (error) {
      console.error(`[workshop] schedule skipped: could not read pause state: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const indexFile = resolve(stateRoot, "runs.jsonl");
    let entries: RunIndexEntry[];
    try {
      entries = readRunIndex(indexFile);
    } catch (error) {
      console.error(`[workshop] schedule skipped: could not read run index: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const now = new Date();
    for (const workflow of loaded.workflows) {
      if (workflow.enabled === false || paused.has(workflow.name)) continue;
      const decision = decideWorkflowSlot({
        cron: workflow.cron,
        now,
        lastSlot: lastSlotForWorkflow(entries, workflow.name),
        startedCount: startedCountForWorkflow(entries, workflow.name),
        ...(workflow.max_runs === undefined ? {} : { maxRuns: workflow.max_runs }),
      });
      if (decision.kind === "already-indexed") continue;
      if (decision.kind === "skip") {
        const entry = appendRunIndex(indexFile, {
          workflow: workflow.name,
          slot: decision.slot,
          run_id: null,
          outcome: "skipped",
          reason: decision.reason,
          at: now.toISOString(),
        });
        entries.push(entry);
        continue;
      }

      try {
        const handle = await start(executeWorkflow, [{
          workflowName: workflow.name,
          scheduledSlot: decision.slot,
          ...(workflow.max_runs === undefined ? {} : { maxRuns: workflow.max_runs }),
        }]);
        // The tick must return while the run works so later slots can observe and skip its lock.
        void handle.returnValue.then(
          (result) => {
            if (result.status === "skipped") console.info(`[workshop] workflow ${workflow.name} slot ${decision.slot} skipped (${result.reason})`);
          },
          (error) => console.error(`[workshop] workflow run ${handle.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      } catch (error) {
        console.error(`[workshop] could not start workflow ${workflow.name} for slot ${decision.slot}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  },
});
