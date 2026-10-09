import type { Context } from "@earendil-works/chord";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTask, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { processStartId } from "../process/identify-process.js";
import { buildProofResult } from "./build-proof-result.js";
import { launchProofProcess, awaitProofProcess } from "./launch-proof-process.js";
import { loadProofResult, type GeneratedProofResult } from "./load-proof-result.js";
import { locateProofFiles, type ProofFiles } from "./locate-proof-files.js";
import { renderProofPrompt } from "./render-proof-prompt.js";
import { retireProofProcessGroup } from "./retire-proof-process-group.js";
import type {
  LaunchCheckpoint,
  PrepareCheckpoint,
  ProcessIntent,
  ProofCheckpoint,
  ProofInput,
  ProofNode,
  ProofOutputs,
  ProofResult,
  ProofSummaries,
  SettleCheckpoint,
} from "./types.js";

export const HEMINGWAY_TASK_NAME = "hemingway.proof";
export const HEMINGWAY_TASK_VERSION = 1;

type ProofRuntime = TaskRuntime<ProofInput, ProofCheckpoint, ProofResult, object>;

/**
 * Intents this process committed in this incarnation. An intent found in
 * durable storage but absent here was written by a process that is gone, so
 * its effects are unknown and the launch must not be repeated.
 */
const intentsCommittedHere = new Set<string>();

function intentKey(taskId: number, intent: ProcessIntent): string {
  return `${taskId}:${intent.nodeId}:${intent.startedAt}`;
}

/** The deterministic chain: no agent decides what runs next. */
export function proofNodes(input: ProofInput): ProofNode[] {
  return [
    {
      id: "node-timestamp",
      kind: "command",
      command: 'date -u +%FT%TZ',
      validator: 'test -n "$(cat "$WORKSHOP_NODE_OUTPUT_FILE")"',
    },
    {
      id: "node-generate",
      kind: "generate",
      command: input.agentCommand,
      validator: 'test -s "$WORKSHOP_RESULT_FILE"',
    },
    {
      id: "node-archive",
      kind: "archive",
      command:
        'mkdir -p "$WORKSHOP_ARCHIVE_DIR" && printf \'%s\\n\' "$(cat "$WORKSHOP_PREVIOUS_OUTPUT_FILE")" > "$WORKSHOP_ARCHIVE_FILE" && printf \'%s\\n\' "$WORKSHOP_ARCHIVE_FILE"',
      validator: 'test -s "$WORKSHOP_ARCHIVE_FILE"',
    },
  ];
}

function nodeEnvironment(files: ProofFiles, input: ProofInput, node: ProofNode): Record<string, string> {
  return {
    WORKSHOP_RUN_ID: input.runId,
    WORKSHOP_NODE_ID: node.id,
    WORKSHOP_STATE_DIR: input.stateDir,
    WORKSHOP_PROJECT_ROOT: input.projectRoot,
    WORKSHOP_PROMPT_FILE: files.promptFile,
    WORKSHOP_PREVIOUS_OUTPUT_FILE: files.previousOutputFile,
    WORKSHOP_NODE_OUTPUT_FILE: files.nodeOutputFile(node.id),
    WORKSHOP_RESULT_FILE: files.resultFile,
    WORKSHOP_ARCHIVE_DIR: files.archiveDir,
    WORKSHOP_ARCHIVE_FILE: files.archiveFile,
    WORKSHOP_LAUNCH_LOG: files.launchLog,
  };
}

/** Materialize the node's inputs and clear any stale output before launch. */
function writeNodeInputs(files: ProofFiles, input: ProofInput, checkpoint: PrepareCheckpoint, nodes: ProofNode[]): ProofNode {
  const node = nodes[checkpoint.nodeIndex];
  if (node === undefined) throw new Error(`no node at index ${checkpoint.nodeIndex}`);
  mkdirSync(dirname(files.promptFile), { recursive: true });
  mkdirSync(dirname(files.nodeOutputFile(node.id)), { recursive: true });
  mkdirSync(dirname(files.stdoutFile(node.id, 0)), { recursive: true });
  mkdirSync(dirname(files.receiptFile(node.id)), { recursive: true });
  mkdirSync(files.archiveDir, { recursive: true });
  const previousNode = checkpoint.nodeIndex === 0 ? undefined : nodes[checkpoint.nodeIndex - 1];
  const previousOutput = previousNode === undefined ? "" : checkpoint.outputs[previousNode.id] ?? "";
  writeFileSync(files.previousOutputFile, previousOutput, "utf8");
  writeFileSync(
    files.promptFile,
    renderProofPrompt({
      runId: input.runId,
      nodeId: node.id,
      previousOutput,
      resultFile: files.resultFile,
    }),
    "utf8",
  );
  rmSync(files.nodeOutputFile(node.id), { force: true });
  return node;
}

function isRecordedProcessAlive(identity: { pid: number; startId: string }): boolean {
  return processStartId(identity.pid) === identity.startId;
}

function nodeMatchesPause(value: string, nodeId: string): boolean {
  return nodeId === value || nodeId === `node-${value}` || nodeId.endsWith(`-${value}`);
}

async function commitBlocked(
  runtime: ProofRuntime,
  context: Context,
  task: RunningTask<ProofInput, ProofCheckpoint, ProofResult>,
  outputs: ProofOutputs,
  summaries: ProofSummaries,
  reason: string,
  detail: ProofResult["cleanup"],
): Promise<void> {
  const nodes = proofNodes(task.input);
  const result = buildProofResult({
    status: "blocked",
    proofInput: task.input,
    taskId: task.id,
    outputs,
    summaries,
    nodes,
    ...(detail !== undefined ? { cleanup: detail } : {}),
    reason,
  });
  await runtime.commit(
    () => ({
      status: "terminal",
      outcome: { status: "failed", error: { message: `blocked: ${reason}` }, result },
    }),
    context,
  );
}

/**
 * Park until the harness closes or the task is aborted. The caller commits the
 * next checkpoint before parking, so a reopen resumes from it. One-second
 * steps keep every wait bounded and observable; `runtime.sleep` rejects when
 * the invocation is signalled, which ends the park without a fixed timer that
 * depends on the harness's internal clamping.
 */
async function parkUntilSignalled(runtime: ProofRuntime, context: Context): Promise<void> {
  while (!runtime.signal.aborted) {
    try {
      await runtime.sleep(runtime.now() + 1000, context);
    } catch (error) {
      if (runtime.signal.aborted) return;
      throw error;
    }
  }
}

/** Advance to the next node, or publish the completed result. */
async function finishNode(
  runtime: ProofRuntime,
  context: Context,
  task: RunningTask<ProofInput, ProofCheckpoint, ProofResult>,
  nodeIndex: number,
  outputs: ProofOutputs,
  summaries: ProofSummaries,
): Promise<void> {
  const nodes = proofNodes(task.input);
  const nextIndex = nodeIndex + 1;
  if (nextIndex >= nodes.length) {
    const result = buildProofResult({
      status: "completed",
      proofInput: task.input,
      taskId: task.id,
      outputs,
      summaries,
      nodes,
    });
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
    return;
  }

  await runtime.commit((_tx, current) => {
    const cur = current.state.checkpoint as SettleCheckpoint;
    const next: PrepareCheckpoint = { phase: "prepare", nodeIndex: nextIndex, outputs, summaries };
    return { status: "running", checkpoint: next };
  }, context);

  const completed = nodes[nodeIndex];
  const pauseAfter = process.env.WORKSHOP_PROOF_PAUSE_AFTER;
  if (completed !== undefined && pauseAfter !== undefined && pauseAfter !== "" && nodeMatchesPause(pauseAfter, completed.id)) {
    const files = locateProofFiles(task.input.stateDir, task.input.runId);
    writeFileSync(
      files.pauseMarker,
      JSON.stringify({ runId: task.input.runId, nodeId: completed.id, at: new Date().toISOString() }) + "\n",
      "utf8",
    );
    await parkUntilSignalled(runtime, context);
  }
}

export const HemingwayTask = defineTask<ProofInput, ProofCheckpoint, ProofResult>({
  name: HEMINGWAY_TASK_NAME,
  version: HEMINGWAY_TASK_VERSION,
  initial: () => ({ phase: "prepare", nodeIndex: 0, outputs: {}, summaries: {} }),

  phases: {
    /** Choose the node, materialize its inputs, and move to launch. */
    prepare: async (task, runtime, context) => {
      const input = task.input;
      const nodes = proofNodes(input);
      const files = locateProofFiles(input.stateDir, input.runId);
      writeNodeInputs(files, input, task.state.checkpoint, nodes);
      await runtime.commit((_tx, current) => {
        const checkpoint = current.state.checkpoint as PrepareCheckpoint;
        const next: LaunchCheckpoint = {
          phase: "launch",
          nodeIndex: checkpoint.nodeIndex,
          outputs: checkpoint.outputs,
          summaries: checkpoint.summaries,
        };
        return { status: "running", checkpoint: next };
      }, context);
    },

    /**
     * Commit the intent before spawning, record the identity after, then wait.
     * On reopen, a committed intent or identity means the process effects are
     * unknown: block explicitly instead of relaunching. The same machinery
     * runs a node's worker and, in the `validator` stage, its validator.
     */
    launch: async (task, runtime, context) => {
      const input = task.input;
      const nodes = proofNodes(input);
      const files = locateProofFiles(input.stateDir, input.runId);
      const checkpoint = task.state.checkpoint;
      const node = nodes[checkpoint.nodeIndex];
      if (node === undefined) {
        await commitBlocked(runtime, context, task, checkpoint.outputs, checkpoint.summaries, `no node at index ${checkpoint.nodeIndex}`, undefined);
        return;
      }

      const isValidator = checkpoint.stage === "validator";
      const command = isValidator ? node.validator : node.command;
      const subject = isValidator ? `validator of ${node.id}` : `node ${node.id}`;
      if (command === undefined) {
        await commitBlocked(runtime, context, task, checkpoint.outputs, checkpoint.summaries, `no command for ${subject}`, undefined);
        return;
      }

      let intent = checkpoint.intent;
      if (intent?.identity !== undefined) {
        const alive = isRecordedProcessAlive(intent.identity);
        const cleanupConfirmed = await retireProofProcessGroup(intent.identity);
        await commitBlocked(
          runtime,
          context,
          task,
          checkpoint.outputs,
          checkpoint.summaries,
          `process identity recorded without a settle commit (${subject}, pid ${intent.identity.pid}, alive=${alive}); effects unknown`,
          { confirmed: cleanupConfirmed, pgid: intent.identity.pgid },
        );
        return;
      }
      if (intent !== undefined && !intentsCommittedHere.has(intentKey(task.id, intent))) {
        // The intent is durable but this process did not commit it, so a
        // process may already be running. Never relaunch; block explicitly.
        await commitBlocked(
          runtime,
          context,
          task,
          checkpoint.outputs,
          checkpoint.summaries,
          `launch intent recorded without a process identity (${subject}); effects unknown`,
          undefined,
        );
        return;
      }

      if (intent === undefined) {
        intent = {
          nodeId: isValidator ? `${node.id}-validator` : node.id,
          command,
          startedAt: runtime.now(),
        };
        const planned = intent;
        const stage = checkpoint.stage;
        await runtime.commit((_tx, current) => {
          const cur = current.state.checkpoint as LaunchCheckpoint;
          const next: LaunchCheckpoint = {
            phase: "launch",
            nodeIndex: cur.nodeIndex,
            outputs: cur.outputs,
            summaries: cur.summaries,
            ...(stage !== undefined ? { stage } : {}),
            intent: planned,
          };
          return { status: "running", checkpoint: next };
        }, context);
        intentsCommittedHere.add(intentKey(task.id, planned));
      }

      // Crash injection for the durability proof: the intent above is durable,
      // this process is not, so the reopen must block rather than relaunch.
      // "1" crashes at the first intent; a node id targets one intent.
      const crashAfterIntent = process.env.WORKSHOP_PROOF_CRASH_AFTER_INTENT;
      if (crashAfterIntent !== undefined && (crashAfterIntent === "1" || crashAfterIntent === intent.nodeId)) {
        process.exit(137);
      }

      if (runtime.signal.aborted) return;

      const child = launchProofProcess({
        command: intent.command,
        cwd: input.projectRoot,
        env: nodeEnvironment(files, input, node),
        stdoutFile: files.stdoutFile(intent.nodeId, intent.startedAt),
        stderrFile: files.stderrFile(intent.nodeId, intent.startedAt),
      });
      try {
        await runtime.commit((_tx, current) => {
          const cur = current.state.checkpoint as LaunchCheckpoint;
          const next: LaunchCheckpoint = {
            ...cur,
            intent: { ...intent, identity: child.identity },
          };
          return { status: "running", checkpoint: next };
        }, context);
      } catch (error) {
        await child.kill();
        throw error;
      }
      writeFileSync(
        files.receiptFile(intent.nodeId),
        JSON.stringify({ nodeId: intent.nodeId, identity: child.identity, command: intent.command, startedAt: intent.startedAt }, null, 2),
        "utf8",
      );

      const outcome = await awaitProofProcess(child, { timeoutMs: input.timeoutMs, signal: runtime.signal });
      if (outcome.kind === "aborted") {
        // Close or abort signalled the invocation; kill here so a graceful
        // close never orphans the group. The abort handler re-verifies.
        await child.kill();
        return;
      }
      if (outcome.kind === "timeout") {
        await commitBlocked(
          runtime,
          context,
          task,
          checkpoint.outputs,
          checkpoint.summaries,
          `${subject} timed out; cleanup confirmed=${outcome.cleanupConfirmed}`,
          { confirmed: outcome.cleanupConfirmed, pgid: child.identity.pgid },
        );
        return;
      }

      // The leader's exit does not mean its group is empty: descendants can
      // outlive it. Retire the whole group and confirm death before settling.
      const groupRetired = await retireProofProcessGroup(child.identity);
      if (!groupRetired) {
        await commitBlocked(
          runtime,
          context,
          task,
          checkpoint.outputs,
          checkpoint.summaries,
          `${subject} exited but its process group cleanup could not be confirmed`,
          { confirmed: false, pgid: child.identity.pgid },
        );
        return;
      }

      const settled: ProcessIntent = {
        ...intent,
        identity: child.identity,
        exit: { code: outcome.code, signal: outcome.signal },
      };
      const stage = checkpoint.stage;
      await runtime.commit((_tx, current) => {
        const cur = current.state.checkpoint as LaunchCheckpoint;
        const next: SettleCheckpoint = {
          phase: "settle",
          nodeIndex: cur.nodeIndex,
          outputs: cur.outputs,
          summaries: cur.summaries,
          ...(stage !== undefined ? { stage } : {}),
          intent: settled,
        };
        return { status: "running", checkpoint: next };
      }, context);
    },

    /**
     * Check the settled process, publish the node's output, and either launch
     * the node's validator as its own durable stage or finish the node.
     */
    settle: async (task, runtime, context) => {
      const input = task.input;
      const nodes = proofNodes(input);
      const files = locateProofFiles(input.stateDir, input.runId);
      const checkpoint = task.state.checkpoint;
      const node = nodes[checkpoint.nodeIndex];
      if (node === undefined) {
        await commitBlocked(runtime, context, task, checkpoint.outputs, checkpoint.summaries, `no node at index ${checkpoint.nodeIndex}`, undefined);
        return;
      }

      const isValidator = checkpoint.stage === "validator";
      const subject = isValidator ? `validator of ${node.id}` : `node ${node.id}`;
      const exit = checkpoint.intent.exit;
      if (exit === undefined || exit.code !== 0) {
        await commitBlocked(
          runtime,
          context,
          task,
          checkpoint.outputs,
          checkpoint.summaries,
          `${subject} exited code=${exit?.code ?? "?"} signal=${exit?.signal ?? "?"}`,
          { confirmed: true },
        );
        return;
      }

      if (isValidator) {
        await finishNode(runtime, context, task, checkpoint.nodeIndex, checkpoint.outputs, checkpoint.summaries);
        return;
      }

      const outputs: ProofOutputs = { ...checkpoint.outputs };
      const summaries: ProofSummaries = { ...checkpoint.summaries };
      if (node.kind === "generate") {
        let result: GeneratedProofResult;
        try {
          result = loadProofResult(files.resultFile);
        } catch (error) {
          await commitBlocked(runtime, context, task, outputs, summaries, (error as Error).message, { confirmed: true });
          return;
        }
        // The checked result is the only file the agent writes. The runtime
        // publishes its output as the node output the next node reads.
        outputs[node.id] = result.output;
        summaries[node.id] = result.summary;
        writeFileSync(files.nodeOutputFile(node.id), `${result.output}\n`, "utf8");
      } else {
        let output = "";
        try {
          output = readFileSync(files.stdoutFile(checkpoint.intent.nodeId, checkpoint.intent.startedAt), "utf8").trim();
        } catch {
          output = "";
        }
        if (output === "") {
          await commitBlocked(runtime, context, task, outputs, summaries, `node ${node.id} produced no output`, { confirmed: true });
          return;
        }
        outputs[node.id] = output;
        writeFileSync(files.nodeOutputFile(node.id), `${output}\n`, "utf8");
      }
      if (node.kind === "archive" && !existsSync(files.archiveFile)) {
        await commitBlocked(runtime, context, task, outputs, summaries, `archive file is missing: ${files.archiveFile}`, { confirmed: true });
        return;
      }

      if (node.validator !== undefined) {
        await runtime.commit((_tx, current) => {
          const cur = current.state.checkpoint as SettleCheckpoint;
          const next: LaunchCheckpoint = {
            phase: "launch",
            nodeIndex: cur.nodeIndex,
            outputs,
            summaries,
            stage: "validator",
          };
          return { status: "running", checkpoint: next };
        }, context);
        return;
      }

      await finishNode(runtime, context, task, checkpoint.nodeIndex, outputs, summaries);
    },
  },

  /**
   * Retire the recorded process group and confirm death before committing an
   * outcome. A dead leader is not proof of an empty group, so cleanup always
   * checks the whole group under the recorded leader identity.
   */
  abort: async (task, runtime, context) => {
    const input = task.input;
    const checkpoint = task.state.checkpoint;
    const intent = "intent" in checkpoint ? checkpoint.intent : undefined;
    const outputs = checkpoint.outputs;
    const summaries = checkpoint.summaries;
    const nodes = proofNodes(input);

    if (intent !== undefined && intent.identity === undefined) {
      await commitBlocked(
        runtime, context, task, outputs, summaries,
        "process identity unrecorded; effects unknown", { confirmed: false },
      );
      return;
    }

    if (intent === undefined) {
      const result = buildProofResult({
        status: "aborted",
        proofInput: input,
        taskId: task.id,
        outputs,
        summaries,
        nodes,
        cleanup: { confirmed: true },
        reason: "abort requested before any launch intent",
      });
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted before launch", result } }), context);
      return;
    }

    if (intent.identity === undefined) throw new Error("process identity branch was not handled");
    const cleanupConfirmed = await retireProofProcessGroup(intent.identity);
    if (!cleanupConfirmed) {
      const result = buildProofResult({
        status: "blocked",
        proofInput: input,
        taskId: task.id,
        outputs,
        summaries,
        nodes,
        cleanup: { confirmed: false, pgid: intent.identity.pgid },
        reason: `process group ${intent.identity.pgid} cleanup could not be confirmed`,
      });
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "failed", error: { message: "blocked: process group cleanup not confirmed" }, result },
        }),
        context,
      );
      return;
    }

    const result = buildProofResult({
      status: "aborted",
      proofInput: input,
      taskId: task.id,
      outputs,
      summaries,
      nodes,
      cleanup: { confirmed: true, pgid: intent.identity.pgid },
      reason: "stop requested; process group cleanup confirmed",
    });
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted", reason: "process group cleanup confirmed", result } }),
      context,
    );
  },
});
