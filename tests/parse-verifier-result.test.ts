import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseVerifierResult } from "../src/attempt/parse-verifier-result.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const invalidUtf8 = Uint8Array.of(0xc3, 0x28);

function expectInvalid(result: { ok: boolean; failure?: { kind: string; message: string } }, message?: string) {
  expect(result.ok).toBe(false);
  expect(result.failure?.kind).toBe("result_invalid");
  if (message !== undefined) expect(result.failure?.message).toBe(message);
}

describe("verifier stdout parsing", () => {
  test("accepts every decision with a required reason", () => {
    for (const decision of ["accept", "retry", "block"] as const) {
      const input = bytes(decision + "\nwhy");
      expect(parseVerifierResult(input)).toEqual({
        ok: true,
        value: { decision, reason: "why" },
        sourceBytesHash: "sha256:" + createHash("sha256").update(input).digest("hex"),
      });
    }
  });

  test("allows analysis and leading blank lines before the decision", () => {
    expect(parseVerifierResult(bytes("analysis\n\n \t\r\n  retry \t\r\n  change the candidate  \n "))).toMatchObject({
      ok: true,
      value: { decision: "retry", reason: "change the candidate" },
    });
  });

  test("allows a leading decision and keeps a reason prefix", () => {
    expect(parseVerifierResult(bytes("accept\nreason: looks good"))).toMatchObject({
      ok: true,
      value: { decision: "accept", reason: "reason: looks good" },
    });
  });

  test("rejects zero or several decision lines", () => {
    expectInvalid(
      parseVerifierResult(bytes("explanation\nno decision here")),
      'verifier stdout must contain one line that is exactly "accept", "retry", or "block"',
    );
    expectInvalid(
      parseVerifierResult(bytes("analysis\naccept\nretry\nwhy")),
      "verifier stdout must contain exactly one decision line; found several decision lines",
    );
    expectInvalid(
      parseVerifierResult(bytes("accept\naccept\nwhy")),
      "verifier stdout must contain exactly one decision line; found several decision lines",
    );
  });

  test("rejects a decision on the last line without a reason", () => {
    expectInvalid(parseVerifierResult(bytes("analysis\naccept")), "verifier reason must be nonempty");
    expectInvalid(parseVerifierResult(bytes("accept\n \t\n")), "verifier reason must be nonempty");
  });

  test("rejects legacy tagged output and non-exact decision lines", () => {
    const message = 'verifier stdout must contain one line that is exactly "accept", "retry", or "block"';
    expectInvalid(parseVerifierResult(bytes("<decision>accept</decision>\n<reason>why</reason>")), message);
    expectInvalid(parseVerifierResult(bytes("Accept\nwhy")), message);
    expectInvalid(parseVerifierResult(bytes("**accept**\nwhy")), message);
    expectInvalid(parseVerifierResult(bytes("The word accept appears here.\nwhy")), message);
  });

  test("accepts CRLF input and trims surrounding line whitespace", () => {
    expect(parseVerifierResult(bytes("analysis\r\n  block \t\r\n  needs work  \r\n details \r\n"))).toMatchObject({
      ok: true,
      value: { decision: "block", reason: "needs work  \r\n details" },
    });
  });

  test("bounds the reason, total stdout, and UTF-8 input", () => {
    expectInvalid(parseVerifierResult(bytes("accept\n" + "x".repeat(64 * 1024 + 1))), "verifier reason exceeds 64 KiB");
    const tooLarge = new Uint8Array(1024 * 1024 + 1);
    expect(parseVerifierResult(tooLarge)).toMatchObject({
      ok: false,
      failure: { kind: "result_too_large", message: "result exceeds 1 MiB" },
    });
    expectInvalid(parseVerifierResult(invalidUtf8), "result is not valid UTF-8");
  });
});
