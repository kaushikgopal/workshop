import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkflows } from "./load-workflows.ts";
import type { Workflow, WorkflowSnapshot } from "./types.ts";

type CreateWorkflowSnapshotInput = {
  workflowName: string;
  runId: string;
  workflowRoot: string;
  stateRoot: string;
  dataDirectory: string;
  profileCommands: Record<string, string[]>;
};

function markdownBody(file: string): string {
  const contents = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = contents.split(/\r?\n/);
  const closingLine = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (lines[0]?.trim() !== "---" || closingLine < 0) throw new Error(`${file}: missing or incomplete YAML frontmatter`);
  return lines.slice(closingLine + 1).join("\n").trim();
}

function workflowDocuments(workflow: Workflow, directory: string): Record<string, string> {
  const documents: Record<string, string> = {};
  for (const step of workflow.steps) {
    if (step.kind === "agent") documents[step.file] = markdownBody(join(directory, step.file));
    if (step.check?.kind === "agent") documents[step.check.file] = markdownBody(join(directory, step.check.file));
  }
  return documents;
}

function workflowFiles(workflow: Workflow, directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const step of workflow.steps) {
    files[step.file] = join(directory, step.file);
    if (step.check) files[step.check.file] = join(directory, step.check.file);
  }
  return files;
}

function workflowContents(workflow: Workflow, directory: string): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const step of workflow.steps) {
    contents[step.file] = readFileSync(join(directory, step.file), "utf8");
    if (step.check) contents[step.check.file] = readFileSync(join(directory, step.check.file), "utf8");
  }
  return contents;
}

export function createWorkflowSnapshot(input: CreateWorkflowSnapshotInput): WorkflowSnapshot {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workflowName)) throw new Error(`Invalid workflow name: ${input.workflowName}`);
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error(`Invalid workflow run ID: ${input.runId}`);

  const snapshotsDirectory = resolve(input.stateRoot, "snapshots");
  const runDirectory = join(snapshotsDirectory, input.runId);
  const temporaryDirectory = join(snapshotsDirectory, `.${input.runId}.tmp`);
  const directory = join(runDirectory, input.workflowName);
  try {
    mkdirSync(snapshotsDirectory, { recursive: true });
    if (existsSync(runDirectory) && !existsSync(directory)) rmSync(runDirectory, { recursive: true, force: true });
    if (!existsSync(runDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      mkdirSync(temporaryDirectory, { recursive: true });
      cpSync(join(input.workflowRoot, input.workflowName), join(temporaryDirectory, input.workflowName), { recursive: true });
      renameSync(temporaryDirectory, runDirectory);
    }
    const loaded = loadWorkflows(runDirectory, new Set(Object.keys(input.profileCommands)));
    if (loaded.errors.length > 0) {
      throw new Error(loaded.errors.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
    }
    const workflow = loaded.workflows.find((item) => item.name === input.workflowName);
    if (!workflow) throw new Error(`Workflow "${input.workflowName}" was not found in its snapshot`);
    return {
      workflow,
      runDirectory,
      documents: workflowDocuments(workflow, directory),
      files: workflowFiles(workflow, directory),
      contents: workflowContents(workflow, directory),
      profileCommands: input.profileCommands,
      dataDirectory: input.dataDirectory,
      stateDirectory: input.stateRoot,
    };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    rmSync(runDirectory, { recursive: true, force: true });
    throw error;
  }
}
