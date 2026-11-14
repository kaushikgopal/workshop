import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateText, tool } from "ai";
import { z } from "zod";
import { createProfileModel } from "../agent/lib/create-profile-model.ts";

const fixture = fileURLToPath(new URL("./fixtures/respond-profile.mjs", import.meta.url));

function model(mode: string) {
  return createProfileModel([process.execPath, fixture, mode]);
}

test("profile model parses a JSON text reply from its command", async () => {
  const result = await generateText({ model: model("success"), prompt: "Say hello" });
  assert.equal(result.text, "fixture reply");
});

test("profile model preserves escaped JSON text, backslashes, and braces", async () => {
  const result = await generateText({ model: model("escaped-text"), prompt: "Say hello" });
  assert.equal(result.text, 'Quote " and slash \\ and braces {x}');
});

test("profile model converts a JSON tool-call reply", async () => {
  const result = await generateText({
    model: model("tool"),
    prompt: "List the latest runs",
    tools: {
      list_runs: tool({
        description: "List workflow runs.",
        inputSchema: z.object({ limit: z.number(), note: z.string() }),
      }),
    },
  });
  assert.deepEqual(result.toolCalls.map(({ toolName, input }) => ({ toolName, input })), [
    { toolName: "list_runs", input: { limit: 3, note: 'Quote " and slash \\ and braces {x}' } },
  ]);
});

test("profile model repairs one invalid JSON reply", async () => {
  const result = await generateText({ model: model("repair"), prompt: "Say hello" });
  assert.equal(result.text, "repaired reply");
});

test("profile model fails when the reply stays invalid after one repair", async () => {
  await assert.rejects(
    generateText({ model: model("always-invalid"), prompt: "Say hello" }),
    /invalid JSON reply after one repair attempt/,
  );
});

test("profile model treats a nonzero command exit as a model failure", async () => {
  await assert.rejects(
    generateText({ model: model("fail"), prompt: "Say hello" }),
    /Profile exited 7: fixture failure/,
  );
});

test("profile model rejects an empty argv", () => {
  assert.throws(() => createProfileModel([]), /must contain an executable/);
});
