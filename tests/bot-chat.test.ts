import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { loadInstallation } from "../src/installation/load-installation.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { botChatViewV1Schema } from "../src/bot/schema.js";
import { statusDtoSchema } from "../src/views/schema.js";
import { TALLY_BASE_URL_BY_API } from "../src/model/schema-owner-models.js";
import { createBotExtension } from "../src/bot/create-bot-tools.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
test("configured shared bot completes a chat round trip with a fake model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workshop-bot-chat-"));
  const workshopDirectory = join(directory, ".workshop");
  mkdirSync(join(workshopDirectory, "workflows"), { recursive: true });
  writeFileSync(join(workshopDirectory, "workshop.yaml"), "bot:\n  model: fixture/fake:medium\n", "utf8");
  const installation = loadInstallation(directory);
  const models = createModels();
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "fake" }] });
  faux.setResponses([fauxAssistantMessage("The fake bot is ready.")]);
  models.setProvider(faux.provider);
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
  const models = createModels();
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "fake" }] });
  models.setProvider(faux.provider);
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
        const response = await sendServiceRequest(socketPath, { version: 1, method: "chat.view", limit: 100 });
        if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
        const view = botChatViewV1Schema.parse(response.result);
        if (view.entries.filter(entry => entry.role === "assistant" && entry.text === "read complete").length >= expectedReplies) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("bot did not complete its read tool call");
    };

    await submitAndWait("bot-read-logs", 1);
    expect(toolOutputs[0]).toContain("bot-known-stdout-marker");
    expect(toolOutputs[0]).toContain("capture worker stdout");
    expect(toolOutputs[0]).toContain("[truncated: Workshop bot log output");
    expect(Buffer.byteLength(toolOutputs[0] ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect((toolOutputs[0] ?? "").split("\n").length).toBeLessThanOrEqual(100);

    await submitAndWait("bot-read-run", 2);
    expect(toolOutputs[1]).toContain('"status":"completed"');
    expect(toolOutputs[1]).toContain('"terminalOutput":"bot-known-stdout-marker"');
  } finally {
    await owner?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
