import { resolve } from "node:path";
import { ParsedModel } from "../definition/parse-model.js";

/**
 * The runtime context every attempt process receives. The prompt is never
 * expanded into a shell variable; harness commands read the prompt file with
 * `"$(cat "$WORKSHOP_PROMPT_FILE")"`.
 */
export function attemptEnv(input: {
  logPath: string;
  runId: string;
  nodeId: string;
  attempt: number;
  promptFile: string | null;
  nodeOutputFile: string;
  previousOutputFile: string | null;
  packetFile: string;
  stdoutFile: string;
  stderrFile: string;
  ownerToken: string;
  validationFile: string | null;
  model: ParsedModel | null;
  cliPath: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    WORKSHOP_WORKLOG_FILE: input.logPath,
    WORKSHOP_RUN_ID: input.runId,
    WORKSHOP_NODE_ID: input.nodeId,
    WORKSHOP_ATTEMPT: String(input.attempt),
    WORKSHOP_NODE_OUTPUT_FILE: input.nodeOutputFile,
    WORKSHOP_NODE_PACKET_FILE: input.packetFile,
    WORKSHOP_STDOUT_FILE: input.stdoutFile,
    WORKSHOP_STDERR_FILE: input.stderrFile,
    WORKSHOP_OWNER_TOKEN: input.ownerToken,
    WORKSHOP_CLI: input.cliPath,
  };
  if (input.promptFile) env.WORKSHOP_PROMPT_FILE = input.promptFile;
  if (input.previousOutputFile) env.WORKSHOP_PREVIOUS_OUTPUT_FILE = input.previousOutputFile;
  if (input.validationFile) env.WORKSHOP_VALIDATION_FILE = input.validationFile;
  if (input.model) {
    env.WORKSHOP_PROVIDER = input.model.provider;
    env.WORKSHOP_MODEL_ID = input.model.modelId;
    env.WORKSHOP_MODEL = `${input.model.provider}/${input.model.modelId}`;
    env.WORKSHOP_THINKING = input.model.thinking;
    env.WORKSHOP_MODEL_WITH_THINKING = input.model.full;
  }
  for (const [k, v] of Object.entries(input.extra ?? {})) env[k] = v;
  return env;
}
/**
 * The single executable agents use for internal runtime commands.
 * Source checkouts invoke the executable TypeScript entry point directly;
 * installed packages fall back to the `workshop` binary.
 */
export function runtimeCliInvocation(): string {
  const script = process.argv[1];
  if (script && script.endsWith(".ts")) {
    return resolve(script);
  }
  return "workshop";
}

