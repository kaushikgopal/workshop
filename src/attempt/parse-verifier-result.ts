import { createHash } from "node:crypto";

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_REASON_BYTES = 64 * 1024;

export type VerifierDecision = "accept" | "retry" | "block";
export type VerifierResult = { decision: VerifierDecision; reason: string };
export type VerifierResultParse =
  | { ok: true; value: VerifierResult; sourceBytesHash: string }
  | { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } };

function invalidResult(message: string): VerifierResultParse {
  return { ok: false, failure: { kind: "result_invalid", message } };
}

/**
 * Exactly one exact decision line is deliberate; ignore analysis before it and read the reason after it.
 * This matches observed model behavior and stays unambiguous. Do not loosen it with case folding, Markdown stripping, or word search.
 * Do not restore first-line-only behavior without trial evidence.
 */
export function parseVerifierResult(bytes: Uint8Array): VerifierResultParse {
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    return { ok: false, failure: { kind: "result_too_large", message: "result exceeds 1 MiB" } };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalidResult("result is not valid UTF-8");
  }

  const lines = text.split("\n");
  let decisionLine = -1;
  let decision: VerifierDecision | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value !== "accept" && value !== "retry" && value !== "block") continue;
    if (decision !== undefined) {
      return invalidResult("verifier stdout must contain exactly one decision line; found several decision lines");
    }
    decisionLine = index;
    decision = value;
  }
  if (decision === undefined) {
    return invalidResult('verifier stdout must contain one line that is exactly "accept", "retry", or "block"');
  }
  const reason = lines.slice(decisionLine + 1).join("\n").trim();
  if (reason.length === 0) return invalidResult("verifier reason must be nonempty");
  if (new TextEncoder().encode(reason).byteLength > MAX_REASON_BYTES) {
    return invalidResult("verifier reason exceeds 64 KiB");
  }

  return {
    ok: true,
    value: { decision, reason },
    sourceBytesHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  };
}
