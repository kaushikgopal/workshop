export function buildDecisionToken(runId: string, step: string, decisionNumber: number): string {
  if (!Number.isSafeInteger(decisionNumber) || decisionNumber < 1) throw new Error("decision number must be a positive safe integer");
  return `workshop-decision:${runId}:${step}:${decisionNumber}`;
}
