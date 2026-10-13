import { createHash } from "node:crypto";
import type { ProcessExit } from "../process/schema.js";

const FEEDBACK_LIMIT = 64 * 1024;
const TRUNCATION_LABEL = "\n[Feedback truncated to 64 KiB.]";

/** Bound feedback including its label without splitting a UTF-8 character. */
export function buildFailureFeedback(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= FEEDBACK_LIMIT) return text;
  const maximum = FEEDBACK_LIMIT - Buffer.byteLength(TRUNCATION_LABEL, "utf8");
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + TRUNCATION_LABEL;
}

/** Frame the exit and reason separately from raw stderr to avoid ambiguous concatenations. */
export function hashFailureEvidence(role: "worker" | "validator", exit: ProcessExit | null, stderr: Uint8Array, verifierReason: string | null): string {
  const identity = Buffer.from(JSON.stringify([role, exit]), "utf8");
  const reason = Buffer.from(verifierReason ?? "", "utf8");
  return "sha256:" + createHash("sha256")
    .update(identity.byteLength + ":").update(identity)
    .update(stderr.byteLength + ":").update(stderr)
    .update(reason.byteLength + ":").update(reason).digest("hex");
}
