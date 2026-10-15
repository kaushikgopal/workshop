import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseTaggedWorkerResult, parseTextResult } from "../src/attempt/parse-tagged-result.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const invalidUtf8 = Uint8Array.of(0xc3, 0x28);
const fence = String.fromCharCode(96).repeat(3);
const worker = (status: string, content = "<output>work</output>") => "<status>" + status + "</status>\n" + content;

function expectInvalid(result: { ok: boolean; failure?: { kind: string } }, kind = "result_invalid") {
  expect(result.ok).toBe(false);
  expect(result.failure?.kind).toBe(kind);
}

describe("text result parsing", () => {
  test("keeps stdout byte-for-byte and hashes the source bytes", () => {
    const input = "<status>needs_input</status>\n<status>success_and_complete</status>\n<output>literal tags</output>";
    const source = bytes(input);
    const result = parseTextResult(source);
    expect(result).toEqual({
      ok: true,
      value: { status: "succeeded", output: input },
      sourceBytesHash: "sha256:" + createHash("sha256").update(source).digest("hex"),
    });
  });

  test("accepts empty stdout", () => {
    expect(parseTextResult(new Uint8Array())).toMatchObject({ ok: true, value: { status: "succeeded", output: "" } });
  });

  test("rejects oversized stdout before decoding", () => {
    expectInvalid(parseTextResult(new Uint8Array(1024 * 1024 + 1)), "result_too_large");
  });

  test("rejects invalid UTF-8", () => {
    expectInvalid(parseTextResult(invalidUtf8));
  });
});

describe("tagged worker result parsing", () => {
  test("parses the minimal succeeded result", () => {
    expect(parseTaggedWorkerResult(bytes(worker("succeeded")))).toMatchObject({
      ok: true,
      value: { status: "succeeded", reason: null, question: null, output: "work", preamble: "", trailer: "" },
    });
  });

  test("accepts each worker status and preserves optional fields", () => {
    expect(parseTaggedWorkerResult(bytes(worker("success_and_complete", "<reason>done</reason>\n<output>work</output>"))))
      .toMatchObject({ ok: true, value: { status: "success_and_complete", reason: "done", question: null } });
    expect(parseTaggedWorkerResult(bytes(
      "<status>needs_input</status>\n<question>Which option?</question>\n<output>proposal</output>",
    ))).toMatchObject({ ok: true, value: { status: "needs_input", question: "Which option?", output: "proposal" } });
  });

  test("keeps preamble, trailer, and a Markdown fence outside the result", () => {
    const result = parseTaggedWorkerResult(bytes(
      "model preface\n" + fence + "text\n<status>succeeded</status>\n<output>answer</output>\n" + fence + "\n",
    ));
    expect(result).toMatchObject({
      ok: true,
      value: { preamble: "model preface\n" + fence + "text\n", output: "answer", trailer: "\n" + fence + "\n" },
    });
  });

  test("uses the last output closing tag so output can contain closing-tag text", () => {
    const result = parseTaggedWorkerResult(bytes(
      "<status>succeeded</status>\n<output>first\n</output>\nsecond\n</output>\ntrailer",
    ));
    expect(result).toMatchObject({ ok: true, value: { output: "first\n</output>\nsecond", trailer: "\ntrailer" } });
  });

  test("allows empty output except for needs_input", () => {
    expect(parseTaggedWorkerResult(bytes("<status>succeeded</status><output></output>")))
      .toMatchObject({ ok: true, value: { output: "" } });
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>needs_input</status><question>Question?</question><output> \n </output>",
    )));
  });

  test("requires a nonempty question for needs_input and forbids it otherwise", () => {
    expectInvalid(parseTaggedWorkerResult(bytes("<status>needs_input</status><output>proposal</output>")));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>needs_input</status><question> \t </question><output>proposal</output>",
    )));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>succeeded</status><question>Question?</question><output>work</output>",
    )));
  });

  test("rejects duplicate, out-of-order, unknown, and non-whitespace inter-block content", () => {
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>succeeded</status><reason>first</reason><reason>duplicate</reason><output>work</output>",
    )));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>needs_input</status><question>Question?</question><reason>late</reason><output>work</output>",
    )));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>succeeded</status><unknown>x</unknown><output>work</output>",
    )));
    expectInvalid(parseTaggedWorkerResult(bytes("<status>succeeded</status>junk<output>work</output>")));
  });

  test("rejects a missing status, unknown status, and opening tags with attributes", () => {
    expectInvalid(parseTaggedWorkerResult(bytes("preface only")));
    expectInvalid(parseTaggedWorkerResult(bytes("<succeeded>work</succeeded>")));
    expectInvalid(parseTaggedWorkerResult(bytes(worker("waiting"))));
    expectInvalid(parseTaggedWorkerResult(bytes("<status x=1>succeeded</status><output>work</output>")));
  });

  test("trims status values and strips one LF or CRLF at each block boundary", () => {
    expect(parseTaggedWorkerResult(bytes(
      "<status>  succeeded \t</status>\n<output>\n  content\n</output>",
    ))).toMatchObject({ ok: true, value: { status: "succeeded", output: "  content" } });
    expect(parseTaggedWorkerResult(bytes(
      "<status>\r\nsucceeded\r\n</status>\r\n<output>\r\ntext\r\n</output>",
    ))).toMatchObject({ ok: true, value: { status: "succeeded", output: "text" } });
  });

  test("requires the opening tag at column zero", () => {
    expectInvalid(parseTaggedWorkerResult(bytes(" <status>succeeded</status>\n<output>work</output>")));
  });

  test("rejects oversized stdout, invalid UTF-8, empty fields, and oversized fields", () => {
    expectInvalid(parseTaggedWorkerResult(new Uint8Array(1024 * 1024 + 1)), "result_too_large");
    expectInvalid(parseTaggedWorkerResult(invalidUtf8));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>succeeded</status><reason> \n </reason><output>work</output>",
    )));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>succeeded</status><reason>" + "x".repeat(64 * 1024 + 1) + "</reason><output>work</output>",
    )));
    expectInvalid(parseTaggedWorkerResult(bytes(
      "<status>needs_input</status><question>" + "x".repeat(64 * 1024 + 1) + "</question><output>work</output>",
    )));
  });
});
