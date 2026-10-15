import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { prepareRunAdmission } from "../src/run/prepare-admission.js";

const sourceText = [
  "version: 4",
  "defaults:",
  "  retries: 2",
  "  timeout: 2m",
  "  stream_cap: 64kb",
  "  replay: safe",
  "environment:",
  "  preflight:",
  "    command: echo preflight",
  "    timeout: 5s",
  "steps:",
  "  - prepare-report:",
  "      run: echo prepare",
  "      verify: { run: test -f output }",
  "",
].join("\n");
const machineConfig = { shell: "/bin/bash", default_timeout: "90s", stream_cap: "128kb" } as const;
const projectCwd = "/tmp/workshop-project";

function preparedRequest(resolvedSettings = resolveWorkflowSettings({
  definition: checkDefinitionText(sourceText, "release.yaml", "release").def,
  machine: machineConfig,
  projectCwd,
})) {
  return {
    sourceText,
    sourceLabel: "release.yaml",
    workflowId: "release",
    machineConfig,
    projectCwd,
    stateDirectory: "/tmp/workshop-state",
    resolvedSettings,
    runtimeManifest: {
      durableVersion: "1.0.2",
      integrationManifestHash: `sha256:${"b".repeat(64)}`,
      taskVersions: {},
    },
    runId: "release-run-001",
    eventId: "event-run-001",
    activationId: "activation-release",
    occurrenceId: "occurrence-slot-001",
    requestId: "request-client-001",
    admittedAt: "2026-10-05T12:00:00.000Z",
  };
}

describe("prepareRunAdmission", () => {
  test("checks source, canonical definition, resolved settings, and paths before persistence", () => {
    const result = prepareRunAdmission(preparedRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);

    const expectedSourceHash = `sha256:${createHash("sha256").update(sourceText, "utf8").digest("hex")}`;
    const definition = checkDefinitionText(sourceText, "release.yaml", "release").def;
    expect(result.value.sourceHash).toBe(expectedSourceHash);
    expect(result.value.canonicalHash).toBe(canonicalHash(definition));
    expect(result.value.chain).toEqual({
      order: ["prepare-report"],
      predecessors: { "prepare-report": null },
    });
    expect(result.value.preflightCacheKey).toBe(canonicalHash({
      definition: result.value.canonicalHash,
      preflight: result.value.resolvedSettings.preflight,
      projectCwd,
    }));
    expect(result.value.resolvedSettings).toMatchObject({
      nodes: {
        "prepare-report": {
          run: { kind: "command", timeoutMs: 120_000, streamCapBytes: 64 * 1024, replay: "safe" },
          validator: { kind: "command", timeoutMs: 120_000, replay: "safe" },
          retries: 2,
          result: "text",
        },
      },
      preflight: { command: "echo preflight", timeoutMs: 5_000 },
    });
    expect(result.value.paths).toEqual({
      projectCwd,
      workflowDirectory: "/tmp/workshop-state/release",
    });
  });

  test("keys preflight passes by definition, effective settings, and project cwd", () => {
    const request = preparedRequest();
    const base = prepareRunAdmission(request);
    expect(base.ok).toBe(true);
    if (!base.ok) throw new Error(base.failure.message);

    const changedText = sourceText.replace("command: echo preflight", "command: echo preflight && true");
    const changedDefinition = checkDefinitionText(changedText, "release.yaml", "release").def;
    const changedDefinitionSettings = resolveWorkflowSettings({
      definition: changedDefinition,
      machine: machineConfig,
      projectCwd,
    });
    const changedDefinitionResult = prepareRunAdmission({
      ...request,
      sourceText: changedText,
      resolvedSettings: changedDefinitionSettings,
    });
    expect(changedDefinitionResult.ok).toBe(true);
    if (!changedDefinitionResult.ok) throw new Error(changedDefinitionResult.failure.message);
    expect(changedDefinitionResult.value.preflightCacheKey).not.toBe(base.value.preflightCacheKey);

    const anotherCwd = "/tmp/workshop-project-other";
    const cwdSettings = resolveWorkflowSettings({
      definition: checkDefinitionText(sourceText, "release.yaml", "release").def,
      machine: machineConfig,
      projectCwd: anotherCwd,
    });
    const cwdResult = prepareRunAdmission({ ...request, projectCwd: anotherCwd, resolvedSettings: cwdSettings });
    expect(cwdResult.ok).toBe(true);
    if (!cwdResult.ok) throw new Error(cwdResult.failure.message);
    expect(cwdResult.value.preflightCacheKey).not.toBe(base.value.preflightCacheKey);

    const inheritedTimeoutText = sourceText.replace("    timeout: 5s\n", "");
    const inheritedDefinition = checkDefinitionText(inheritedTimeoutText, "release.yaml", "release").def;
    const inheritedSettings = resolveWorkflowSettings({ definition: inheritedDefinition, machine: machineConfig, projectCwd });
    const inheritedRequest = { ...request, sourceText: inheritedTimeoutText, resolvedSettings: inheritedSettings };
    const inheritedResult = prepareRunAdmission(inheritedRequest);
    expect(inheritedResult.ok).toBe(true);
    if (!inheritedResult.ok) throw new Error(inheritedResult.failure.message);

    const changedMachine = { ...machineConfig, shell: "/bin/sh" };
    const settings = resolveWorkflowSettings({ definition: inheritedDefinition, machine: changedMachine, projectCwd });
    const settingsResult = prepareRunAdmission({
      ...inheritedRequest,
      machineConfig: changedMachine,
      resolvedSettings: settings,
    });
    expect(settingsResult.ok).toBe(true);
    if (!settingsResult.ok) throw new Error(settingsResult.failure.message);
    expect(settingsResult.value.canonicalHash).toBe(inheritedResult.value.canonicalHash);
    expect(settingsResult.value.preflightCacheKey).not.toBe(inheritedResult.value.preflightCacheKey);
  });

  test("rejects resolved values that differ from the checked source and machine", () => {
    const resolved = resolveWorkflowSettings({
      definition: checkDefinitionText(sourceText, "release.yaml", "release").def,
      machine: machineConfig,
      projectCwd,
    });
    const altered = {
      ...resolved,
      nodes: {
        ...resolved.nodes,
        "prepare-report": {
          ...resolved.nodes["prepare-report"]!,
          run: {
            ...resolved.nodes["prepare-report"]!.run,
            command: "echo substituted",
          },
        },
      },
    };
    const result = prepareRunAdmission(preparedRequest(altered));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("mismatched settings were accepted");
    expect(result.failure.kind).toBe("resolved_settings_mismatch");
  });

  test("rejects removed harness variables before admission with migration guidance", () => {
    const legacyHarnessSource = [
      "version: 4",
      "defaults: { retries: 0, replay: never }",
      "steps:",
      "  - legacy-worker:",
      "      agent:",
      "        instructions: Write the result.",
      "        model: provider/model:low",
      "        harness:",
      "          command: 'custom-agent $WORKSHOP_RESULT_FILE'",
      "",
    ].join("\n");
    const result = prepareRunAdmission({
      ...preparedRequest(),
      sourceText: legacyHarnessSource,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("legacy harness command passed admission");
    expect(result.failure.kind).toBe("machine_settings_invalid");
    expect(result.failure.message).toContain("step \"legacy-worker\" worker harness");
    expect(result.failure.message).toContain("WORKSHOP_RESULT_FILE");
    expect(result.failure.message).toContain("read input from stdin");
    expect(result.failure.message).toContain("write the declared result to stdout");
    expect(result.failure.message).toContain("send diagnostics to stderr");
  });

  test("rejects malformed definitions and unsafe run paths before storage access", () => {
    const invalidSource = prepareRunAdmission({ ...preparedRequest(), sourceText: "version: 1\nid: old\n" });
    expect(invalidSource.ok).toBe(false);
    if (!invalidSource.ok) expect(invalidSource.failure.kind).toBe("definition_invalid");

    const unsafeId = prepareRunAdmission({ ...preparedRequest(), runId: "release-../escape" });
    expect(unsafeId.ok).toBe(false);
    if (!unsafeId.ok) expect(unsafeId.failure.kind).toBe("admission_input_invalid");
  });
});
