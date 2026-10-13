import { createHash } from "node:crypto";

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_FIELD_BYTES = 64 * 1024;

export type ResultParse<T> =
  | { ok: true; value: T; sourceBytesHash: string }
  | { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } };

export type TextResult = { status: "succeeded"; output: string };

export type TaggedWorkerResult = {
  status: "succeeded" | "success_and_complete" | "needs_input";
  reason: string | null;
  question: string | null;
  output: string;
  preamble: string;
  trailer: string;
};

export type TaggedVerifierDecision = {
  decision: "accept" | "retry" | "block";
  reason: string;
  corrections: string | null;
  preamble: string;
  trailer: string;
};

type DecodedResult = { text: string; sourceBytesHash: string };
type ParseFailure = { ok: false; failure: { kind: "result_invalid" | "result_too_large"; message: string } };

function invalidResult<T>(message: string): ResultParse<T> {
  return { ok: false, failure: { kind: "result_invalid", message } };
}

function decodeResult(bytes: Uint8Array): DecodedResult | ParseFailure {
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    return { ok: false, failure: { kind: "result_too_large", message: "result exceeds 1 MiB" } };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, failure: { kind: "result_invalid", message: "result is not valid UTF-8" } };
  }

  const sourceBytesHash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  return { text, sourceBytesHash };
}

export function parseTextResult(bytes: Uint8Array): ResultParse<TextResult> {
  const decoded = decodeResult(bytes);
  if ("ok" in decoded) return decoded;
  return { ok: true, value: { status: "succeeded", output: decoded.text }, sourceBytesHash: decoded.sourceBytesHash };
}

function findOpeningLine(text: string, openingTag: string): number {
  let lineStart = 0;
  while (lineStart <= text.length) {
    if (text.startsWith(openingTag, lineStart)) return lineStart;
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) return -1;
    lineStart = newline + 1;
  }
  return -1;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")) {
    index += 1;
  }
  return index;
}

function stripBoundaryNewlines(value: string): string {
  let stripped = value;
  if (stripped.startsWith("\r\n")) stripped = stripped.slice(2);
  else if (stripped.startsWith("\n")) stripped = stripped.slice(1);
  if (stripped.endsWith("\r\n")) stripped = stripped.slice(0, -2);
  else if (stripped.endsWith("\n")) stripped = stripped.slice(0, -1);
  return stripped;
}

type Block = { value: string; end: number };

function firstBlock(text: string, start: number, name: string): Block | null {
  const opening = "<" + name + ">";
  const closing = "</" + name + ">";
  if (!text.startsWith(opening, start)) return null;
  const bodyStart = start + opening.length;
  const closeStart = text.indexOf(closing, bodyStart);
  if (closeStart === -1) return null;
  return { value: stripBoundaryNewlines(text.slice(bodyStart, closeStart)), end: closeStart + closing.length };
}

function lastBlock(text: string, start: number, name: string): Block | null {
  const opening = "<" + name + ">";
  const closing = "</" + name + ">";
  if (!text.startsWith(opening, start)) return null;
  const bodyStart = start + opening.length;
  const closeStart = text.lastIndexOf(closing);
  if (closeStart < bodyStart) return null;
  return { value: stripBoundaryNewlines(text.slice(bodyStart, closeStart)), end: closeStart + closing.length };
}

function hasNonWhitespaceText(value: string): boolean {
  return value.trim().length > 0;
}

function withinFieldLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_FIELD_BYTES;
}

export function parseTaggedWorkerResult(bytes: Uint8Array): ResultParse<TaggedWorkerResult> {
  const decoded = decodeResult(bytes);
  if ("ok" in decoded) return decoded;
  const { text, sourceBytesHash } = decoded;
  const statusStart = findOpeningLine(text, "<status>");
  if (statusStart === -1) return invalidResult("worker result has no status block");

  const statusBlock = firstBlock(text, statusStart, "status");
  if (!statusBlock) return invalidResult("worker status block is incomplete");
  const status = statusBlock.value.trim();
  if (status !== "succeeded" && status !== "success_and_complete" && status !== "needs_input") {
    return invalidResult("worker status is unknown");
  }

  let position = skipWhitespace(text, statusBlock.end);
  let reason: string | null = null;
  let question: string | null = null;

  if (text.startsWith("<reason>", position)) {
    const block = firstBlock(text, position, "reason");
    if (!block || !hasNonWhitespaceText(block.value) || !withinFieldLimit(block.value)) {
      return invalidResult("worker reason is invalid");
    }
    reason = block.value;
    position = skipWhitespace(text, block.end);
  }

  if (text.startsWith("<question>", position)) {
    if (status !== "needs_input") return invalidResult("question is only valid for needs_input");
    const block = firstBlock(text, position, "question");
    if (!block || !hasNonWhitespaceText(block.value) || !withinFieldLimit(block.value)) {
      return invalidResult("worker question is invalid");
    }
    question = block.value;
    position = skipWhitespace(text, block.end);
  } else if (status === "needs_input") {
    return invalidResult("needs_input requires a question block");
  }

  if (!text.startsWith("<output>", position)) return invalidResult("worker output block is missing or misplaced");
  const outputBlock = lastBlock(text, position, "output");
  if (!outputBlock) return invalidResult("worker output block is incomplete");
  if (status === "needs_input" && !hasNonWhitespaceText(outputBlock.value)) {
    return invalidResult("needs_input requires nonempty output");
  }

  return {
    ok: true,
    value: {
      status,
      reason,
      question,
      output: outputBlock.value,
      preamble: text.slice(0, statusStart),
      trailer: text.slice(outputBlock.end),
    },
    sourceBytesHash,
  };
}

export function parseTaggedVerifierDecision(bytes: Uint8Array): ResultParse<TaggedVerifierDecision> {
  const decoded = decodeResult(bytes);
  if ("ok" in decoded) return decoded;
  const { text, sourceBytesHash } = decoded;
  const decisionStart = findOpeningLine(text, "<decision>");
  if (decisionStart === -1) return invalidResult("verifier result has no decision block");

  const decisionBlock = firstBlock(text, decisionStart, "decision");
  if (!decisionBlock) return invalidResult("verifier decision block is incomplete");
  const decision = decisionBlock.value.trim();
  if (decision !== "accept" && decision !== "retry" && decision !== "block") {
    return invalidResult("verifier decision is unknown");
  }

  const reasonStart = skipWhitespace(text, decisionBlock.end);
  if (!text.startsWith("<reason>", reasonStart)) return invalidResult("verifier reason block is missing or misplaced");
  const firstReason = firstBlock(text, reasonStart, "reason");
  if (!firstReason) return invalidResult("verifier reason block is incomplete");

  const nextBlock = skipWhitespace(text, firstReason.end);
  let reason: string;
  let corrections: string | null = null;
  let end: number;
  if (text.startsWith("<corrections>", nextBlock)) {
    if (decision !== "retry") return invalidResult("corrections are only valid for retry");
    reason = firstReason.value;
    const correctionsBlock = lastBlock(text, nextBlock, "corrections");
    if (!correctionsBlock) return invalidResult("verifier corrections block is incomplete");
    corrections = correctionsBlock.value;
    end = correctionsBlock.end;
  } else {
    // Without corrections, reason is the last block and uses its final closing tag.
    const lastReason = lastBlock(text, reasonStart, "reason");
    if (!lastReason) return invalidResult("verifier reason block is incomplete");
    reason = lastReason.value;
    end = lastReason.end;
  }

  if (!hasNonWhitespaceText(reason) || !withinFieldLimit(reason)) return invalidResult("verifier reason is invalid");
  if (corrections !== null && (!hasNonWhitespaceText(corrections) || !withinFieldLimit(corrections))) {
    return invalidResult("verifier corrections are invalid");
  }

  return {
    ok: true,
    value: { decision, reason, corrections, preamble: text.slice(0, decisionStart), trailer: text.slice(end) },
    sourceBytesHash,
  };
}
