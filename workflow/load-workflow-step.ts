import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Workflow, WorkflowStep } from "./types.ts";

export type WorkflowStepFiles = {
  documents: Record<string, string>;
  files: Record<string, string>;
  stepContent: string;
};

export class WorkflowStepLoadError extends Error {}

function readSource(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && "syscall" in error) {
      throw new WorkflowStepLoadError(error.message, { cause: error });
    }
    throw error;
  }
}

function readMarkdownBody(file: string, source: string): string {
  const contents = source.replace(/^\uFEFF/, "");
  const lines = contents.split(/\r?\n/);
  const closingLine = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (lines[0]?.trim() !== "---" || closingLine < 0) throw new WorkflowStepLoadError(`${file}: missing or incomplete YAML frontmatter`);
  const body = lines.slice(closingLine + 1).join("\n").trim();
  if (body.length === 0) throw new WorkflowStepLoadError(`${file}: step content must not be empty`);
  return body;
}
export function loadWorkflowStepSource(workflowRoot: string, workflow: Workflow, step: WorkflowStep): string {
  const directory = resolve(workflowRoot, workflow.directory);
  return readSource(join(directory, step.file));
}

export function loadWorkflowStep(workflowRoot: string, workflow: Workflow, step: WorkflowStep): WorkflowStepFiles {
  const directory = resolve(workflowRoot, workflow.directory);
  const documents: Record<string, string> = {};
  const files: Record<string, string> = {};
  const stepFiles = [step, ...(step.check === undefined ? [] : [step.check])];
  const stepContent = loadWorkflowStepSource(workflowRoot, workflow, step);

  for (const [index, item] of stepFiles.entries()) {
    const file = join(directory, item.file);
    const source = index === 0 ? stepContent : readSource(file);
    files[item.file] = file;
    if (item.kind === "agent") documents[item.file] = readMarkdownBody(file, source);
  }

  return { documents, files, stepContent };
}
