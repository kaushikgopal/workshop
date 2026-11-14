import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/check-workflows.ts");

test("workflow check uses local profiles for workflows and example profiles for shipped examples", () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-check-workflows-test-"));
  const config = join(directory, "workshop.yaml");
  writeFileSync(config, [
    "agent_profiles:",
    "  local:",
    "    command: [node]",
    "orchestrator:",
    "  profile: local",
    "  escalation_profile: local",
    "",
  ].join("\n"));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKSHOP_CONFIG: config },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
