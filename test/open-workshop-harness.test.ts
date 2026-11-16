import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { test } from "node:test";
import { openWorkshopHarness } from "../service/open-workshop-harness.ts";
import type { OrchestratorModel } from "../service/create-orchestrator-runtime.ts";

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
