import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { parseModel } from "../src/definition/parse-model.js";
import { resolveAgent, unresolvedAgentSites } from "../src/definition/resolve-agent-settings.js";
import {
  machineConfigSchema,
  workflowSchema,
  type WorkflowDefinition,
} from "../src/definition/schema.js";
import { parseStrictYaml } from "../src/definition/parse-yaml.js";
import { parseByteSize, parseDuration } from "../src/util/parse-units.js";

function baseDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    id: "clock",
    nodes: {
      "node-a": {
        run: { command: "echo hello" },
        next: null,
      },
    },
    ...overrides,
  };
}

function yaml(nodes: string, prefix = ""): string {
  return `version: 2\nid: clock\n${prefix}nodes:\n${nodes}`;
}

function definitionText(nodes: string): string {
  return yaml(nodes).trimEnd();
}

describe("workflow and machine schemas", () => {
  test("accepts the strict machine and workflow shapes", () => {
    expect(workflowSchema.parse(baseDefinition())).toMatchObject({ version: 2, id: "clock" });
    expect(machineConfigSchema.parse({
      version: 2,
      shell: "/bin/bash",
      agent: { harness: { command: "mock-agent" }, model: "provider/model:low" },
      orchestrator: { model: "provider/judge:medium", timeout: "5m" },
    })).toMatchObject({ version: 2, shell: "/bin/bash" });
    expect(machineConfigSchema.parse({ version: 2 })).toEqual({ version: 2 });
  });

  test("loads the copyable workflow and fixture machine in a temporary installation", () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-fixture-"));
    try {
      const configDir = join(root, ".workshop", "config");
      const workflowsDir = join(configDir, "workflows");
      const harnessDir = join(root, "tests", "mock");
      mkdirSync(workflowsDir, { recursive: true });
      mkdirSync(harnessDir, { recursive: true });
      const workflowSource = join(import.meta.dir, "..", "examples", "workflows", "hemingway-clock.yaml");
      const machineSource = join(import.meta.dir, "fixtures", "machine.yaml");
      const harnessSource = join(import.meta.dir, "mock", "hemingway-node.ts");
      const workflowPath = join(workflowsDir, "hemingway-clock.yaml");
      const machinePath = join(configDir, "workshop.yaml");
      copyFileSync(workflowSource, workflowPath);
      copyFileSync(machineSource, machinePath);
      copyFileSync(harnessSource, join(harnessDir, "hemingway-node.ts"));

      const checked = checkDefinitionText(readFileSync(workflowPath, "utf8"), workflowPath);
      expect(checked.chain.order).toEqual(["node-timestamp", "node-generate-line", "node-publish-quote"]);
      expect(checked.def.id).toBe("hemingway-clock");
      const machine = machineConfigSchema.parse(
        parseStrictYaml(readFileSync(machinePath, "utf8"), machinePath),
      );
      expect(resolveAgent({ machine: machine.agent })).toMatchObject({
        harnessCommand: "bun tests/mock/hemingway-node.ts",
        model: { full: "fixture/mock-model:medium" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checks the documented Pi, OpenCode, and Claude Code command templates as workflow sites", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    const heading = "### Headless-agent command templates";
    const start = readme.indexOf(heading);
    if (start < 0) throw new Error("README is missing the harness-template section");
    const yaml = /```yaml\n([\s\S]*?)\n```/u.exec(readme.slice(start))?.[1];
    if (yaml === undefined) throw new Error("README harness templates are missing their YAML mapping");

    const templateSchema = z.strictObject({
      pi: z.strictObject({
        model: z.string(), model_env: z.array(z.string()).min(1),
        prompt_env: z.literal("WORKSHOP_PROMPT_FILE"), result_env: z.literal("WORKSHOP_RESULT_FILE"),
        command: z.string().min(1),
      }),
      opencode: z.strictObject({
        model: z.string(), model_env: z.array(z.string()).min(1),
        prompt_env: z.literal("WORKSHOP_PROMPT_FILE"), result_env: z.literal("WORKSHOP_RESULT_FILE"),
        command: z.string().min(1),
      }),
      "claude-code": z.strictObject({
        model: z.string(), model_env: z.array(z.string()).min(1),
        prompt_env: z.literal("WORKSHOP_PROMPT_FILE"), result_env: z.literal("WORKSHOP_RESULT_FILE"),
        command: z.string().min(1),
      }),
    });
    const templates = templateSchema.parse(parseStrictYaml(yaml, "README.md harness templates"));
    expect(templates.pi.model_env).toEqual(["WORKSHOP_MODEL_WITH_THINKING"]);
    expect(templates.opencode.model_env).toEqual(["WORKSHOP_MODEL", "WORKSHOP_THINKING"]);
    expect(templates["claude-code"].model_env).toEqual(["WORKSHOP_MODEL_ID", "WORKSHOP_THINKING"]);
    const entries = Object.entries(templates);
    const nodes: Record<string, unknown> = {};
    for (const [index, [name, template]] of entries.entries()) {
      const id = `node-${name}`;
      const next = entries[index + 1]?.[0];
      nodes[id] = {
        run: { agent: { model: template.model, harness: { command: template.command }, instructions: "Write the checked result JSON to the supplied result path." } },
        next: next === undefined ? null : `node-${next}`,
      };
      expect(template.command).toContain(`"$${template.prompt_env}"`);
      for (const modelEnv of template.model_env) expect(template.command).toContain(`"$${modelEnv}"`);
      expect(template.result_env).toBe("WORKSHOP_RESULT_FILE");
      expect(resolveAgent({ site: { model: template.model, harness: { command: template.command } } }))
        .toMatchObject({ harnessCommand: template.command, model: { full: template.model } });
    }

    const checked = workflowSchema.parse({ version: 2, id: "harness-templates", nodes });
    expect(Object.keys(checked.nodes)).toEqual(["node-pi", "node-opencode", "node-claude-code"]);
    expect(readme.slice(start)).toContain("Claude Code flags have not been checked against installed binaries");
  });

  test("rejects a workflow version other than 2, or none, with a plain schema error", () => {
    const nodes = "nodes:\n  node-a:\n    run: { command: echo hi }\n    next: null\n";
    expect(() => checkDefinitionText(`version: 1\nid: old\n${nodes}`, "old.yaml"))
      .toThrow("old.yaml: unsupported workflow version 1; expected version: 2");
    expect(() => checkDefinitionText(`id: old\n${nodes}`, "unversioned.yaml"))
      .toThrow("unversioned.yaml: workflow does not declare a version; add version: 2");
  });

  test("rejects unknown keys at every schema depth and prohibits instructions in defaults", () => {
    const extraTop = baseDefinition({ extra: true });
    const extraNode = baseDefinition({
      nodes: { "node-a": { run: { command: "echo" }, next: null, extra: true } },
    });
    const extraRun = baseDefinition({
      nodes: { "node-a": { run: { command: "echo", agent: { instructions: "write" } }, next: null } },
    });
    const instructionsInDefaults = baseDefinition({ defaults: { agent: { instructions: "no" } } });
    const extraValidator = baseDefinition({
      nodes: { "node-a": {
        run: { command: "echo" },
        validator: { command: "true", replay: "safe", extra: true },
        next: null,
      } },
    });
    const extraPreflight = baseDefinition({ environment: { preflight: { command: "true", extra: 1 } } });
    const removedHarnessJudge = baseDefinition({ orchestrator: { agent: { model: "p/m:low" } } });

    for (const value of [extraTop, extraNode, extraRun, instructionsInDefaults, extraValidator, extraPreflight, removedHarnessJudge]) {
      expect(() => workflowSchema.parse(value)).toThrow();
    }

    expect(() => machineConfigSchema.parse({ version: 2, surprise: true })).toThrow();
    expect(() => machineConfigSchema.parse({ version: 1 })).toThrow();
  });

  test("enforces workflow identifiers, description bytes, nonempty chains, and required next", () => {
    expect(() => workflowSchema.parse(baseDefinition({ id: "Upper" }))).toThrow();
    expect(() => workflowSchema.parse(baseDefinition({ id: `a${"b".repeat(80)}` }))).toThrow(/80 characters/);
    expect(() => workflowSchema.parse(baseDefinition({ description: "é".repeat(2049) }))).toThrow(/4 KiB in UTF-8/);
    expect(workflowSchema.parse(baseDefinition({ description: "é".repeat(2048) })).description).toHaveLength(2048);
    expect(() => workflowSchema.parse(baseDefinition({ nodes: {} }))).toThrow(/at least one node/);
    expect(() => workflowSchema.parse({
      version: 2,
      id: "clock",
      nodes: { "node-a": { run: { command: "echo" } } },
    })).toThrow();
  });

  test("requires an absolute shell path and a nonempty command template", () => {
    expect(() => machineConfigSchema.parse({ version: 2, shell: "bash" })).toThrow(/absolute executable path/);
    expect(() => workflowSchema.parse(baseDefinition({
      nodes: { "node-a": { run: { command: "  " }, next: null } },
    }))).toThrow(/command must be nonempty/);
  });

  test("accepts positive bounded attempts, timeouts, byte caps, and explicit replay policy", () => {
    expect(workflowSchema.parse(baseDefinition({
      defaults: { max_attempts: 1, timeout: "1ms", stream_cap: "256kb", replay: "safe" },
      nodes: { "node-a": {
        run: { command: "echo" },
        timeout: "unlimited",
        stream_cap: "1024",
        replay: "never",
        validator: { command: "true", timeout: "2s", replay: "safe" },
        next: null,
      } },
    }))).toMatchObject({
      defaults: { replay: "safe" },
      nodes: { "node-a": { replay: "never", validator: { replay: "safe" } } },
    });

    for (const attempts of [0, -1, 1.5]) {
      expect(() => workflowSchema.parse(baseDefinition({ defaults: { max_attempts: attempts } }))).toThrow();
    }
    expect(() => workflowSchema.parse(baseDefinition({
      defaults: { stream_cap: `${"9".repeat(400)}mb` },
    }))).toThrow(/finite safe-integer byte value/);
    expect(() => parseDuration("9007199254740993ms")).toThrow(/safe-integer millisecond range/);
    expect(() => workflowSchema.parse(baseDefinition({
      defaults: { timeout: "100000000000w" },
    }))).toThrow(/safe-integer millisecond value/);
    expect(() => parseByteSize("9007199254740993kb")).toThrow(/safe-integer byte value/);
    const aboveSafeInteger = Number.MAX_SAFE_INTEGER + 1;
    expect(() => workflowSchema.parse(baseDefinition({
      defaults: { max_attempts: aboveSafeInteger },
    }))).toThrow(/safe integer/);
    expect(() => workflowSchema.parse(baseDefinition({
      schedule: { every: "1s", max_runs: aboveSafeInteger },
    }))).toThrow(/safe integer/);
    expect(() => machineConfigSchema.parse({ version: 2, max_concurrent_runs: aboveSafeInteger }))
      .toThrow(/safe integer/);
  });

  test("schedule requires a finite positive interval and a positive count or unlimited", () => {
    expect(workflowSchema.parse(baseDefinition({ schedule: { every: "10ms", max_runs: 6 } })).schedule)
      .toEqual({ every: "10ms", max_runs: 6 });
    expect(workflowSchema.parse(baseDefinition({ schedule: { every: "1h", max_runs: "unlimited" } })).schedule)
      .toEqual({ every: "1h", max_runs: "unlimited" });
    for (const schedule of [
      { every: "0ms", max_runs: 1 },
      { every: "unlimited", max_runs: 1 },
      { every: "1s", max_runs: 0 },
      { every: "1s", max_runs: -1 },
      { every: "1s", max_runs: 1.5 },
    ]) {
      expect(() => workflowSchema.parse(baseDefinition({ schedule }))).toThrow();
    }
  });

  test("requires agent instructions, forbids agent-only settings on commands, and checks thinking levels", () => {
    expect(() => workflowSchema.parse(baseDefinition({
      nodes: { "node-a": { run: { agent: { model: "provider/model:low" } }, next: null } },
    }))).toThrow();
    expect(() => workflowSchema.parse(baseDefinition({
      nodes: { "node-a": { run: { command: "echo", model: "provider/model:low" }, next: null } },
    }))).toThrow();
    expect(() => workflowSchema.parse(baseDefinition({
      nodes: { "node-a": {
        run: { agent: { instructions: "write", model: "provider/model:mid" } },
        next: null,
      } },
    }))).toThrow(/unsupported thinking level/);
    expect(parseModel("provider/model:with:colons/and/slashes:xhigh")).toEqual({
      provider: "provider",
      modelId: "model:with:colons/and/slashes",
      thinking: "xhigh",
      full: "provider/model:with:colons/and/slashes:xhigh",
    });
    expect(() => parseModel("provider/model:low extra")).toThrow(/whitespace/);
  });

  test("duration parsing accepts milliseconds and rejects malformed or overflowing values", () => {
    expect(parseDuration("1ms")).toBe(1);
    expect(parseDuration("2s")).toBe(2_000);
    expect(parseDuration("3w")).toBe(3 * 604_800_000);
    for (const value of ["0ms", "01ms", "1us", "1s ", `${"9".repeat(400)}w`]) {
      expect(() => parseDuration(value)).toThrow();
    }
  });
});

describe("definition text and linear chain", () => {
  test("derives order and predecessors from edges instead of YAML insertion order", () => {
    const checked = checkDefinitionText(definitionText(
      `  node-c:\n    run: { command: echo c }\n    next: null\n  node-a:\n    run: { command: echo a }\n    next: node-b\n  node-b:\n    run: { command: echo b }\n    next: node-c\n`,
    ), "fixture.yaml");
    expect(checked.chain.order).toEqual(["node-a", "node-b", "node-c"]);
    expect(checked.chain.prev.get("node-a")).toBeNull();
    expect(checked.chain.prev.get("node-c")).toBe("node-b");
  });

  test("accepts a non-Hemingway two-node chain", () => {
    const checked = checkDefinitionText(
      "version: 2\nid: release\nnodes:\n  prepare-report:\n    run: { command: echo prepare }\n    next: publish-summary\n  publish-summary:\n    run: { command: echo publish }\n    next: null\n",
      "release.yaml",
    );
    expect(checked.chain.order).toEqual(["prepare-report", "publish-summary"]);
    expect(checked.chain.prev.get("publish-summary")).toBe("prepare-report");
  });

  test("rejects missing targets, cycles, multiple starts, detached nodes, and YAML anchors", () => {
    const cases = [
      ["missing target", `  node-a:\n    run: { command: echo }\n    next: ghost\n`, /no such node/],
      ["cycle without a start", `  node-a:\n    run: { command: echo }\n    next: node-b\n  node-b:\n    run: { command: echo }\n    next: node-a\n`, /no start node/],
      ["reachable cycle", `  node-a:\n    run: { command: echo }\n    next: node-b\n  node-b:\n    run: { command: echo }\n    next: node-c\n  node-c:\n    run: { command: echo }\n    next: node-b\n`, /cycle at node/],
      ["multiple starts", `  node-a:\n    run: { command: echo }\n    next: null\n  node-b:\n    run: { command: echo }\n    next: null\n`, /multiple start nodes/],
      ["detached nodes", `  node-a:\n    run: { command: echo }\n    next: null\n  node-b:\n    run: { command: echo }\n    next: node-c\n  node-c:\n    run: { command: echo }\n    next: node-b\n`, /unreachable nodes/],
    ] as const;

    for (const [, nodes, message] of cases) {
      expect(() => checkDefinitionText(definitionText(nodes), "bad.yaml")).toThrow(message);
    }
    expect(() => checkDefinitionText(
      "version: 2\nid: clock\nnodes:\n  node-a: &a { run: { command: echo }, next: null }\n",
      "anchor.yaml",
    )).toThrow(/anchors are rejected/);
    expect(() => checkDefinitionText(
      "version: 2\nid: clock\nid: duplicate\nnodes:\n  node-a: { run: { command: echo }, next: null }\n",
      "duplicate.yaml",
    )).toThrow(/duplicate|unique/i);
  });
});

describe("field-by-field agent resolution", () => {
  const machine = { harness: { command: "machine-harness" }, model: "machine/model:low" };
  const workflowDefault = { harness: { command: "workflow-harness" }, model: "workflow/model:medium" };

  test("a site can override one field while inheriting the other", () => {
    const modelOnly = resolveAgent({
      site: { model: "site/model:high" },
      workflowDefault,
      machine,
    });
    expect(modelOnly.harnessCommand).toBe("workflow-harness");
    expect(modelOnly.model?.full).toBe("site/model:high");

    const harnessOnly = resolveAgent({
      site: { harness: { command: "site-harness" } },
      workflowDefault,
      machine,
    });
    expect(harnessOnly.harnessCommand).toBe("site-harness");
    expect(harnessOnly.model?.full).toBe("workflow/model:medium");
  });

  test("machine defaults fill only missing fields and unresolved sites are reported", () => {
    const resolved = resolveAgent({ workflowDefault: { model: "workflow/model:low" }, machine });
    expect(resolved.harnessCommand).toBe("machine-harness");
    expect(resolved.model?.full).toBe("workflow/model:low");

    const unresolved = {
      version: 2,
      id: "clock",
      nodes: {
        "node-a": {
          run: { agent: { instructions: "write" } },
          validator: { agent: { instructions: "judge" } },
          next: null,
        },
      },
    } satisfies WorkflowDefinition;
    expect(unresolvedAgentSites(unresolved, undefined)).toEqual([
      'node "node-a" run',
      'node "node-a" validator',
    ]);
  });
});
