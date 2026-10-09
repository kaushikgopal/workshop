import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProofResult } from "../../src/proof/load-proof-result.js";
import { renderProofPrompt } from "../../src/proof/render-proof-prompt.js";

function resultFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "workshop-result-")), "result.json");
  writeFileSync(path, contents);
  return path;
}

const valid = { version: 1 as const, output: "The old man rowed.", summary: "", artifacts: [] };

test("the headless prompt names every required result key explicitly", () => {
  const prompt = renderProofPrompt({ runId: "run-1", nodeId: "generate", previousOutput: "", resultFile: "/result.json" });
  expect(prompt).toContain("four required top-level keys: version, output, summary, artifacts");
  expect(prompt).toContain("Do not omit version or artifacts");
});

test("result parsing rejects duplicate JSON keys, including escaped equivalents", () => {
  for (const duplicate of [
    '{"version":1,"output":"first","output":"second","summary":"","artifacts":[]}',
    '{"version":1,"output":"first","out\\u0070ut":"second","summary":"","artifacts":[]}',
  ]) {
    expect(() => loadProofResult(resultFile(duplicate))).toThrow("duplicate");
  }
});

test("result parsing preserves Unicode and escaped content", () => {
  const value = { ...valid, output: 'The sea said "שלום".\n🌊' };
  expect(loadProofResult(resultFile(JSON.stringify(value)))).toEqual(value);
});

test("result and field limits fail closed", () => {
  expect(() => loadProofResult(resultFile(" ".repeat(1024 * 1024 + 1)))).toThrow("exceeds 1 MiB");
  expect(() => loadProofResult(resultFile(JSON.stringify({ ...valid, summary: "é".repeat(32769) })))).toThrow("version-1 check");
  expect(() => loadProofResult(resultFile(JSON.stringify({ ...valid, artifacts: Array.from({ length: 101 }, () => ({ kind: "file", path: "quote.md" })) })))).toThrow("version-1 check");
  expect(() => loadProofResult(resultFile(JSON.stringify({ ...valid, artifacts: [{ kind: "file" }] })))).toThrow("version-1 check");
});

test("stop after a launch-intent crash does not claim confirmed cleanup", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "workshop-intent-stop-"));
  const root = new URL("../..", import.meta.url).pathname;
  const cli = join(root, "src/proof/prove-hemingway.ts");
  const crashed = spawnSync("bun", [cli, "--state-dir", stateDir], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, WORKSHOP_PROOF_CRASH_AFTER_INTENT: "1" },
  });
  expect(crashed.status).toBe(137);
  const stop = join(stateDir, "stop");
  writeFileSync(stop, "stop\n");
  const reopened = spawnSync("bun", [cli, "--state-dir", stateDir, "--stop-file", stop], {
    cwd: root, encoding: "utf8", timeout: 15000, env: process.env,
  });
  expect(reopened.status).toBe(2);
  const blocked = JSON.parse(reopened.stdout);
  expect(blocked.status).toBe("blocked");
  expect(blocked.cleanup.confirmed).toBe(false);
  expect(blocked.reason).toContain("identity unrecorded");
}, 30000);
