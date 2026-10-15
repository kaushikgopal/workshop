import { Buffer } from "node:buffer";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { loadInstallation } from "../../src/installation/load-installation.js";
import { startWorkshopService } from "../../src/service/open-service-runtime.js";
import { createFauxModels } from "./create-faux-models.js";

const scenes = [
  "The fisherman set his lantern beside the frozen reeds.",
  "Rain filled the mule tracks before the white road reached the harbor.",
  "One grey gull circled the abandoned orchard above the cliffs.",
  "At dusk the quarrymen carried a brass drum through the pines.",
  "A red sail crossed the bay while the church bell called the farmers home.",
  "The boy counted crabs beneath the moonlit pier before the tide returned.",
] as const;

const [root, scenario, optionsText = "{}"] = process.argv.slice(2);
if (root === undefined || scenario === undefined) throw new Error("usage: serve-faux-workshop <root> <scenario> [options-json]");
const options = JSON.parse(optionsText) as Record<string, unknown>;
function createScenarioModels(name: string, scenarioOptions: Record<string, unknown>) {
  if (name === "restart-progress") return restartProgressModels();
  if (name === "restart-recovered") return restartRecoveredModels();
  if (name === "native-provider-parity") return nativeProviderParityModels();
  if (name === "hemingway-acceptance") return hemingwayAcceptanceModels(scenarioOptions);
  throw new Error("unknown faux Workshop scenario: " + name);
}

function restartProgressModels() {
  const { models, faux } = createFauxModels([], { provider: "fixture", modelIds: ["mock-model"], reasoning: true });
  faux.setResponses([
    (context) => {
      requirePrompt(context, "RESTART_PROMPT_SENTINEL");
      const promptBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
      const command = "receipt=\"${WORKSHOP_RESULTS_PATH%/results.md}/agent-receipt.txt\""
        + "; activity=\"${WORKSHOP_RESULTS_PATH%/results.md}/mock-activity.jsonl\""
        + "; printf 'receipt\\n' >> \"$receipt\""
        + "; printf '{\"event\":\"start\",\"role\":\"worker\",\"runId\":\"%s\",\"executionId\":\"%s\",\"model\":\"%s\",\"thinking\":\"%s\",\"resultsPath\":\"%s\",\"logPath\":\"%s\",\"promptBytes\":%s,\"promptMarker\":\"RESTART_PROMPT_SENTINEL\"}\\n'"
        + " \"$WORKSHOP_RUN_ID\" \"$WORKSHOP_EXECUTION_ID\" \"$WORKSHOP_MODEL_WITH_THINKING\" \"$WORKSHOP_THINKING\" \"$WORKSHOP_RESULTS_PATH\" \"$WORKSHOP_LOG_PATH\" " + promptBytes
        + " >> \"$activity\"";
      return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage(fauxToolCall("bash", {
      command: "printf 'after-receipt\\n' >> \"${WORKSHOP_RESULTS_PATH%/results.md}/after-receipt.txt\"",
    }), { stopReason: "toolUse" }),
    () => new Promise<AssistantMessage>(() => {}),
  ]);
  return models;
}

function restartRecoveredModels() {
  return createFauxModels([
    fauxAssistantMessage("<status>succeeded</status>\n<reason>One Hemingway sentence, written by the deterministic mock.</reason>\n<output>The old man rowed until the sea forgot the shore.</output>"),
  ], { provider: "fixture", modelIds: ["mock-model"], reasoning: true }).models;
}

function nativeProviderParityModels() {
  const alpha = createFauxModels([], { provider: "mock-alpha", modelIds: ["poet"], reasoning: true });
  const beta = createFauxModels([], { provider: "mock-beta", modelIds: ["editor"], reasoning: true });
  alpha.models.setProvider(beta.faux.provider);
  const alphaOutput = "alpha:mock-alpha/poet:high:prompt=MOCK_ALPHA_PROMPT_SENTINEL";
  const alphaResult = "<status>succeeded</status>\n<reason>Mock alpha completed.</reason>\n<output>" + alphaOutput + "</output>";
  const betaOutput = "beta:mock-beta/editor:low:prompt=MOCK_BETA_PROMPT_SENTINEL:previous=" + alphaOutput;
  const betaResult = "<status>succeeded</status>\n<reason>Mock beta completed.</reason>\n<output>" + betaOutput + "</output>";
  const tracePath = process.env.WORKSHOP_TEST_TRACE_PATH;
  if (tracePath === undefined) throw new Error("native provider trace path is missing");
  alpha.faux.setResponses([
    (context) => {
      requirePrompt(context, "MOCK_ALPHA_PROMPT_SENTINEL");
      return fauxAssistantMessage(fauxToolCall("bash", {
        command: traceCommand(tracePath, "alpha", context, "MOCK_ALPHA_PROMPT_SENTINEL"),
      }), { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage(alphaResult),
  ]);
  beta.faux.setResponses([
    (context) => {
      requirePrompt(context, "MOCK_BETA_PROMPT_SENTINEL");
      requirePrompt(context, alphaOutput);
      return fauxAssistantMessage(fauxToolCall("bash", {
        command: traceCommand(tracePath, "beta", context, "MOCK_BETA_PROMPT_SENTINEL", alphaOutput),
      }), { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage(betaResult),
  ]);
  return alpha.models;
}

function traceCommand(path: string, role: string, context: TranscriptContext, marker: string, previousOutput?: string): string {
  const format = "{\"role\":\"%s\",\"provider\":\"%s\",\"model\":\"%s\",\"thinking\":\"%s\",\"runId\":\"%s\",\"executionId\":\"%s\",\"promptLength\":%s,\"promptMarker\":\"%s\",\"previousOutput\":%s}\\n";
  const values = [
    shellQuote(role), "\"$WORKSHOP_PROVIDER\"", "\"$WORKSHOP_MODEL_WITH_THINKING\"", "\"$WORKSHOP_THINKING\"",
    "\"$WORKSHOP_RUN_ID\"", "\"$WORKSHOP_EXECUTION_ID\"", String(Buffer.byteLength(JSON.stringify(context), "utf8")),
    shellQuote(marker), shellQuote(previousOutput === undefined ? "null" : JSON.stringify(previousOutput)),
  ];
  return "printf '" + format + "' " + values.join(" ") + " >> " + shellQuote(path);
}

function hemingwayAcceptanceModels(scenarioOptions: Record<string, unknown>) {
  const generator = createFauxModels([], { provider: "fixture-generator", modelIds: ["generator"], reasoning: true });
  const validator = createFauxModels([], { provider: "fixture-validator", modelIds: ["validator"], reasoning: true });
  generator.models.setProvider(validator.faux.provider);
  const activityPath = typeof scenarioOptions.activityPath === "string" ? scenarioOptions.activityPath : undefined;
  if (activityPath === undefined) throw new Error("Hemingway activity path is missing");
  const fixedOutput = typeof scenarioOptions.fixedOutput === "string" ? scenarioOptions.fixedOutput : undefined;
  const malformed = scenarioOptions.malformedGenerator === true;
  const needsInput = scenarioOptions.needsInput === true;
  const generatorDelay = positiveDelay(scenarioOptions.generatorSleepMs);
  const validatorDelay = positiveDelay(scenarioOptions.validatorSleepMs);
  let currentOutput = "";
  let currentResult = "";
  let currentCandidate = "";
  let currentPriorCount = 0;
  let currentPassed = false;
  let currentReason = "";

  generator.faux.setResponses(repeatResponses(generator.faux, [
    async (context) => {
      requirePrompt(context, "WORKSHOP_RESULTS_PATH");
      await delay(generatorDelay);
      return fauxAssistantMessage(fauxToolCall("bash", {
        command: activityCommand(activityPath, "start", "generator", context) + '; cat "$WORKSHOP_RESULTS_PATH"',
      }), { stopReason: "toolUse" });
    },
    (context) => {
      const earlier = earlierSentences(latestToolResult(context));
      currentPriorCount = earlier.length;
      const scene = fixedOutput ?? scenes.find((candidate) => !overlapsEarlier(candidate, earlier));
      if (scene === undefined) throw new Error("no distinct Hemingway fixture sentence remains");
      currentOutput = scene;
      currentResult = malformed
        ? "<status>succeeded</status>\n<output>unfinished"
        : needsInput
          ? "<status>needs_input</status>\n<question>Approve this sentence?</question>\n<output>" + scene + "</output>"
          : "<status>succeeded</status>\n<reason>One original sentence with a deterministic acceptance check.</reason>\n<output>" + scene + "</output>";
      return fauxAssistantMessage(fauxToolCall("bash", {
        command: activityCommand(activityPath, "result", "generator", context, {
          output: currentOutput,
          priorCount: currentPriorCount,
        }),
      }), { stopReason: "toolUse" });
    },
    (context) => {
      if (currentResult === "") throw new Error("generator result was not prepared before its final response");
      return fauxAssistantMessage(currentResult);
    },
  ]));
  validator.faux.setResponses(repeatResponses(validator.faux, [
    async (context) => {
      requirePrompt(context, "Role: verifier");
      await delay(validatorDelay);
      return fauxAssistantMessage(fauxToolCall("bash", {
        command: activityCommand(activityPath, "start", "validator", context) + '; cat "$WORKSHOP_RESULTS_PATH"',
      }), { stopReason: "toolUse" });
    },
    (context) => {
      const earlier = earlierSentences(latestToolResult(context));
      currentCandidate = readCandidateFromPrompt(context);
      currentPriorCount = earlier.length;
      currentPassed = currentCandidate.length > 0 && !overlapsEarlier(currentCandidate, earlier);
      currentReason = currentPassed
        ? "The candidate is original and distinct from earlier results."
        : "The candidate is empty or repeats the meaning of an earlier result.";
      return fauxAssistantMessage(fauxToolCall("bash", {
        command: activityCommand(activityPath, "verdict", "validator", context, {
          candidate: currentCandidate,
          priorCount: currentPriorCount,
          passed: currentPassed,
          reason: currentReason,
        }),
      }), { stopReason: "toolUse" });
    },
    (context) => {
      if (currentReason === "") throw new Error("validator verdict was not prepared before its final response");
      return fauxAssistantMessage((currentPassed ? "accept\n" : "retry\n") + currentReason);
    },
  ]));
  return generator.models;
}

function repeatResponses(
  faux: { appendResponses: (responses: FauxResponseStep[]) => void },
  responses: readonly FauxResponseStep[],
): FauxResponseStep[] {
  if (responses.length === 0) throw new Error("repeating faux responses cannot be empty");
  let index = 0;
  const repeat: FauxResponseFactory = async (context, options, state, model) => {
    const response = responses[index]!;
    index = (index + 1) % responses.length;
    faux.appendResponses([repeat]);
    return typeof response === "function" ? response(context, options, state, model) : response;
  };
  return [repeat];
}

function activityCommand(
  path: string,
  event: "start" | "result" | "verdict",
  role: "generator" | "validator",
  context: TranscriptContext,
  fields: { readonly output?: string; readonly priorCount?: number; readonly candidate?: string; readonly passed?: boolean; readonly reason?: string } = {},
): string {
  const format = event === "start"
    ? "{\"event\":\"%s\",\"role\":\"%s\",\"runId\":\"%s\",\"executionId\":\"%s\",\"provider\":\"%s\",\"model\":\"%s\",\"thinking\":\"%s\",\"promptBytes\":%s,\"resultsPath\":\"%s\",\"logPath\":\"%s\",\"archivePresent\":false}\\n"
    : event === "result"
      ? "{\"event\":\"%s\",\"role\":\"%s\",\"runId\":\"%s\",\"executionId\":\"%s\",\"output\":%s,\"priorCount\":%s}\\n{\"event\":\"finish\",\"role\":\"%s\",\"runId\":\"%s\",\"executionId\":\"%s\"}\\n"
      : "{\"event\":\"verdict\",\"role\":\"%s\",\"runId\":\"%s\",\"executionId\":\"%s\",\"candidate\":%s,\"priorCount\":%s,\"passed\":%s,\"reason\":%s}\\n{\"event\":\"finish\",\"role\":\"%s\",\"runId\":\"%s\",\"executionId\":\"%s\"}\\n";
  const values = event === "start"
    ? [
      shellQuote(event), shellQuote(role), "\"$WORKSHOP_RUN_ID\"", "\"$WORKSHOP_EXECUTION_ID\"", "\"$WORKSHOP_PROVIDER\"",
      "\"$WORKSHOP_MODEL_WITH_THINKING\"", "\"$WORKSHOP_THINKING\"", String(Buffer.byteLength(JSON.stringify(context), "utf8")),
      "\"$WORKSHOP_RESULTS_PATH\"", "\"$WORKSHOP_LOG_PATH\"",
    ]
    : event === "result"
      ? [
        shellQuote(event), shellQuote(role), "\"$WORKSHOP_RUN_ID\"", "\"$WORKSHOP_EXECUTION_ID\"",
        shellQuote(JSON.stringify(fields.output ?? "")), String(fields.priorCount ?? 0), shellQuote(role),
        "\"$WORKSHOP_RUN_ID\"", "\"$WORKSHOP_EXECUTION_ID\"",
      ]
      : [
        shellQuote(role), "\"$WORKSHOP_RUN_ID\"", "\"$WORKSHOP_EXECUTION_ID\"", shellQuote(JSON.stringify(fields.candidate ?? "")),
        String(fields.priorCount ?? 0), fields.passed === true ? "true" : "false", shellQuote(JSON.stringify(fields.reason ?? "")),
        shellQuote(role), "\"$WORKSHOP_RUN_ID\"", "\"$WORKSHOP_EXECUTION_ID\"",
      ];
  return "printf '" + format + "' " + values.join(" ") + " >> " + shellQuote(path);
}

function earlierSentences(content: string): string[] {
  const lines = content.split("\n");
  const sentences: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^<result-generate-([0-9a-f]{8}) status="succeeded">$/u.exec(lines[index] ?? "");
    if (opening === null) continue;
    const closing = "</result-generate-" + opening[1] + ">";
    const body: string[] = [];
    for (index += 1; index < lines.length && lines[index] !== closing; index += 1) body.push(lines[index]!);
    if (index < lines.length) sentences.push(body.join("\n").trim());
  }
  return sentences;
}

function overlapsEarlier(candidate: string, earlier: readonly string[]): boolean {
  const words = contentWords(candidate);
  return earlier.some((sentence) => {
    const previousWords = contentWords(sentence);
    let shared = 0;
    for (const word of words) if (previousWords.has(word)) shared += 1;
    return shared >= 3;
  });
}

function contentWords(sentence: string): Set<string> {
  const stopWords = new Set(["the", "a", "an", "as", "at", "by", "from", "in", "of", "on", "to", "while", "before", "after", "and", "or", "his", "her", "its"]);
  return new Set((sentence.toLowerCase().match(/[a-z]+/gu) ?? []).filter((word) => word.length > 2 && !stopWords.has(word)));
}

function readCandidateFromPrompt(context: TranscriptContext): string {
  const prompt = context.messages.filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join("\n"))
    .join("\n");
  const startMarker = "### Candidate output (data)\n\n";
  const endMarker = "\n\nCandidate status: ";
  const start = prompt.indexOf(startMarker);
  if (start === -1) throw new Error("validator candidate is missing from its prompt");
  const contentStart = start + startMarker.length;
  const end = prompt.indexOf(endMarker, contentStart);
  if (end === -1) throw new Error("validator candidate boundary is missing from its prompt");
  return prompt.slice(contentStart, end).trim();
}

function latestToolResult(context: TranscriptContext): string {
  const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
  if (result === undefined || result.role !== "toolResult") throw new Error("faux model did not receive the artifact tool result");
  return result.content.map((block) => block.type === "text" ? block.text : "").join("\n");
}

function requirePrompt(context: TranscriptContext, value: string): void {
  if (!JSON.stringify(context).includes(value)) throw new Error("native prompt is missing expected evidence: " + value);
}

function shellQuote(value: string): string {
  return "'" + value + "'";
}

function positiveDelay(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const models = createScenarioModels(scenario, options);
const owner = await startWorkshopService(loadInstallation(root), models);
await new Promise<void>((resolve) => {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void owner.shutdown().then(() => resolve(), (error: unknown) => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      process.exitCode = 1;
      resolve();
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});
