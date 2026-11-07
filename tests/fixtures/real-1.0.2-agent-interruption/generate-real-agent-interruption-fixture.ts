import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { ExecutionError, err, ok, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineAgentExecutionTask, type AgentExecutionTaskInput } from "../../../src/storage/durable/define-agent-execution-task.js";
import { openDurableStorage } from "../../../src/storage/durable/open-durable-storage.js";

const model = { provider: "fixture", modelId: "legacy-agent" };
const executionId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const firstCommand = "workshop-migration-first-unsafe-effect";
const secondCommand = "workshop-migration-second-unsafe-effect";
const outputDirectory = fileURLToPath(new URL("./", import.meta.url));

class InterruptedEffectEnv extends NodeExecutionEnv {
  readonly firstEffectStarted: Promise<void>;
  #start!: () => void;

  constructor(cwd: string, private readonly effects: string) {
    super({ cwd });
    this.firstEffectStarted = new Promise(resolve => { this.#start = resolve; });
  }

  override async exec(commandText: string, options: ShellExecOptions | undefined, context: Context) {
    if (commandText !== firstCommand && commandText !== secondCommand) throw new Error("unexpected fixture shell command: " + commandText);
    const label = commandText === firstCommand ? "first" : "second";
    appendFileSync(this.effects, label + String.fromCharCode(10));
    this.#start();
    if (commandText === firstCommand) {
      await waitForAbort(context.abortSignal);
      return err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "simulated first tool cancelled"));
    }
    return ok<ShellExecResult, ExecutionError>({ exitCode: 0 });
  }
}

const directory = mkdtempSync(join(tmpdir(), "workshop-real-agent-interruption-"));
const databasePath = join(directory, "durable.db");
const effectsPath = join(directory, "effects.txt");
const env = new InterruptedEffectEnv(directory, effectsPath);
let harness: HarnessType | undefined;
try {
  const storage = await openDurableStorage(databasePath);
  if (!storage.ok) throw new Error(storage.failure.message);
  const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  faux.setResponses([() => fauxAssistantMessage([
    fauxToolCall("bash", { command: firstCommand }, { id: "migration-first-call" }),
    fauxToolCall("bash", { command: secondCommand }, { id: "migration-second-call" }),
  ], { stopReason: "toolUse" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  let activeHarness: HarnessType;
  const { task, guard } = defineAgentExecutionTask({ getHarness: () => activeHarness });
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(guard.extension);
  registry.install(defineExtension({ name: "workshop-agent-execution-task", tasks: [task] }));
  activeHarness = await Harness.open(storage.storage, { models, registry, env: () => env }, BACKGROUND_CONTEXT);
  harness = activeHarness;

  const owner = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const input: AgentExecutionTaskInput = {
    executionId,
    role: "worker",
    model: { ...model, thinkingLevel: "off" },
    cwd: "/fixture/workspace",
    shellPath: null,
    promptText: "Use both tools.",
    env: {},
    startedAt: Date.now(),
    deadlineAt: null,
  };
  await harness.commit(tx => tx.createTask(task, input, {
    ownership: { kind: "conversation" },
    conversationId: owner.id,
  }), BACKGROUND_CONTEXT);
  harness.resume();
  await within(env.firstEffectStarted, 5_000);
  await waitForInterruptedSiblings(harness);
  if (readFileSync(effectsPath, "utf8") !== "first" + String.fromCharCode(10)) throw new Error("capture did not stop after the first effect");

  await within(harness.close(BACKGROUND_CONTEXT), 5_000);
  harness = undefined;
  copyFileSync(databasePath, join(outputDirectory, "durable.db"));
  copyFileSync(effectsPath, join(outputDirectory, "effects.txt"));
  console.log("Wrote the legacy database and first-effect fixture.");
} finally {
  if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
  rmSync(directory, { recursive: true, force: true });
}

async function waitForInterruptedSiblings(harness: HarnessType): Promise<void> {
  await waitForCondition(async () => {
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const tools = inspection.tasks.filter(item => item.record.kind === "pi.tool");
    const phases = tools.map(item => checkpointPhase(item.record));
    return tools.length === 2
      && phases.includes("execute")
      && tools.some(item => item.state.kind === "running" && checkpointPhase(item.record) === "call");
  }, 5_000);
}

async function waitForCondition(check: () => Promise<boolean>, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the sibling tool checkpoint");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function checkpointPhase(record: { readonly state: unknown }): string | undefined {
  const state = record.state as { readonly checkpoint?: { readonly phase?: unknown } };
  return typeof state.checkpoint?.phase === "string" ? state.checkpoint.phase : undefined;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) throw new Error("expected an abort signal");
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("capture timed out")), milliseconds); }),
  ]).finally(() => clearTimeout(timer!));
}
