/**
 * Shared shapes of the Hemingway durable proof. Pure declarations only: the
 * SQLite storage is the one authority, and every shape here is stored in it.
 */

export interface ProofInput {
  runId: string;
  stateDir: string;
  /** Commands run here, so a real Pi harness finds the project's config. */
  projectRoot: string;
  /** Shell template for the generate node. */
  agentCommand: string;
  timeoutMs: number;
}

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startId: string;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/** Durable declaration of a launch, committed before the process exists. */
export interface ProcessIntent {
  nodeId: string;
  command: string;
  startedAt: number;
  identity?: ProcessIdentity;
  exit?: ProcessExit;
}

export interface ProofResult {
  version: 1;
  status: "completed" | "blocked" | "failed" | "aborted";
  runId: string;
  taskId: number;
  /** Downstream output of the generate node, as published to the node output file. */
  output: string;
  /** Narrative the generate node returned alongside its output. */
  summary: string;
  /** Output of the timestamp node. */
  timestamp: string;
  artifacts: Array<{ kind: string; path: string }>;
  nodes: Array<{ id: string; output: string }>;
  cleanup?: { confirmed: boolean; pgid?: number };
  reason?: string;
}

export type ProofOutputs = Record<string, string>;
/** Narrative summaries keyed by node id, stored beside the node outputs. */
export type ProofSummaries = Record<string, string>;

export type PrepareCheckpoint = {
  phase: "prepare";
  nodeIndex: number;
  outputs: ProofOutputs;
  summaries: ProofSummaries;
};
export type LaunchCheckpoint = {
  phase: "launch";
  nodeIndex: number;
  outputs: ProofOutputs;
  summaries: ProofSummaries;
  /** Absent runs the node's worker; "validator" runs its validator command. */
  stage?: "validator";
  intent?: ProcessIntent;
};
export type SettleCheckpoint = {
  phase: "settle";
  nodeIndex: number;
  outputs: ProofOutputs;
  summaries: ProofSummaries;
  stage?: "validator";
  intent: ProcessIntent;
};

export type ProofCheckpoint = PrepareCheckpoint | LaunchCheckpoint | SettleCheckpoint;

export interface ProofNode {
  id: string;
  kind: "command" | "generate" | "archive";
  command: string;
  validator?: string;
}
