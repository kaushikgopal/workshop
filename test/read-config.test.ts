import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProfileCommands } from "../config/check-profile-commands.ts";
import { ConfigReadError, loadWorkshopConfig, type WorkshopConfig } from "../config/load-workshop-config.ts";

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), "workshop-config-test-"));
}

function writeConfig(directory: string, source: string): string {
  const file = join(directory, "workshop.yaml");
  writeFileSync(file, source);
  return file;
}

function basicConfig(command = "[node, -e, hello]"): string {
  return `agent_profiles:\n  writer:\n    command: ${command}\norchestrator:\n  model: provider/model:thinking\n  escalation_model: provider/escalation\n`;
}

test("config loads .env.local without overwriting the environment and substitutes parsed string values", () => {
  const directory = createDirectory();
  const envName = "WORKSHOP_CONFIG_TEST_FROM_FILE";
  const existingName = "WORKSHOP_CONFIG_TEST_EXISTING";
  const quotedName = "WORKSHOP_CONFIG_TEST_QUOTED";
  const specialName = "WORKSHOP_CONFIG_TEST_SPECIAL";
  const configName = "WORKSHOP_CONFIG";
  const variables = [envName, existingName, quotedName, specialName, configName];
  const originals = new Map(variables.map((name) => [name, process.env[name]]));
  const specialValue = `quote: \" # [] , slash \\\n\u0001\n\${"WORKSHOP_CONFIG_TEST_NESTED"}`;
  delete process.env[envName];
  delete process.env[quotedName];
  process.env[existingName] = "kept-from-process";
  process.env[specialName] = specialValue;
  try {
    writeFileSync(join(directory, ".env.local"), `${envName}=value-from-file\n${existingName}=ignored-file-value\n${quotedName}="value # from file"\n${specialName}=ignored-special-value\n`);
    const file = writeConfig(directory, `agent_profiles:\n  writer:\n    command: [node, "\${${envName}}", "\${${existingName}}", "\${${quotedName}}", "\${${specialName}}"]\n    context_window: 64000\norchestrator: {}\n`);
    process.env[configName] = file;
    const config = loadWorkshopConfig();
    assert.deepEqual(config.agent_profiles.writer, {
      command: ["node", "value-from-file", "kept-from-process", "value # from file", specialValue],
      context_window: 64000,
    });
    assert.deepEqual(config.orchestrator, {});
    assert.equal(process.env[envName], "value-from-file");
    assert.equal(process.env[existingName], "kept-from-process");
    assert.equal(process.env[quotedName], "value # from file");
    assert.equal(process.env[specialName], specialValue);
  } finally {
    for (const name of variables) {
      const original = originals.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config failures do not apply values staged from .env.local", () => {
  const directory = createDirectory();
  const configName = "WORKSHOP_CONFIG";
  const dotenvName = "WORKSHOP_CONFIG_TEST_STAGED_DOTENV";
  const yamlParseName = "WORKSHOP_CONFIG_TEST_STAGED_YAML_PARSE";
  const yamlInterpolationName = "WORKSHOP_CONFIG_TEST_STAGED_YAML_INTERPOLATION";
  const missingInterpolationName = "WORKSHOP_CONFIG_TEST_MISSING_STAGED_YAML_INTERPOLATION";
  const yamlSchemaName = "WORKSHOP_CONFIG_TEST_STAGED_YAML_SCHEMA";
  const variables = [dotenvName, yamlParseName, yamlInterpolationName, yamlSchemaName, missingInterpolationName];
  const originals = new Map(variables.map((name) => [name, process.env[name]]));
  const previousConfig = process.env[configName];
  try {
    for (const name of variables) delete process.env[name];
    const failures = [
      {
        key: dotenvName,
        env: `${dotenvName}=staged-value\nBROKEN="unterminated\n`,
        config: basicConfig(`[node, "\${${dotenvName}}"]`),
        message: /unterminated quoted value/,
      },
      {
        key: yamlParseName,
        env: `${yamlParseName}=staged-value\n`,
        config: "agent_profiles:\n  writer:\n    command: [node\norchestrator: {}\n",
        message: /invalid YAML/,
      },
      {
        key: yamlInterpolationName,
        env: `${yamlInterpolationName}=staged-value\n`,
        config: basicConfig(`[node, "\${${missingInterpolationName}}"]`),
        message: new RegExp(missingInterpolationName),
      },
      {
        key: yamlSchemaName,
        env: `${yamlSchemaName}=staged-value\n`,
        config: `agent_profiles:\n  writer:\n    command: [node, "\${${yamlSchemaName}}"]\n    context_window: 0\norchestrator: {}\n`,
        message: /context_window: Too small/,
      },
    ];
    for (const [index, failure] of failures.entries()) {
      writeFileSync(join(directory, ".env.local"), failure.env);
      const file = writeConfig(directory, failure.config);
      process.env[configName] = file;
      assert.throws(() => loadWorkshopConfig(), failure.message, `invalid input ${index}`);
      assert.equal(process.env[failure.key], undefined, `failed read applied ${failure.key}`);
    }
  } finally {
    for (const name of variables) {
      const original = originals.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (previousConfig === undefined) delete process.env[configName];
    else process.env[configName] = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config errors name an unset interpolation variable", () => {
  const directory = createDirectory();
  const envName = "WORKSHOP_CONFIG_TEST_MISSING";
  const configName = "WORKSHOP_CONFIG";
  const previous = process.env[envName];
  const previousConfig = process.env[configName];
  delete process.env[envName];
  try {
    const file = writeConfig(directory, `agent_profiles:\n  writer:\n    command: [node, "\${${envName}}"]\norchestrator: {}\n`);
    process.env[configName] = file;
    assert.throws(() => loadWorkshopConfig(), (error: unknown) => {
      assert.ok(error instanceof ConfigReadError);
      assert.match(error.message, new RegExp(envName));
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    if (previousConfig === undefined) delete process.env[configName];
    else process.env[configName] = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config validates command arrays, agent profile names, and context windows", () => {
  const directory = createDirectory();
  try {
    const invalidConfigs = [
      { source: basicConfig("[]"), message: /at least one argument/ },
      { source: basicConfig("[\"\"]"), message: /must not be empty/ },
      { source: basicConfig().replace("writer:", "Writer:"), message: /lowercase letters, digits, and hyphens/ },
      { source: basicConfig().replace("model: provider/model:thinking", "model: ''"), message: /Too small/ },
      { source: basicConfig().replace("command:", "unknown: true\n    command:"), message: /Unrecognized key/ },
      { source: basicConfig().replace("model: provider/model:thinking", "profile: writer"), message: /Unrecognized key/ },
      { source: basicConfig().replace("command:", "context_window: 0\n    command:"), message: /context_window: Too small/ },
      { source: basicConfig().replace("command:", "context_window: 1.5\n    command:"), message: /context_window: Invalid input/ },
    ];
    for (const [index, item] of invalidConfigs.entries()) {
      const file = writeConfig(directory, item.source);
      assert.throws(() => loadWorkshopConfig(file), item.message, `invalid config ${index}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("profile commands preserve empty arguments for CLI flags", () => {
  const directory = createDirectory();
  try {
    const file = writeConfig(directory, basicConfig('[node, "", -e, hello]'));
    assert.deepEqual(loadWorkshopConfig(file).agent_profiles.writer?.command, ["node", "", "-e", "hello"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("profile command check requires each first argument to be an executable file", () => {
  const directory = createDirectory();
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const executable = join(bin, "fake-profile");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const pathDirectory = join(bin, "directory-command");
    mkdirSync(pathDirectory);
    const explicitDirectory = join(directory, "explicit-directory");
    mkdirSync(explicitDirectory);
    const config: WorkshopConfig = {
      agent_profiles: {
        found: { command: ["fake-profile"] },
        missing: { command: ["not-installed"] },
        pathDirectory: { command: ["directory-command"] },
        explicitDirectory: { command: [explicitDirectory] },
      },
      orchestrator: {},
    };
    const issues = checkProfileCommands(config, bin);
    assert.equal(issues.length, 3);
    assert.ok(issues.some(({ reason }) => reason.includes('agent_profiles.missing.command[0] "not-installed"')));
    assert.ok(issues.some(({ reason }) => reason.includes('agent_profiles.pathDirectory.command[0] "directory-command"')));
    assert.ok(issues.some(({ reason }) => reason.includes(`agent_profiles.explicitDirectory.command[0] "${explicitDirectory}"`)));
    assert.ok(issues.every(({ reason }) => reason.includes("must resolve to an executable file on PATH")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves relative profile executables against the config directory", () => {
  const directory = createDirectory();
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const executable = join(bin, "fake-profile");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const file = writeConfig(directory, basicConfig("[./bin/fake-profile]"));
    const config = loadWorkshopConfig(file);

    assert.equal(config.agent_profiles.writer?.command[0], executable);
    assert.deepEqual(checkProfileCommands(config, "", file), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
