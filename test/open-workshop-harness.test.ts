import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { test } from "node:test";
import { openWorkshopHarness, type WorkshopHarnessOptions } from "../service/open-workshop-harness.ts";
import type { OrchestratorModel } from "../service/create-orchestrator-runtime.ts";

test("does not close storage when Harness.open option preparation fails", async () => {
  const storage = new MemoryStorage();
  const originalClose = storage.close.bind(storage);
  let closeCalls = 0;
  let storageClosed = false;
  storage.close = async (context) => {
    closeCalls += 1;
    await originalClose(context);
    storageClosed = true;
  };
  const model: OrchestratorModel = {
    model: { provider: "fake", modelId: "fake" },
    thinkingLevel: "medium",
  };
  const options = {
    projectRoot: process.cwd(),
    request: async () => ({ ok: true }),
    model,
    escalationModel: model,
    get models(): ReturnType<typeof createModels> { throw new Error("injected harness option preparation failure"); },
  } satisfies WorkshopHarnessOptions;

  try {
    await assert.rejects(openWorkshopHarness(storage, undefined, options), /injected harness option preparation failure/);
    assert.equal(closeCalls, 0);
  } finally {
    if (!storageClosed) await originalClose(BACKGROUND_CONTEXT);
  }
});

test("does not close storage twice when Harness.open fails during task initialization", async () => {
  const storage = new MemoryStorage();
  const originalClose = storage.close.bind(storage);
  const originalScanTasks = storage.scanTasks.bind(storage);
  let closeCalls = 0;
  let storageClosed = false;
  storage.close = async (context) => {
    closeCalls += 1;
    await originalClose(context);
    storageClosed = true;
  };
  storage.scanTasks = async () => {
    throw new Error("injected task initialization failure");
  };

  try {
    await assert.rejects(openWorkshopHarness(storage), /injected task initialization failure/);
    assert.equal(closeCalls, 1);
  } finally {
    storage.scanTasks = originalScanTasks;
    if (!storageClosed) await originalClose(BACKGROUND_CONTEXT);
  }
});

test("closes the opened harness when root configuration fails", async () => {
  const storage = new MemoryStorage();
  const originalClose = storage.close.bind(storage);
  let closeCalls = 0;
  storage.close = async (context) => {
    closeCalls += 1;
    await originalClose(context);
  };
  const invalidModel: OrchestratorModel = {
    model: new Proxy({ provider: "fake", modelId: "fake" }, {
      ownKeys: () => { throw new Error("injected root configuration failure"); },
    }),
    thinkingLevel: "medium",
  };

  try {
    await assert.rejects(openWorkshopHarness(storage, undefined, {
      projectRoot: process.cwd(),
      request: async () => ({ ok: true }),
      models: createModels(),
      model: invalidModel,
      escalationModel: invalidModel,
    }), /injected root configuration failure/);
    assert.equal(closeCalls, 1);
  } finally {
    if (closeCalls === 0) await storage.close(BACKGROUND_CONTEXT);
  }
});
