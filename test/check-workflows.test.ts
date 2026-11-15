import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const exampleConfig = join(directory, "workshop.example.yaml");
  const localWorkflow = join(directory, "workflows", "local-check");
  const exampleWorkflow = join(directory, "examples", "workflows", "example-check");
  mkdirSync(localWorkflow, { recursive: true });
  mkdirSync(exampleWorkflow, { recursive: true });
  writeFileSync(config, [
    "agent_profiles:",
    "  local:",
    "    command: [node]",
    "orchestrator:",
    "  profile: local",
    "  escalation_profile: local",
    "",
  ].join("\n"));
  writeFileSync(exampleConfig, [
    "agent_profiles:",
    "  example:",
    "    command: [node]",
    "orchestrator:",
    "  profile: example",
    "  escalation_profile: example",
    "",
  ].join("\n"));
  writeFileSync(join(localWorkflow, "workflow.md"), "---\ncron: '* * * * *'\n---\nLocal fixture.\n");
  writeFileSync(join(localWorkflow, "10-draft.md"), "---\nprofile: local\n---\nDraft locally.\n");
  writeFileSync(join(exampleWorkflow, "workflow.md"), "---\ncron: '* * * * *'\n---\nExample fixture.\n");
  writeFileSync(join(exampleWorkflow, "10-draft.md"), "---\nprofile: example\n---\nDraft an example.\n");
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, WORKSHOP_CONFIG: config },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
