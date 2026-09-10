import type { ParsedModel } from "../definition/validate.js";
import { readFileSync } from "node:fs";
import { authorizedMarker, packetTemplate } from "../worklog/worklog.js";

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
    WORKSHOP_LOG: input.logPath,
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

const AGENT_CONTRACT = `You are one node of a Workshop agent workflow. Workshop is a deterministic
runtime; you are a fresh session scoped to this attempt.

Contract:
- Read the complete worklog at $WORKSHOP_LOG for context.
- Write ONLY your assigned packet file at $WORKSHOP_NODE_PACKET_FILE.
- Record progress, decisions, validation evidence, and blockers in the packet,
  under the matching headings.
- Report meaningful progress with:
    "$WORKSHOP_CLI" runtime progress --text "..."
- If you cannot proceed, request a blocked state with:
    "$WORKSHOP_CLI" runtime block --reason "..."
  (add --kind unknown_external only when an external effect ended in an
  uncertain state)
- Place the concise context your successor needs inside the scaffolded marker.
- Never write the worklog, another node's packet, or the global decision log.
- Never invent lifecycle values; lifecycle truth belongs to Workshop.
- Manage any subagents yourself and summarize them in your packet.`;

/** Render the injected prompt for an agent attempt. */
export function renderAgentPrompt(input: {
  workflowId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  instructions: string;
  logPath: string;
  packetFile: string;
  previousOutputFile: string | null;
  successorId: string | null;
}): string {
  const previous = input.previousOutputFile
    ? `Previous node output file: ${input.previousOutputFile}`
    : `Previous node output file: (none — this is the first node)`;

  // The packet exists on disk by claim time (scaffolded at attempt creation).
  // Show it verbatim so the model treats the marker pair as load-bearing.
  const marker = authorizedMarker(input.successorId);
  let scaffold: string;
  try {
    scaffold = readFileSync(input.packetFile, "utf8");
  } catch {
    scaffold = packetTemplate(input.attempt, marker);
  }

  return `# Workshop attempt

Workflow: ${input.workflowId}
Run: ${input.runId}
Node: ${input.nodeId}
Attempt: ${input.attempt}

## Instructions

${input.instructions}

## Runtime context

Worklog (read-only for you): ${input.logPath}
Your packet file (the only file you may write): ${input.packetFile}
${previous}

## Contract

${AGENT_CONTRACT}

## Your packet, as it exists right now

Edit this file in place. Two lines in it are load-bearing and MUST survive
everything you do — never delete, rename, or move them:

    ${marker.opening}
    ${marker.closing}

Write the text your successor (or the final result) consumes between those two
lines. The other headings structure the runtime's record — keep them if you
can, but the marker pair is the one hard rule: without it your work is
rejected as invalid and the whole run blocks.

    ${scaffold.split("\n").join("\n    ")}
`;
}
