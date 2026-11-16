import type { OrchestratorRound } from "./advance-orchestrator-round.ts";
import type { ProcessExecutionResult } from "./interpret-workflow.ts";

export type OrchestratorRoundRequest = {
  workflow: string;
  runId: string;
  profile: string;
  round: OrchestratorRound;
  input: string;
  step: string;
  timeoutMs?: number;
  allowedRetryProfiles: string[];
  lastOutput: string;
  signal: AbortSignal;
};

export async function executeOrchestratorRound(_request: OrchestratorRoundRequest): Promise<ProcessExecutionResult> {
  const error = "Automatic failure decisions are not available in this Workshop build";
  return { exitCode: 1, stdout: "", stderr: error, timedOut: false, error };
}
