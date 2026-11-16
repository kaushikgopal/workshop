import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Workflow, WorkflowStep } from "./types.ts";

export type WorkflowStepFiles = {
  documents: Record<string, string>;
  files: Record<string, string>;
  contents: Record<string, string>;
};

function readMarkdownBody(file: string): string {
  const contents = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = contents.split(/\r?\n/);
  const closingLine = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (lines[0]?.trim() !== "---" || closingLine < 0) throw new Error(`${file}: missing or incomplete YAML frontmatter`);
  const body = lines.slice(closingLine + 1).join("\n").trim();
  if (body.length === 0) throw new Error(`${file}: step content must not be empty`);
  return body;
}

export function loadWorkflowStep(workflowRoot: string, workflow: Workflow, step: WorkflowStep): WorkflowStepFiles {
  const directory = resolve(workflowRoot, workflow.directory);
  const documents: Record<string, string> = {};
  const files: Record<string, string> = {};
  const contents: Record<string, string> = {};
  const stepFiles = [step, ...(step.check === undefined ? [] : [step.check])];

  for (const item of stepFiles) {
    const file = join(directory, item.file);
    const source = readFileSync(file, "utf8");
    files[item.file] = file;
    contents[item.file] = source;
    if (item.kind === "agent") documents[item.file] = readMarkdownBody(file);
  }

  return { documents, files, contents };
}
