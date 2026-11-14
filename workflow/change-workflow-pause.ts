import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { recordActionLog } from "../run/record-action-log.ts";
import { readPausedWorkflows } from "./read-paused-workflows.ts";

export function changeWorkflowPause(input: {
  workflow: string;
  paused: boolean;
  pauseFile: string;
  actionFile: string;
  at?: string;
}): { workflow: string; paused: boolean; pausedWorkflows: string[] } {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workflow)) throw new Error(`Invalid workflow name: ${input.workflow}`);
  const workflows = readPausedWorkflows(input.pauseFile);
  if (input.paused) workflows.add(input.workflow);
  else workflows.delete(input.workflow);
  const pausedWorkflows = [...workflows].sort();
  mkdirSync(dirname(input.pauseFile), { recursive: true });
  const temporaryFile = `${input.pauseFile}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(pausedWorkflows, null, 2)}\n`, "utf8");
  renameSync(temporaryFile, input.pauseFile);
  recordActionLog(input.actionFile, {
    ...(input.at === undefined ? {} : { at: input.at }),
    workflow: input.workflow,
    run_id: null,
    step: null,
    source: "chat",
    decision: { action: input.paused ? "pause" : "resume" },
    note: input.paused ? "Workflow paused from chat." : "Workflow resumed from chat.",
  });
  return { workflow: input.workflow, paused: input.paused, pausedWorkflows };
}
