import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const env = process.env;
const roleValue = env.WORKSHOP_MOCK_ROLE;
if (roleValue !== "generator" && roleValue !== "validator") throw new Error("recurring Hemingway mock: invalid role");
const role = roleValue;
const runId = requiredEnvironment("WORKSHOP_RUN_ID");
const launchLog = requiredEnvironment("WORKSHOP_MOCK_LAUNCH_LOG");
const archiveDirectory = requiredEnvironment("WORKSHOP_MOCK_ARCHIVE_DIR");
const executionId = requiredEnvironment("WORKSHOP_EXECUTION_ID");
const prompt = readFileSync(0, "utf8");
const sleepMs = Number(env.WORKSHOP_MOCK_SLEEP_MS ?? "0");
if (!Number.isSafeInteger(sleepMs) || sleepMs < 0) throw new Error("recurring Hemingway mock: invalid sleep duration");

function requiredEnvironment(name: string): string {
  const value = env[name];
  if (value === undefined) throw new Error(`recurring Hemingway mock: ${name} is missing`);
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
  appendFileSync(launchLog, `${JSON.stringify(entry)}\n`, "utf8");
}

const scenes = [
  "The fisherman set his lantern beside the frozen reeds.",
  "Rain filled the mule tracks before the white road reached the harbor.",
  "One grey gull circled the abandoned orchard above the cliffs.",
  "At dusk the quarrymen carried a brass drum through the pines.",
  "A red sail crossed the bay while the church bell called the farmers home.",
  "The boy counted crabs beneath the moonlit pier before the tide returned.",
] as const;

function priorGeneratorCount(): number {
  if (!existsSync(launchLog)) return 0;
  return readFileSync(launchLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ActivityRecord)
    .filter((entry) => entry.event === "start" && entry.role === "generator")
    .length;
}

function archivedQuotes(): string[] {
  if (!existsSync(archiveDirectory)) return [];
  return readdirSync(archiveDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(`${archiveDirectory}/${name}`, "utf8").trim());
}

function contentWords(sentence: string): Set<string> {
  const stopWords = new Set(["the", "a", "an", "as", "at", "by", "from", "in", "of", "on", "to", "while", "before", "after", "and", "or", "his", "her", "its"]);
  return new Set((sentence.toLowerCase().match(/[a-z]+/gu) ?? []).filter((word) => word.length > 2 && !stopWords.has(word)));
}

function overlapsArchive(candidate: string, quotes: readonly string[]): boolean {
  const words = contentWords(candidate);
  return quotes.some((quote) => {
    const archivedWords = contentWords(quote);
    let shared = 0;
    for (const word of words) if (archivedWords.has(word)) shared += 1;
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

record("start", { executionId, promptBytes: Buffer.byteLength(prompt) });

try {
  if (sleepMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, sleepMs));

  if (role === "generator") {
    const output = env.WORKSHOP_MOCK_OUTPUT ?? scenes[priorGeneratorCount() % scenes.length]!;
    const mode = env.WORKSHOP_MOCK_GENERATOR_RESULT ?? "valid";
    const result = mode === "malformed"
      ? "<status>succeeded</status>\n<output>unfinished"
      : `<status>succeeded</status>\n<output>${output}</output>`;
    process.stdout.write(result);
    record("result", { executionId, malformed: mode === "malformed", output });
  } else {
    const candidate = readCandidateFromPrompt(prompt).trim();
    const quotes = archivedQuotes();
    const distinct = !overlapsArchive(candidate, quotes);
    const oneSentence = candidate.length > 0 && (candidate.match(/[.!?]/gu) ?? []).length === 1;
    const passed = env.WORKSHOP_MOCK_VERDICT !== "reject" && distinct && oneSentence
      && !candidate.toLowerCase().includes("hemingway");
    const reason = passed
      ? `The sentence is original and distinct from ${quotes.length} archived quote(s).`
      : distinct ? "The candidate failed the deterministic sentence policy." : "The candidate paraphrases an archived scene.";
    const result = passed
      ? `<decision>accept</decision>\n<reason>${reason}</reason>`
      : `<decision>retry</decision>\n<reason>${reason}</reason>\n<corrections>Write a distinct one-sentence result.</corrections>`;
    process.stdout.write(result);
    record("verdict", { executionId, candidate, archiveCount: quotes.length, passed, reason });
  }
} finally {
  record("finish", { executionId });
}
