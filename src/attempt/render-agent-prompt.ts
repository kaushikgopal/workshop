interface AgentPromptIdentity {
  workflowId: string;
  runId: string;
  nodeId: string;
  attemptNumber: number;
  instructions: string;
  workflowInstructions: string | null;
  worklogPath: string;
  previousOutputPath: string;
  resultPath: string;
}

/** Render a fresh worker prompt whose file output remains only a proposal. */
export function renderWorkerPrompt(input: AgentPromptIdentity): string {
  return `# Workshop worker attempt

Workflow: ${input.workflowId}
Run: ${input.runId}
Step: ${input.nodeId}
Attempt: ${input.attemptNumber}
${renderWorkflowInstructions(input.workflowInstructions)}
## Instructions

${input.instructions}

## Context

Read the worklog at ${input.worklogPath} and the previous successful output at ${input.previousOutputPath}.

## Result contract

Write one strict UTF-8 JSON object to ${input.resultPath} with exactly these keys:

- \`version\`: integer 1
- \`output\`: nonempty string, at most 1 MiB in UTF-8
- \`summary\`: string, at most 64 KiB in UTF-8
- \`artifacts\`: array of at most 100 objects, each with exactly \`kind\` and \`path\` string keys

The result is a proposal. Workshop accepts it only after your process exits successfully, the whole process group is confirmed dead, and the result bytes pass validation. Do not edit Workshop state or claim that a validator has approved this result.
`;
}

/** Render a fresh validator prompt over the committed worker candidate. */
export function renderValidatorPrompt(input: AgentPromptIdentity & { candidatePath: string }): string {
  return `# Workshop validator attempt

Workflow: ${input.workflowId}
Run: ${input.runId}
Step: ${input.nodeId}
Attempt: ${input.attemptNumber}
${renderWorkflowInstructions(input.workflowInstructions)}
## Instructions

${input.instructions}

## Context

Read the worklog at ${input.worklogPath}, the previous successful output at ${input.previousOutputPath}, and the committed worker candidate at ${input.candidatePath}. The candidate is immutable evidence; do not edit it or replace the worker result.

## Verdict contract

Write one strict UTF-8 JSON object to ${input.resultPath} with exactly these keys:

- \`version\`: integer 1
- \`passed\`: boolean
- \`reason\`: nonempty string, at most 64 KiB in UTF-8

Your verdict is a proposal. Workshop accepts it only after your process exits with code 0, the whole process group is confirmed dead, and the verdict bytes pass validation. You cannot publish output, create a successor, or change Workshop lifecycle state.
`;
}

/** Workflow instructions are shared by every agent in the workflow and precede the site's own instructions. */
function renderWorkflowInstructions(text: string | null): string {
  return text === null ? "" : `\n## Workflow instructions\n\n${text}\n`;
}
