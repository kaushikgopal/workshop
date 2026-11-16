import type { WorkflowDecision } from "./types.ts";

export type BlockedDecisionObservation = {
  phase: string;
  decisionNumber: number;
  mailboxOccupied: boolean;
  abortRequested: boolean;
  failure: {
    runId: string;
    step: string;
    attempt: number;
    lastOutput: string;
    retryProfiles: readonly string[];
  };
};

type FailureRoundBinding = { runId: string; step: string; attempt: number };

export type BlockedDecisionCommand =
  | { source: "chat"; decisionNumber: number; decision: WorkflowDecision }
  | { source: "round"; decisionNumber: number; decision: WorkflowDecision; round: FailureRoundBinding };

export type BlockedDecisionRejectionCode =
  | "stale_decision"
  | "choice_already_recorded"
  | "cancellation_in_progress"
  | "empty_output"
  | "incompatible_profile";

export type BlockedDecisionAcceptance =
  | { kind: "accepted" }
  | { kind: "rejected"; code: BlockedDecisionRejectionCode };

function rejected(code: BlockedDecisionRejectionCode): BlockedDecisionAcceptance {
  return { kind: "rejected", code };
}

export function acceptBlockedDecision(
  observation: BlockedDecisionObservation,
  command: BlockedDecisionCommand,
): BlockedDecisionAcceptance {
  if (observation.abortRequested) return rejected("cancellation_in_progress");
  if (command.decisionNumber !== observation.decisionNumber) return rejected("stale_decision");
  if (observation.phase === "decision") return rejected("choice_already_recorded");
  if (observation.phase !== "blocked") return rejected("stale_decision");
  if (observation.mailboxOccupied) return rejected("choice_already_recorded");
  if (command.source === "round" && (
    command.round.runId !== observation.failure.runId
    || command.round.step !== observation.failure.step
    || command.round.attempt !== observation.failure.attempt
  )) return rejected("stale_decision");
  if (command.decision.action === "accept" && observation.failure.lastOutput.trim().length === 0) {
    return rejected("empty_output");
  }
  if (command.decision.action === "retry" && command.decision.profile !== undefined
    && !observation.failure.retryProfiles.includes(command.decision.profile)) {
    return rejected("incompatible_profile");
  }
  return { kind: "accepted" };
}
