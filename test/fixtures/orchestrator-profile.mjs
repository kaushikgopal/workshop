import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const mode = process.argv[2];
const decisions = {
  retry: { action: "retry", hint: "Retry once with the existing data.", note: "The command may pass after its first failure." },
  skip: { action: "skip", note: "The step is safe to skip in this test." },
  accept: { action: "accept", note: "The output is usable." },
  fail: { action: "fail", note: "The workflow cannot continue." },
  "give-up": { action: "give_up", note: "I cannot justify another automatic action." },
  "retry-fast": { action: "retry", profile: "fast", hint: "Use the fast profile.", note: "Try the same executable profile." },
};
const decision = decisions[mode];
if (!decision) {
  process.stderr.write(`unknown fixture decision: ${mode ?? "missing"}`);
  process.exitCode = 2;
} else {
  if (!prompt.includes("## Workflow description") || !prompt.includes("## Attempt history")) {
    process.stderr.write("failure brief is missing required sections");
    process.exitCode = 3;
  } else {
    process.stdout.write(JSON.stringify(decision));
  }
}
