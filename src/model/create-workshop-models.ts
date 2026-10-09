import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { OwnerModelApi } from "./schema-owner-models.js";
import { loadOwnerModels } from "./load-owner-models.js";
import { resolveOwnerProviderAuth } from "./resolve-owner-provider-auth.js";

const agentDirectoryEnv = "PI_CODING_AGENT_DIR";

/** Compile the supported Tally-backed Pi provider entries into public pi-ai providers. */
export function createWorkshopModels(options: { readonly modelsFile?: string } = {}): MutableModels {
  const models = createModels();
  const modelsFile = options.modelsFile ?? locateOwnerModelsFile();
  const catalog = loadOwnerModels(modelsFile);
  if (catalog.kind !== "loaded") return models;

  for (const provider of catalog.providers) {
    const api = providerApi(provider.api);
    models.setProvider(createProvider<OwnerModelApi>({
      id: provider.id,
      name: `${provider.id} via Instacart Tally`,
      baseUrl: provider.baseUrl,
      auth: resolveOwnerProviderAuth({
        modelsFile,
        providerId: provider.id,
        api: provider.api,
        baseUrl: provider.baseUrl,
      }),
      models: provider.models,
      api,
    }));
  }
  return models;
}

export function locateOwnerModelsFile(): string {
  const configuredDirectory = process.env[agentDirectoryEnv];
  const agentDirectory = configuredDirectory === undefined || configuredDirectory.trim().length === 0
    ? join(homedir(), ".pi", "agent")
    : resolve(configuredDirectory);
  return join(agentDirectory, "models.json");
}

function providerApi(api: OwnerModelApi): Partial<Record<OwnerModelApi, ProviderStreams>> {
  switch (api) {
    case "openai-responses": return { [api]: openAIResponsesApi() };
    case "openai-completions": return { [api]: openAICompletionsApi() };
    case "anthropic-messages": return { [api]: anthropicMessagesApi() };
  }
}
