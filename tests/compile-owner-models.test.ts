import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createWorkshopModels } from "../src/model/create-workshop-models.js";
import { TALLY_BASE_URL_BY_API, type OwnerModelApi } from "../src/model/schema-owner-models.js";

const testHeaders = {
  "X-Tally-User": "fixture-user",
  "X-Tally-Hostname": "fixture-host",
};
const userContext = { messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }] };

type ProviderFixture = {
  readonly baseUrl: string;
  readonly api: OwnerModelApi;
  readonly apiKey: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: string | null;
  readonly models: readonly Record<string, unknown>[];
};

function model(id: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Fixture ${id}`,
    contextWindow: 32_000,
    maxTokens: 4_000,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...extras,
  };
}

function provider(api: OwnerModelApi, apiKey: string, extras: Partial<ProviderFixture> = {}): ProviderFixture {
  return {
    api,
    baseUrl: TALLY_BASE_URL_BY_API[api],
    apiKey,
    headers: testHeaders,
    models: [model("judge-fixture")],
    ...extras,
  };
}

function writeModelsFile(providers: Record<string, ProviderFixture>): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "workshop-owner-models-"));
  const path = join(directory, "models.json");
  writeFileSync(path, JSON.stringify({ providers }), { mode: 0o600 });
  return { directory, path };
}

describe("owner Tally model compilation", () => {
  test("registers only checked Tally providers and strips private config from public models", () => {
    const unpriced = model("unpriced");
    delete unpriced.cost;
    const file = writeModelsFile({
      "instacart-openai": provider("openai-responses", "fixture-private-key", {
        models: [model("judge-fixture", { compat: { supportsStrictMode: true } }), unpriced],
      }),
      "open-weights": provider("openai-completions", "fixture-private-key"),
      "instacart-anthropic": provider("anthropic-messages", "fixture-private-key"),
      "open-weights-local": provider("openai-completions", "fixture-private-key", {
        baseUrl: "https://aigateway.instacart.tools/unified/pi.dev/v1",
      }),
      "vendor-openai": provider("openai-responses", "fixture-vendor-key", {
        baseUrl: "https://api.openai.com/v1",
      }),
    });
    try {
      const models = createWorkshopModels({ modelsFile: file.path });
      expect(models.getProviders().map((entry) => entry.id).sort()).toEqual([
        "instacart-anthropic",
        "instacart-openai",
        "open-weights",
      ]);
      expect(models.getModel("instacart-openai", "judge-fixture")).toMatchObject({
        api: "openai-responses",
        baseUrl: TALLY_BASE_URL_BY_API["openai-responses"],
        compat: { supportsStrictMode: true },
      });
      expect(models.getModel("open-weights", "judge-fixture")).toMatchObject({
        api: "openai-completions",
        baseUrl: TALLY_BASE_URL_BY_API["openai-completions"],
      });
      expect(models.getModel("instacart-anthropic", "judge-fixture")).toMatchObject({
        api: "anthropic-messages",
        baseUrl: TALLY_BASE_URL_BY_API["anthropic-messages"],
      });
      expect(models.getModel("vendor-openai", "judge-fixture")).toBeUndefined();
      expect(models.getModel("instacart-openai", "unpriced")).toBeUndefined();
      expect(models.getModel("open-weights-local", "judge-fixture")).toBeUndefined();
      expect(JSON.stringify(models.getProviders())).not.toContain("fixture-private-key");
      expect(JSON.stringify(models.getProviders())).not.toContain("fixture-user");
    } finally {
      rmSync(file.directory, { recursive: true, force: true });
    }
  });

  test("resolves owner credentials at request time through the SDK adapter with network faked", async () => {
    const file = writeModelsFile({
      "instacart-openai": provider("openai-responses", "fixture-old-key"),
      "open-weights": provider("openai-completions", "fixture-old-key"),
      "instacart-anthropic": provider("anthropic-messages", "fixture-old-key"),
    });
    try {
      const models = createWorkshopModels({ modelsFile: file.path });
      writeFileSync(file.path, JSON.stringify({
        providers: {
          "instacart-openai": provider("openai-responses", "fixture-current-openai-key", {
            headers: { "X-Tally-User": "current-user", "X-Tally-Hostname": "current-host" },
          }),
          "open-weights": provider("openai-completions", "fixture-current-completions-key"),
          "instacart-anthropic": provider("anthropic-messages", "fixture-current-anthropic-key"),
        },
      }), { mode: 0o600 });

      const requests: Array<{ url: string; headers: Headers; body: string }> = [];
      const fakeFetch = Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
          const request = new Request(input, init);
          requests.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
          if (request.url.endsWith("/chat/completions")) {
            const firstChunk = {
              id: "chatcmpl-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture-model",
              choices: [{ index: 0, delta: { role: "assistant", content: "synthetic judgment" }, finish_reason: null }],
            };
            const finalChunk = {
              id: "chatcmpl-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            return new Response(`data: ${JSON.stringify(firstChunk)}\n\ndata: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          return new Response(JSON.stringify({ error: { message: "fake provider response" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        },
        { preconnect: (_url: string | URL, _options?: Parameters<typeof globalThis.fetch.preconnect>[1]) => undefined },
      ) satisfies typeof globalThis.fetch;
      const openaiModel = models.getModel("instacart-openai", "judge-fixture");
      if (openaiModel === undefined) throw new Error("Responses fixture model did not compile");
      await models.completeSimple(openaiModel, userContext, { fetch: fakeFetch }).catch(() => undefined);
      const completionModel = models.getModel("open-weights", "judge-fixture");
      if (completionModel === undefined) throw new Error("completion fixture model did not compile");
      const completed = await models.completeSimple(completionModel, userContext, { fetch: fakeFetch });
      const anthropicModel = models.getModel("instacart-anthropic", "judge-fixture");
      if (anthropicModel === undefined) throw new Error("Anthropic fixture model did not compile");
      await models.completeSimple(anthropicModel, userContext, { fetch: fakeFetch }).catch(() => undefined);

      expect(requests).toHaveLength(3);
      expect(completed.content).toEqual([{ type: "text", text: "synthetic judgment" }]);
      expect(completed.stopReason).toBe("stop");
      expect(JSON.parse(requests[1]?.body ?? "{}").model).toBe("judge-fixture");
      expect(JSON.parse(requests[1]?.body ?? "{}").stream).toBe(true);
      expect(requests[0]?.url).toBe(`${TALLY_BASE_URL_BY_API["openai-responses"]}/responses`);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer fixture-current-openai-key");
      expect(requests[0]?.headers.get("x-tally-user")).toBe("current-user");
      expect(requests[0]?.headers.get("x-tally-hostname")).toBe("current-host");
      expect(requests[1]?.url).toBe(`${TALLY_BASE_URL_BY_API["openai-completions"]}/chat/completions`);
      expect(requests[1]?.headers.get("authorization")).toBe("Bearer fixture-current-completions-key");
      expect(requests[1]?.headers.get("x-tally-user")).toBe("fixture-user");
      expect(requests[1]?.headers.get("x-tally-hostname")).toBe("fixture-host");
      const anthropicRequest = new URL(requests[2]?.url ?? "");
      const anthropicBase = new URL(TALLY_BASE_URL_BY_API["anthropic-messages"]);
      expect(anthropicRequest.origin).toBe(anthropicBase.origin);
      expect(anthropicRequest.pathname).toBe(`${anthropicBase.pathname}/v1/messages`);
      expect(new URL(requests[2]?.url ?? "").search).toBe("?beta=true");
      expect(requests[2]?.headers.get("x-api-key")).toBe("fixture-current-anthropic-key");
      expect(requests[2]?.headers.get("x-tally-user")).toBe("fixture-user");
      expect(requests[2]?.headers.get("x-tally-hostname")).toBe("fixture-host");
    } finally {
      rmSync(file.directory, { recursive: true, force: true });
    }
  });

  test("rejects command credentials and unsafe headers without fallback or command execution", async () => {
    const marker = join(tmpdir(), `workshop-command-auth-${randomUUID()}`);
    const file = writeModelsFile({
      "instacart-openai": provider("openai-responses", `!touch ${marker}`),
      "direct-provider": provider("openai-responses", "fixture-direct-key", {
        baseUrl: "https://api.vendor.example/v1",
      }),
      "bad-headers": provider("openai-responses", "fixture-key", {
        headers: { Authorization: "fixture-override" },
      }),
    });
    try {
      const models = createWorkshopModels({ modelsFile: file.path });
      const model = models.getModel("instacart-openai", "judge-fixture");
      if (model === undefined) throw new Error("supported Tally catalog entry did not compile");
      const auth = await models.checkAuth("instacart-openai");
      expect(auth).toBeUndefined();
      expect(models.getModel("direct-provider", "judge-fixture")).toBeUndefined();
      expect(models.getModel("bad-headers", "judge-fixture")).toBeDefined();
      expect(await models.checkAuth("bad-headers")).toBeUndefined();
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      rmSync(file.directory, { recursive: true, force: true });
    }
  });
});
