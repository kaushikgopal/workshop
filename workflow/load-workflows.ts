import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Workflow, WorkflowCheck, WorkflowIssue, WorkflowLoadOptions, WorkflowLoadResult, WorkflowStep, WorkflowStepKind } from "./types.ts";

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const profileName = z.string().regex(namePattern, "must use lowercase letters, digits, and hyphens");
const maxTimeoutMs = 2_147_483_647;
const durationFactors = { s: 1_000, m: 60_000, h: 3_600_000 };
const duration = z.string().refine((value) => {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const factor = durationFactors[match[2] as keyof typeof durationFactors];
  return Number.isSafeInteger(amount) && amount * factor <= maxTimeoutMs;
}, "must be a positive duration supported by Node timers, such as 30s, 10m, or 2h");
const retryCount = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");
const workflowMetadataSchema = z.object({
  cron: z.string().min(1).refine((value) => {
    try {
      CronExpressionParser.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid cron expression"),
  max_runs: z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer").optional(),
  enabled: z.boolean().optional(),
  profile: profileName.optional(),
  retries: retryCount.optional(),
  timeout: duration.optional(),
}).strict();
const stepMetadataSchema = z.object({
  profile: profileName.optional(),
  retries: retryCount.optional(),
  timeout: duration.optional(),
}).strict();

type WorkflowMetadata = z.infer<typeof workflowMetadataSchema>;
type StepMetadata = z.infer<typeof stepMetadataSchema>;
type MarkdownDocument = { metadata: unknown; body: string };
type StepFile = {
  number: number;
  name: string;
  file: string;
  kind: WorkflowStepKind;
  profile?: string;
  retries?: number;
  timeout?: string;
};
type CheckFile = {
  number: number;
  name: string;
  file: string;
  kind: WorkflowStepKind;
  profile?: string;
  retries?: number;
  timeout?: string;
};

function issue(errors: WorkflowIssue[], file: string, reason: string): void {
  errors.push({ file, reason });
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function readMarkdown(file: string, relativeFile: string, errors: WorkflowIssue[]): MarkdownDocument | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    issue(errors, relativeFile, `could not read file: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    issue(errors, relativeFile, "missing YAML frontmatter");
    return undefined;
  }
  const closingLine = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (closingLine < 0) {
    issue(errors, relativeFile, "frontmatter is missing its closing delimiter");
    return undefined;
  }

  const yamlText = lines.slice(1, closingLine).join("\n");
  let metadata: unknown;
  if (yamlText.trim().length === 0) {
    metadata = {};
  } else {
    const document = parseDocument(yamlText, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0) {
      for (const error of document.errors) issue(errors, relativeFile, `invalid YAML frontmatter: ${oneLine(error.message)}`);
      return undefined;
    }
    try {
      metadata = document.toJS();
    } catch (error) {
      issue(errors, relativeFile, `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    issue(errors, relativeFile, "frontmatter must be a mapping");
    return undefined;
  }
  return { metadata, body: lines.slice(closingLine + 1).join("\n").trim() };
}

function reportSchemaIssues(errors: WorkflowIssue[], file: string, issues: z.ZodIssue[]): void {
  for (const entry of issues) {
    const field = entry.path.length > 0 ? `${entry.path.join(".")}: ` : "";
    issue(errors, file, `${field}${oneLine(entry.message)}`);
  }
}

function parseWorkflowMetadata(markdown: MarkdownDocument, file: string, errors: WorkflowIssue[]): WorkflowMetadata | undefined {
  const result = workflowMetadataSchema.safeParse(markdown.metadata);
  if (!result.success) {
    reportSchemaIssues(errors, file, result.error.issues);
    return undefined;
  }
  return result.data;
}

function parseStepMetadata(markdown: MarkdownDocument, file: string, errors: WorkflowIssue[]): StepMetadata | undefined {
  const result = stepMetadataSchema.safeParse(markdown.metadata);
  if (!result.success) {
    reportSchemaIssues(errors, file, result.error.issues);
    return undefined;
  }
  return result.data;
}

function resolveProfile(
  metadataProfile: string | undefined,
  defaultProfile: string | undefined,
  availableProfiles: ReadonlySet<string>,
  file: string,
  errors: WorkflowIssue[],
): string | undefined {
  const profile = metadataProfile ?? defaultProfile;
  if (profile === undefined) {
    issue(errors, file, "agent profile must be set here or in workflow.md");
    return undefined;
  }
  if (!availableProfiles.has(profile)) issue(errors, file, `profile "${profile}" does not exist in agent_profiles`);
  return profile;
}

function parseStepName(file: string): { number: number; name: string; extension: string } | undefined {
  const match = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.(md|sh|ts)$/.exec(file);
  if (!match) return undefined;
  const numberText = match[1];
  const name = match[2];
  const extension = match[3];
  if (numberText === undefined || name === undefined || extension === undefined) return undefined;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) return undefined;
  return { number, name, extension };
}

function parseCheckName(file: string): { number: number; name: string; extension: string } | undefined {
  const match = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.check\.(md|sh|ts)$/.exec(file);
  if (!match) return undefined;
  const numberText = match[1];
  const name = match[2];
  const extension = match[3];
  if (numberText === undefined || name === undefined || extension === undefined) return undefined;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) return undefined;
  return { number, name, extension };
}

function readStepFile(
  root: string,
  directory: string,
  file: string,
  number: number,
  name: string,
  extension: string,
  defaultProfile: string | undefined,
  availableProfiles: ReadonlySet<string>,
  errors: WorkflowIssue[],
): StepFile {
  const kind: WorkflowStepKind = extension === "md" ? "agent" : "command";
  const step: StepFile = { number, name, file, kind };
  if (kind === "command") return step;

  const relativeFile = join(directory, file);
  const markdown = readMarkdown(join(root, directory, file), relativeFile, errors);
  if (!markdown) return step;
  if (markdown.body.length === 0) issue(errors, relativeFile, "agent prompt body must not be empty");
  const metadata = parseStepMetadata(markdown, relativeFile, errors);
  if (!metadata) return step;
  const profile = resolveProfile(metadata.profile, defaultProfile, availableProfiles, relativeFile, errors);
  if (profile !== undefined) step.profile = profile;
  if (metadata.retries !== undefined) step.retries = metadata.retries;
  if (metadata.timeout !== undefined) step.timeout = metadata.timeout;
  return step;
}

function readCheckFile(
  root: string,
  directory: string,
  file: string,
  number: number,
  name: string,
  extension: string,
  defaultProfile: string | undefined,
  availableProfiles: ReadonlySet<string>,
  errors: WorkflowIssue[],
): CheckFile {
  const kind: WorkflowStepKind = extension === "md" ? "agent" : "command";
  const check: CheckFile = { number, name, file, kind };
  if (kind === "command") return check;

  const relativeFile = join(directory, file);
  const markdown = readMarkdown(join(root, directory, file), relativeFile, errors);
  if (!markdown) return check;
  if (markdown.body.length === 0) issue(errors, relativeFile, "judge prompt body must not be empty");
  const metadata = parseStepMetadata(markdown, relativeFile, errors);
  if (!metadata) return check;
  const profile = resolveProfile(metadata.profile, defaultProfile, availableProfiles, relativeFile, errors);
  if (profile !== undefined) check.profile = profile;
  if (metadata.retries !== undefined) check.retries = metadata.retries;
  if (metadata.timeout !== undefined) check.timeout = metadata.timeout;
  return check;
}

function readWorkflow(
  root: string,
  directory: string,
  availableProfiles: ReadonlySet<string>,
  errors: WorkflowIssue[],
): Workflow | undefined {
  const folder = join(root, directory);
  const contents = readdirSync(folder, { withFileTypes: true });
  const workflowFile = contents.find((entry) => entry.name === "workflow.md");
  let markdown: MarkdownDocument | undefined;
  let metadata: WorkflowMetadata | undefined;
  if (!workflowFile || !workflowFile.isFile()) {
    issue(errors, join(directory, "workflow.md"), "required file is missing or is not a regular file");
  } else {
    const metadataFile = join(directory, "workflow.md");
    markdown = readMarkdown(join(folder, "workflow.md"), metadataFile, errors);
    if (markdown) metadata = parseWorkflowMetadata(markdown, metadataFile, errors);
  if (markdown && markdown.body.length === 0) {
    issue(errors, join(directory, "workflow.md"), "workflow description body must not be empty");
  }
  }
  if (metadata?.profile !== undefined && !availableProfiles.has(metadata.profile)) {
    issue(errors, join(directory, "workflow.md"), `profile "${metadata.profile}" does not exist in agent_profiles`);
  }

  const stepFiles: StepFile[] = [];
  const checkFiles: CheckFile[] = [];
  for (const entry of contents) {
    if (entry.name === "workflow.md") continue;
    const relativeFile = join(directory, entry.name);
    if (!entry.isFile()) {
      issue(errors, relativeFile, "unknown file; workflow folders may contain only numbered steps and checks");
      continue;
    }
    const checkName = parseCheckName(entry.name);
    if (checkName) {
      checkFiles.push(readCheckFile(root, directory, entry.name, checkName.number, checkName.name, checkName.extension, metadata?.profile, availableProfiles, errors));
      continue;
    }
    const stepName = parseStepName(entry.name);
    if (!stepName) {
      issue(errors, relativeFile, "unknown file; expected N-name.md, N-name.sh, N-name.ts, or a matching check");
      continue;
    }
    stepFiles.push(readStepFile(root, directory, entry.name, stepName.number, stepName.name, stepName.extension, metadata?.profile, availableProfiles, errors));
  }

  if (stepFiles.length === 0) issue(errors, join(directory, "workflow.md"), "workflow must contain at least one step");
  stepFiles.sort((left, right) => left.number - right.number || left.file.localeCompare(right.file));
  const stepsByNumber = new Map<number, StepFile>();
  for (const step of stepFiles) {
    const previous = stepsByNumber.get(step.number);
    if (previous) {
      issue(errors, join(directory, step.file), `step number ${step.number} duplicates ${previous.file}; numbers must be unique`);
    } else {
      stepsByNumber.set(step.number, step);
    }
  }

  const checksByNumber = new Map<number, CheckFile>();
  for (const check of checkFiles) {
    const matching = stepsByNumber.get(check.number);
    if (!matching || matching.name !== check.name) {
      issue(errors, join(directory, check.file), `check does not match an existing step with number ${check.number} and name "${check.name}"`);
      continue;
    }
    const previous = checksByNumber.get(check.number);
    if (previous) {
      issue(errors, join(directory, check.file), `step ${matching.file} has more than one check (${previous.file}, ${check.file})`);
      continue;
    }
    checksByNumber.set(check.number, check);
  }

  if (!metadata || !markdown) return undefined;
  const steps: WorkflowStep[] = stepFiles.map((step) => {
    const check = checksByNumber.get(step.number);
    const workflowStep: WorkflowStep = {
      kind: step.kind,
      file: step.file,
      number: step.number,
      name: step.name,
    };
    if (step.profile !== undefined) workflowStep.profile = step.profile;
    if (step.retries !== undefined) workflowStep.retries = step.retries;
    if (step.timeout !== undefined) workflowStep.timeout = step.timeout;
    if (check) {
      const workflowCheck: WorkflowCheck = { kind: check.kind, file: check.file };
      if (check.profile !== undefined) workflowCheck.profile = check.profile;
      if (check.retries !== undefined) workflowCheck.retries = check.retries;
      if (check.timeout !== undefined) workflowCheck.timeout = check.timeout;
      workflowStep.check = workflowCheck;
    }
    return workflowStep;
  });

  return {
    name: directory,
    directory,
    cron: metadata.cron,
    ...(metadata.max_runs !== undefined ? { max_runs: metadata.max_runs } : {}),
    ...(metadata.enabled !== undefined ? { enabled: metadata.enabled } : {}),
    ...(metadata.profile !== undefined ? { profile: metadata.profile } : {}),
    ...(metadata.retries !== undefined ? { retries: metadata.retries } : {}),
    ...(metadata.timeout !== undefined ? { timeout: metadata.timeout } : {}),
    description: markdown.body,
    steps,
  };
}

export function loadWorkflows(
  root: string,
  availableProfiles: ReadonlySet<string>,
  options: WorkflowLoadOptions = {},
): WorkflowLoadResult {
  const absoluteRoot = resolve(root);
  const workflows: Workflow[] = [];
  const errors: WorkflowIssue[] = [];
  let entries;
  try {
    entries = readdirSync(absoluteRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    issue(errors, ".", `could not read workflow directory: ${error instanceof Error ? error.message : String(error)}`);
    return { workflows, errors };
  }

  for (const entry of entries) {
    if (entry.name === ".gitkeep" && entry.isFile()) continue;
    if (!entry.isDirectory()) {
      if (options.ignoreTopLevelYaml && entry.isFile() && /\.ya?ml$/i.test(entry.name)) continue;
      issue(errors, entry.name, "unknown file; expected one directory per workflow");
      continue;
    }

    const directory = entry.name;
    const before = errors.length;
    if (!namePattern.test(directory)) issue(errors, directory, "workflow name must use lowercase letters, digits, and hyphens");
    let workflow: Workflow | undefined;
    try {
      workflow = readWorkflow(absoluteRoot, directory, availableProfiles, errors);
    } catch (error) {
      issue(errors, directory, `could not read workflow: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (workflow && errors.length === before) workflows.push(workflow);
  }

  return { workflows, errors };
}
