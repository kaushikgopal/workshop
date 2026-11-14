import type { Workflow, WorkflowIssue, WorkflowLoadResult } from "./types.ts";

export type WorkflowStatus = {
  name: string;
  enabled: boolean;
  paused: boolean;
  cron: string;
  description: string;
};

export type BrokenWorkflowStatus = {
  name: string;
  errors: WorkflowIssue[];
};

export function listWorkflowStatus(
  loaded: WorkflowLoadResult,
  paused: ReadonlySet<string>,
): { workflows: WorkflowStatus[]; broken_workflows: BrokenWorkflowStatus[] } {
  const workflows = loaded.workflows.map((workflow: Workflow): WorkflowStatus => ({
    name: workflow.name,
    enabled: workflow.enabled !== false,
    paused: paused.has(workflow.name),
    cron: workflow.cron,
    description: workflow.description,
  }));
  const errorsByName = new Map<string, WorkflowIssue[]>();
  for (const issue of loaded.errors) {
    const name = issue.file === "." ? "workflows" : issue.file.split(/[\\/]/, 1)[0] ?? issue.file;
    const errors = errorsByName.get(name) ?? [];
    errors.push(issue);
    errorsByName.set(name, errors);
  }
  const broken_workflows = [...errorsByName].map(([name, errors]) => ({ name, errors }));
  return { workflows, broken_workflows };
}
