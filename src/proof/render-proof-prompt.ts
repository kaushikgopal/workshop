export interface ProofPromptInput {
  runId: string;
  nodeId: string;
  previousOutput: string;
  resultFile: string;
}

/**
 * The prompt a real harness reads. It names absolute paths rather than
 * environment variables so a `pi --print -- "$(cat ...)"` template works.
 * The generate node writes only the checked result JSON; the runtime
 * publishes `output` as the node output file the next node reads.
 */
export function renderProofPrompt(input: ProofPromptInput): string {
  return [
    `# Hemingway durable proof — ${input.nodeId}`,
    "",
    `Run: ${input.runId}`,
    "",
    "Previous node output:",
    "",
    input.previousOutput.trim() === "" ? "(none)" : input.previousOutput.trim(),
    "",
    "Write exactly one original Hemingway-inspired sentence, without quotation marks.",
    "",
    `Write this JSON to: ${input.resultFile}`,
    "",
    '{"version":1,"output":"<your sentence>","summary":"<one short note about the sentence>","artifacts":[]}',
    "",
    "Include exactly these four required top-level keys: version, output, summary, artifacts.",
    "Set version to the number 1 and artifacts to an empty array.",
    "`output` is the sentence the next node reads. `summary` is a short note for",
    "the proof record. Do not omit version or artifacts, and do not add any keys.",
    "Before finishing, reread your file and check that all four required keys are present.",
    "",
    "Do not write any other files.",
    "",
  ].join("\n");
}
