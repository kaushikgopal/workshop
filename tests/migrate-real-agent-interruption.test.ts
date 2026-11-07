import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  Harness,
  ToolResultEntry,
  type ConversationId,
  type Harness as HarnessType,
  type TaskId,
} from "@earendil-works/pi-durable";
import { ExecutionError, ok, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, test } from "bun:test";
import { defineAgentExecutionTask, type AgentExecutionTaskResult } from "../src/storage/durable/define-agent-execution-task.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/real-1.0.2-agent-interruption/", import.meta.url));
const firstCommand = "workshop-migration-first-unsafe-effect";
const secondCommand = "workshop-migration-second-unsafe-effect";
const model = { provider: "fixture", modelId: "legacy-agent" };

class RecoveryEffectEnv extends NodeExecutionEnv {
  constructor(cwd: string, private readonly effects: string) {
    super({ cwd });
  }

  override async exec(commandText: string, _options: ShellExecOptions | undefined) {
    if (commandText === firstCommand || commandText === secondCommand) {
      const label = commandText === firstCommand ? "first" : "second";
      appendFileSync(this.effects, label + "\n");
      return ok<ShellExecResult, ExecutionError>({ exitCode: 0 });
    }
    throw new Error("unexpected tool replay: " + commandText);
  }
}

test("migrates real 1.0.2 interrupted unsafe tool evidence without replaying its sibling", async () => {
  // Captured with pi-durable@1.0.2 and Workshop definitions at 70ba393 using two faux bash tool calls.
  // The old harness closed after the first effect and while the later sibling waited on it.
  const directory = mkdtempSync(join(tmpdir(), "workshop-real-migration-"));
  const databasePath = join(directory, "durable.db");
  const effectsPath = join(directory, "effects.txt");
  let harness: HarnessType | undefined;
  try {
    copyFileSync(join(fixtureDirectory, "durable.db"), databasePath);
    copyFileSync(join(fixtureDirectory, "effects.txt"), effectsPath);
    expect(readFileSync(effectsPath, "utf8")).toBe("first\n");

    const legacyDatabase = await openNodeSqliteDatabase(databasePath);
    try {
      expect(await legacyDatabase.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({ version: 1 });
    } finally {
      await legacyDatabase.close();
    }

    const opened = await openDurableStorage(databasePath);
    if (!opened.ok) throw new Error(opened.failure.message + ": " + String(opened.failure.cause));
    const migratedDatabase = await openNodeSqliteDatabase(databasePath);
    try {
      expect(await migratedDatabase.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))
        .toEqual({ version: CURRENT_SQLITE_SCHEMA_VERSION });
    } finally {
      await migratedDatabase.close();
    }
    const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
    let recoveryRequests = 0;
    faux.setResponses([() => {
      recoveryRequests += 1;
      return fauxAssistantMessage("must not request a new model response after an interrupted unsafe tool");
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    let activeHarness: HarnessType;
    const { task, guard } = defineAgentExecutionTask({ getHarness: () => activeHarness });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(guard.extension);
    registry.install(defineExtension({ name: "workshop-agent-execution-task", tasks: [task] }));
    activeHarness = await Harness.open(opened.storage, {
      models,
      registry,
      env: () => new RecoveryEffectEnv(directory, effectsPath),
    }, BACKGROUND_CONTEXT);
    harness = activeHarness;

    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const execution = inspection.tasks.find(item => item.record.kind === "workshop.agent-execution");
    expect(execution).toBeDefined();
    if (execution === undefined) throw new Error("migrated Workshop agent task is missing");
    const executionId = execution.record.id as TaskId<AgentExecutionTaskResult>;
    expect((execution.record.input as { cwd?: string }).cwd).toBe("/fixture/workspace");
    const checkpoint = (execution.record.state as { checkpoint?: { conversationId?: number } }).checkpoint;
    const conversationId = checkpoint?.conversationId;
    expect(conversationId).toBe(9);
    if (conversationId === undefined) throw new Error("migrated agent conversation identity is missing");

    const toolTasks = inspection.tasks.filter(item => item.record.kind === "pi.tool");
    expect(toolTasks).toHaveLength(2);
    const firstTool = toolTasks.find(item => JSON.stringify(item.record).includes("migration-first-call"));
    const siblingTool = toolTasks.find(item => JSON.stringify(item.record).includes("migration-second-call"));
    expect(firstTool).toBeDefined();
    expect(siblingTool).toBeDefined();
    if (firstTool === undefined || siblingTool === undefined) throw new Error("migrated unsafe tool records are incomplete");
    expect(firstTool.record.state).toMatchObject({
      checkpoint: { phase: "execute", arguments: { command: firstCommand }, replay: "unsafe" },
    });
    expect(siblingTool.record.state).toMatchObject({ checkpoint: { phase: "call" } });
    const firstToolId = Number(firstTool.record.id);
    const siblingToolId = Number(siblingTool.record.id);

    const agentConversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (agentConversation === undefined) throw new Error("migrated agent conversation is missing");
    const beforeResume = await agentConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(beforeResume.items)).toContain("migration-first-call");
    expect(JSON.stringify(beforeResume.items)).toContain("migration-second-call");
    expect(beforeResume.items.some(entry => ToolResultEntry.is(entry))).toBe(false);

    harness.resume();
    const settled = await harness.waitForTask(executionId, BACKGROUND_CONTEXT);
    expect(settled.state.status).toBe("terminal");
    if (settled.state.status !== "terminal" || settled.state.outcome.status !== "completed") {
      throw new Error("migrated unsafe-tool task did not settle with its recorded block");
    }
    expect(settled.state.outcome.result).toMatchObject({ kind: "blocked", reason: "unsafe_tool_interrupted" });
    if (settled.state.outcome.result.kind !== "blocked") throw new Error("migrated unsafe-tool task did not block");
    expect(settled.state.outcome.result.toolTaskIds).toContain(firstToolId);
    expect(recoveryRequests).toBe(0);
    expect(readFileSync(effectsPath, "utf8")).toBe("first\n");
    const afterRecovery = await agentConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const firstToolReceipt = await harness.waitForTask(firstToolId as TaskId, BACKGROUND_CONTEXT);
    const siblingToolReceipt = await harness.waitForTask(siblingToolId as TaskId, BACKGROUND_CONTEXT);
    expect(firstToolReceipt.state.status).toBe("terminal");
    expect(firstToolReceipt.state.outcome.status).toBe("failed");
    expect(siblingToolReceipt.state.status).toBe("terminal");
    expect(siblingToolReceipt.state.outcome.status).toBe("completed");
    if (firstToolReceipt.state.status !== "terminal" || firstToolReceipt.state.outcome.status !== "failed") {
      throw new Error("interrupted unsafe tool did not retain its failed terminal receipt");
    }
    if (siblingToolReceipt.state.status !== "terminal" || siblingToolReceipt.state.outcome.status !== "completed") {
      throw new Error("later sibling tool did not retain its blocked terminal receipt");
    }
    const firstResult = firstToolReceipt.state.outcome.result as { entryId: number };
    const siblingResult = siblingToolReceipt.state.outcome.result as { entryId: number };
    const toolResults = afterRecovery.items.filter(ToolResultEntry.is);
    const resultsForCall = (callId: string) => toolResults.filter(entry => {
      const message = entry.model?.[0];
      return message?.role === "toolResult" && message.toolCallId === callId;
    });
    const firstResults = resultsForCall("migration-first-call");
    const siblingResults = resultsForCall("migration-second-call");
    expect(toolResults).toHaveLength(2);
    expect(firstResults).toHaveLength(1);
    expect(siblingResults).toHaveLength(1);
    const firstResultEntry = firstResults[0];
    const siblingResultEntry = siblingResults[0];
    if (firstResultEntry === undefined || siblingResultEntry === undefined) {
      throw new Error("migrated tool terminal receipt entry is missing");
    }
    expect(firstResult.entryId).toBe(Number(firstResultEntry.id));
    expect(siblingResult.entryId).toBe(Number(siblingResultEntry.id));
    expect(firstResultEntry.data.diagnostics.map(item => item.code)).toContain("interrupted");
    expect(siblingResultEntry.data.diagnostics.map(item => item.code)).toContain("blocked");
  } finally {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
});
