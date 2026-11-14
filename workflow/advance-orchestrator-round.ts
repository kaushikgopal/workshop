import type { OrchestratorDecision } from "./types.ts";

export type OrchestratorRound = 1 | 2;
export type OrchestratorRoundOutcome = "not-retried" | "retry-failed" | "retry-succeeded";
export type OrchestratorRoundAction =
  | { kind: "retry" }
  | { kind: "apply" }
  | { kind: "escalate"; nextRound: 2 }
  | { kind: "wait-for-user" };

export function advanceOrchestratorRound(
  round: OrchestratorRound,
  decision: OrchestratorDecision,
  outcome: OrchestratorRoundOutcome = "not-retried",
): OrchestratorRoundAction {
  if (decision.action === "give_up" || decision.action === "fail") {
    return round === 1 ? { kind: "escalate", nextRound: 2 } : { kind: "wait-for-user" };
  }
  if (decision.action !== "retry") return { kind: "apply" };
  if (outcome === "not-retried") return { kind: "retry" };
  if (outcome === "retry-succeeded") return { kind: "apply" };
  return round === 1 ? { kind: "escalate", nextRound: 2 } : { kind: "wait-for-user" };
}
