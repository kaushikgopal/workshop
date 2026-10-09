import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

function environment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name} environment variable`);
  return value;
}

const provider = environment("WORKSHOP_PROVIDER");
const modelId = environment("WORKSHOP_MODEL_ID");
const thinking = environment("WORKSHOP_THINKING");
const model = `${provider}/${modelId}:${thinking}`;
if (environment("WORKSHOP_MODEL") !== `${provider}/${modelId}`) {
  throw new Error("the decomposed model mapping differs from the resolved Workshop model");
}

const promptFile = environment("WORKSHOP_PROMPT_FILE");
const resultFile = environment("WORKSHOP_RESULT_FILE");
const traceFile = environment("WORKSHOP_HARNESS_TRACE");
const prompt = readFileSync(promptFile, "utf8");
const promptMarker = "MOCK_BETA_PROMPT_SENTINEL";
if (!prompt.includes(promptMarker)) throw new Error("the environment harness did not receive its rendered prompt");
const previousOutput = readFileSync(environment("WORKSHOP_PREVIOUS_OUTPUT_FILE"), "utf8").trimEnd();
if (!previousOutput.startsWith("alpha:")) throw new Error("the previous node output was not mapped to the environment harness");

const output = `beta:${model}:prompt=${promptMarker}:previous=${previousOutput}`;
writeFileSync(resultFile, `${JSON.stringify({
  version: 1,
  output,
  summary: "environment harness mapped split model, prompt, and result paths",
  artifacts: [],
})}\n`, "utf8");
appendFileSync(traceFile, `${JSON.stringify({
  harness: "environment",
  model,
  promptFile,
  promptMarker,
  resultFile,
  previousOutput,
})}\n`, "utf8");
process.stdout.write("environment harness completed\n");
