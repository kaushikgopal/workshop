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

/** Parse the strict first-line verifier decision and its bounded reason. */
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
  let decisionLine = 0;
  while (decisionLine < lines.length && lines[decisionLine]!.trim() === "") decisionLine += 1;
  const decision = lines[decisionLine]?.trim();
  if (decision !== "accept" && decision !== "retry" && decision !== "block") {
    return invalidResult('verifier stdout must start with a line "accept", "retry", or "block"');
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
