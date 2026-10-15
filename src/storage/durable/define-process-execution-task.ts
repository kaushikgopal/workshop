import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationId, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { canonicalHash } from "../../definition/hash-canonical-json.js";
import { parseModel } from "../../definition/parse-model.js";
import { nodeIdSchema, workflowIdSchema } from "../../definition/schema.js";
import {
  executionIdSchema,
  incarnationIdSchema,
  processCaptureSchema,
  processExitSchema,
  processIdentitySchema,
  processIncarnationSchema,
} from "../../process/schema.js";
import { processStartId } from "../../process/identify-process.js";
import { terminateProcessGroup } from "../../process/kill-process-tree.js";
import { raceDeadline, spawnTracked, type TrackedProcess } from "../../process/launch-process.js";
import {
  attemptIdSchema,
  blockInfoSchema,
  runIdSchema,
  type BlockInfo,
} from "../../run/schema.js";
import {
  persistedNodeAttemptSchema,
  workflowRunDocumentV1Schema,
  workshopProcessV1Schema,
  type WorkflowRunDocumentV1,
} from "../../run/records.js";
import { WorkshopProcessEntry, WorkshopRunDoc } from "./define-workshop-records.js";
import { sha256Schema, utcTimestampSchema } from "../../util/schema.js";
import { DEFAULT_STREAM_CAP_BYTES } from "../../util/parse-units.js";
import { locateProcessFiles, locateWorkflowDirectory, type ProcessFiles } from "../../run/locate-run-files.js";
import { readVerifiedRetentionWindow, retainStreamWindow } from "../disk/cap-streams.js";
import { removeProcessCaptures } from "../disk/remove-process-captures.js";
import { reconstructProcessStdin, committedHumanAnswer } from "../../attempt/build-process-stdin.js";

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegative = z.number().int().nonnegative().refine(Number.isSafeInteger);
const absolutePath = z.string().min(1).refine((value) => isAbsolute(value) && !value.includes("\u0000"));
const MAX_SEMANTIC_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESS_INCARNATIONS = 3;
const MAX_TIMER_MS = 2_147_000_000;

export const processExecutionTaskInputSchema = z.strictObject({
  runId: runIdSchema,
  workflowId: workflowIdSchema,
  activationId: z.string().min(1),
  occurrenceId: z.string().min(1),
  workflowTaskId: positive,
  nodeTaskId: positive,
  nodeId: nodeIdSchema.nullable(),
  attemptId: attemptIdSchema.nullable(),
  executionId: executionIdSchema,
  incarnationId: incarnationIdSchema,
  incarnationNumber: positive,
  serviceBootId: z.string().uuid(),
  role: z.enum(["worker", "validator", "preflight"]),
  ioVersion: z.literal(1),
  stdinSha256: sha256Schema,
  stdinByteCount: nonnegative,
  launchIntentAt: utcTimestampSchema,
  deadlineAt: utcTimestampSchema.nullable(),
  shell: absolutePath,
  command: z.string().min(1),
  cwd: absolutePath,
  timeoutMs: positive.nullable(),
  streamCapBytes: z.union([positive, z.literal("unlimited")]),
  replay: z.enum(["never", "safe"]),
  stdoutPath: absolutePath,
  stderrPath: absolutePath,
  env: z.record(z.string(), z.string()),
});
export type ProcessExecutionTaskInput = z.infer<typeof processExecutionTaskInputSchema>;
export type ProcessExecutionTaskEnvironmentInput = Omit<ProcessExecutionTaskInput, "env">;

/** Locates the files of one process from its task input. */
export function processExecutionFiles(
  input: Pick<ProcessExecutionTaskInput, "role" | "nodeId" | "incarnationNumber" | "executionId">,
  workflowDirectory: string,
  runId: string,
  attemptNumber: number | null,
): ProcessFiles {
  return locateProcessFiles(workflowDirectory, runId, { role: input.role, nodeId: input.nodeId, attemptNumber, incarnationNumber: input.incarnationNumber, executionId: input.executionId });
}

export function buildProcessExecutionEnvironment(
  input: ProcessExecutionTaskEnvironmentInput,
  runDocument: WorkflowRunDocumentV1,
  attemptNumber: number | null,
): Record<string, string> {
  const run = readyRun(runDocument);
  const settings = format4Settings(run);
  const paths = processExecutionFiles(input, locateWorkflowDirectory(run), run.runId, attemptNumber);
  const common = {
    WORKSHOP_RUN_ID: run.runId,
    WORKSHOP_WORKFLOW_ID: run.workflowId,
    WORKSHOP_EXECUTION_ID: input.executionId,
    WORKSHOP_RESULTS_PATH: paths.resultsPath,
    WORKSHOP_LOG_PATH: paths.logPath,
  };
  if (input.role === "preflight") {
    if (input.nodeId !== null || input.attemptId !== null || attemptNumber !== null || run.resolvedSettings.preflight === null) {
      throw new Error("preflight process identity differs from frozen workflow settings");
    }
    return { ...common, WORKSHOP_STEP_ID: "", WORKSHOP_ATTEMPT: "0" };
  }
  if (input.nodeId === null || input.attemptId === null || attemptNumber === null) {
    throw new Error("node process identity is missing its node or attempt");
  }
  const nodeSettings = settings.nodes[input.nodeId];
  const site = input.role === "worker" ? nodeSettings?.run : nodeSettings?.validator;
  if (site === undefined || site === null) throw new Error("process role has no resolved execution site");
  const env: Record<string, string> = {
    ...common,
    WORKSHOP_STEP_ID: input.nodeId,
    WORKSHOP_ATTEMPT: String(attemptNumber),
  };
  const answer = committedHumanAnswer(run, input.nodeId);
  if (answer !== null) env.WORKSHOP_ANSWER = answer;
  if (input.role === "validator" && site.kind === "command") {
    const attempt = requireAttempt(run, input.nodeId, input.attemptId);
    if (attempt.result.kind !== "candidate_committed" && attempt.result.kind !== "validation_committed") {
      throw new Error("command validator environment requires a committed candidate");
    }
    const candidate = attempt.result.candidate;
    const retries = nodeSettings?.retries;
    if (retries === undefined) throw new Error("command validator environment lacks frozen retry settings");
    env.WORKSHOP_CANDIDATE_STATUS = candidate.version === 2 ? candidate.stdioResult.status : "succeeded";
    env.WORKSHOP_RETRIES_LEFT = retries === "unlimited" ? "unlimited" : String(Math.max(0, retries + 1 - attempt.number));
  }
  if (site.kind === "agent") {
    const model = parseModel(site.model);
    env.WORKSHOP_PROVIDER = model.provider;
    env.WORKSHOP_MODEL_ID = model.modelId;
    env.WORKSHOP_MODEL = model.provider + "/" + model.modelId;
    env.WORKSHOP_THINKING = model.thinking;
    env.WORKSHOP_MODEL_WITH_THINKING = model.full;
  }
  return env;
}
const processCheckpointSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("intent") }),
  z.strictObject({ phase: z.literal("launch"), process: processIncarnationSchema }),
  z.strictObject({ phase: z.literal("monitor"), process: processIncarnationSchema }),
]);
type ProcessCheckpoint = z.infer<typeof processCheckpointSchema>;

const semanticStdoutSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("captured"),
    text: z.string(),
    byteCount: nonnegative,
    sha256: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("invalid_utf8"),
    byteCount: nonnegative,
    sha256: sha256Schema,
  }),
  z.strictObject({ kind: z.literal("too_large"), byteCount: positive }),
  z.strictObject({ kind: z.literal("not_captured") }),
]).superRefine((capture, context) => {
  if (capture.kind === "captured") {
    if (Buffer.byteLength(capture.text, "utf8") !== capture.byteCount) {
      context.addIssue({ code: "custom", path: ["byteCount"], message: "semantic stdout byte count matches its text" });
    }
    if (sha256(Buffer.from(capture.text, "utf8")) !== capture.sha256) {
      context.addIssue({ code: "custom", path: ["sha256"], message: "semantic stdout digest matches its text" });
    }
  }
});

export const processExecutionTaskResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exited"),
    exit: processExitSchema,
    timedOut: z.boolean(),
    stdoutCaptureHash: sha256Schema,
    stderrCaptureHash: sha256Schema,
    semanticStdout: semanticStdoutSchema,
  }),
  z.strictObject({
    kind: z.literal("cancelled"),
    executionId: executionIdSchema,
    incarnationId: incarnationIdSchema,
    incarnationNumber: positive,
    identity: processIdentitySchema,
    exit: processExitSchema,
    cleanupState: z.literal("confirmed_dead"),
  }),
  z.strictObject({
    kind: z.literal("replayable"),
    executionId: executionIdSchema,
    incarnationId: incarnationIdSchema,
    incarnationNumber: positive,
    launchIntentAt: utcTimestampSchema,
    deadlineAt: utcTimestampSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("blocked"), block: blockInfoSchema }),
]);
export type ProcessExecutionTaskResult = z.infer<typeof processExecutionTaskResultSchema>;

type ReadyRun = Extract<WorkflowRunDocumentV1, { state: "ready" }>;
type Format4Settings = Extract<ReadyRun["resolvedSettings"], { formatVersion: 4 }>;
type PersistedNodeAttempt = z.infer<typeof persistedNodeAttemptSchema>;
type ProcessRuntime = TaskRuntime<ProcessExecutionTaskInput, ProcessCheckpoint, ProcessExecutionTaskResult, object>;
export type ProcessExecutionTaskDefinition = Task<ProcessExecutionTaskInput, ProcessCheckpoint, ProcessExecutionTaskResult, object>;

/** Owns OS-process lifecycle and capture evidence for every Durable execution role. */
export function defineProcessExecutionTask(
  serviceBootId: string = randomUUID(),
  options: { readonly startupLaunchGate?: "open" | "closed"; readonly beforeLaunch?: (conversationId: ConversationId, signal: AbortSignal) => Promise<void> } = {},
): {
  readonly serviceBootId: string;
  readonly task: ProcessExecutionTaskDefinition;
  readonly stopLaunching: () => void;
  readonly canLaunch: () => boolean;
  readonly openStartupLaunchGate: () => void;
} {
  let acceptingLaunches = true;
  let releaseStartupLaunchGate: (() => void) | undefined;
  const startupLaunchGate = options.startupLaunchGate === "closed"
    ? new Promise<void>((resolve) => { releaseStartupLaunchGate = resolve; })
    : Promise.resolve();
  const openStartupLaunchGate = () => {
    const release = releaseStartupLaunchGate;
    releaseStartupLaunchGate = undefined;
    release?.();
  };
  const launched = new Set<string>();
  const trackedProcesses = new Map<string, TrackedProcess>();

  const task = defineTask<ProcessExecutionTaskInput, ProcessCheckpoint, ProcessExecutionTaskResult>({
    name: "workshop.process-execution",
    version: 4,
    initial: () => ({ phase: "intent" }),
    phases: {
      intent: async (task, runtime, context) => {
        await waitForStartupLaunchGate(startupLaunchGate, runtime.signal);
        const input = parseProcessInput(task.input);
        const run = await snapshotRun(runtime, context);

        await options.beforeLaunch?.(runtime.conversationId, runtime.signal);
        const at = timestamp(runtime.now());
        const process = processIncarnationSchema.parse({
          executionId: input.executionId,
          incarnationId: input.incarnationId,
          incarnationNumber: input.incarnationNumber,
          role: input.role,
          status: "launching",
          replay: input.replay,
          commandHash: processCommandHash(input),
          launchIntentAt: input.launchIntentAt,
          launchServiceBootId: serviceBootId,
          startedAt: null,
          finishedAt: null,
          deadlineAt: input.deadlineAt,
          identity: null,
          exit: null,
          cleanupState: "pending",
          captures: [],
          stdio: { version: 1, stdinSha256: input.stdinSha256, stdinByteCount: input.stdinByteCount, write: { kind: "pending", queuedBytes: 0 } },
        });
        if (!matchesProcessStdin(input, run)) {
          await blockProcess(task, runtime, input, process, "integrity_failed", "reconstructed stdin differs from its committed identity", context);
          return;
        }
        assertProcessIdentity(input, run);
        await runtime.commit(async (tx) => {
          const { draft, run: current } = await runDraft(tx, runtime.conversationId);
          if (!matchesProcessStdin(input, current)) {
            const block = blockInfo("integrity_failed", "stdin source changed before launch intent", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
            const blocked = processIncarnationSchema.parse({ ...process, status: "blocked", cleanupState: "unconfirmed" });
            await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), blocked, timestamp(runtime.now()));
            return { status: "terminal", outcome: { status: "completed", result: { kind: "blocked", block } } };
          }
          assertProcessIdentity(input, current);
          if (input.role === "preflight") {
            assign(draft, current);
          } else {
            if (input.nodeId === null || input.attemptId === null) throw new Error("node process identity is incomplete");
            const attempt = requireAttempt(current, input.nodeId, input.attemptId);
            const incarnations = attempt.processIncarnations.filter((item) => item.executionId === input.executionId);
            if (incarnations.some((item) => item.incarnationId === input.incarnationId)
              || incarnations.length + 1 !== input.incarnationNumber) {
              throw new Error("process incarnation does not extend the canonical execution history");
            }
            const next = replaceRunAttempt(current, input.nodeId, input.attemptId, (value) => ({
              ...value,
              processIncarnations: [...value.processIncarnations, { executionId: input.executionId, incarnationId: input.incarnationId }],
            }));
            assign(draft, next);
          }
          await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), process, at);
          return { status: "running", checkpoint: { phase: "launch", process } };
        }, context);
      },
      launch: async (task, runtime, context) => {
        const input = parseProcessInput(task.input);
        const checkpoint = processCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "launch") throw new Error("launch checkpoint lacks process intent");
        const process = checkpoint.process;
        const run = await snapshotRun(runtime, context);

        if (!matchesRecordedProcessStdin(input, process, run)) {
          await blockProcess(task, runtime, input, process, "integrity_failed", "reconstructed stdin differs from its committed identity", context);
          return;
        }

        assertProcessIdentity(input, run, { requireReference: true, requireExecuting: false });
        const authorized = input.role === "preflight"
          ? run.preflight.kind === "pending" && run.preflight.processExecutionIds.includes(input.executionId)
          : input.nodeId !== null && input.attemptId !== null
            && (() => {
              const attempt = requireAttempt(run, input.nodeId, input.attemptId);
              return input.role === "worker"
                ? attempt.status === "executing" && attempt.result.kind === "pending"
                : attempt.status === "validating" && (attempt.result.kind === "candidate_committed" || attempt.result.kind === "worker_failure_committed");
            })();
        const runIsActive = run.status === "running" && run.desiredState === "running";
        const pausedValidatorMayFinish = input.role === "validator"
          && run.desiredState === "paused"
          && (run.status === "running" || run.status === "paused");
        const pausedPreflightMayFinish = input.role === "preflight"
          && run.desiredState === "paused"
          && (run.status === "running" || run.status === "paused");
        if ((!runIsActive && !pausedValidatorMayFinish && !pausedPreflightMayFinish) || !authorized) {
          await blockProcess(task, runtime, input, process, "external_outcome_unknown", "run state no longer authorizes process launch", context);
          return;
        }
        if (!acceptingLaunches) {
          await blockProcess(task, runtime, input, process, "external_outcome_unknown", "service shutdown prevented process launch", context);
          return;
        }
        const launchServiceBootId = process.launchServiceBootId ?? input.serviceBootId;
        const key = `${launchServiceBootId}:${input.executionId}:${input.incarnationId}`;
        if (launchServiceBootId !== serviceBootId || launched.has(key)) {
          await blockProcess(task, runtime, input, process, "external_outcome_unknown", "persisted launch intent cannot authorize a second process launch", context);
          return;
        }
        launched.add(key);
        const until = process.deadlineAt === null ? null : Date.parse(process.deadlineAt);
        if (until !== null && (!Number.isSafeInteger(until) || until <= Date.now())) {
          await blockProcess(task, runtime, input, process, "external_outcome_unknown", "process deadline elapsed before a launch could be authorized", context);
          return;
        }
        mkdirSync(dirname(input.stdoutPath), { recursive: true });
        const stdin = reconstructProcessStdin(input, run);
        let child: TrackedProcess;
        try {
          child = spawnTracked({
            shell: input.shell,
            command: input.command,
            cwd: input.cwd,
            env: processSpawnEnvironment(input, run),
            inputBytes: stdin.bytes,
            stdoutLogCapBytes: MAX_SEMANTIC_OUTPUT_BYTES,
            semanticStdoutLimitBytes: MAX_SEMANTIC_OUTPUT_BYTES,
            stdoutFile: input.stdoutPath,
            stderrFile: input.stderrPath,
          });
        } catch {
          await blockProcess(task, runtime, input, process, input.role === "validator" ? "verifier_failed" : "external_outcome_unknown", "process launch did not produce a durable identity", context);
          return;
        }
        trackedProcesses.set(input.executionId, child);
        const running = processIncarnationSchema.parse({
          ...process,
          status: "running",
          startedAt: timestamp(runtime.now()),
          stdio: { ...process.stdio, write: child.writeOutcome() },
          identity: processIdentitySchema.parse({
            pid: child.pid,
            pgid: child.pgid,
            startIdentity: child.startId,
            serviceBootId,
          }),
        });
        try {
          await runtime.commit(async (tx) => {
            const { draft, run: current } = await runDraft(tx, runtime.conversationId);
            assertProcessIdentity(input, current, { requireReference: true });
            assign(draft, current);
            await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), running, timestamp(runtime.now()));
            return { status: "running", checkpoint: { phase: "monitor", process: running } };
          }, context);
        } catch (error) {
          const dead = await child.kill();
          if (dead) await child.streamsClosed;
          trackedProcesses.delete(input.executionId);
          throw error;
        }
      },
      monitor: async (task, runtime, context) => {
        const input = parseProcessInput(task.input);
        const checkpoint = processCheckpointSchema.parse(task.state.checkpoint);
        if (checkpoint.phase !== "monitor") throw new Error("monitor checkpoint lacks process identity");
        const process = checkpoint.process;
        const identity = process.identity;
        if (identity === null) throw new Error("running process checkpoint has no identity");
        const run = await snapshotRun(runtime, context);
        const child = trackedProcesses.get(input.executionId);
        const stdinMatches = matchesRecordedProcessStdin(input, process, run);
        if (!stdinMatches && child !== undefined) {
          const dead = await child.kill();
          if (dead) await child.streamsClosed;
          const captures = dead
            ? await captureProcessRecords(input, child.captures(), { bestEffort: true })
            : process.captures;
          const checkedProcess = process.stdio === undefined ? process : {
            ...process,
            stdio: { ...process.stdio, write: child.writeOutcome() },
          };
          await blockProcess(
            task,
            runtime,
            input,
            checkedProcess,
            "integrity_failed",
            "reconstructed stdin differs from its committed identity",
            context,
            dead ? "confirmed_dead" : "unconfirmed",
            captures,
          );
          trackedProcesses.delete(input.executionId);
          return;
        }
        if (stdinMatches) assertProcessIdentity(input, run, { requireReference: true, requireExecuting: false });
        const launchServiceBootId = process.launchServiceBootId ?? input.serviceBootId;
        if (identity.serviceBootId !== launchServiceBootId) {
          await blockProcess(task, runtime, input, process, "process_death_unconfirmed", "process identity does not match its launch intent", context);
          return;
        }
        if (launchServiceBootId !== serviceBootId || child === undefined) {
          const sameProcess = processStartId(identity.pid) === identity.startIdentity;
          const dead = sameProcess ? await terminateProcessGroup(identity.pgid) : false;
          if (dead) {
            await settleRecoveredProcess(runtime, input, process, context);
            trackedProcesses.delete(input.executionId);
            return;
          }
          const captures = await recoverRetainedProcessCaptureRecords(input);
          await blockProcess(
            task,
            runtime,
            input,
            process,
            "process_death_unconfirmed",
            "recorded process identity could not be reconciled safely",
            context,
            "unconfirmed",
            captures,
          );
          return;
        }
        const onAbort = () => { void child.kill(); };
        runtime.signal.addEventListener("abort", onAbort, { once: true });
        let waited: Awaited<ReturnType<typeof waitForExit>>;
        try {
          if (runtime.signal.aborted) await child.kill();
          waited = await waitForExit(child, process.deadlineAt);
        } finally {
          runtime.signal.removeEventListener("abort", onAbort);
        }
        if (runtime.signal.aborted) {
          await child.kill();
          return;
        }
        const dead = await child.kill();
        const exit = await child.exit;
        if (!dead) {
          await blockProcess(task, runtime, input, process, "process_death_unconfirmed", "process group death could not be confirmed", context);
          trackedProcesses.delete(input.executionId);
          return;
        }
        await child.streamsClosed;
        const stats = child.captures();
        const finishedAt = timestamp(runtime.now());
        const semantic = stats.stdout.totalBytes > MAX_SEMANTIC_OUTPUT_BYTES
          ? { kind: "too_large" as const, byteCount: stats.stdout.totalBytes }
          : readSemanticStdout(input.stdoutPath);
        const captures = await captureProcessRecords(input, stats);
        const stdoutCapture = captures.find((capture) => capture.stream === "stdout");
        const stderrCapture = captures.find((capture) => capture.stream === "stderr");
        const normalizedExit = exitRecord(exit);
        if (stats.stdout.error !== null || stats.stderr.error !== null
          || stdoutCapture?.sha256 == null || stderrCapture?.sha256 == null || normalizedExit === null) {
          const blocked = processIncarnationSchema.parse({
            ...process,
            status: "blocked",
            finishedAt,
            exit: normalizedExit,
            cleanupState: "confirmed_dead",
            captures,
          });
          await blockProcess(task, runtime, input, blocked, "integrity_failed", "process exit or stream evidence failed validation", context, "confirmed_dead");
          trackedProcesses.delete(input.executionId);
          return;
        }
        const exited = processIncarnationSchema.parse({
          ...process,
          status: "exited",
          stdio: { ...process.stdio, write: child.writeOutcome() },
          finishedAt,
          exit: normalizedExit,
          cleanupState: "confirmed_dead",
          captures,
        });
        const semanticStdout = semantic ?? { kind: "not_captured" as const };
        const result = processExecutionTaskResultSchema.parse({
          kind: "exited",
          exit: normalizedExit,
          timedOut: waited.kind === "timeout",
          stdoutCaptureHash: stdoutCapture.sha256,
          stderrCaptureHash: stderrCapture.sha256,
          semanticStdout,
        });
        await runtime.commit(async (tx) => {
          const { draft, run: current } = await runDraft(tx, runtime.conversationId);
          assertProcessIdentity(input, current, { requireReference: true, requireExecuting: false });
          assign(draft, current);
          await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), exited, finishedAt);
          return { status: "terminal", outcome: { status: "completed", result } };
        }, context);
        removeProcessCaptures(exited, true);
        trackedProcesses.delete(input.executionId);
      },
    },
    abort: async (task, runtime, context) => {
      const input = parseProcessInput(task.input);
      const parsed = processCheckpointSchema.safeParse(task.state.checkpoint);
      if (!parsed.success) {
        const block = blockInfo("process_death_unconfirmed", "process checkpoint failed validation; cleanup and exit remain unknown", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { kind: "blocked", block } } }), context);
        return;
      }
      if (parsed.data.phase === "intent") {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "process was aborted before launch intent" } }), context);
        return;
      }
      const process = parsed.data.process;
      const run = await snapshotRun(runtime, context);
      assertProcessIdentity(input, run, { requireReference: true, requireExecuting: false });
      const operatorStopRequested = run.desiredState === "stopped" && run.block === null;
      const child = trackedProcesses.get(input.executionId);
      const expectedBootId = process.launchServiceBootId ?? input.serviceBootId;
      const identityMatches = child !== undefined && process.identity !== null
        && child.pid === process.identity.pid && child.pgid === process.identity.pgid
        && child.startId === process.identity.startIdentity
        && process.identity.serviceBootId === expectedBootId;
      let dead = false;
      if (identityMatches && child !== undefined) dead = await child.kill();
      else if (child !== undefined && process.identity === null) dead = await child.kill();
      else if (child === undefined && process.identity !== null
        && process.identity.serviceBootId === expectedBootId
        && processStartId(process.identity.pid) === process.identity.startIdentity) {
        dead = await terminateProcessGroup(process.identity.pgid);
      }
      let observedExit: ReturnType<typeof exitRecord> = null;
      let captures: Awaited<ReturnType<typeof captureProcessRecords>> = process.captures;
      let finishedAt: string | null = null;
      if (dead && identityMatches && child !== undefined && process.identity !== null) {
        const exit = await child.exit;
        await child.streamsClosed;
        const stats = child.captures();
        finishedAt = timestamp(runtime.now());
        captures = await captureProcessRecords(input, stats, { bestEffort: true });
        observedExit = exitRecord(exit);
        if (operatorStopRequested && observedExit !== null && finishedAt !== null) {
          const completedAt = finishedAt;
          const retired = processIncarnationSchema.parse({
            ...process,
            status: "exited",
            stdio: { ...process.stdio, write: child.writeOutcome() },
            finishedAt: completedAt,
            exit: observedExit,
            cleanupState: "confirmed_dead",
            captures,
          });
          const result = processExecutionTaskResultSchema.parse({
            kind: "cancelled",
            executionId: input.executionId,
            incarnationId: input.incarnationId,
            incarnationNumber: input.incarnationNumber,
            identity: process.identity,
            exit: observedExit,
            cleanupState: "confirmed_dead",
          });
          await runtime.commit(async (tx) => {
            const { draft, run: current } = await runDraft(tx, runtime.conversationId);
            assertProcessIdentity(input, current, { requireReference: true, requireExecuting: false });
            if (current.desiredState !== "stopped" || current.block !== null) {
              const blockedReceipt = processIncarnationSchema.parse({
                ...process,
                status: "blocked",
                finishedAt: completedAt,
                exit: observedExit,
                cleanupState: "confirmed_dead",
                captures,
              });
              await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), blockedReceipt, timestamp(runtime.now()));
              return { status: "terminal", outcome: { status: "aborted", reason: "operator stop was no longer eligible at retirement commit" } };
            }
            assign(draft, current);
            await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), retired, completedAt);
            return { status: "terminal", outcome: { status: "completed", result } };
          }, context);
          removeProcessCaptures(retired, true);
          trackedProcesses.delete(input.executionId);
          return;
        }
      } else if (dead && child === undefined && process.identity !== null) {
        finishedAt = timestamp(runtime.now());
        captures = await recoverProcessCaptureRecords(input);
      }
      const block = blockInfo("process_death_unconfirmed", "process was aborted before a checked operator-stop receipt", input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
      const confirmedIdentity = process.identity !== null;
      const blocked = processIncarnationSchema.parse({
        ...process,
        status: "blocked",
        ...(finishedAt === null ? {} : { finishedAt }),
        exit: observedExit,
        cleanupState: dead && confirmedIdentity ? "confirmed_dead" : "unconfirmed",
        captures,
      });
      await runtime.commit(async (tx) => {
        const { draft, run: current } = await runDraft(tx, runtime.conversationId);
        assertProcessIdentity(input, current, { requireReference: true, requireExecuting: false });
        assign(draft, current);
        await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), blocked, timestamp(runtime.now()));
        return { status: "terminal", outcome: { status: "aborted", reason: dead ? "process stopped without a checked operator-stop receipt" : block.reason } };
      }, context);
      trackedProcesses.delete(input.executionId);
    },
  });

  return {
    serviceBootId,
    task,
    stopLaunching: () => { acceptingLaunches = false; },
    canLaunch: () => acceptingLaunches,
    openStartupLaunchGate,
  };
}

async function waitForStartupLaunchGate(
  gate: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("process launch wait was aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("process launch wait was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, reject);
  });
}

async function blockProcess(
  _task: unknown,
  runtime: ProcessRuntime,
  input: ProcessExecutionTaskInput,
  process: z.infer<typeof processIncarnationSchema>,
  kind: BlockInfo["kind"],
  reason: string,
  context: Context,
  cleanup: "confirmed_dead" | "unconfirmed" = "unconfirmed",
  captures = process.captures,
): Promise<void> {
  const block = blockInfo(kind, reason, input.runId, input.nodeId, input.attemptId, timestamp(runtime.now()));
  const blocked = processIncarnationSchema.parse({ ...process, status: "blocked", cleanupState: cleanup, captures });
  await runtime.commit(async (tx) => {
    await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), blocked, timestamp(runtime.now()));
    return { status: "terminal", outcome: { status: "completed", result: { kind: "blocked", block } } };
  }, context);
}

async function settleRecoveredProcess(
  runtime: ProcessRuntime,
  input: ProcessExecutionTaskInput,
  process: z.infer<typeof processIncarnationSchema>,
  context: Context,
): Promise<void> {
  const recordedIdentityMatches = process.executionId === input.executionId
    && process.incarnationId === input.incarnationId
    && process.incarnationNumber === input.incarnationNumber
    && process.role === input.role
    && process.replay === input.replay
    && process.launchIntentAt === input.launchIntentAt
    && process.deadlineAt === input.deadlineAt;
  const now = runtime.now();
  const recoveredAt = timestamp(now);
  const captures = await recoverProcessCaptureRecords(input);
  const blocked = processIncarnationSchema.parse({
    ...process,
    status: "blocked",
    stdio: process.stdio === undefined ? undefined : { ...process.stdio, write: { kind: "unknown_after_restart", queuedBytes: process.stdio.write.queuedBytes } },
    finishedAt: recoveredAt,
    cleanupState: "confirmed_dead",
    captures,
  });
  const nextIncarnationId = incarnationIdSchema.parse(randomUUID());
  await runtime.commit(async (tx) => {
    const { draft, run } = await runDraft(tx, runtime.conversationId);

    assign(draft, run);
    await appendProcess(tx, runtime.conversationId, input, Number(runtime.taskId), blocked, timestamp(now));
    if (!recordedIdentityMatches || !matchesRecordedProcessStdin(input, process, run)) {
      const block = blockInfo("integrity_failed", "reconstructed stdin differs from its committed identity", input.runId, input.nodeId, input.attemptId, timestamp(now));
      return { status: "terminal", outcome: { status: "completed", result: { kind: "blocked", block } } };
    }
    assertProcessIdentity(input, run, { requireReference: true, requireExecuting: false });
    const reason = decideProcessReplay({
      replayPolicy: input.replay,
      recordedReplayPolicy: process.replay,
      incarnationNumber: process.incarnationNumber,
      runStatus: run.status,
      desiredState: run.desiredState,
      deadlineAt: input.deadlineAt,
      confirmedDead: true,
      hasExitReceipt: process.exit !== null,
      now,
    });
    if (reason !== null) {
      const block = blockInfo("external_outcome_unknown", reason, input.runId, input.nodeId, input.attemptId, timestamp(now));
      return { status: "terminal", outcome: { status: "completed", result: { kind: "blocked", block } } };
    }
    return {
      status: "terminal",
      outcome: {
        status: "completed",
        result: {
          kind: "replayable",
          executionId: input.executionId,
          incarnationId: nextIncarnationId,
          incarnationNumber: process.incarnationNumber + 1,
          launchIntentAt: recoveredAt,
          deadlineAt: input.deadlineAt,
        },
      },
    };
  }, context);
}

export function decideProcessReplay(input: {
  readonly replayPolicy: "safe" | "never";
  readonly recordedReplayPolicy: "safe" | "never";
  readonly incarnationNumber: number;
  readonly runStatus: "waiting" | "queued" | "running" | "paused" | "blocked" | "failed" | "completed" | "cancelled";
  readonly desiredState: "running" | "paused" | "stopped";
  readonly deadlineAt: string | null;
  readonly confirmedDead: boolean;
  readonly hasExitReceipt: boolean;
  readonly now: number;
}): string | null {
  if (!input.confirmedDead || input.hasExitReceipt) return "same-attempt replay requires confirmed death without a checked exit receipt";
  if (input.replayPolicy !== "safe" || input.recordedReplayPolicy !== "safe") return "process replay policy forbids automatic repetition";
  if (input.incarnationNumber >= MAX_PROCESS_INCARNATIONS) return "safe process replay limit was exhausted";
  if (input.desiredState === "stopped") return "run was stopped while the process outcome remained unknown";
  if (input.runStatus !== "running" && input.runStatus !== "paused") return "run state no longer authorizes safe process replay";
  if (input.deadlineAt !== null && Date.parse(input.deadlineAt) <= input.now) return "absolute process deadline elapsed before safe replay";
  return null;
}

function validProcessDeadline(input: ProcessExecutionTaskInput, timeoutMs: number | null): boolean {
  if (timeoutMs === null) return input.deadlineAt === null;
  if (input.deadlineAt === null) return false;
  const launchTime = Date.parse(input.launchIntentAt);
  const deadlineTime = Date.parse(input.deadlineAt);
  const remaining = deadlineTime - launchTime;
  return Number.isSafeInteger(launchTime) && Number.isSafeInteger(deadlineTime)
    && Number.isFinite(new Date(deadlineTime).getTime())
    && remaining >= 0
    && (input.incarnationNumber === 1 ? remaining === timeoutMs : remaining <= timeoutMs);
}

function format4Settings(run: ReadyRun): Format4Settings {
  const settings = run.resolvedSettings;
  if (!("formatVersion" in settings) || settings.formatVersion !== 4) {
    throw new Error("format 3 runs cannot launch or replay processes");
  }
  return settings;
}

function matchesProcessStdin(input: ProcessExecutionTaskInput, run: ReadyRun): boolean {
  try {
    const rebuilt = reconstructProcessStdin(input, run);
    return input.ioVersion === 1 && rebuilt.sha256 === input.stdinSha256 && rebuilt.byteCount === input.stdinByteCount;
  } catch {
    return false;
  }
}

function matchesRecordedProcessStdin(
  input: ProcessExecutionTaskInput,
  process: z.infer<typeof processIncarnationSchema>,
  run: ReadyRun,
): boolean {
  return process.executionId === input.executionId
    && process.incarnationId === input.incarnationId
    && process.incarnationNumber === input.incarnationNumber
    && process.role === input.role
    && process.replay === input.replay
    && process.launchIntentAt === input.launchIntentAt
    && process.deadlineAt === input.deadlineAt
    && process.commandHash === processCommandHash(input)
    && process.stdio?.version === 1
    && process.stdio.stdinSha256 === input.stdinSha256
    && process.stdio.stdinByteCount === input.stdinByteCount
    && matchesProcessStdin(input, run);
}

function processSpawnEnvironment(input: ProcessExecutionTaskInput, run: ReadyRun): Record<string, string> {
  const settings = format4Settings(run);
  const site = input.role === "preflight" || input.nodeId === null
    ? null
    : input.role === "worker"
      ? settings.nodes[input.nodeId]?.run ?? null
      : settings.nodes[input.nodeId]?.validator ?? null;
  const environment: NodeJS.ProcessEnv = { ...input.env };
  const removed = [
    "WORKSHOP_PROMPT_FILE", "WORKSHOP_RESULT_FILE", "WORKSHOP_PREVIOUS_OUTPUT_FILE",
    "WORKSHOP_STEP_OUTPUT_FILE", "WORKSHOP_WORKLOG_FILE", "WORKSHOP_STDOUT_FILE",
    "WORKSHOP_STDERR_FILE", "WORKSHOP_BIN",
  ];
  if (input.nodeId === null || committedHumanAnswer(run, input.nodeId) === null) removed.push("WORKSHOP_ANSWER");
  if (input.role !== "validator" || site?.kind !== "command") {
    removed.push("WORKSHOP_CANDIDATE_STATUS", "WORKSHOP_RETRIES_LEFT");
  }
  if (site?.kind !== "agent") {
    removed.push("WORKSHOP_PROVIDER", "WORKSHOP_MODEL_ID", "WORKSHOP_MODEL", "WORKSHOP_THINKING", "WORKSHOP_MODEL_WITH_THINKING");
  }
  // Node drops undefined values from the child environment, which clears inherited Workshop channels.
  for (const name of removed) environment[name] = undefined;
  return environment as Record<string, string>;
}

function readSemanticStdout(path: string): z.infer<typeof semanticStdoutSchema> | null {
  try {
    if (!existsSync(path)) return null;
    const byteCount = statSync(path).size;
    if (byteCount > MAX_SEMANTIC_OUTPUT_BYTES) return { kind: "too_large", byteCount };
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_SEMANTIC_OUTPUT_BYTES) return { kind: "too_large", byteCount: bytes.byteLength };
    const digest = sha256(bytes);
    try {
      return {
        kind: "captured",
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        byteCount: bytes.byteLength,
        sha256: digest,
      };
    } catch {
      return { kind: "invalid_utf8", byteCount: bytes.byteLength, sha256: digest };
    }
  } catch {
    return null;
  }
}

function processCommandHash(input: ProcessExecutionTaskInput): string {
  const stableEnvironment = input.env;
  return canonicalHash({
    role: input.role,
    ioVersion: input.ioVersion,
    stdinSha256: input.stdinSha256,
    stdinByteCount: input.stdinByteCount,
    command: input.command,
    shell: input.shell,
    cwd: input.cwd,
    env: stableEnvironment,
  });
}

function replaceRunAttempt(
  run: ReadyRun,
  nodeId: string,
  attemptId: string,
  update: (attempt: PersistedNodeAttempt) => PersistedNodeAttempt,
): ReadyRun {
  const parsed = workflowRunDocumentV1Schema.parse({
    ...run,
    nodes: run.nodes.map((node) => node.nodeId !== nodeId ? node : {
      ...node,
      attempts: node.attempts.map((attempt) => attempt.attemptId === attemptId ? update(attempt) : attempt),
    }),
  });
  if (parsed.state !== "ready") throw new Error("canonical run document is uninitialized");
  return parsed;
}

function requireAttempt(run: ReadyRun, nodeId: string, attemptId: string): PersistedNodeAttempt {
  const attempt = run.nodes.find((node) => node.nodeId === nodeId)?.attempts.find((value) => value.attemptId === attemptId);
  if (attempt === undefined) throw new Error("canonical attempt is missing");
  return attempt;
}

function assertProcessIdentity(
  input: ProcessExecutionTaskInput,
  run: ReadyRun,
  options: { requireReference?: boolean; requireExecuting?: boolean } = {},
): void {
  const { requireReference = false, requireExecuting = true } = options;
  format4Settings(run);
  if (input.role === "preflight") {
    const site = format4Settings(run).preflight;
    const expectedEnv = buildProcessExecutionEnvironment(input, run, null);
    const paths = processExecutionFiles(input, locateWorkflowDirectory(run), run.runId, null);
    const validDeadline = site !== null && site !== undefined
      && validProcessDeadline(input, site.timeoutMs);
    const authorized = run.preflight.kind === "pending"
      && run.preflight.processExecutionIds.includes(input.executionId);
    if (input.runId !== run.runId || input.workflowId !== run.workflowId
      || input.activationId !== run.activationId || input.occurrenceId !== run.occurrenceId
      || input.workflowTaskId !== run.durable.workflowTaskId || input.nodeTaskId !== run.durable.workflowTaskId
      || input.nodeId !== null || input.attemptId !== null || site === null
      || (requireExecuting && !authorized) || (requireReference && !authorized)
      || site.command !== input.command || site.shell !== input.shell || site.cwd !== input.cwd
      || site.timeoutMs !== input.timeoutMs || input.streamCapBytes !== DEFAULT_STREAM_CAP_BYTES
      || input.replay !== "safe" || !validDeadline
      || input.stdoutPath !== paths.stdoutPath || input.stderrPath !== paths.stderrPath
      || canonicalHash(input.env) !== canonicalHash(expectedEnv)) {
      throw new Error("Preflight ProcessExecution input differs from frozen settings or run identity");
    }
    return;
  }
  if (input.nodeId === null || input.attemptId === null) throw new Error("node process identity is incomplete");
  const attempt = requireAttempt(run, input.nodeId, input.attemptId);
  const nodeSettings = format4Settings(run).nodes[input.nodeId];
  const site = input.role === "worker" ? nodeSettings?.run : nodeSettings?.validator;
  const command = site?.kind === "command" ? site.command : site?.kind === "agent" ? site.harnessCommand : null;
  const executionId = input.role === "worker" ? attempt.workerExecutionId : attempt.validatorExecutionId;
  const authorizedAttempt = input.role === "worker"
    ? attempt.status === "executing" && attempt.result.kind === "pending"
    : attempt.status === "validating" && (attempt.result.kind === "candidate_committed" || attempt.result.kind === "worker_failure_committed");
  const executionIncarnations = attempt.processIncarnations.filter((item) => item.executionId === input.executionId);
  const recordedIncarnationIndex = executionIncarnations.findIndex((item) => item.incarnationId === input.incarnationId);
  const hasReference = recordedIncarnationIndex >= 0;
  const expectedIncarnationNumber = hasReference ? recordedIncarnationIndex + 1 : executionIncarnations.length + 1;
  const expectedEnv = buildProcessExecutionEnvironment(input, run, attempt.number);
  const paths = processExecutionFiles(input, locateWorkflowDirectory(run), run.runId, attempt.number);
  const validDeadline = site !== undefined && site !== null
    && validProcessDeadline(input, site.timeoutMs);
  if (input.runId !== run.runId || input.workflowId !== run.workflowId
    || input.activationId !== run.activationId || input.occurrenceId !== run.occurrenceId
    || input.workflowTaskId !== run.durable.workflowTaskId || input.nodeTaskId !== attempt.taskId
    || executionId !== input.executionId || input.incarnationNumber !== expectedIncarnationNumber
    || (requireExecuting && !authorizedAttempt) || (requireReference && !hasReference)
    || site === undefined || site === null || command !== input.command
    || site.shell !== input.shell || site.cwd !== input.cwd || site.timeoutMs !== input.timeoutMs
    || site.streamCapBytes !== input.streamCapBytes || site.replay !== input.replay || !validDeadline
    || input.stdoutPath !== paths.stdoutPath
    || input.stderrPath !== paths.stderrPath
    || canonicalHash(input.env) !== canonicalHash(expectedEnv)) {
    throw new Error("ProcessExecution input differs from frozen settings or attempt identity");
  }
}

async function appendProcess(
  tx: Tx,
  conversationId: ConversationId,
  input: ProcessExecutionTaskInput,
  taskId: number,
  process: z.infer<typeof processIncarnationSchema>,
  recordedAt: string,
): Promise<void> {
  const checked = workshopProcessV1Schema.safeParse({
    version: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    taskId,
    recordedAt,
    process,
  });
  if (!checked.success) throw new Error(`process evidence failed validation: ${checked.error.message}`);
  await tx.appendEntry(WorkshopProcessEntry, conversationId, { data: checked.data });
}

function parseProcessInput(value: unknown): ProcessExecutionTaskInput {
  const parsed = processExecutionTaskInputSchema.safeParse(value);
  if (!parsed.success) throw new Error(`ProcessExecution input failed validation: ${parsed.error.message}`);
  return parsed.data;
}

function readyRun(value: unknown): ReadyRun {
  const parsed = workflowRunDocumentV1Schema.safeParse(value);
  if (!parsed.success) throw new Error(`canonical run document failed validation: ${parsed.error.message}`);
  if (parsed.data.state !== "ready") throw new Error("canonical run document is uninitialized");
  return parsed.data;
}

async function snapshotRun<I, S extends { phase: string }, R, H extends object>(
  runtime: TaskRuntime<I, S, R, H>,
  context: Context,
): Promise<ReadyRun> {
  return readyRun(await runtime.snapshot(WorkshopRunDoc, runtime.conversationId, context));
}

async function runDraft(tx: Tx, conversationId: ConversationId) {
  const draft = await tx.doc(WorkshopRunDoc, conversationId);
  return { draft, run: readyRun(draft) };
}

function assign(draft: object, value: unknown): void {
  Object.assign(draft, readyRun(value));
}

function blockInfo(
  kind: BlockInfo["kind"],
  reason: string,
  runId: string,
  nodeId: string | null,
  attemptId: string | null,
  blockedAt: string,
): BlockInfo {
  runIdSchema.parse(runId);
  return blockInfoSchema.parse({ blockId: randomUUID(), kind, reason, blockedAt, nodeId, attemptId });
}

function timestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error("task clock returned an invalid timestamp");
  return utcTimestampSchema.parse(new Date(ms).toISOString());
}

async function waitForExit(child: TrackedProcess, deadlineAt: string | null) {
  if (deadlineAt === null) return raceDeadline(child, null);
  const at = Date.parse(deadlineAt);
  if (!Number.isSafeInteger(at)) throw new Error("stored process deadline is invalid");
  while (true) {
    const left = at - Date.now();
    if (left <= 0) return { kind: "timeout" as const };
    const result = await raceDeadline(child, Math.min(left, MAX_TIMER_MS));
    if (result.kind === "exit") return result;
  }
}

function exitRecord(exit: { code: number | null; signal: NodeJS.Signals | null }) {
  if (exit.code !== null && exit.code >= 0) return processExitSchema.parse({ kind: "code", code: exit.code });
  if (exit.signal !== null) return processExitSchema.parse({ kind: "signal", signal: exit.signal });
  return null;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export type ProcessCaptureFiles = Pick<ProcessExecutionTaskInput, "stdoutPath" | "stderrPath" | "streamCapBytes">;

export interface CaptureProcessRecordsOptions {
  readonly bestEffort?: boolean;
  readonly hashFile?: (path: string) => Promise<string>;
}

/** Persist post-exit stream evidence; monitor and abort may call this concurrently. */
export async function captureProcessRecords(
  input: ProcessCaptureFiles,
  stats: ReturnType<TrackedProcess["captures"]>,
  options: CaptureProcessRecordsOptions = {},
) {
  const captures = [];
  const hashFile = options.hashFile ?? sha256File;
  for (const item of [
    { stream: "stdout" as const, path: input.stdoutPath, stats: stats.stdout },
    { stream: "stderr" as const, path: input.stderrPath, stats: stats.stderr },
  ]) {
    let retention: ReturnType<typeof retainStreamWindow> | undefined;
    let retentionFailed = false;
    let sha256: string | null = null;
    let retained: ReturnType<typeof retainedBytesRecord> | undefined;
    if (item.stats.error === null) {
      try { retention = item.stream === "stdout" ? stdoutWindow(item.path, item.stats.totalBytes) : retainStreamWindow(item.path, input.streamCapBytes); }
      catch (error) {
        if (!options.bestEffort) throw error;
        retentionFailed = true;
      }
      if (!retentionFailed) {
        try {
          sha256 = item.stream === "stdout" ? sha256Prefix(item.path) : await hashFile(item.path);
          retained = retainedBytesRecord(item.path, item.stream);
        } catch (error) {
          if (!options.bestEffort) throw error;
          sha256 = null;
        }
      }
    }
    const currentBytes = captureFileSize(item.path);
    const totalBytes = retention?.totalBytes ?? Math.max(item.stats.totalBytes, currentBytes);
    const retainedBytes = retention?.retainedBytes ?? Math.min(totalBytes, currentBytes);
    const truncatedBytes = totalBytes - retainedBytes;
    captures.push(processCaptureSchema.parse({
      stream: item.stream,
      path: item.path,
      totalBytes,
      retainedBytes,
      truncatedBytes,
      ...(retention === undefined ? {} : {
        keptHeadBytes: retention.keptHeadBytes,
        keptTailBytes: retention.keptTailBytes,
      }),
      sha256,
      ...(retained === undefined ? {} : { retained }),
      complete: item.stats.error === null && !retentionFailed && retention !== undefined
        && truncatedBytes === 0 && sha256 !== null,
    }));
  }
  return captures;
}

/** Recover readable diagnostics after confirmed death without claiming a checked exit or complete stream. */
export async function recoverProcessCaptureRecords(input: ProcessCaptureFiles) {
  const captures = [];
  for (const item of [
    { stream: "stdout" as const, path: input.stdoutPath },
    { stream: "stderr" as const, path: input.stderrPath },
  ]) {
    if (!existsSync(item.path)) continue;
    try {
      const retention = item.stream === "stdout" ? stdoutWindow(item.path, captureFileSize(item.path)) : retainStreamWindow(item.path, input.streamCapBytes);
      const sha256 = item.stream === "stdout" ? sha256Prefix(item.path) : await sha256File(item.path);
      captures.push(processCaptureSchema.parse({
        stream: item.stream,
        path: item.path,
        ...retention,
        sha256,
        retained: retainedBytesRecord(item.path, item.stream),
        complete: false,
      }));
    } catch {
      // Keep the process blocked, but omit bytes whose retention receipt cannot be reconciled.
    }
  }
  return captures;
}

/** Recover only captures whose retained file still matches its durable receipt. */
export async function recoverRetainedProcessCaptureRecords(input: ProcessCaptureFiles) {
  const captures: z.infer<typeof processCaptureSchema>[] = [];
  for (const item of [
    { stream: "stdout" as const, path: input.stdoutPath },
    { stream: "stderr" as const, path: input.stderrPath },
  ]) {
    const retained = readVerifiedRetentionWindow(item.path, input.streamCapBytes);
    if (retained === null) continue;
    const { retainedSha256, ...window } = retained;
    captures.push(processCaptureSchema.parse({
      stream: item.stream,
      path: item.path,
      ...window,
      sha256: retainedSha256,
      retained: retainedBytesRecord(item.path, item.stream),
      complete: false,
    }));
  }
  return captures;
}

function captureFileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function stdoutPrefix(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min(captureFileSize(path), MAX_SEMANTIC_OUTPUT_BYTES));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("stdout changed during durable import");
      offset += read;
    }
    return bytes;
  } finally { closeSync(fd); }
}

function stdoutWindow(path: string, observedBytes: number) {
  const retainedBytes = Math.min(captureFileSize(path), MAX_SEMANTIC_OUTPUT_BYTES);
  const totalBytes = Math.max(observedBytes, captureFileSize(path));
  return { totalBytes, retainedBytes, truncatedBytes: totalBytes - retainedBytes, keptHeadBytes: retainedBytes, keptTailBytes: 0 };
}

function sha256Prefix(path: string): string { return sha256(stdoutPrefix(path)); }

function retainedBytesRecord(path: string, stream: "stdout" | "stderr") {
  const bytes = stream === "stdout" ? stdoutPrefix(path) : readFileSync(path);
  return { version: 1 as const, encoding: "base64" as const, bytes: bytes.toString("base64") };
}
