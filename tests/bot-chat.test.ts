import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { loadCheckedWorkflow, loadInstallation } from "../src/installation/load-installation.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../src/storage/durable/define-workshop-records.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { botChatViewV1Schema } from "../src/bot/schema.js";
import { buildBotChatEntries } from "../src/bot/build-bot-feed.js";
import { nodeDescriptionDtoSchema, statusDtoSchema } from "../src/views/schema.js";
import { TALLY_BASE_URL_BY_API } from "../src/model/schema-owner-models.js";
import { createBotExtension } from "../src/bot/create-bot-tools.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { createFauxModels } from "./fixtures/create-faux-models.js";

const oldBotChatEntryV1Schema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant", "activity"]),
  text: z.string(),
});

test("bot chat feed keeps the V1 mapping by default and labels entries only on opt-in", () => {
  const messages: Message[] = [
    { role: "user", content: "Terminal output: this is quoted input.", timestamp: 1 },
    { role: "user", content: "Error: this is also human input.", timestamp: 2 },
    fauxAssistantMessage("Terminal output: this is bot prose."),
    fauxAssistantMessage([fauxText("I will inspect the run."), fauxToolCall("workshop_run", { workflowId: "demo" })], { stopReason: "toolUse" }),
    {
      role: "toolResult", toolCallId: "call-1", toolName: "workshop_run",
      content: [{ type: "text", text: "{\"status\":\"completed\"}" }], isError: false, timestamp: 3,
    },
    {
      role: "toolResult", toolCallId: "call-2", toolName: "workshop_logs",
      content: [{ type: "text", text: "permission denied." }], isError: true, timestamp: 4,
    },
    {
      role: "toolResult", toolCallId: "call-3", toolName: "workshop_logs",
      content: [{ type: "text", text: "Error: this is successful tool output." }], isError: false, timestamp: 5,
    },
    { role: "toolResult", toolCallId: "call-4", toolName: "workshop_status", content: [], isError: false, timestamp: 6 },
  ];
  const record = {
    id: 17 as EntryRecord["id"], conversationId: 5 as EntryRecord["conversationId"], kind: "message", model: messages,
  };
  const legacyFeed = buildBotChatEntries([record]);

  expect(legacyFeed).toEqual([
    { id: "17:0", role: "user", text: "Terminal output: this is quoted input." },
    { id: "17:1", role: "user", text: "Error: this is also human input." },
    { id: "17:2", role: "assistant", text: "Terminal output: this is bot prose." },
    { id: "17:3", role: "assistant", text: "I will inspect the run.\nUsed workshop_run" },
    { id: "17:4", role: "activity", text: "Completed workshop_run" },
    { id: "17:5", role: "activity", text: "Completed workshop_logs" },
    { id: "17:6", role: "activity", text: "Completed workshop_logs" },
    { id: "17:7", role: "activity", text: "Completed workshop_status" },
  ]);
  for (const entry of legacyFeed) expect(oldBotChatEntryV1Schema.parse(entry)).toEqual(entry);

  const feed = buildBotChatEntries([record], true);
  expect(feed).toEqual([
    { id: "17:0", role: "user", kind: "input", text: "Terminal output: this is quoted input." },
    { id: "17:1", role: "user", kind: "input", text: "Error: this is also human input." },
    { id: "17:2", role: "assistant", kind: "message", text: "Terminal output: this is bot prose." },
    { id: "17:3", role: "assistant", kind: "tool_call", text: "I will inspect the run.\nUsed workshop_run" },
    { id: "17:4", role: "activity", kind: "tool_result", text: "workshop_run\n{\"status\":\"completed\"}" },
    { id: "17:5", role: "activity", kind: "error", text: "workshop_logs\npermission denied." },
    { id: "17:6", role: "activity", kind: "tool_result", text: "workshop_logs\nError: this is successful tool output." },
    { id: "17:7", role: "activity", kind: "tool_result", text: "workshop_status" },
  ]);
  expect(oldBotChatEntryV1Schema.safeParse(feed[0]).success).toBe(false);
});

test("bot chat feed preserves IDs, order, and the 100-entry cap in either mapping", () => {
  const record: EntryRecord = {
    id: 19 as EntryRecord["id"], conversationId: 5 as EntryRecord["conversationId"], kind: "message",
    model: Array.from({ length: 120 }, (_, index): Message => ({ role: "user", content: "message-" + index, timestamp: index })),
  };
  const legacyFeed = buildBotChatEntries([record]);
  const enrichedFeed = buildBotChatEntries([record], true);

  expect(legacyFeed).toHaveLength(100);
  expect(enrichedFeed).toHaveLength(100);
  expect(legacyFeed.map(entry => entry.id)).toEqual(Array.from({ length: 100 }, (_, index) => "19:" + (index + 20)));
  expect(enrichedFeed.map(entry => entry.id)).toEqual(legacyFeed.map(entry => entry.id));
  expect(legacyFeed[0]).toEqual({ id: "19:20", role: "user", text: "message-20" });
});

test("bot chat feed bounds tool result previews without splitting UTF-8", () => {
  const feed = buildBotChatEntries([{
    id: 18 as EntryRecord["id"], conversationId: 5 as EntryRecord["conversationId"], kind: "message",
    model: [{
      role: "toolResult", toolCallId: "call-long", toolName: "workshop_logs",
      content: [{ type: "text", text: "🧩".repeat(6000) }], isError: false, timestamp: 1,
    }],
  }], true);
  const entry = feed[0];
  if (entry === undefined) throw new Error("tool result feed entry is missing");
  expect(entry.kind).toBe("tool_result");
  expect(entry.text).toContain("[truncated: tool result preview reached 16 KiB]");
  expect(entry.text).not.toContain("�");
  expect(Buffer.byteLength(entry.text, "utf8")).toBeLessThanOrEqual(16 * 1024 + Buffer.byteLength("workshop_logs\n", "utf8"));
});

test("configured shared bot completes a chat round trip with a fake model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-chat-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), "bot:\n  model: fixture/fake:medium\n", "utf8");
  const installation = loadInstallation(directory);
  const { models } = createFauxModels([fauxAssistantMessage("The fake bot is ready.")], { modelIds: ["fake"] });
  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    owner = await startWorkshopService(installation, models);
    const socketPath = owner.metadata.socketPath;
    if (socketPath === null) throw new Error("service socket path is missing");
    const submission = await sendServiceRequest(socketPath, { version: 1, method: "chat.submit", requestId: "chat-round-trip", text: "Hello, bot." });
    expect(submission.ok).toBe(true);
    const deadline = Date.now() + 5000;
    let view = botChatViewV1Schema.parse({ configured: false, entries: [], nextCursor: null, pending: [] });
    while (Date.now() < deadline) {
      const response = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 20 });
      if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
      view = botChatViewV1Schema.parse(response.result);
      if (view.entries.some(entry => entry.role === "assistant" && entry.text.includes("The fake bot is ready."))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(view.configured).toBe(true);
    expect(view.entries.every(entry => !("kind" in entry))).toBe(true);
    for (const entry of view.entries) expect(oldBotChatEntryV1Schema.parse(entry)).toEqual(entry);
    expect(view.entries.some(entry => entry.role === "user" && entry.text === "Hello, bot.")).toBe(true);
    expect(view.entries.some(entry => entry.role === "assistant" && entry.text === "The fake bot is ready.")).toBe(true);
  } finally {
    await owner?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});


test("loads an owner model without cost for the bot and reports its identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-owner-models-"));
  const workshopDirectory = join(directory, ".workshop");
  const agentDirectory = join(directory, "pi-agent");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), "bot:\n  model: bot-gateway/custom-bot:medium\n", "utf8");
  writeFileSync(join(agentDirectory, "models.json"), JSON.stringify({ providers: {
    "bot-gateway": {
      api: "openai-completions",
      baseUrl: TALLY_BASE_URL_BY_API["openai-completions"],
      models: [{
        id: "custom-bot", name: "Custom bot fixture", contextWindow: 32_000, maxTokens: 4_000,
        input: ["text"], reasoning: false,
      }],
    },
  } }), "utf8");
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  const installation = loadInstallation(directory);
  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    owner = await startWorkshopService(installation);
    const socketPath = owner.metadata.socketPath;
    if (socketPath === null) throw new Error("service socket path is missing");
    const status = await sendServiceRequest(socketPath, { version: 1, method: "status" });
    const chat = await sendServiceRequest(socketPath, { version: 1, method: "chat.view" });
    expect(status.ok).toBe(true);
    expect(chat.ok).toBe(true);
    if (!status.ok || !chat.ok) throw new Error("service status or chat view failed");
    expect(statusDtoSchema.parse(status.result).service.bot).toEqual({ providerId: "bot-gateway", modelId: "custom-bot" });
    expect(botChatViewV1Schema.parse(chat.result)).toMatchObject({
      configured: true,
      bot: { providerId: "bot-gateway", modelId: "custom-bot" },
    });
    expect(JSON.stringify([status.result, chat.result])).not.toContain("apiKey");
  } finally {
    await owner?.shutdown();
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a bot model missing from its registered provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-unknown-model-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), "bot:\n  model: fixture/missing:medium\n", "utf8");
  const installation = loadInstallation(directory);
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "fixture", models: [{ id: "known" }] }).provider);
  try {
    await expect(startWorkshopService(installation, models)).rejects.toThrow(
      'bot.model "fixture/missing:medium" is not available from provider "fixture"',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a bot model whose provider is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-unknown-provider-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), "bot:\n  model: missing/fake:medium\n", "utf8");
  const installation = loadInstallation(directory);
  try {
    await expect(startWorkshopService(installation, createModels())).rejects.toThrow(
      'bot.model provider "missing" is not available in the model registry',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bot tools expose only the restricted Workshop authority", () => {
  const extension = createBotExtension({
    readStatus: async () => ({}), readRun: async () => ({}), readLogs: async () => "",
    startWorkflow: async () => ({}), resolveBlock: async () => ({}),
  });
  expect((extension.tools ?? []).map(tool => tool.name)).toEqual([
    "workshop_status", "workshop_run", "workshop_logs", "workshop_start", "workshop_resolve",
  ]);
  const resolution = (extension.tools ?? []).find(tool => tool.name === "workshop_resolve");
  if (resolution === undefined) throw new Error("bot resolve tool is missing");
  const schema = resolution.parameters as { properties?: { action?: { anyOf?: Array<{ const: string }> } } };
  expect(schema.properties?.action?.anyOf?.map(option => option.const)).toEqual(["retry", "fail"]);
});


test("machine bot model is required explicitly and replaces orchestrator configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-config-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  try {
    writeFileSync(join(workshopDirectory, "workshop.yaml"), "bot:\n  model: fixture/fake:medium\n", "utf8");
    expect(loadInstallation(directory).machine.bot?.model).toBe("fixture/fake:medium");
    writeFileSync(join(workshopDirectory, "workshop.yaml"), "orchestrator:\n  model: fixture/fake:medium\n", "utf8");
    expect(() => loadInstallation(directory)).toThrow("machine orchestrator is removed; configure bot.model instead");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("chat stays model-free when bot.model is absent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-disabled-"));
  mkdirSync(join(directory, ".workshop", "workflows"), { recursive: true });
  const installation = loadInstallation(directory);
  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    owner = await startWorkshopService(installation, createModels());
    const socketPath = owner.metadata.socketPath;
    if (socketPath === null) throw new Error("service socket path is missing");
    const view = await sendServiceRequest(socketPath, { version: 1, method: "chat.view" });
    expect(view.ok && botChatViewV1Schema.parse(view.result).configured).toBe(false);
    const submission = await sendServiceRequest(socketPath, { version: 1, method: "chat.submit", requestId: "disabled-chat", text: "Hello." });
    expect(submission).toMatchObject({ ok: false, error: { code: "bot_not_configured" } });
  } finally {
    await owner?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});


test("bot read tools include retained captures and the completed run result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-read-tools-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), [
    "shell: /bin/sh",
    "keep_files: always",
    "bot:",
    "  model: fixture/fake:medium",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(workshopDirectory, "workflows", "capture.yaml"), [
    "version: 4",
    "defaults:",
    "  retries: 0",
    "  replay: never",
    "steps:",
    "  - capture:",
    "      run: \"printf 'bot-known-stdout-marker'; printf 'bot-known-stderr-marker' >&2; i=0; while [ $i -lt 20000 ]; do printf x >&2; i=$((i+1)); done\"",
    "",
  ].join("\n"), "utf8");

  const installation = loadInstallation(directory);
  const { models, faux } = createFauxModels([], { modelIds: ["fake"] });
  const toolOutputs: string[] = [];
  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    owner = await startWorkshopService(installation, models);
    const socketPath = owner.metadata.socketPath;
    if (socketPath === null) throw new Error("service socket path is missing");
    const started = await sendServiceRequest(socketPath, { version: 1, method: "start", requestId: "bot-read-start", workflowId: "capture" });
    if (!started.ok) throw new Error(started.error.code + ": " + started.error.message);
    const runId = serviceStartResultV1Schema.parse(started.result).runId;

    const runDeadline = Date.now() + 10_000;
    let completed = false;
    while (Date.now() < runDeadline) {
      const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "capture", limit: 1 });
      if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
      const page = serviceRunsPageV1Schema.parse(response.result);
      completed = page.runs.some(run => run.runId === runId && run.status === "completed");
      if (completed) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(completed).toBe(true);

    const collectToolResult = (context: Parameters<FauxResponseFactory>[0]) => {
      const result = [...context.messages].reverse().find(message => message.role === "toolResult");
      if (result?.role === "toolResult") {
        toolOutputs.push(result.content.flatMap(block => block.type === "text" ? [block.text] : []).join(""));
      }
      return fauxAssistantMessage("read complete");
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("workshop_logs", { workflowId: "capture", runId }), { stopReason: "toolUse" }),
      collectToolResult,
      fauxAssistantMessage(fauxToolCall("workshop_run", { workflowId: "capture", runId }), { stopReason: "toolUse" }),
      collectToolResult,
    ]);

    const submitAndWait = async (requestId: string, expectedReplies: number) => {
      const submitted = await sendServiceRequest(socketPath, { version: 1, method: "chat.submit", requestId, text: "Read this run." });
      if (!submitted.ok) throw new Error(submitted.error.code + ": " + submitted.error.message);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const response = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 100, includeKinds: true });
        if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
        const view = botChatViewV1Schema.parse(response.result);
        if (view.entries.filter(entry => entry.role === "assistant" && entry.text === "read complete").length >= expectedReplies) return view;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("bot did not complete its read tool call");
    };

    const logsView = await submitAndWait("bot-read-logs", 1);
    const logsToolResult = logsView.entries.find(entry => entry.kind === "tool_result" && entry.text.startsWith("workshop_logs\n"));
    if (logsToolResult === undefined) throw new Error("bot logs tool result is missing from the chat feed");
    expect(logsToolResult.text).toContain("bot-known-stdout-marker");
    expect(toolOutputs[0]).toContain("bot-known-stdout-marker");
    expect(toolOutputs[0]).toContain("capture worker stdout");
    expect(toolOutputs[0]).toContain("[truncated: Workshop bot log output");
    expect(Buffer.byteLength(toolOutputs[0] ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect((toolOutputs[0] ?? "").split("\n").length).toBeLessThanOrEqual(100);

    const runView = await submitAndWait("bot-read-run", 2);
    const runToolResult = runView.entries.find(entry => entry.kind === "tool_result" && entry.text.startsWith("workshop_run\n"));
    if (runToolResult === undefined) throw new Error("bot run tool result is missing from the chat feed");
    expect(runToolResult.text).toContain('"status":"completed"');
    expect(toolOutputs[1]).toContain('"status":"completed"');
    expect(toolOutputs[1]).toContain('"terminalOutput":"bot-known-stdout-marker"');

    const legacyResponse = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 100 });
    if (!legacyResponse.ok) throw new Error(legacyResponse.error.code + ": " + legacyResponse.error.message);
    const legacyView = botChatViewV1Schema.parse(legacyResponse.result);
    expect(legacyView.entries.length).toBeLessThanOrEqual(100);
    expect(legacyView.nextCursor).toBe(runView.nextCursor);
    expect(legacyView.entries.map(entry => entry.id)).toEqual(runView.entries.map(entry => entry.id));
    expect(legacyView.entries.map(entry => entry.role)).toEqual(runView.entries.map(entry => entry.role));
    expect(legacyView.entries.every(entry => !("kind" in entry))).toBe(true);
    for (const entry of legacyView.entries) expect(oldBotChatEntryV1Schema.parse(entry)).toEqual(entry);
    const legacyToolResult = legacyView.entries.find(entry => entry.id === runToolResult.id);
    expect(legacyToolResult).toEqual({ id: runToolResult.id, role: "activity", text: "Completed workshop_run" });
  } finally {
    await owner?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);


test("runs and the bot run tool read a retried agent result beside a v2 archive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-retried-run-read-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), [
    "shell: /bin/sh",
    "bot:",
    "  model: fixture/fake:medium",
    "agent:",
    "  model: fixture/worker:medium",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(workshopDirectory, "workflows", "retry-read.yaml"), [
    "version: 4",
    "defaults: { retries: 1, replay: safe }",
    "steps:",
    "  - generate:",
    "      result: tagged",
    "      agent: Generate a candidate.",
    "      verify:",
    "        agent:",
    "          model: fixture/verifier:medium",
    "          instructions: Check the candidate.",
    "",
  ].join("\n"), "utf8");

  const installation = loadInstallation(directory);
  await seedHistoricalV2Run(installation, "retry-read");
  const failedWorkerText = "invalid worker result";
  const verifierRetryText = "retry\nEmit a tagged result. The worker output was malformed.";
  const successfulWorkerText = "<status>succeeded</status>\n<reason>Valid result.</reason>\n<output>accepted candidate</output>";
  const verifierAcceptText = "accept\nThe candidate is valid.";
  const { models, faux } = createFauxModels([
    fauxAssistantMessage(failedWorkerText),
    fauxAssistantMessage(verifierRetryText),
    fauxAssistantMessage(successfulWorkerText),
    fauxAssistantMessage(verifierAcceptText),
  ], { modelIds: ["fake", "worker", "verifier"] });
  let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
  try {
    owner = await startWorkshopService(installation, models);
    const socketPath = owner.metadata.socketPath;
    if (socketPath === null) throw new Error("service socket path is missing");
    const started = await sendServiceRequest(socketPath, {
      version: 1, method: "start", requestId: "retried-result-start", workflowId: "retry-read",
    });
    if (!started.ok) throw new Error(started.error.code + ": " + started.error.message);
    const runId = serviceStartResultV1Schema.parse(started.result).runId;

    const deadline = Date.now() + 15_000;
    let page: ReturnType<typeof serviceRunsPageV1Schema.parse> | undefined;
    while (Date.now() < deadline) {
      const response = await sendServiceRequest(socketPath, { version: 1, method: "runs", workflowId: "retry-read", limit: 10 });
      if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
      page = serviceRunsPageV1Schema.parse(response.result);
      if (page.runs.some((run) => run.runId === runId && run.status === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(page?.runs.some((run) => run.runId === "historical-v2-run")).toBe(true);
    expect(page?.runs.find((run) => run.runId === runId)?.terminalOutput).toBe("accepted candidate");
    expect(page?.total).toBe(2);

    const descriptionResponse = await sendServiceRequest(socketPath, {
      version: 1, method: "node.describe", workflowId: "retry-read", runId, nodeId: "generate",
    });
    if (!descriptionResponse.ok) throw new Error(descriptionResponse.error.code + ": " + descriptionResponse.error.message);
    const description = nodeDescriptionDtoSchema.parse(descriptionResponse.result);
    expect(description.node.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(description.node.attempts[0]?.failure?.kind).toBe("result_invalid");
    expect(description.node.attempts.map(attempt => attempt.processes)).toEqual([[], []]);
    const attempts = description.node.attempts;
    const nativeExecution = (evidence: typeof attempts[number]["candidate"] | undefined) =>
      evidence?.kind === "candidate" || evidence?.kind === "verdict" ? evidence.nativeExecution : undefined;
    const nativeExecutions = [
      attempts[0]?.failure?.nativeExecution,
      nativeExecution(attempts[0]?.verdict),
      nativeExecution(attempts[1]?.candidate),
      nativeExecution(attempts[1]?.verdict),
    ];
    const expectedFinalTexts = [failedWorkerText, verifierRetryText, successfulWorkerText, verifierAcceptText];
    expect(nativeExecutions.map((execution) => execution?.finalText)).toEqual(expectedFinalTexts);
    for (const [index, finalText] of expectedFinalTexts.entries()) {
      expect(nativeExecutions[index]?.finalTextSha256).toBe(
        "sha256:" + createHash("sha256").update(finalText).digest("hex"),
      );
    }
    const evidence = JSON.stringify(attempts);
    expect(evidence).toContain("finalTextSha256");
    expect(evidence).toContain("conversationId");
    expect(evidence).toContain("assistantEntryId");

    const toolOutputs: string[] = [];
    const collectToolResult = (context: Parameters<FauxResponseFactory>[0]) => {
      const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
      if (result?.role === "toolResult") {
        toolOutputs.push(result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""));
      }
      return fauxAssistantMessage("read complete");
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("workshop_run", { workflowId: "retry-read", runId }), { stopReason: "toolUse" }),
      collectToolResult,
    ]);
    const submitted = await sendServiceRequest(socketPath, { version: 1, method: "chat.submit", requestId: "read-retried-run", text: "Read this run." });
    if (!submitted.ok) throw new Error(submitted.error.code + ": " + submitted.error.message);
    const chatDeadline = Date.now() + 10_000;
    while (Date.now() < chatDeadline) {
      const response = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 100 });
      if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
      const view = botChatViewV1Schema.parse(response.result);
      if (view.entries.some((entry) => entry.role === "assistant" && entry.text === "read complete")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(toolOutputs[0]).toContain('"status":"completed"');
    expect(toolOutputs[0]).toContain('"terminalOutput":"accepted candidate"');
  } finally {
    await owner?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

async function seedHistoricalV2Run(installation: ReturnType<typeof loadInstallation>, workflowId: string): Promise<void> {
  const opened = await openDurableStorage(installation.databasePath);
  if (!opened.ok) throw new Error(opened.failure.message + ": " + String(opened.failure.cause));
  const harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const checked = loadCheckedWorkflow(installation, workflowId);
  const activationId = randomUUID();
  const occurrenceId = randomUUID();
  const admittedAt = new Date(Date.now() - 60_000).toISOString();
  const finishedAt = new Date(Date.now() - 30_000).toISOString();
  try {
    await harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const conversationId = Number(conversation.id);
      Object.assign(await tx.doc(WorkshopRunDoc, conversation.id), {
        state: "ready",
        runId: "historical-v2-run",
        workflowId,
        activationId,
        occurrenceId,
        canonicalHash: checked.canonicalHash,
        status: "completed",
        desiredState: "running",
        admittedAt,
        startedAt: admittedAt,
        finishedAt,
        currentNodeId: null,
        currentAttemptId: null,
        block: null,
        failure: null,
        terminalOutput: "",
        durable: { conversationId, workflowTaskId: 1 },
        canonicalDefinition: { version: 2 },
        resolvedSettings: { nodes: {} },
      });
      Object.assign(await tx.doc(WorkshopInstallationDoc), {
        state: "ready",
        installationId: "fixture-installation",
        maxConcurrentRuns: 1,
        workflows: {
          [workflowId]: {
            definitionHash: checked.canonicalHash,
            admissionHighWater: 1,
            openRunId: null,
            activations: [{
              activationId, state: "exhausted", admittedCount: 1, maxRuns: 1,
              activatedAt: admittedAt, nextDueAt: null,
            }],
            occurrenceCounters: { [activationId]: 1 },
            runs: [{
              runId: "historical-v2-run", activationId, occurrenceId, conversationId,
              workflowTaskId: 1, admissionSequence: 1, admittedAt, status: "completed", requestId: null,
            }],
            requestIndex: {},
            capacityReservations: [],
            preflightCache: {},
          },
        },
      });
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}
