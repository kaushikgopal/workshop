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

  test("allows leading blank lines and trims the decision and reason", () => {
    expect(parseVerifierResult(bytes("\n \t\r\n  retry \t\r\n  change the candidate  \n "))).toMatchObject({
      ok: true,
      value: { decision: "retry", reason: "change the candidate" },
    });
  });

  test("rejects a missing or whitespace-only reason", () => {
    expectInvalid(parseVerifierResult(bytes("accept")), "verifier reason must be nonempty");
    expectInvalid(parseVerifierResult(bytes("accept\n \t\n")), "verifier reason must be nonempty");
  });

  test("rejects text before the decision and legacy tagged output", () => {
    const message = 'verifier stdout must start with a line "accept", "retry", or "block"';
    expectInvalid(parseVerifierResult(bytes("explanation\naccept\nwhy")), message);
    expectInvalid(parseVerifierResult(bytes("<decision>accept</decision>\n<reason>why</reason>")), message);
  });

  test("does not fold case or strip Markdown", () => {
    const message = 'verifier stdout must start with a line "accept", "retry", or "block"';
    expectInvalid(parseVerifierResult(bytes("Accept\nwhy")), message);
    expectInvalid(parseVerifierResult(bytes("**accept**\nwhy")), message);
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
