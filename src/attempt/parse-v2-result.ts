import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";

const MAX_RESULT_BYTES_V2 = 1024 * 1024;
const MAX_SUMMARY_BYTES_V2 = 64 * 1024;
const MAX_ARTIFACTS_V2 = 100;

function atMostUtf8Bytes(value: string, maximum: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maximum;
}

export const artifactInputV2Schema = z.strictObject({
  kind: z.string().min(1).refine((value) => value.isWellFormed(), "artifact kind must be well-formed Unicode"),
  path: z.string().min(1).refine(
    (value) => value.isWellFormed() && !value.includes("\u0000"),
    "artifact path must be well-formed Unicode without NUL",
  ),
});

/** Strict file contract emitted by a headless worker agent. */
export const workerResultV2Schema = z.strictObject({
  version: z.literal(1),
  output: z.string().min(1).refine(
    (value) => value.isWellFormed(),
    "output must be well-formed Unicode",
  ).refine(
    (value) => atMostUtf8Bytes(value, MAX_RESULT_BYTES_V2),
    "output must be at most 1 MiB in UTF-8",
  ),
  summary: z.string().refine(
    (value) => value.isWellFormed(),
    "summary must be well-formed Unicode",
  ).refine(
    (value) => atMostUtf8Bytes(value, MAX_SUMMARY_BYTES_V2),
    "summary must be at most 64 KiB in UTF-8",
  ),
  artifacts: z.array(artifactInputV2Schema).max(MAX_ARTIFACTS_V2),
});

/** Strict file contract emitted by a headless agent validator. */
export const validatorVerdictV2Schema = z.strictObject({
  version: z.literal(1),
  passed: z.boolean(),
  reason: z.string().min(1).refine(
    (value) => value.isWellFormed(),
    "reason must be well-formed Unicode",
  ).refine(
    (value) => atMostUtf8Bytes(value, MAX_SUMMARY_BYTES_V2),
    "reason must be at most 64 KiB in UTF-8",
  ),
});

export type ArtifactInputV2 = z.infer<typeof artifactInputV2Schema>;
export type WorkerResultV2 = z.infer<typeof workerResultV2Schema>;
export type ValidatorVerdictV2 = z.infer<typeof validatorVerdictV2Schema>;

export type ResultEnvelopeParseV2<T> =
  | { ok: true; value: T; sourceBytesHash: string }
  | { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } };

function invalidResult<T>(message: string): ResultEnvelopeParseV2<T> {
  return { ok: false, failure: { kind: "result_invalid", message } };
}

function invalidFileReadV2(message: string): {
  ok: false;
  failure: { kind: "result_invalid" | "result_too_large"; message: string };
} {
  return { ok: false, failure: { kind: "result_invalid", message } };
}

function schemaFailureSummaryV2(issues: readonly z.ZodIssue[]): string {
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
function parseEnvelopeBytesV2<T>(bytes: Uint8Array, schema: z.ZodType<T>, label: string): ResultEnvelopeParseV2<T> {
  if (bytes.byteLength > MAX_RESULT_BYTES_V2) {
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
    return invalidResult(`${label} has an invalid schema: ${schemaFailureSummaryV2(checked.error.issues)}`);
  }

  const sourceBytesHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { ok: true, value: checked.data, sourceBytesHash };
}

export function parseWorkerResultBytesV2(bytes: Uint8Array): ResultEnvelopeParseV2<WorkerResultV2> {
  return parseEnvelopeBytesV2(bytes, workerResultV2Schema, "worker result");
}

export function parseValidatorVerdictBytesV2(bytes: Uint8Array): ResultEnvelopeParseV2<ValidatorVerdictV2> {
  return parseEnvelopeBytesV2(bytes, validatorVerdictV2Schema, "validator verdict");
}

export function parseWorkerResultFileV2(path: string): ResultEnvelopeParseV2<WorkerResultV2> {
  const loaded = readResultFileBytesV2(path);
  return loaded.ok ? parseWorkerResultBytesV2(loaded.bytes) : loaded;
}

export function parseValidatorVerdictFileV2(path: string): ResultEnvelopeParseV2<ValidatorVerdictV2> {
  const loaded = readResultFileBytesV2(path);
  return loaded.ok ? parseValidatorVerdictBytesV2(loaded.bytes) : loaded;
}

function readResultFileBytesV2(path: string):
  | { ok: true; bytes: Buffer }
  | { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return invalidFileReadV2("result file is missing or unreadable");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return invalidFileReadV2("result path is not a regular file");
    if (before.size > MAX_RESULT_BYTES_V2) {
      return { ok: false, failure: { kind: "result_too_large", message: "result file exceeds 1 MiB" } };
    }
    const bytes = Buffer.allocUnsafe(MAX_RESULT_BYTES_V2 + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = readSync(fd, bytes, length, bytes.byteLength - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length > MAX_RESULT_BYTES_V2 || after.size > MAX_RESULT_BYTES_V2) {
      return { ok: false, failure: { kind: "result_too_large", message: "result file exceeds 1 MiB" } };
    }
    if (after.size !== length) return invalidFileReadV2("result file changed while being read");
    return { ok: true, bytes: Buffer.from(bytes.subarray(0, length)) };
  } catch {
    return invalidFileReadV2("result file is missing or unreadable");
  } finally {
    closeSync(fd);
  }
}
