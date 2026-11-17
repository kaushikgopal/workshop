import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflowDuration } from "../workflow/parse-workflow-duration.ts";

test("parses supported units and enforces Node timer limits", () => {
  for (const [value, milliseconds] of [["1s", 1_000], ["3m", 180_000], ["2h", 7_200_000]] as const) {
    assert.deepEqual(parseWorkflowDuration(value), { kind: "valid", milliseconds });
  }
  assert.deepEqual(parseWorkflowDuration("2147483s"), { kind: "valid", milliseconds: 2_147_483_000 });
  assert.deepEqual(parseWorkflowDuration("2147484s"), { kind: "too-large" });
  assert.deepEqual(parseWorkflowDuration("0s"), { kind: "invalid" });
  assert.deepEqual(parseWorkflowDuration("01m"), { kind: "invalid" });
  assert.deepEqual(parseWorkflowDuration("9999999999999999999999999h"), { kind: "too-large" });
});
