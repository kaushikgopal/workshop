import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { test } from "node:test";
import { createWorkshopService } from "../service/create-workshop-service.ts";
import { openWorkshopHarness } from "../service/open-workshop-harness.ts";
import { serveServiceSocket } from "../service/serve-service-socket.ts";
import { parseServiceRequest } from "../service/types.ts";

const chatScript = fileURLToPath(new URL("../scripts/chat-workshop.ts", import.meta.url));

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "workshop-chat-client-test-"));
  const workflow = join(root, "workflows", "clock");
  mkdirSync(workflow, { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "instructions.md"), "Manage the test workflows.\n");
  writeFileSync(join(root, "workshop.yaml"), [
    "agent_profiles:",
    `  writer:\n    command: ["${process.execPath}"]`,
    "orchestrator: {}",
    "",
  ].join("\n"));
  writeFileSync(join(workflow, "workflow.md"), "---\ncron: '* * * * *'\n---\nA test workflow.\n");
  writeFileSync(join(workflow, "10-task.sh"), "printf 'unused'\n");
  return root;
}

function executeChat(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [chatScript, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout: output, stderr: errors }));
  });
}

function executeInteractiveChat(cwd: string, message: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [chatScript], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  let submitted = false;
  let inputEnded = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    const prompts = output.match(/workshop> /g)?.length ?? 0;
    if (!submitted && prompts > 0) {
      submitted = true;
      child.stdin.write(`${message}\n`);
    }
    if (submitted && !inputEnded && prompts > 1) {
      inputEnded = true;
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout: output, stderr: errors }));
  });
}

test("interactive and --print modes receive the streamed answer", { timeout: 30_000 }, async () => {
  const projectRoot = createProject();
  const storage = new MemoryStorage();
  const faux = fauxProvider({ tokensPerSecond: 12, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    fauxAssistantMessage("The command-line client received this streamed reply."),
    fauxAssistantMessage("The interactive client received this streamed reply."),
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let socketServer: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request);
      },
    });
    service = createWorkshopService({ projectRoot, harness });
    harness.resume();
    const stateDirectory = join(projectRoot, "state");
    mkdirSync(stateDirectory, { recursive: true });
    socketServer = await serveServiceSocket(join(stateDirectory, "service.sock"), async (value, send) => {
      if (!service) throw new Error("Workshop service is not ready");
      const request = parseServiceRequest(value);
      if (request.type === "watch_chat") return await service.watchChat(request.request_id, send);
      send(await service.handleRequest(request));
    });

    const result = await executeChat(["--print", "What does the client stream?"], projectRoot);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "The command-line client received this streamed reply.\n");
    assert.equal(result.stderr, "");

    const interactive = await executeInteractiveChat(projectRoot, "Say hello to the interactive client.");
    assert.equal(interactive.code, 0, interactive.stderr);
    assert.ok(interactive.stdout.includes("workshop> The interactive client received this streamed reply."));
    assert.equal(interactive.stderr, "");
  } finally {
    if (socketServer) await socketServer.close();
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("--print ignores text from an earlier chat submission", { timeout: 30_000 }, async () => {
  const projectRoot = createProject();
  const storage = new MemoryStorage();
  const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  let markFirstStarted = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  faux.setResponses([
    async () => {
      markFirstStarted();
      await firstGate;
      return fauxAssistantMessage("Skipped 10-fail after the earlier command failed.");
    },
    fauxAssistantMessage(fauxToolCall("list_workflows", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("The slow workflow started."),
  ]);
  const configuredModel = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "medium" as const,
  };
  let service: ReturnType<typeof createWorkshopService> | undefined;
  let harness: Awaited<ReturnType<typeof openWorkshopHarness>> | undefined;
  let socketServer: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  let markWatchAttached = () => {};
  let markPrintSubmitted = () => {};
  const watchAttached = new Promise<void>((resolve) => { markWatchAttached = resolve; });
  const printSubmitted = new Promise<void>((resolve) => { markPrintSubmitted = resolve; });
  let printed: Promise<{ code: number | null; stdout: string; stderr: string }> | undefined;
  try {
    harness = await openWorkshopHarness(storage, undefined, {
      projectRoot,
      models,
      model: configuredModel,
      escalationModel: configuredModel,
      request: async (request) => {
        if (!service) throw new Error("Workshop service is not ready");
        return await service.handleRequest(request);
      },
    });
    service = createWorkshopService({ projectRoot, harness });
    harness.resume();
    const stateDirectory = join(projectRoot, "state");
    mkdirSync(stateDirectory, { recursive: true });
    socketServer = await serveServiceSocket(join(stateDirectory, "service.sock"), async (value, send) => {
      if (!service) throw new Error("Workshop service is not ready");
      const request = parseServiceRequest(value);
      if (request.type === "watch_chat") {
        const watch = await service.watchChat(request.request_id, send);
        markWatchAttached();
        return watch;
      }
      if (request.type === "submit_chat" && request.request_id !== "earlier-chat") markPrintSubmitted();
      send(await service.handleRequest(request));
    });
    const earlier = service.handleRequest({ request_id: "earlier-chat", type: "submit_chat", content: "Handle the earlier failure." });
    await firstStarted;
    printed = executeChat(["--print", "Start slow"], projectRoot);
    await Promise.all([watchAttached, printSubmitted]);
    releaseFirst();
    const [result, previous] = await Promise.all([printed, earlier]);
    assert.equal(previous.ok, true);
    assert.equal(previous.answer, "Skipped 10-fail after the earlier command failed.");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "The slow workflow started.\n");
    assert.equal(result.stderr, "  list_workflows {}\n  list_workflows ok\n");
  } finally {
    releaseFirst();
    await printed?.catch(() => undefined);
    if (socketServer) await socketServer.close();
    if (harness) await harness.close(BACKGROUND_CONTEXT);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("--print gives one make-start hint when the service socket is missing", { timeout: 10_000 }, async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "workshop-chat-missing-test-"));
  try {
    const result = await executeChat(["--print", "Hello"], projectRoot);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Workshop service is not running. Run `make start`.\n");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
