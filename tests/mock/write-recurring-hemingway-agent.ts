import { appendFileSync, readFileSync } from "node:fs";

const env = process.env;
const roleValue = env.WORKSHOP_MOCK_ROLE;
if (roleValue !== "generator" && roleValue !== "validator") throw new Error("recurring Hemingway mock: invalid role");
const role = roleValue;
const runId = requiredEnvironment("WORKSHOP_RUN_ID");
const launchLog = requiredEnvironment("WORKSHOP_MOCK_LAUNCH_LOG");
const resultsPath = requiredEnvironment("WORKSHOP_MOCK_RESULTS_PATH");
const executionId = requiredEnvironment("WORKSHOP_EXECUTION_ID");
const prompt = readFileSync(0, "utf8");
const sleepMs = Number(env.WORKSHOP_MOCK_SLEEP_MS ?? "0");
if (!Number.isSafeInteger(sleepMs) || sleepMs < 0) throw new Error("recurring Hemingway mock: invalid sleep duration");

function requiredEnvironment(name: string): string {
  const value = env[name];
  if (value === undefined) throw new Error("recurring Hemingway mock: " + name + " is missing");
  return value;
}

interface ActivityRecord {
  readonly event: string;
  readonly role: string;
  readonly runId: string;
  readonly pid: number;
  readonly [key: string]: unknown;
}

function record(event: string, fields: Record<string, unknown> = {}): void {
  const entry: ActivityRecord = { event, role, runId, pid: process.pid, ...fields };
  appendFileSync(launchLog, JSON.stringify(entry) + "\n", "utf8");
}

const scenes = [
  "The fisherman set his lantern beside the frozen reeds.",
  "Rain filled the mule tracks before the white road reached the harbor.",
  "One grey gull circled the abandoned orchard above the cliffs.",
  "At dusk the quarrymen carried a brass drum through the pines.",
  "A red sail crossed the bay while the church bell called the farmers home.",
  "The boy counted crabs beneath the moonlit pier before the tide returned.",
] as const;

function earlierSentences(): string[] {
  const lines = readFileSync(resultsPath, "utf8").split("\n");
  const sentences: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^<result-generate-([0-9a-f]{8}) status="succeeded">$/u.exec(lines[index] ?? "");
    if (opening === null) continue;
    const closing = "</result-generate-" + opening[1] + ">";
    const content: string[] = [];
    for (index += 1; index < lines.length && lines[index] !== closing; index += 1) content.push(lines[index]!);
    if (index < lines.length) sentences.push(content.join("\n").trim());
  }
  return sentences;
}

function contentWords(sentence: string): Set<string> {
  const stopWords = new Set(["the", "a", "an", "as", "at", "by", "from", "in", "of", "on", "to", "while", "before", "after", "and", "or", "his", "her", "its"]);
  return new Set((sentence.toLowerCase().match(/[a-z]+/gu) ?? []).filter((word) => word.length > 2 && !stopWords.has(word)));
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

function readCandidateFromPrompt(value: string): string {
  const startMarker = "### Candidate output (data)\n\n";
  const endMarker = "\n\nCandidate status: ";
  const start = value.indexOf(startMarker);
  if (start === -1) throw new Error("validator candidate is missing from stdin");
  const contentStart = start + startMarker.length;
  const end = value.indexOf(endMarker, contentStart);
  if (end === -1) throw new Error("validator candidate boundary is missing from stdin");
  return value.slice(contentStart, end);
}

record("start", { executionId, promptBytes: Buffer.byteLength(prompt), resultsPath: env.WORKSHOP_RESULTS_PATH, logPath: env.WORKSHOP_LOG_PATH, archivePresent: env.WORKSHOP_ARCHIVE !== undefined });

try {
  if (sleepMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, sleepMs));

  const earlier = earlierSentences();
  if (role === "generator") {
    const fixedOutput = env.WORKSHOP_MOCK_OUTPUT;
    const output = fixedOutput ?? scenes.find((scene) => !overlapsEarlier(scene, earlier));
    if (output === undefined) throw new Error("recurring Hemingway mock: no distinct fixture sentence remains");
    const mode = env.WORKSHOP_MOCK_GENERATOR_RESULT ?? "valid";
    const result = mode === "malformed"
      ? "<status>succeeded</status>\n<output>unfinished"
      : env.WORKSHOP_MOCK_NEEDS_INPUT === "1"
        ? "<status>needs_input</status>\n<question>Approve this sentence?</question>\n<output>" + output + "</output>"
        : output;
    process.stdout.write(result);
    record("result", { executionId, malformed: mode === "malformed", output });
  } else {
    const candidate = readCandidateFromPrompt(prompt).trim();
    const distinct = !overlapsEarlier(candidate, earlier);
    const oneSentence = candidate.length > 0 && (candidate.match(/[.!?]/gu) ?? []).length === 1;
    const passed = env.WORKSHOP_MOCK_VERDICT !== "reject" && distinct && oneSentence
      && !candidate.toLowerCase().includes("hemingway");
    const reason = passed
      ? "The sentence is original and distinct from " + earlier.length + " earlier accepted sentence(s)."
      : distinct ? "The candidate failed the deterministic sentence policy." : "The candidate repeats an earlier accepted sentence.";
    const result = passed
      ? "accept\n" + reason
      : "retry\n" + reason + "\nWrite a distinct one-sentence result.";
    process.stdout.write(result);
    record("verdict", { executionId, candidate, priorCount: earlier.length, passed, reason });
  }
} finally {
  record("finish", { executionId });
}
