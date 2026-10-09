/**
 * Deterministic headless agent stand-in for the Hemingway durable proof.
 * A separate Bun process that writes the checked result JSON and appends a
 * launch record so tests can count executions. It never writes the node
 * output file: the runtime publishes `output` from the checked result.
 *
 * WORKSHOP_MOCK_SLEEP_MS      sleep before writing results (kill tests)
 * WORKSHOP_MOCK_DESCENDANT=1  spawn a long-lived child in this process group
 * WORKSHOP_MOCK_RESULT        valid (default) | malformed | unknown | empty-output
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const env = process.env;
const nodeId = env.WORKSHOP_NODE_ID ?? "unknown";
const sleepMs = Number(env.WORKSHOP_MOCK_SLEEP_MS ?? "0");

const launchLog = env.WORKSHOP_LAUNCH_LOG;
if (launchLog === undefined) {
  console.error("hemingway mock: WORKSHOP_LAUNCH_LOG is required");
  process.exit(70);
}

appendFileSync(
  launchLog,
  JSON.stringify({ event: "launch", nodeId, pid: process.pid, sleepMs, at: new Date().toISOString() }) + "\n",
  "utf8",
);

if (env.WORKSHOP_MOCK_DESCENDANT === "1") {
  const child = spawn("sleep", [String(Math.ceil(sleepMs / 1000) + 30)], { stdio: "ignore" });
  // The leader must be able to exit while the descendant lives: that is the
  // shape the runtime has to retire after a normal exit.
  child.unref();
  appendFileSync(launchLog, JSON.stringify({ event: "descendant", nodeId, pid: child.pid }) + "\n", "utf8");
}

if (sleepMs > 0) await new Promise((done) => setTimeout(done, sleepMs));

const sentence = "The old man rowed until the sea forgot the shore.";
const summary = "One Hemingway sentence, written by the deterministic mock.";
const valid = { version: 1, output: sentence, summary, artifacts: [] };

const mode = env.WORKSHOP_MOCK_RESULT ?? "valid";
const payload =
  mode === "malformed"
    ? "{ this is not json"
    : mode === "unknown"
      ? JSON.stringify({ ...valid, extra: "not allowed" })
      : mode === "empty-output"
        ? JSON.stringify({ ...valid, output: "" })
        : JSON.stringify(valid);

writeFileSync(env.WORKSHOP_RESULT_FILE ?? "generated.json", payload + "\n", "utf8");
