import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkDefinitionText } from "../src/definition/check-definition.js";
import { parseStrictYaml } from "../src/definition/parse-yaml.js";
import { resolveWorkflowSettings } from "../src/definition/resolve-workflow-settings.js";
import { machineConfigSchema } from "../src/definition/schema.js";

const repoRoot = join(import.meta.dir, "..");
const exampleDir = join(repoRoot, "examples");
const workflowDir = join(exampleDir, "workflows");
const placeholderModel = "example/pi-model:medium";

describe("public example configuration", () => {
  test("checks every workflow and resolves native agents separately from the bot", () => {
    const machinePath = join(exampleDir, "workshop.yaml");
    const machineText = readFileSync(machinePath, "utf8");
    const machine = machineConfigSchema.parse(parseStrictYaml(machineText, machinePath));

    expect(machine.version).toBe(3);
    expect(machine.agent?.model).toBe(placeholderModel);
    expect(machine.bot?.model).toBe(placeholderModel);

    const botOnlyMachine = machineConfigSchema.parse({ ...machine, agent: undefined });
    const files = readdirSync(workflowDir).filter((file) => file.endsWith(".yaml")).sort();

    const checkedById = new Map<string, ReturnType<typeof checkDefinitionText>["def"]>();
    const settingsById = new Map<string, ReturnType<typeof resolveWorkflowSettings>>();
    for (const file of files) {
      const workflowId = file.slice(0, -".yaml".length);
      const path = join(workflowDir, file);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("command -v pi");

      const checked = checkDefinitionText(text, path, workflowId);
      const settings = resolveWorkflowSettings({ definition: checked.def, machine, projectCwd: repoRoot });
      checkedById.set(workflowId, checked.def);
      settingsById.set(workflowId, settings);

      for (const [stepId, node] of Object.entries(checked.def.nodes)) {
        const resolved = settings.nodes[stepId];
        if (resolved === undefined) throw new Error("Missing resolved settings for " + workflowId + "." + stepId);
        const expectedWorkerKind = "agent" in node.run ? "agent" : "command";
        expect(resolved.run.kind).toBe(expectedWorkerKind);
        if (resolved.run.kind === "agent") expect(resolved.run.model).toBe(placeholderModel);

        if (node.validator === undefined) {
          expect(resolved.validator).toBeNull();
        } else {
          const expectedVerifierKind = "agent" in node.validator ? "agent" : "command";
          expect(resolved.validator?.kind).toBe(expectedVerifierKind);
          if (resolved.validator?.kind === "agent") expect(resolved.validator.model).toBe(placeholderModel);
        }
      }

      expect(() => resolveWorkflowSettings({
        definition: checked.def,
        machine: botOnlyMachine,
        projectCwd: repoRoot,
      })).toThrow(/agent model is unresolved/u);
    }

    const clock = checkedById.get("hemingway-clock")!;
    const clockSettings = settingsById.get("hemingway-clock")!;
    expect(clock.schedule).toEqual({ every: "3m", max_runs: 6 });
    expect(clock.defaults).toMatchObject({ retries: 1, timeout: "10m", replay: "safe" });
    expect(clock.environment?.preflight.command).toBe("command -v date >/dev/null");
    expect(clockSettings.nodes.timestamp?.run.kind).toBe("command");
    expect(clockSettings.nodes["generate-line"]?.run.kind).toBe("agent");
    expect(clockSettings.nodes["generate-line"]?.validator?.kind).toBe("agent");

    const retry = checkedById.get("hemingway-clock-retry")!;
    const retrySettings = settingsById.get("hemingway-clock-retry")!;
    expect(retry.defaults).toMatchObject({ retries: 1, replay: "safe" });
    expect(retry.environment?.preflight.command).toBe("command -v date >/dev/null");
    expect(retry.nodes.timestamp?.validator).toMatchObject({ command: expect.stringContaining("WORKSHOP_ATTEMPT") });
    expect(retrySettings.nodes.timestamp).toMatchObject({ retries: 1, run: { kind: "command" }, validator: { kind: "command" } });

    const approval = checkedById.get("hemingway-clock-human-approval")!;
    const approvalSettings = settingsById.get("hemingway-clock-human-approval")!;
    expect(approval.environment).toBeUndefined();
    expect(approval.nodes.draft?.result).toBe("tagged");
    const approvalWorker = approval.nodes.draft?.run;
    if (approvalWorker === undefined || !("agent" in approvalWorker)) throw new Error("Approval step must use a native agent");
    expect(approvalWorker.agent.instructions).toContain("needs_input");
    expect(approvalWorker.agent.instructions).toContain("Approve this sentence?");
    expect(approvalSettings.nodes.draft?.result).toBe("tagged");
    expect(approvalSettings.nodes.draft?.run.kind).toBe("agent");
  });
});
