import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { parseModel } from "../src/definition/parse-model.js";
import { resolveAgent, PI_HARNESS_COMMAND } from "../src/definition/resolve-agent-settings.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import {
  machineConfigSchema,
  workflowSchema,
  type MachineConfig,
} from "../src/definition/schema.js";
import { resolvedWorkflowSettingsSchema } from "../src/definition/schema-resolved.js";
import { resolveRetryLimit } from "../src/definition/resolve-retry-limit.js";
import { checkNoOpenLegacyRuns } from "../src/service/check-legacy-runs.js";
import { parseStrictYaml } from "../src/definition/parse-yaml.js";
import { parseByteSize, parseDuration } from "../src/util/parse-units.js";

function baseDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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

describe("workflow and machine schemas", () => {
  test("accepts the internal chain shape and optional version 3 machine config", () => {
    expect(workflowSchema.parse(baseDefinition())).toMatchObject({ id: "clock" });
    expect(workflowSchema.parse(baseDefinition())).not.toHaveProperty("version");
    expect(machineConfigSchema.parse({
      version: 3,
      shell: "/bin/bash",
      agent: { harness: { command: "mock-agent" }, model: "provider/model:low" },
      orchestrator: { model: "provider/judge:medium", timeout: "5m" },
    })).toMatchObject({ version: 3, shell: "/bin/bash" });
    expect(machineConfigSchema.parse({})).toEqual({});
  });

  test("resolves keep_files from machine config and the failed default", () => {
    const definition = workflowSchema.parse(baseDefinition({ defaults: { retries: 0, replay: "never" } }));
    const resolve = (config: MachineConfig) =>
      resolveWorkflowSettings({ definition, machine: config, projectCwd: "/tmp" }).keepFiles;

    expect(resolve(machineConfigSchema.parse({}))).toBe("failed");
    expect(resolve(machineConfigSchema.parse({ keep_files: "always" }))).toBe("always");
    expect(() => machineConfigSchema.parse({ keep_files: "success" })).toThrow();
  });

  test("loads the copyable workflow and fixture machine in a temporary installation", () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-fixture-"));
    try {
      const workshopDir = join(root, ".workshop");
      const workflowsDir = join(workshopDir, "workflows");
      const harnessDir = join(root, "tests", "mock");
      mkdirSync(workflowsDir, { recursive: true });
      mkdirSync(harnessDir, { recursive: true });
      const workflowSource = join(import.meta.dir, "..", "examples", "workflows", "hemingway-clock.yaml");
      const machineSource = join(import.meta.dir, "fixtures", "machine.yaml");
      const harnessSource = join(import.meta.dir, "mock", "hemingway-node.ts");
      const workflowPath = join(workflowsDir, "hemingway-clock.yaml");
      const machinePath = join(workshopDir, "workshop.yaml");
      copyFileSync(workflowSource, workflowPath);
      copyFileSync(machineSource, machinePath);
      copyFileSync(harnessSource, join(harnessDir, "hemingway-node.ts"));

      const checked = checkDefinitionText(readFileSync(workflowPath, "utf8"), workflowPath, "hemingway-clock");
      expect(checked.chain.order).toEqual(["timestamp", "generate-line", "publish-quote"]);
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

    const checked = workflowSchema.parse({ id: "harness-templates", nodes });
    expect(Object.keys(checked.nodes)).toEqual(["node-pi", "node-opencode", "node-claude-code"]);
    expect(readme.slice(start)).toContain("Claude Code flags have not been checked against installed binaries");
  });

  test("rejects unknown keys at every internal schema depth and prohibits instructions in defaults", () => {
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

    expect(() => workflowSchema.parse(baseDefinition({ version: 3 }))).toThrow();
    expect(() => machineConfigSchema.parse({ version: 3, surprise: true })).toThrow();
    expect(() => machineConfigSchema.parse({ version: 2 })).toThrow();
  });

  test("enforces internal workflow identifiers, description bytes, nonempty chains, and required next", () => {
    expect(() => workflowSchema.parse(baseDefinition({ id: "Upper" }))).toThrow();
    expect(() => workflowSchema.parse(baseDefinition({ id: `a${"b".repeat(80)}` }))).toThrow(/80 characters/);
    expect(() => workflowSchema.parse(baseDefinition({ description: "é".repeat(2049) }))).toThrow(/4 KiB in UTF-8/);
    expect(workflowSchema.parse(baseDefinition({ description: "é".repeat(2048) })).description).toHaveLength(2048);
    expect(() => workflowSchema.parse(baseDefinition({ nodes: {} }))).toThrow(/at least one step/);
    expect(() => workflowSchema.parse({
      id: "clock",
      nodes: { "node-a": { run: { command: "echo" } } },
    })).toThrow();
  });

  test("requires an absolute shell path and a nonempty command template", () => {
    expect(() => machineConfigSchema.parse({ shell: "bash" })).toThrow(/absolute executable path/);
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
    for (const retries of [-1, 1.5, "forever"]) {
      expect(() => workflowSchema.parse(baseDefinition({ defaults: { retries } }))).toThrow();
    }
    expect(workflowSchema.parse(baseDefinition({ defaults: { retries: 0 } })).defaults).toEqual({ retries: 0 });
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
    expect(() => machineConfigSchema.parse({ max_concurrent_runs: aboveSafeInteger })).toThrow(/safe integer/);
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

const V4 = "version: 4\ndefaults: { retries: 0, replay: never }\n";

describe("authored workflow text", () => {
  test("uses the file name as the workflow id", () => {
    const checked = checkDefinitionText(`${V4}steps:\n  - greet: echo hello\n`, "/project/.workshop/workflows/greeting.yaml", "greeting");
    expect(checked.def.id).toBe("greeting");
    expect(checked.chain.order).toEqual(["greet"]);
  });

  test("requires version 4 and names the migration for older files", () => {
    const steps = "defaults: { retries: 0, replay: never }\nsteps:\n  - greet: echo hello\n";
    expect(checkDefinitionText(`version: 4\n${steps}`, "clock.yaml", "clock").def.id).toBe("clock");
    expect(() => checkDefinitionText(steps, "clock.yaml", "clock")).toThrow(/must declare version: 4.*max_attempts: N with retries: N-1/);
    expect(() => checkDefinitionText(`version: 3\n${steps}`, "clock.yaml", "clock")).toThrow(/version 3 is no longer supported; declare version: 4.*check: with verify:/);
  });

  test("normalizes ordered steps and verifiers written like step bodies", () => {
    const checked = checkDefinitionText([
      "version: 4",
      "defaults:",
      "  retries: 0",
      "  replay: never",
      "steps:",
      "  - command-shortcut: echo shortcut",
      "  - command-step:",
      "      run: echo command",
      "      verify: test -s output.txt",
      "  - run-verified:",
      "      run: echo command",
      "      verify: { run: test -s output.txt }",
      "  - agent-step:",
      "      agent:",
      "        instructions: Write the result.",
      "        model: provider/model:low",
      "        harness: pi",
      "      verify:",
      "        agent:",
      "          instructions: Judge the result.",
      "          model: provider/judge:medium",
      "",
    ].join("\n"), "clock.yaml", "clock");

    expect(checked.chain.order).toEqual(["command-shortcut", "command-step", "run-verified", "agent-step"]);
    expect(checked.chain.prev.get("command-shortcut")).toBeNull();
    expect(checked.chain.prev.get("agent-step")).toBe("run-verified");
    expect(checked.def.nodes).toMatchObject({
      "command-shortcut": { run: { command: "echo shortcut" }, next: "command-step" },
      "command-step": { validator: { command: "test -s output.txt" }, next: "run-verified" },
      "run-verified": { validator: { command: "test -s output.txt" }, next: "agent-step" },
      "agent-step": {
        run: { agent: { instructions: "Write the result.", model: "provider/model:low", harness: "pi" } },
        validator: { agent: { instructions: "Judge the result.", model: "provider/judge:medium" } },
        next: null,
      },
    });
  });

  test("requires every step to resolve retries and replay, and replay: never to forbid retries", () => {
    const cases = [
      ["no retries", "version: 4\ndefaults: { replay: safe }\nsteps:\n  - one: echo hi\n", /step "one": retries is not set/],
      ["no replay", "version: 4\ndefaults: { retries: 1 }\nsteps:\n  - one: echo hi\n", /step "one": replay is not set/],
      ["never retries", "version: 4\nsteps:\n  - one: { run: echo hi, retries: 1, replay: never }\n", /replay: never requires retries: 0/],
      ["never default", "version: 4\ndefaults: { retries: 2, replay: never }\nsteps:\n  - one: echo hi\n", /step "one": replay: never requires retries: 0/],
      ["negative", "version: 4\nsteps:\n  - one: { run: echo hi, retries: -1, replay: safe }\n", /./],
      ["empty agent verifier", `${V4}steps:\n  - one:\n      run: echo hi\n      verify: { agent: \"  \" }\n`, /agent verifier needs nonempty instructions/],
      ["verifier limits", `${V4}steps:\n  - one:\n      run: echo hi\n      verify: { run: echo ok, timeout: 5s }\n`, /./],
    ] as const;
    for (const [label, text, message] of cases) {
      expect(() => checkDefinitionText(text, `${label}.yaml`, "clock"), label).toThrow(message);
    }
    const unlimited = checkDefinitionText(
      "version: 4\nsteps:\n  - one: { run: echo hi, retries: unlimited, replay: safe }\n  - two: { run: echo bye, retries: 0, replay: never }\n",
      "clock.yaml",
      "clock",
    );
    expect(unlimited.def.nodes.one).toMatchObject({ retries: "unlimited", replay: "safe" });
  });

  test("rejects legacy keys with the replacement named", () => {
    const cases = [
      ["id", `${V4}id: old\nsteps:\n  - one: echo hi\n`, /id:.*file name/],
      ["nodes", `${V4}nodes:\n  one:\n    run: { command: echo hi }\n    next: null\n`, /nodes:.*steps:/],
      ["next", `${V4}steps:\n  - one:\n      run: echo hi\n      next: two\n`, /next:.*steps run in list order/],
      ["validator", `${V4}steps:\n  - one:\n      run: echo hi\n      validator: true\n`, /validator:.*verify:/],
      ["check", `${V4}steps:\n  - one:\n      run: echo hi\n      check: true\n`, /check: is replaced by verify:/],
      ["max_attempts", `${V4}steps:\n  - one:\n      run: echo hi\n      max_attempts: 2\n`, /max_attempts: is replaced by retries:.*N-1/],
      ["defaults max_attempts", "version: 4\ndefaults: { max_attempts: 2, replay: safe }\nsteps:\n  - one: echo hi\n", /defaults.max_attempts: is replaced by defaults.retries:/],
      ["defaults keep_files", "version: 4\ndefaults: { keep_files: always, retries: 0, replay: never }\nsteps:\n  - one: echo hi\n", /keep_files: is removed/],
      ["orchestrator", `${V4}orchestrator: { model: p/m:low }\nsteps:\n  - one: echo hi\n`, /orchestrator: is removed/],
      ["run mapping", `${V4}steps:\n  - one:\n      run: { command: echo hi }\n`, /run: takes a command string/],
      ["version 2", "version: 2\nsteps:\n  - one: echo hi\n", /version 2.*remove id:.*steps:.*declare version: 4/],
    ] as const;

    for (const [label, text, message] of cases) {
      expect(() => checkDefinitionText(text, `${label}.yaml`, "clock"), label).toThrow(message);
    }
  });

  test("rejects duplicate step ids, YAML anchors, and duplicate YAML keys", () => {
    expect(() => checkDefinitionText(
      `${V4}steps:\n  - repeat: echo first\n  - repeat: echo second\n`,
      "duplicate-steps.yaml",
      "clock",
    )).toThrow(/step id "repeat" appears more than once/);
    expect(() => checkDefinitionText(
      `${V4}steps:\n  - one: &a { run: echo hi }\n`,
      "anchor.yaml",
      "clock",
    )).toThrow(/anchors are rejected/);
    expect(() => checkDefinitionText(
      `${V4}steps:\n  - one: echo hi\nsteps:\n  - two: echo bye\n`,
      "duplicate-key.yaml",
      "clock",
    )).toThrow(/duplicate|unique/i);
  });

  test("bounds workflow instructions at 64 KiB and freezes them with the resolved settings", () => {
    const text = (instructions: string) => `version: 4\ninstructions: ${JSON.stringify(instructions)}\ndefaults: { retries: 0, replay: never }\nsteps:\n  - one: echo hi\n`;
    const checked = checkDefinitionText(text("Use plain words."), "clock.yaml", "clock");
    expect(resolveWorkflowSettings({ definition: checked.def, machine: {}, projectCwd: "/tmp" }).instructions).toBe("Use plain words.");
    expect(() => checkDefinitionText(text("a".repeat(64 * 1024 + 1)), "clock.yaml", "clock")).toThrow(/64 KiB/);
  });
});

describe("format 4 resolved settings", () => {
  const machine = { shell: "/bin/bash", agent: { model: "machine/model:low" } };

  test("resolves retries, result mode, and verifier policy from the step", () => {
    const checked = checkDefinitionText([
      "version: 4",
      "defaults: { retries: 2, replay: safe, timeout: 2m }",
      "steps:",
      "  - shell:",
      "      run: echo hi",
      "      timeout: 30s",
      "      verify: test -n hi",
      "  - write:",
      "      agent: Write it.",
      "      retries: unlimited",
      "  - publish:",
      "      run: echo done",
      "      retries: 0",
      "      replay: never",
      "      result: tagged",
      "",
    ].join("\n"), "clock.yaml", "clock");
    const settings = resolveWorkflowSettings({ definition: checked.def, machine, projectCwd: "/tmp" });
    expect(settings).toMatchObject({ formatVersion: 4, instructions: null });
    expect(settings.nodes.shell).toMatchObject({
      retries: 2,
      result: "text",
      run: { replay: "safe", timeoutMs: 30_000 },
      validator: { kind: "command", replay: "safe", timeoutMs: 30_000 },
    });
    expect(settings.nodes.write).toMatchObject({ retries: "unlimited", result: "tagged", validator: null });
    expect(settings.nodes.publish).toMatchObject({ retries: 0, result: "tagged", run: { replay: "never" } });
  });

  test("keeps format 3 settings readable and converts their attempt limit exactly", () => {
    const site = { kind: "command", command: "echo", shell: "/bin/bash", cwd: "/tmp", timeoutMs: null, streamCapBytes: 1024, replay: "never" };
    const legacy = resolvedWorkflowSettingsSchema.parse({
      keepFiles: "failed",
      nodes: { one: { run: site, validator: null, maxAttempts: 3 } },
      preflight: null,
      orchestrator: { model: null, timeoutMs: null },
    });
    expect(resolveRetryLimit(legacy.nodes.one!)).toBe(2);
    expect(() => resolvedWorkflowSettingsSchema.parse({
      formatVersion: 4,
      instructions: null,
      keepFiles: "failed",
      nodes: { one: { run: site, validator: null, maxAttempts: 3 } },
      preflight: null,
      orchestrator: { model: null, timeoutMs: null },
    })).toThrow();
  });

  test("refuses to start while a format 3 run is open", () => {
    const current = { formatVersion: 4 };
    expect(() => checkNoOpenLegacyRuns([{ workflowId: "clock", runId: "run-new", resolvedSettings: current }])).not.toThrow();
    expect(() => checkNoOpenLegacyRuns([
      { workflowId: "clock", runId: "run-new", resolvedSettings: current },
      { workflowId: "quotes", runId: "run-old", resolvedSettings: { keepFiles: "failed" } },
    ])).toThrow(/workflow format 3.*quotes\/run-old.*previous Workshop build/);
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

  test("machine defaults fill only missing fields", () => {
    const resolved = resolveAgent({ workflowDefault: { model: "workflow/model:low" }, machine });
    expect(resolved.harnessCommand).toBe("machine-harness");
    expect(resolved.model?.full).toBe("workflow/model:low");
  });

  test("the Pi preset is used for an explicit or unset harness", () => {
    const explicit = resolveAgent({ site: { harness: "pi", model: "provider/model:low" } });
    const unset = resolveAgent({ site: { model: "provider/model:low" } });
    expect(explicit.harnessCommand).toBe(PI_HARNESS_COMMAND);
    expect(unset.harnessCommand).toBe(PI_HARNESS_COMMAND);
    expect(explicit.model?.full).toBe("provider/model:low");
    expect(unset.model?.full).toBe("provider/model:low");
  });
});
