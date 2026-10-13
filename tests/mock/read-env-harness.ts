import { appendFileSync, readFileSync } from "node:fs";

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
const traceFile = environment("WORKSHOP_HARNESS_TRACE");
const prompt = readFileSync(0, "utf8");
const promptMarker = "MOCK_BETA_PROMPT_SENTINEL";
if (!prompt.includes(promptMarker)) throw new Error("the environment harness did not receive its rendered prompt on stdin");
const previousOutput = prompt.includes("alpha:mock-alpha/poet:high:prompt=MOCK_ALPHA_PROMPT_SENTINEL")
  ? "alpha:mock-alpha/poet:high:prompt=MOCK_ALPHA_PROMPT_SENTINEL"
  : "";
if (previousOutput === "") throw new Error("the previous node output was not included in the environment harness prompt");

const output = `beta:${model}:prompt=${promptMarker}:previous=${previousOutput}`;
appendFileSync(traceFile, `${JSON.stringify({ harness: "environment", model, promptMarker, previousOutput, promptLength: prompt.length })}\n`, "utf8");
process.stdout.write(`<status>succeeded</status>\n<output>${output}</output>`);
