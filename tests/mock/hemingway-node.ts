/**
 * Deterministic headless agent stand-in for the Hemingway durable proof.
 * It reads the rendered prompt from stdin and writes its tagged result to stdout.
 *
 * WORKSHOP_MOCK_SLEEP_MS      sleep before writing results (kill tests)
 * WORKSHOP_MOCK_DESCENDANT=1  spawn a long-lived child in this process group
 * WORKSHOP_MOCK_RESULT        valid (default) | malformed | unknown | empty-output
 */

import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const env = process.env;
const nodeId = env.WORKSHOP_STEP_ID ?? "unknown";
const sleepMs = Number(env.WORKSHOP_MOCK_SLEEP_MS ?? "0");
const prompt = readFileSync(0, "utf8");
if (!prompt.includes("Workshop Agent Instructions")) {
  console.error("hemingway mock: rendered prompt is missing from stdin");
  process.exit(70);
}

const launchLog = env.WORKSHOP_LAUNCH_LOG;
if (launchLog === undefined) {
  console.error("hemingway mock: WORKSHOP_LAUNCH_LOG is required");
  process.exit(70);
}

appendFileSync(launchLog, JSON.stringify({ event: "launch", nodeId, pid: process.pid, sleepMs, at: new Date().toISOString() }) + "\n", "utf8");

if (env.WORKSHOP_MOCK_DESCENDANT === "1") {
  // Keep a descendant alive after this process exits to exercise group retirement.
  const child = spawn("sleep", [String(Math.ceil(sleepMs / 1000) + 30)], { stdio: "ignore" });
  child.unref();
  appendFileSync(launchLog, JSON.stringify({ event: "descendant", nodeId, pid: child.pid }) + "\n", "utf8");
}

if (sleepMs > 0) await new Promise((done) => setTimeout(done, sleepMs));

const sentence = "The old man rowed until the sea forgot the shore.";
const mode = env.WORKSHOP_MOCK_RESULT ?? "valid";
const output = mode === "empty-output" ? "" : sentence;
const result = mode === "malformed"
  ? "<status>succeeded</status>\n<output>unfinished"
  : mode === "unknown"
    ? "<status>unknown</status>\n<output>invalid status</output>"
    : `<status>succeeded</status>\n<reason>One Hemingway sentence, written by the deterministic mock.</reason>\n<output>${output}</output>`;

process.stdout.write(result);
