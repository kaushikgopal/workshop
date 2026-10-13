import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 100;

function atMostUtf8Bytes(value: string, maximum: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maximum;
}

export const artifactInputSchema = z.strictObject({
  kind: z.string().min(1).refine((value) => value.isWellFormed(), "artifact kind must be well-formed Unicode"),
  path: z.string().min(1).refine(
    (value) => value.isWellFormed() && !value.includes("\u0000"),
    "artifact path must be well-formed Unicode without NUL",
  ),
});

/** Strict file contract emitted by a headless worker agent. */
export const workerResultSchema = z.strictObject({
  version: z.literal(1),
  output: z.string().min(1).refine(
    (value) => value.isWellFormed(),
    "output must be well-formed Unicode",
  ).refine(
    (value) => atMostUtf8Bytes(value, MAX_RESULT_BYTES),
    "output must be at most 1 MiB in UTF-8",
  ),
  summary: z.string().refine(
    (value) => value.isWellFormed(),
    "summary must be well-formed Unicode",
  ).refine(
    (value) => atMostUtf8Bytes(value, MAX_SUMMARY_BYTES),
    "summary must be at most 64 KiB in UTF-8",
  ),
  artifacts: z.array(artifactInputSchema).max(MAX_ARTIFACTS),
});

/** Strict file contract emitted by a headless agent validator. */
export const validatorVerdictSchema = z.strictObject({
  version: z.literal(1),
  passed: z.boolean(),
  reason: z.string().min(1).refine(
    (value) => value.isWellFormed(),
    "reason must be well-formed Unicode",
  ).refine(
    (value) => atMostUtf8Bytes(value, MAX_SUMMARY_BYTES),
    "reason must be at most 64 KiB in UTF-8",
  ),
});

type WorkerResult = z.infer<typeof workerResultSchema>;
type ValidatorVerdict = z.infer<typeof validatorVerdictSchema>;

type ResultEnvelopeParse<T> =
  | { ok: true; value: T; sourceBytesHash: string }
  | { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } };

function invalidResult<T>(message: string): ResultEnvelopeParse<T> {
  return { ok: false, failure: { kind: "result_invalid", message } };
}

function invalidFileRead(message: string): {
  ok: false;
  failure: { kind: "result_invalid" | "result_too_large"; message: string };
} {
  return { ok: false, failure: { kind: "result_invalid", message } };
}

function schemaFailureSummary(issues: readonly z.ZodIssue[]): string {
  const shown = issues.slice(0, 5).map((issue) => {
    const path = issue.path.map((part) => {
      if (typeof part === "number") return `[${part}]`;
      return typeof part === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(part) ? part : "<key>";
    }).join(".") || "<root>";
    return `${issue.code} at ${path}`;
  });
  if (issues.length > shown.length) shown.push(`${issues.length - shown.length} more issue(s)`);
  return shown.join("; ").slice(0, 512);
}

/** Parse bounded strict UTF-8 JSON, rejecting duplicate keys before returning checked data. */
function parseEnvelopeBytes<T>(bytes: Uint8Array, schema: z.ZodType<T>, label: string): ResultEnvelopeParse<T> {
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    return { ok: false, failure: { kind: "result_too_large", message: "result file exceeds 1 MiB" } };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalidResult("result file is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidResult("result file is not valid JSON");
  }

  let hasDuplicateOrInvalidKeys: boolean;
  try {
    hasDuplicateOrInvalidKeys = parseDocument(text, { uniqueKeys: true }).errors.length > 0;
  } catch {
    return invalidResult("result JSON object keys could not be validated");
  }
  if (hasDuplicateOrInvalidKeys) {
    return invalidResult("result JSON contains duplicate or invalid object keys");
  }

  const checked = schema.safeParse(value);
  if (!checked.success) {
    return invalidResult(`${label} has an invalid schema: ${schemaFailureSummary(checked.error.issues)}`);
  }

  const sourceBytesHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { ok: true, value: checked.data, sourceBytesHash };
}

export function parseWorkerResultBytes(bytes: Uint8Array): ResultEnvelopeParse<WorkerResult> {
  return parseEnvelopeBytes(bytes, workerResultSchema, "worker result");
}

export function parseValidatorVerdictBytes(bytes: Uint8Array): ResultEnvelopeParse<ValidatorVerdict> {
  return parseEnvelopeBytes(bytes, validatorVerdictSchema, "validator verdict");
}

export function parseWorkerResultFile(path: string): ResultEnvelopeParse<WorkerResult> {
  const loaded = readResultFileBytes(path);
  return loaded.ok ? parseWorkerResultBytes(loaded.bytes) : loaded;
}

export function parseValidatorVerdictFile(path: string): ResultEnvelopeParse<ValidatorVerdict> {
  const loaded = readResultFileBytes(path);
  return loaded.ok ? parseValidatorVerdictBytes(loaded.bytes) : loaded;
}

export function readResultFileBytes(path: string):
  | { ok: true; bytes: Buffer }
  | { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return invalidFileRead("result file is missing or unreadable");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return invalidFileRead("result path is not a regular file");
    if (before.size > MAX_RESULT_BYTES) {
      return { ok: false, failure: { kind: "result_too_large", message: "result file exceeds 1 MiB" } };
    }
    const bytes = Buffer.allocUnsafe(MAX_RESULT_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = readSync(fd, bytes, length, bytes.byteLength - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length > MAX_RESULT_BYTES || after.size > MAX_RESULT_BYTES) {
      return { ok: false, failure: { kind: "result_too_large", message: "result file exceeds 1 MiB" } };
    }
    if (after.size !== length) return invalidFileRead("result file changed while being read");
    return { ok: true, bytes: Buffer.from(bytes.subarray(0, length)) };
  } catch {
    return invalidFileRead("result file is missing or unreadable");
  } finally {
    closeSync(fd);
  }
}
