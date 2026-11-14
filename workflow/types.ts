export type WorkflowStepKind = "agent" | "command";

export type WorkflowDecision =
  | { action: "retry"; hint?: string; profile?: string; after?: string }
  | { action: "skip" }
  | { action: "accept" }
  | { action: "fail" };

export type OrchestratorDecision =
  | { action: "retry"; hint?: string; profile?: string; after?: string; note: string }
  | { action: "skip" | "accept" | "fail" | "give_up"; note: string };

export type AttemptHistoryEntry = {
  attempt: number;
  profile?: string;
  output: string;
  error?: string;
};

export type WorkflowStepResult = {
  step: string;
  status: "completed" | "skipped" | "nothing-to-do";
  output: string;
  attempts: AttemptHistoryEntry[];
};

export type WorkflowSnapshot = {
  workflow: Workflow;
  runDirectory: string;
  documents: Record<string, string>;
  files: Record<string, string>;
  contents: Record<string, string>;
  profileCommands: Record<string, string[]>;
  dataDirectory: string;
  stateDirectory: string;
};

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
