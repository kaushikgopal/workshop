import { readFileSync } from "node:fs";
import { authorizedMarker } from "../worklog/apply-marker-rules.js";
import { packetTemplate } from "../worklog/prepare-packet.js";

export const AGENT_CONTRACT = `You are one node of a Workshop agent workflow. Workshop is a deterministic
runtime; you are a fresh session scoped to this attempt.

Contract:
- Read the complete worklog at $WORKSHOP_WORKLOG_FILE for context.
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
