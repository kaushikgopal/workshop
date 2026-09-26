import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "../load-installation.js";
import { type Clock } from "../util/clock.js";
import type { RunRow, Store } from "../storage/db/store.js";
import { atomicWriteFileSync, fsyncFileSync } from "../storage/disk/write-crash-safe.js";
import { attemptEnv } from "./build-attempt-env.js";
import { raceDeadline, spawnTracked } from "../process/launch-process.js";
import type { NodeValidator } from "../definition/resolve-node-settings.js";

/**
 * The normalized validator record both validator kinds converge on: command
 * validators record their exit-code verdict, agent validators the verdict
 * parsed from their validation.json. Atomic and durable (S9).
 */
function writeValidatorRecord(
  validationDir: string,
  record: { kind: "command" | "agent"; status: "passed" | "failed"; reason: string },
): void {
  atomicWriteFileSync(join(validationDir, "validator-record.json"), JSON.stringify({ version: 1, ...record }, null, 2) + "\n");
}

/**
 * Discriminated validator result. A timeout is machinery, not judgment: it is
 * typed `timeout` (spec §10), never a `validator_rejection`.
 */
export type ValidatorOutcome =
  | { outcome: "passed"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "timeout"; reason: string }
  | { outcome: "unconfirmed"; reason: string };

export async function judgeOutput(input: {
  store: Store;
  ownerToken: string;
  clock: Clock;
  inst: Installation;
  run: RunRow;
  nodeId: string;
  validator: NodeValidator;
  attemptFolder: string;
  attemptNo: number;
  packetFile: string;
  outputFile: string;
  stdoutFile: string;
  stderrFile: string;
  cliPath: string;
}): Promise<ValidatorOutcome> {
  const validationDir = join(input.attemptFolder, "validation");
  mkdirSync(validationDir, { recursive: true });
  const validationFile = join(validationDir, "validation.json");
  const validationStdout = join(validationDir, "stdout");
  const validationStderr = join(validationDir, "stderr");
  const normalized = (outcome: "passed" | "rejected", reason: string): ValidatorOutcome => {
    // The runtime-owned normalized verdict: durable evidence both validator
    // kinds converge on (command exit code, or the parsed validation.json).
    writeValidatorRecord(validationDir, {
      kind: input.validator.kind,
      status: outcome === "passed" ? "passed" : "failed",
      reason,
    });
    return { outcome, reason };
  };

  const model = input.validator.kind === "agent" ? input.validator.resolution.model : null;
  if (
    input.validator.kind === "agent" &&
    (!input.validator.resolution.harnessCommand || !input.validator.resolution.model)
  ) {
    return normalized("rejected", "validator agent harness/model unresolved");
  }

  const env = attemptEnv({
    logPath: input.run.worklog_path,
    runId: input.run.run_id,
    nodeId: input.nodeId,
    attempt: input.attemptNo,
    promptFile: null,
    nodeOutputFile: input.outputFile,
    previousOutputFile: null,
    packetFile: input.packetFile,
    stdoutFile: input.stdoutFile,
    stderrFile: input.stderrFile,
    ownerToken: "validator-not-an-owner",
    validationFile,
    model,
    cliPath: input.cliPath,
  });

  let command: string;
  if (input.validator.kind === "command") {
    command = input.validator.command;
  } else {
    const promptFile = join(validationDir, "prompt.md");
    atomicWriteFileSync(
      promptFile,
      renderValidatorPrompt(input.nodeId, input.validator.agent.instructions, {
        packetFile: input.packetFile, outputFile: input.outputFile,
        logPath: input.run.worklog_path, validationFile,
      }),
    );
    env.WORKSHOP_PROMPT_FILE = promptFile;
    command = input.validator.resolution.harnessCommand!;
  }

  const proc = spawnTracked({
    shell: input.inst.shell,
    command,
    cwd: input.inst.projectDir,
    env,
    stdoutFile: validationStdout,
    stderrFile: validationStderr,
  });
  input.store.recordValidatorIdentity({
    runId: input.run.run_id, nodeId: input.nodeId, attempt: input.attemptNo, ownerToken: input.ownerToken,
    childPid: proc.pid, childStartId: proc.startId, childPgid: proc.pgid, now: input.clock.now(),
  });

  const retire = async (): Promise<boolean> => {
    const confirmed = await proc.kill();
    if (!confirmed) return false;
    if (existsSync(validationStdout)) fsyncFileSync(validationStdout);
    if (existsSync(validationStderr)) fsyncFileSync(validationStderr);
    const cleared = input.store.clearAttemptProcessIdentity({
      runId: input.run.run_id, nodeId: input.nodeId, attempt: input.attemptNo, ownerToken: input.ownerToken,
      role: "validator", pid: proc.pid, startId: proc.startId, pgid: proc.pgid, now: input.clock.now(),
    });
    return cleared || input.store.getAttempt(input.run.run_id, input.nodeId, input.attemptNo)?.validator_process_group === null;
  };

  const exitOrTimeout = await raceDeadline(proc, input.validator.timeoutMs);
  if (exitOrTimeout.kind === "timeout") {
    if (!(await retire())) {
      return { outcome: "unconfirmed", reason: "validator timed out and group death could not be confirmed" };
    }
    return { outcome: "timeout", reason: `validator timed out after ${input.validator.timeoutMs}ms` };
  }
  const { code } = exitOrTimeout.exit;
  if (!(await retire())) {
    return { outcome: "unconfirmed", reason: "validator leader exited but surviving group members remain" };
  }

  if (input.validator.kind === "command") {
    return code === 0
      ? normalized("passed", "command validator exited 0")
      : normalized("rejected", `command validator exited ${code ?? "null"}`);
  }

  // The agent wrote this file externally. Flush it before parsing or deriving
  // the runtime-owned normalized validator record.
  if (!existsSync(validationFile)) {
    return normalized("rejected", `validator wrote no validation.json (exit ${code ?? "null"})`);
  }
  fsyncFileSync(validationFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(validationFile, "utf8"));
  } catch (e) {
    return normalized("rejected", `validation.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = parsed as { passed?: unknown; reason?: unknown };
  if (typeof result.passed !== "boolean") {
    return normalized("rejected", "validation.json has no boolean 'passed'");
  }
  const reason = typeof result.reason === "string" ? result.reason : "";
  return result.passed
    ? normalized("passed", reason || "validator passed")
    : normalized("rejected", reason || "validator failed without a reason");
}

function renderValidatorPrompt(
  nodeId: string,
  instructions: string,
  ctx: { packetFile: string; outputFile: string; logPath: string; validationFile: string },
): string {
  return `# Workshop validator

You are a fresh validator for node ${nodeId}. Judge only what the instructions say.

## Instructions

${instructions}

## Evidence

- Attempt packet: ${ctx.packetFile}
- Marked node output: ${ctx.outputFile}
- Worklog: ${ctx.logPath}

## Output contract

Write exactly one JSON object to ${ctx.validationFile}:

{"passed": true, "reason": "<short reason>"}

Missing or invalid validation output counts as failure.
`;
}
