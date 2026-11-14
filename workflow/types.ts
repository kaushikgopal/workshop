export type WorkflowStepKind = "agent" | "command";

export type WorkflowCheck = {
  kind: WorkflowStepKind;
  file: string;
  profile?: string;
  retries?: number;
  timeout?: string;
};

export type WorkflowStep = {
  kind: WorkflowStepKind;
  file: string;
  number: number;
  name: string;
  profile?: string;
  retries?: number;
  timeout?: string;
  check?: WorkflowCheck;
};

export type Workflow = {
  name: string;
  directory: string;
  cron: string;
  max_runs?: number;
  enabled?: boolean;
  profile?: string;
  retries?: number;
  timeout?: string;
  description: string;
  steps: WorkflowStep[];
};

export type WorkflowIssue = { file: string; reason: string };

export type WorkflowLoadResult = {
  workflows: Workflow[];
  errors: WorkflowIssue[];
};

export type WorkflowLoadOptions = {
  ignoreTopLevelYaml?: boolean;
};
