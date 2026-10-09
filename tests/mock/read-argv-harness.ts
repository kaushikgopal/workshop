import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

function option(name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name} argument`);
  return value;
}

function environment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name} environment variable`);
  return value;
}

const model = option("--model");
const promptFile = option("--prompt-file");
const resultFile = option("--result-file");
const traceFile = environment("WORKSHOP_HARNESS_TRACE");
if (model !== environment("WORKSHOP_MODEL_WITH_THINKING")) {
  throw new Error("the argv model mapping differs from the resolved Workshop model");
}

const prompt = readFileSync(promptFile, "utf8");
const promptMarker = "MOCK_ALPHA_PROMPT_SENTINEL";
if (!prompt.includes(promptMarker)) throw new Error("the argv harness did not receive its rendered prompt");

const output = `alpha:${model}:prompt=${promptMarker}`;
writeFileSync(resultFile, `${JSON.stringify({
  version: 1,
  output,
  summary: "argv harness mapped model, prompt, and result paths",
  artifacts: [],
})}\n`, "utf8");
appendFileSync(traceFile, `${JSON.stringify({
  harness: "argv",
  model,
  promptFile,
  promptMarker,
  resultFile,
})}\n`, "utf8");
process.stdout.write("argv harness completed\n");
