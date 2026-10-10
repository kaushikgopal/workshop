import { parseModel, type ParsedModel } from "./parse-model.js";
import type { AgentDefaults, AgentSettings } from "./schema.js";

/** The built-in `harness: pi` preset and the default for every agent step. */
export const PI_HARNESS_COMMAND = 'pi --print --approve --no-session --no-extensions --no-skills'
  + ' --no-context-files --no-mcp --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"';

export interface AgentResolution {
  harnessCommand: string;
  model: ParsedModel | null;
}

/** Resolve each agent field independently: execution site, workflow, machine, then the Pi preset. */
export function resolveAgent(input: {
  site?: Pick<AgentSettings, "harness" | "model">;
  workflowDefault?: AgentDefaults;
  machine?: AgentDefaults;
}): AgentResolution {
  const harness = input.site?.harness ?? input.workflowDefault?.harness ?? input.machine?.harness ?? "pi";
  const harnessCommand = harness === "pi" ? PI_HARNESS_COMMAND : harness.command;
  const modelRaw = input.site?.model ?? input.workflowDefault?.model ?? input.machine?.model ?? null;

  return {
    harnessCommand,
    model: modelRaw ? parseModel(modelRaw) : null,
  };
}
