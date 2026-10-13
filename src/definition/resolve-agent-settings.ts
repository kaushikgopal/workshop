import { parseModel, type ParsedModel } from "./parse-model.js";
import type { AgentDefaults, AgentSettings } from "./schema.js";

/** The built-in `harness: pi` preset and the default for every agent step. */
export const PI_HARNESS_COMMAND = 'pi --print --approve --no-session --no-extensions --no-skills'
  + ' --no-context-files --no-mcp --model "$WORKSHOP_MODEL_WITH_THINKING"';

// This literal migration check does not analyze shell expansion.
const REMOVED_HARNESS_VARIABLES = [
  "WORKSHOP_PROMPT_FILE",
  "WORKSHOP_RESULT_FILE",
  "WORKSHOP_PREVIOUS_OUTPUT_FILE",
  "WORKSHOP_STEP_OUTPUT_FILE",
  "WORKSHOP_WORKLOG_FILE",
  "WORKSHOP_STDOUT_FILE",
  "WORKSHOP_STDERR_FILE",
  "WORKSHOP_BIN",
] as const;

type AgentRole = "worker" | "verifier";

export interface AgentResolution {
  harnessCommand: string;
  model: ParsedModel | null;
}

/** Resolve each agent field independently: execution site, workflow, machine, then the Pi preset. */
export function resolveAgent(input: {
  site?: Pick<AgentSettings, "harness" | "model">;
  workflowDefault?: AgentDefaults;
  machine?: AgentDefaults;
  context?: { readonly role: AgentRole; readonly stepId: string };
}): AgentResolution {
  const harness = input.site?.harness ?? input.workflowDefault?.harness ?? input.machine?.harness ?? "pi";
  const harnessCommand = harness === "pi" ? PI_HARNESS_COMMAND : harness.command;
  const removedVariable = REMOVED_HARNESS_VARIABLES.find((name) => harnessCommand.includes(name));
  if (removedVariable !== undefined) {
    const context = input.context === undefined
      ? "agent harness"
      : "step \"" + input.context.stepId + "\" " + input.context.role + " harness";
    throw new Error(context + " command references removed variable " + removedVariable
      + "; migrate the harness to read input from stdin, write the declared result to stdout, and send diagnostics to stderr");
  }
  const modelRaw = input.site?.model ?? input.workflowDefault?.model ?? input.machine?.model ?? null;

  return {
    harnessCommand,
    model: modelRaw ? parseModel(modelRaw) : null,
  };
}
