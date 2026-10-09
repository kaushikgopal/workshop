import { readFileSync, statSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";

const RESULT_LIMIT = 1024 * 1024;
const SUMMARY_LIMIT = 64 * 1024;

export class ProofResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofResultError";
  }
}

/**
 * The common checked envelope a generate node writes:
 * `{version, output, summary, artifacts}`. Unknown keys are rejected, the
 * version is exact, and `output` must be non-empty because it is what the
 * next node reads.
 */
const GeneratedResultSchema = z.strictObject({
  version: z.literal(1),
  output: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= RESULT_LIMIT),
  summary: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= SUMMARY_LIMIT),
  artifacts: z.array(z.strictObject({
    kind: z.string().min(1),
    path: z.string().min(1).refine((value) => !value.includes("\u0000")),
  })).max(100),
});

export type GeneratedProofResult = z.infer<typeof GeneratedResultSchema>;

/**
 * Read and check the JSON a generate node leaves at WORKSHOP_RESULT_FILE.
 * A malformed or unreadable file throws, so the caller blocks the node rather
 * than publishing unchecked output.
 */
export function loadProofResult(path: string): GeneratedProofResult {
  let raw: string;
  try {
    if (statSync(path).size > RESULT_LIMIT) throw new ProofResultError("result file exceeds 1 MiB");
    raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > RESULT_LIMIT) throw new ProofResultError("result file exceeds 1 MiB");
  } catch (error) {
    if (error instanceof ProofResultError) throw error;
    throw new ProofResultError(`result file is unreadable: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProofResultError(`result file is not JSON: ${path}`);
  }
  // JSON is a YAML 1.2 subset; after checking JSON grammar, reuse the YAML
  // parser's duplicate-key check rather than JSON.parse's last-write-wins.
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length > 0) throw new ProofResultError("result JSON has duplicate or invalid object keys");
  const checked = GeneratedResultSchema.safeParse(parsed);
  if (!checked.success) {
    const detail = checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ProofResultError(`result JSON failed the version-1 check (${detail})`);
  }
  return checked.data;
}
