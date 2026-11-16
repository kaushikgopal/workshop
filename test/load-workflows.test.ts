import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflows } from "../workflow/load-workflows.ts";

const profiles = new Set(["writer", "judge"]);

function withRoot(check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "workshop-workflow-test-"));
  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function workflowText(fields = 'cron: "*/5 * * * *"\nprofile: writer', description = "Describe this workflow."): string {
  return `---\n${fields}\n---\n\n${description}\n`;
}

function createWorkflow(root: string, name = "clock", fields?: string, description?: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workflow.md"), workflowText(fields, description));
  return directory;
}

function writeStep(directory: string, file: string, content = ""): void {
  writeFileSync(join(directory, file), content);
}

function agentMarkdown(profile = "writer", prompt = "Write one useful line.", extra = ""): string {
  return `---\nprofile: ${profile}${extra}\n---\n\n${prompt}\n`;
}

function errorReasons(result: ReturnType<typeof loadWorkflows>, file?: string): string[] {
  return result.errors.filter((entry) => file === undefined || entry.file === file).map((entry) => entry.reason);
}

test("loads a folder workflow with ordered steps, profile inheritance, and all check kinds", () => {
  withRoot((root) => {
    const directory = createWorkflow(root, "hemingway-clock", [
      'cron: "*/3 * * * *"',
      "max_runs: 8",
      "enabled: true",
      "profile: writer",
      "retries: 1",
      "timeout: 2h",
    ].join("\n"), "Create and save one original line.");
    writeStep(directory, "030-save.ts", "process.stdout.write('saved');\n");
    writeStep(directory, "010-fetch.sh", "printf input\n");
    writeStep(directory, "020-draft.md", agentMarkdown("writer", "Write one original sentence.", "\nretries: 2\ntimeout: 10m"));
    writeStep(directory, "020-draft.check.md", agentMarkdown("judge", "Judge the sentence.", "\nretries: 0\ntimeout: 30s"));
    writeStep(directory, "010-fetch.check.sh", "exit 0\n");
    writeStep(directory, "030-save.check.ts", "process.exit(0);\n");

    const result = loadWorkflows(root, profiles);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.workflows, [{
      name: "hemingway-clock",
      directory: "hemingway-clock",
      cron: "*/3 * * * *",
      max_runs: 8,
      enabled: true,
      profile: "writer",
      retries: 1,
      timeout: "2h",
      description: "Create and save one original line.",
      steps: [
        {
          kind: "command",
          file: "010-fetch.sh",
          number: 10,
          name: "fetch",
          check: { kind: "command", file: "010-fetch.check.sh" },
        },
        {
          kind: "agent",
          file: "020-draft.md",
          number: 20,
          name: "draft",
          profile: "writer",
          retries: 2,
          timeout: "10m",
          check: { kind: "agent", file: "020-draft.check.md", profile: "judge", retries: 0, timeout: "30s" },
        },
        {
          kind: "command",
          file: "030-save.ts",
          number: 30,
          name: "save",
          check: { kind: "command", file: "030-save.check.ts" },
        },
      ],
    }]);
  });
});

test("accepts numbering gaps and leading zeroes, and sorts steps numerically", () => {
  withRoot((root) => {
    const directory = createWorkflow(root);
    writeStep(directory, "30-last.sh");
    writeStep(directory, "010-first.sh");
    const result = loadWorkflows(root, profiles);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.workflows[0]?.steps.map(({ number, name }) => [number, name]), [[10, "first"], [30, "last"]]);
  });
});

test("rejects workflows with no steps or an empty description", () => {
  withRoot((root) => {
    createWorkflow(root, "no-steps", undefined, "A workflow description.");
    const emptyDescription = createWorkflow(root, "empty-description", undefined, "");
    writeStep(emptyDescription, "10-step.sh");
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result, "no-steps/workflow.md").join(" "), /at least one step/);
    assert.match(errorReasons(result, "empty-description/workflow.md").join(" "), /description body must not be empty/);
  });
});

test("rejects duplicate numeric steps even when their leading zeroes differ", () => {
  withRoot((root) => {
    const directory = createWorkflow(root);
    writeStep(directory, "10-first.sh");
    writeStep(directory, "010-second.ts");
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result).join(" "), /step number 10 duplicates/);
  });
});

test("requires a valid lowercase workflow folder name and workflow.md", () => {
  withRoot((root) => {
    mkdirSync(join(root, "Bad_Name"));
    mkdirSync(join(root, "missing-workflow"));
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result, "Bad_Name").join(" "), /lowercase letters, digits, and hyphens/);
    assert.match(errorReasons(result, "Bad_Name/workflow.md").join(" "), /required file is missing/);
    assert.match(errorReasons(result, "missing-workflow/workflow.md").join(" "), /required file is missing/);
  });
});

test("rejects unknown root and workflow files", () => {
  withRoot((root) => {
    const directory = createWorkflow(root);
    writeFileSync(join(root, "notes.txt"), "not a workflow");
    writeFileSync(join(directory, "notes.txt"), "unknown");
    mkdirSync(join(directory, "nested"));
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result, "notes.txt").join(" "), /expected one directory per workflow/);
    assert.match(errorReasons(result, "clock/notes.txt").join(" "), /unknown file/);
    assert.match(errorReasons(result, "clock/nested").join(" "), /unknown file/);
  });
});

test("rejects malformed step names while allowing only lowercase letters, digits, and hyphens", () => {
  withRoot((root) => {
    const directory = createWorkflow(root);
    writeStep(directory, "10-UPPER.sh");
    writeStep(directory, "20-bad_name.ts");
    writeStep(directory, "30-trailing-.md", agentMarkdown());
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    for (const file of ["10-UPPER.sh", "20-bad_name.ts", "30-trailing-.md"]) {
      assert.match(errorReasons(result, `clock/${file}`).join(" "), /unknown file/);
    }
  });
});

test("requires valid workflow frontmatter, known keys, and a parseable cron", () => {
  withRoot((root) => {
    const noFrontmatter = join(root, "no-frontmatter");
    mkdirSync(noFrontmatter);
    writeFileSync(join(noFrontmatter, "workflow.md"), "Just a description.\n");
    const noClosing = join(root, "no-closing");
    mkdirSync(noClosing);
    writeFileSync(join(noClosing, "workflow.md"), '---\ncron: "*/5 * * * *"\n');
    const unknownKey = createWorkflow(root, "unknown-key", 'cron: "*/5 * * * *"\nother: true');
    const invalidCron = createWorkflow(root, "invalid-cron", "cron: not-a-cron");
    const malformedYaml = createWorkflow(root, "malformed-yaml", "cron: [unclosed");
    const duplicateKeys = createWorkflow(root, "duplicate-keys", 'cron: "*/5 * * * *"\ncron: "*/10 * * * *"');
    const nonMapping = createWorkflow(root, "non-mapping", "true");
    const missingCron = createWorkflow(root, "missing-cron", "profile: writer");
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result, "no-frontmatter/workflow.md").join(" "), /missing YAML frontmatter/);
    assert.match(errorReasons(result, "no-closing/workflow.md").join(" "), /frontmatter is missing its closing delimiter/);
    assert.match(errorReasons(result, "unknown-key/workflow.md").join(" "), /Unrecognized key/);
    assert.match(errorReasons(result, "invalid-cron/workflow.md").join(" "), /valid cron expression/);
    assert.match(errorReasons(result, "malformed-yaml/workflow.md").join(" "), /invalid YAML frontmatter/);
    assert.match(errorReasons(result, "duplicate-keys/workflow.md").join(" "), /invalid YAML frontmatter/);
    assert.match(errorReasons(result, "non-mapping/workflow.md").join(" "), /frontmatter must be a mapping/);
    assert.match(errorReasons(result, "missing-cron/workflow.md").join(" "), /cron: Invalid input/);
    assert.ok(unknownKey && invalidCron && malformedYaml && duplicateKeys && nonMapping && missingCron);
  });
});

test("checks workflow setting types and ranges", () => {
  withRoot((root) => {
    const cases: Array<{ name: string; fields: string; reason: RegExp }> = [
      { name: "max-zero", fields: 'cron: "*/5 * * * *"\nmax_runs: 0', reason: /max_runs: Too small/ },
      { name: "max-fraction", fields: 'cron: "*/5 * * * *"\nmax_runs: 1.5', reason: /max_runs: Invalid input/ },
      { name: "enabled-string", fields: 'cron: "*/5 * * * *"\nenabled: yes', reason: /enabled: Invalid input/ },
      { name: "negative-retries", fields: 'cron: "*/5 * * * *"\nretries: -1', reason: /retries: Too small/ },
      { name: "fraction-retries", fields: 'cron: "*/5 * * * *"\nretries: 1.5', reason: /retries: Invalid input/ },
      { name: "bad-timeout", fields: 'cron: "*/5 * * * *"\ntimeout: 30d', reason: /timeout: must be a positive duration/ },
      { name: "zero-timeout", fields: 'cron: "*/5 * * * *"\ntimeout: 0s', reason: /timeout: must be a positive duration/ },
      { name: "too-long-timeout", fields: 'cron: "*/5 * * * *"\ntimeout: 597h', reason: /timeout: must be a positive duration/ },
      { name: "unknown-profile", fields: 'cron: "*/5 * * * *"\nprofile: absent', reason: /does not exist in agent_profiles/ },
    ];
    for (const item of cases) createWorkflow(root, item.name, item.fields);
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    for (const item of cases) assert.match(errorReasons(result, `${item.name}/workflow.md`).join(" "), item.reason, item.name);
  });
});

test("requires agent frontmatter and a non-empty prompt, and checks step profiles", () => {
  withRoot((root) => {
    const directory = createWorkflow(root, "steps", 'cron: "*/5 * * * *"');
    writeStep(directory, "10-no-frontmatter.md", "Write a line.\n");
    writeStep(directory, "20-empty-prompt.md", "---\nprofile: writer\n---\n  \n");
    writeStep(directory, "30-no-profile.md", "---\n---\nWrite a line.\n");
    writeStep(directory, "40-unknown-profile.md", agentMarkdown("missing"));
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result, "steps/10-no-frontmatter.md").join(" "), /missing YAML frontmatter/);
    assert.match(errorReasons(result, "steps/20-empty-prompt.md").join(" "), /prompt body must not be empty/);
    assert.match(errorReasons(result, "steps/30-no-profile.md").join(" "), /agent profile must be set here or in workflow.md/);
    assert.match(errorReasons(result, "steps/40-unknown-profile.md").join(" "), /profile "missing" does not exist/);
  });
});

test("validates agent-step retries and timeouts and preserves them in the result", () => {
  withRoot((root) => {
    const directory = createWorkflow(root, "settings", 'cron: "*/5 * * * *"');
    writeStep(directory, "10-agent.md", agentMarkdown("writer", "Do the work.", "\nretries: 3\ntimeout: 2h"));
    const result = loadWorkflows(root, profiles);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.workflows[0]?.steps[0], {
      kind: "agent", file: "10-agent.md", number: 10, name: "agent", profile: "writer", retries: 3, timeout: "2h",
    });

    writeStep(directory, "20-bad-retries.md", agentMarkdown("writer", "Do the work.", "\nretries: -1"));
    const invalidRetries = loadWorkflows(root, profiles);
    assert.equal(invalidRetries.workflows.length, 0);
    assert.match(errorReasons(invalidRetries, "settings/20-bad-retries.md").join(" "), /retries: Too small/);
  });
});

test("resolves Markdown checks through explicit or workflow-default profiles", () => {
  withRoot((root) => {
    const directory = createWorkflow(root, "checks", 'cron: "*/5 * * * *"\nprofile: writer');
    writeStep(directory, "10-agent.md", "---\n---\nDo the work.\n");
    writeStep(directory, "10-agent.check.md", "---\nprofile: judge\n---\nJudge the result.\n");
    writeStep(directory, "20-other.md", "---\n---\nDo more work.\n");
    writeStep(directory, "20-other.check.md", "---\n---\nJudge the result.\n");
    const result = loadWorkflows(root, profiles);
    assert.deepEqual(result.errors, []);
    assert.equal(result.workflows[0]?.steps[0]?.profile, "writer");
    assert.equal(result.workflows[0]?.steps[0]?.check?.profile, "judge");
    assert.equal(result.workflows[0]?.steps[1]?.check?.profile, "writer");
  });
});

test("rejects orphaned, mismatched, and duplicate checks and validates Markdown check prompts", () => {
  withRoot((root) => {
    const directory = createWorkflow(root, "checks", 'cron: "*/5 * * * *"\nprofile: writer');
    writeStep(directory, "10-agent.md", agentMarkdown());
    writeStep(directory, "10-agent.check.md", "---\nprofile: writer\n---\n  \n");
    writeStep(directory, "10-agent.check.sh", "exit 0\n");
    writeStep(directory, "20-orphan.check.ts", "process.exit(0);\n");
    writeStep(directory, "30-mismatch.check.sh", "exit 0\n");
    const result = loadWorkflows(root, profiles);
    assert.equal(result.workflows.length, 0);
    assert.match(errorReasons(result, "checks/10-agent.check.md").join(" "), /judge prompt body must not be empty/);
    assert.match(errorReasons(result, "checks/10-agent.check.sh").join(" "), /more than one check/);
    assert.match(errorReasons(result, "checks/20-orphan.check.ts").join(" "), /does not match an existing step/);
    assert.match(errorReasons(result, "checks/30-mismatch.check.sh").join(" "), /does not match an existing step/);
  });
});

test("ignores top-level YAML examples only when requested and loads good workflows beside broken ones", () => {
  withRoot((root) => {
    const exampleRoot = join(root, "examples");
    mkdirSync(exampleRoot);
    writeFileSync(join(exampleRoot, "top-level.yaml"), "not a folder workflow");
    const result = loadWorkflows(exampleRoot, profiles, { ignoreTopLevelYaml: true });
    assert.deepEqual(result, { workflows: [], errors: [] });

    const workflowsRoot = join(root, "workflows");
    mkdirSync(workflowsRoot);
    writeFileSync(join(workflowsRoot, "invalid.yaml"), "not a folder workflow");
    const good = createWorkflow(workflowsRoot, "good", 'cron: "*/5 * * * *"');
    writeStep(good, "10-step.sh");
    createWorkflow(workflowsRoot, "broken", "cron: invalid");
    const workflows = loadWorkflows(workflowsRoot, profiles);
    assert.deepEqual(workflows.workflows.map(({ name }) => name), ["good"]);
    assert.match(errorReasons(workflows, "broken/workflow.md").join(" "), /valid cron expression/);
    assert.match(errorReasons(workflows, "invalid.yaml").join(" "), /unknown file/);
  });
});

test("reports a missing workflow directory as a load issue", () => {
  withRoot((root) => {
    const result = loadWorkflows(join(root, "missing"), profiles);

    assert.deepEqual(result.workflows, []);
    assert.deepEqual(result.errors.map(({ file }) => file), ["."]);
    assert.match(result.errors[0]?.reason ?? "", /^could not read workflow directory: /);
  });
});
