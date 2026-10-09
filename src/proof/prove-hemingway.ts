import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import { openDurableStorage } from "../storage/durable/open-durable-storage.js";
import { acquireSingletonLock, DaemonLockHeld, type SingletonLock } from "../daemon/acquire-daemon-lock.js";
import { HemingwayTask } from "./define-hemingway-task.js";
import { RunIndexDoc } from "./define-run-index-doc.js";
import { locateProofFiles, type ProofFiles } from "./locate-proof-files.js";
import { parseProofOptions, type ProofOptions } from "./parse-proof-options.js";
import type { ProofCheckpoint, ProofInput, ProofResult } from "./types.js";

const EXIT_COMPLETED = 0;
const EXIT_ABORTED = 1;
const EXIT_BLOCKED = 2;
const EXIT_LOCKED = 3;
const EXIT_USAGE = 64;

type ProofTaskRecord = TaskRecord<JsonValue, JsonValue, ProofResult>;

function defaultAgentCommand(): string {
  const mock = new URL("../../tests/mock/hemingway-node.ts", import.meta.url).pathname;
  return `bun "${mock}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Poll the durable record for terminal state, the clean-pause marker, or the
 * stop file. The stop file requests an abort; cleanup is confirmed by the
 * task's abort handler before this loop can observe a terminal record.
 */
async function waitForProofOutcome(
  harness: Harness,
  taskId: TaskId<ProofResult>,
  files: ProofFiles,
  options: ProofOptions,
): Promise<{ kind: "paused"; record: ProofTaskRecord } | { kind: "terminal"; record: ProofTaskRecord }> {
  const stopFile = options.stopFile === undefined ? undefined : resolve(options.stopFile);
  const deadline = Date.now() + options.timeoutMs + 30_000;
  let abortRequested = false;

  for (;;) {
    const record = await harness.getTask<ProofResult>(taskId, BACKGROUND_CONTEXT);
    if (record === undefined) throw new Error(`proof task ${taskId} is missing from durable storage`);
    if (record.state.status === "terminal") return { kind: "terminal", record };
    if (options.pauseAfter !== undefined && existsSync(files.pauseMarker)) return { kind: "paused", record };
    if (!abortRequested && stopFile !== undefined && existsSync(stopFile)) {
      abortRequested = true;
      await harness.abortTask(taskId, BACKGROUND_CONTEXT);
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the proof task to settle");
    await delay(25);
  }
}

function printPaused(record: ProofTaskRecord): void {
  const checkpoint = record.state.checkpoint as ProofCheckpoint | undefined;
  const outputs = checkpoint !== undefined && "outputs" in checkpoint ? checkpoint.outputs : {};
  const summaries = checkpoint !== undefined && "summaries" in checkpoint ? checkpoint.summaries : {};
  console.log(
    JSON.stringify(
      {
        version: 1,
        status: "paused",
        runId: (record.input as unknown as ProofInput).runId,
        taskId: record.id,
        nodeIndex: checkpoint !== undefined && "nodeIndex" in checkpoint ? checkpoint.nodeIndex : 0,
        output: outputs["node-generate"] ?? "",
        summary: summaries["node-generate"] ?? "",
        timestamp: outputs["node-timestamp"] ?? "",
      },
      null,
      2,
    ),
  );
}

function printTerminal(record: ProofTaskRecord): number {
  if (record.state.status !== "terminal") return EXIT_BLOCKED;
  const outcome = record.state.outcome;
  const result: ProofResult = outcome.result ?? {
    version: 1,
    status: outcome.status === "failed" ? "blocked" : "failed",
    runId: (record.input as unknown as ProofInput).runId,
    taskId: record.id,
    output: "",
    summary: "",
    timestamp: "",
    artifacts: [],
    nodes: [],
    reason: outcome.status === "failed" ? outcome.error.message : outcome.status,
  };
  console.log(JSON.stringify(result, null, 2));
  if (outcome.status === "completed") return EXIT_COMPLETED;
  if (outcome.status === "aborted") return EXIT_ABORTED;
  return EXIT_BLOCKED;
}

async function main(): Promise<number> {
  let options: ProofOptions;
  try {
    options = parseProofOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`prove-hemingway: ${(error as Error).message}`);
    console.error(
      "usage: bun src/proof/prove-hemingway.ts --state-dir <dir> [--agent-command <shell-template>] [--pause-after [node]] [--stop-file <path>] [--timeout-ms <n>]",
    );
    return EXIT_USAGE;
  }

  const stateDir = resolve(options.stateDir);
  mkdirSync(stateDir, { recursive: true });

  let lock: SingletonLock;
  try {
    lock = acquireSingletonLock(stateDir);
  } catch (error) {
    if (error instanceof DaemonLockHeld) {
      console.error(`prove-hemingway: ${error.message}`);
      return EXIT_LOCKED;
    }
    throw error;
  }

  const context = BACKGROUND_CONTEXT;
  const openedStorage = await openDurableStorage(join(stateDir, "durable.db"));
  if (!openedStorage.ok) {
    console.error(`prove-hemingway: ${openedStorage.failure.message}`);
    lock.release();
    return EXIT_BLOCKED;
  }
  const storage = openedStorage.storage;
  const registry = createRegistry();
  registry.install({ name: "hemingway-proof", tasks: [HemingwayTask] });
  const harness = await Harness.open(storage, { models: createModels(), registry }, context);
  let exitCode = EXIT_BLOCKED;
  let closeFailed = false;

  try {
    const root = await harness.root(context);
    const existing = await harness.snapshot(RunIndexDoc, context);
    let runId: string;
    let taskId: TaskId<ProofResult>;

    if (existing !== undefined && existing.runId !== null && existing.taskId !== null) {
      runId = existing.runId;
      taskId = existing.taskId as TaskId<ProofResult>;
    } else {
      runId = `hemingway-proof-${randomUUID().slice(0, 8)}`;
      const input: ProofInput = {
        runId,
        stateDir,
        projectRoot: process.cwd(),
        agentCommand: options.agentCommand ?? defaultAgentCommand(),
        timeoutMs: options.timeoutMs,
      };
      taskId = await root.commit(async (tx) => {
        const doc = await tx.doc(RunIndexDoc);
        doc.runId = runId;
        const id = await tx.createTask(HemingwayTask, input, { ownership: { kind: "conversation" } });
        doc.taskId = id as unknown as number;
        return id;
      }, context);
    }

    const files = locateProofFiles(stateDir, runId);
    if (options.pauseAfter !== undefined) {
      process.env.WORKSHOP_PROOF_PAUSE_AFTER = options.pauseAfter;
      rmSync(files.pauseMarker, { force: true });
    } else {
      delete process.env.WORKSHOP_PROOF_PAUSE_AFTER;
    }

    // A stop file present at startup aborts before any work is resumed, so a
    // recorded process group is retired without launching another node.
    if (options.stopFile !== undefined && existsSync(resolve(options.stopFile))) {
      await harness.abortTask(taskId, BACKGROUND_CONTEXT);
    }
    harness.resume();
    const outcome = await waitForProofOutcome(harness, taskId, files, options);
    exitCode = outcome.kind === "paused" ? EXIT_COMPLETED : printTerminal(outcome.record);
    if (outcome.kind === "paused") printPaused(outcome.record);
  } finally {
    // Release the singleton lock only after the harness closed cleanly: a
    // failed close may leave the durable store open, and a second owner of
    // the state dir must not start while that is unknown.
    try {
      await harness.close(context);
    } catch (error) {
      closeFailed = true;
      console.error(`prove-hemingway: harness close failed; lock retained: ${(error as Error).message}`);
    }
    if (!closeFailed) lock.release();
  }
  return closeFailed ? EXIT_BLOCKED : exitCode;
}

process.exitCode = await main();
