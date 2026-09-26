/**
 * Deterministic mock harness — the automated-gates stand-in for a real agent
 * harness (pi/opencode/claude). Behavior is driven by sentinels embedded in
 * the instructions the workflow YAML provides:
 *
 *   MOCK:progress=<text>     report progress through the runtime command
 *   MOCK:exit=<code>         exit with the given code
 *   MOCK:sleep=<duration>    sleep for the duration (timeout tests)
 *   MOCK:block               request an agent_requested block
 *   MOCK:block-unknown       request an unknown_external block
 *   MOCK:touch-worklog       append to the worklog (integrity violation)
 *   MOCK:extra-marker        add a second reserved marker opening (escaped)
 *   MOCK:bad-heading         add a heading the packet does not own
 *   MOCK:drop-marker         remove the authorized marker (integrity violation)
 *   MOCK:handoff=<text>      custom handoff/workflow-output content
 *   MOCK:validator=<pass|fail>  behavior when running as a validator
 *
 * Without sentinels it writes a well-formed packet with deterministic output.
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const env = process.env;
const required = [
  "WORKSHOP_PROMPT_FILE",
  "WORKSHOP_NODE_PACKET_FILE",
  "WORKSHOP_NODE_OUTPUT_FILE",
  "WORKSHOP_WORKLOG_FILE",
  "WORKSHOP_RUN_ID",
  "WORKSHOP_NODE_ID",
  "WORKSHOP_ATTEMPT",
  "WORKSHOP_CLI",
];
for (const key of required) {
  if (!env[key]) {
    console.error(`mock harness: missing ${key}`);
    process.exit(70);
  }
}

const prompt = readFileSync(env.WORKSHOP_PROMPT_FILE!, "utf8");
const sentinels = new Set<string>();
// Sentinels ride in the prompt (node/validator instructions) or in argv
// (sites without YAML instructions, like the orchestrator). Progress
// registers before block so a reporting-then-blocking agent keeps its
// last progress visible on the attempt row.
for (const m of prompt.matchAll(/MOCK:progress=(.+)/g)) sentinels.add(`MOCK:progress=${m[1]!.trim()}`);
for (const arg of process.argv.slice(2)) {
  if (/^MOCK:[a-z0-9=-]+/.test(arg) || /^MOCK:progress=/.test(arg)) sentinels.add(arg.trim());
}
for (const m of prompt.matchAll(/MOCK:(?!progress)[a-z0-9=-]+/g)) sentinels.add(m[0]);

function report(mode: "log" | "error", message: string): void {
  if (mode === "log") console.log(message);
  else console.error(message);
}

function runtime(args: string[]): number {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    execFileSync(env.WORKSHOP_CLI!, args, {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    report("error", `mock harness: runtime command failed: ${(e as Error).message}`);
    return 1;
  }
}

/** Rewrite the packet, preserving the scaffolded structure and marker. */
function fillPacket(opts: {
  progress: string;
  decisions: string;
  validation: string;
  blockers: string;
  markerContent: string;
}): void {
  const packetFile = env.WORKSHOP_NODE_PACKET_FILE!;
  const original = readFileSync(packetFile, "utf8");

  // Orchestrator contract: write the owner-bound result file, exit 0.
  for (const decision of ["retry", "block", "fail"] as const) {
    if (sentinels.has(`MOCK:orchestrator=${decision}`)) {
      const resultFile = env.WORKSHOP_ORCHESTRATOR_RESULT_FILE!;
      writeFileSync(
        resultFile,
        JSON.stringify({
          decision,
          reason: `mock orchestrator chose ${decision}`,
          notes: `Mock orchestrator notes: ${decision} recorded by the runtime.`,
        }) + "\n",
        "utf8",
      );
      process.exit(0);
    }
  }

  const isValidatorSite = sentinels.has("MOCK:validator=pass") || sentinels.has("MOCK:validator=fail") ||
    [...sentinels].some((s) => s.startsWith("MOCK:validator-until-attempt="));
  if (isValidatorSite) {
    // Validator contract: write validation.json, not packet prose.
    let passed = sentinels.has("MOCK:validator=pass");
    const until = [...sentinels].find((s) => s.startsWith("MOCK:validator-until-attempt="));
    if (until) {
      const nth = Number(until.split("=")[1]);
      passed = Number(env.WORKSHOP_ATTEMPT) >= nth;
    }
    writeFileSync(
      env.WORKSHOP_VALIDATION_FILE ?? "validation.json",
      JSON.stringify({ passed, reason: passed ? "mock validator passed" : "mock validator rejected the output" }) + "\n",
      "utf8",
    );
    process.exit(0);
  }

  let out = original;
  out = replaceSection(out, "##### Progress", opts.progress);
  out = replaceSection(out, "##### Decisions", opts.decisions);
  out = replaceSection(out, "##### Validation", opts.validation);
  out = replaceSection(out, "##### Blockers", opts.blockers);

  // Marker content: replace the (empty) marker body.
  const markerOpening = /<next-node-output id="[^"]*">|<workflow-output>/.exec(original)?.[0];
  if (!markerOpening) {
    report("error", "mock harness: no marker in packet");
    process.exit(71);
  }
  const closing = markerOpening.startsWith("<workflow") ? "</workflow-output>" : "</next-node-output>";
  const markerRe = new RegExp(`${escapeRe(markerOpening)}\\n?[\\s\\S]*?${escapeRe(closing)}`);
  out = out.replace(markerRe, `${markerOpening}\n${opts.markerContent}\n${closing}`);

  if (sentinels.has("MOCK:extra-marker")) {
    out += `\n<workflow-output>\nsneaky extra marker\n</workflow-output>\n`;
  }
  if (sentinels.has("MOCK:bad-heading")) {
    out += `\n## Run outcome\n\nagents must not own this\n`;
  }
  if (sentinels.has("MOCK:drop-headings")) {
    // Real-model drift: rewrite without the scaffold headings, keep the marker.
    out = out
      .replace(/^#### Attempt \d+\n\n/, "")
      .replaceAll(/^##### .*$/gm, "")
      .replace(/\n{3,}/g, "\n\n");
  }
  if (sentinels.has("MOCK:drop-marker")) {
    out = out.replace(markerRe, "\n");
  }
  writeFileSync(packetFile, out, "utf8");
}

function replaceSection(packet: string, heading: string, content: string): string {
  const re = new RegExp(`(${escapeRe(heading)}\\n)([\\s\\S]*?)(\\n\\n##### |\\n\\n<|$)`);
  if (!re.test(packet)) return packet;
  return packet.replace(re, (_m, head, _old, tail) => `${head}\n${content}${tail}`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function parseSleepMs(spec: string): number {
  const m = /^([0-9]+)(ms|s|m)$/.exec(spec);
  if (!m) return 1000;
  const n = Number(m[1]);
  return m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : n * 60_000;
}

// ---- behavior ----

for (const s of sentinels) {
  if (s.startsWith("MOCK:progress=")) {
    const text = s.slice("MOCK:progress=".length);
    runtime(["runtime", "progress", "--text", text]);
  }
  if (s.startsWith("MOCK:sleep=")) {
    sleepSync(parseSleepMs(s.slice("MOCK:sleep=".length)));
  }
  if (s === "MOCK:touch-worklog") {
    appendFileSync(env.WORKSHOP_WORKLOG_FILE!, "\nagent tampered with the worklog\n", "utf8");
  }
  if (s === "MOCK:block" || s === "MOCK:block-unknown") {
    const kind = s === "MOCK:block-unknown" ? ["--kind", "unknown_external"] : [];
    const code = runtime(["runtime", "block", ...kind, "--reason", "mock requested block"]).valueOf();
    // The wrapper terminates our process group once blocked; exit nonzero so
    // the harness does not report success after a block.
    process.exit(code === 0 ? 3 : 1);
  }
  if (s.startsWith("MOCK:exit=")) {
    process.exit(Number(s.slice("MOCK:exit=".length)));
  }
}

const defaultHandoff = `Mock deterministic output from ${env.WORKSHOP_NODE_ID} attempt ${env.WORKSHOP_ATTEMPT}.`;
const handoff = [...sentinels].find((s) => s.startsWith("MOCK:handoff="))?.slice("MOCK:handoff=".length) ?? defaultHandoff;

fillPacket({
  progress: `Mock agent for ${env.WORKSHOP_NODE_ID} completed deterministically.`,
  decisions: "No decisions — deterministic mock.",
  validation: "No validation evidence recorded by the mock.",
  blockers: "None.",
  markerContent: handoff,
});
process.exit(0);
