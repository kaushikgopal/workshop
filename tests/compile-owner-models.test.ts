import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createWorkshopModels } from "../src/model/create-workshop-models.js";
import { TALLY_BASE_URL_BY_API } from "../src/model/schema-owner-models.js";

const model = {
  id: "bot-fixture",
  name: "Bot fixture",
  contextWindow: 32_000,
  maxTokens: 4_000,
  input: ["text"],
  reasoning: true,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};

function writeModelsFile(providers: Record<string, unknown>): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "workshop-owner-models-"));
  const path = join(directory, "models.json");
  writeFileSync(path, JSON.stringify({ providers }), { mode: 0o600 });
  return { directory, path };
}

test("compiles supported owner providers without retaining credentials in public metadata", () => {
  const file = writeModelsFile({
    "bot-gateway": {
      api: "openai-completions",
      baseUrl: TALLY_BASE_URL_BY_API["openai-completions"],
      apiKey: "fixture-only-secret",
      headers: { "X-Tally-User": "fixture-user", "X-Tally-Hostname": "fixture-host" },
      models: [model],
    },
    "external-provider": {
      api: "openai-completions",
      baseUrl: "https://api.example.test/v1",
      models: [model],
    },
  });
  try {
    const models = createWorkshopModels({ modelsFile: file.path });
    expect(models.getModel("bot-gateway", "bot-fixture")).toMatchObject({
      provider: "bot-gateway",
      id: "bot-fixture",
      baseUrl: TALLY_BASE_URL_BY_API["openai-completions"],
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(models.getModel("external-provider", "bot-fixture")).toBeUndefined();
    expect(JSON.stringify(models.getProviders())).not.toContain("fixture-only-secret");
    expect(JSON.stringify(models.getProviders())).not.toContain("fixture-user");
  } finally {
    rmSync(file.directory, { recursive: true, force: true });
  }
});

test("compiles owner models without cost at Pi's zero-cost default", () => {
  const file = writeModelsFile({
    "bot-gateway": {
      api: "openai-completions",
      baseUrl: TALLY_BASE_URL_BY_API["openai-completions"],
      models: [{ ...model, cost: undefined }],
    },
  });
  try {
    const models = createWorkshopModels({ modelsFile: file.path });
    expect(models.getModel("bot-gateway", "bot-fixture")).toMatchObject({
      provider: "bot-gateway",
      id: "bot-fixture",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  } finally {
    rmSync(file.directory, { recursive: true, force: true });
  }
});

test("reads owner provider credentials only when auth is checked", async () => {
  const file = writeModelsFile({
    "bot-gateway": {
      api: "openai-completions",
      baseUrl: TALLY_BASE_URL_BY_API["openai-completions"],
      apiKey: "fixture-only-secret",
      headers: { "X-Tally-User": "fixture-user", "X-Tally-Hostname": "fixture-host" },
      models: [model],
    },
  });
  try {
    const models = createWorkshopModels({ modelsFile: file.path });
    expect(await models.checkAuth("bot-gateway")).toBeDefined();
    writeFileSync(file.path, JSON.stringify({ providers: {} }), { mode: 0o600 });
    expect(await models.checkAuth("bot-gateway")).toBeUndefined();
  } finally {
    rmSync(file.directory, { recursive: true, force: true });
  }
});
