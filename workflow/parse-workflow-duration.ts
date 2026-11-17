const maxTimerMilliseconds = 2_147_483_647;

export type WorkflowDurationParseResult =
  | { kind: "valid"; milliseconds: number }
  | { kind: "invalid" }
  | { kind: "too-large" };

export function parseWorkflowDuration(value: string): WorkflowDurationParseResult {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) return { kind: "invalid" };

  const amountText = match[1];
  const unit = match[2];
  if (amountText === undefined || unit === undefined) return { kind: "invalid" };

  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount)) return { kind: "too-large" };

  const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * factor;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maxTimerMilliseconds) return { kind: "too-large" };
  return { kind: "valid", milliseconds };
}
