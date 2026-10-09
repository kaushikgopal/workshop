import type { Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { parseStrictYaml } from "../definition/parse-yaml.js";
import {
  ownerModelsFileSchema,
  ownerProviderCatalogSchema,
  TALLY_BASE_URL_BY_API,
  type OwnerModelApi,
  type OwnerModelDescriptor,
} from "./schema-owner-models.js";

const providerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const responseCompatSchema = z.object({
  supportsStrictMode: z.boolean().optional(),
});
const completionsCompatSchema = z.object({
  supportsStore: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  thinkingFormat: z.enum([
    "openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen",
    "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
  ]).optional(),
  supportsStrictMode: z.boolean().optional(),
});

export interface CheckedOwnerModel {
  readonly id: string;
  readonly api: OwnerModelApi;
  readonly baseUrl: string;
  readonly models: readonly Model<OwnerModelApi>[];
}

export type OwnerModelsCatalog =
  | { readonly kind: "loaded"; readonly providers: readonly CheckedOwnerModel[] }
  | { readonly kind: "invalid" };

/** Parse only model metadata from the owner's models.json; credentials never leave the raw parse scope. */
export function parseOwnerModels(text: string): OwnerModelsCatalog {
  let root: unknown;
  try {
    root = parseStrictYaml(text, "Pi provider configuration");
  } catch {
    return { kind: "invalid" };
  }
  const document = ownerModelsFileSchema.safeParse(root);
  if (!document.success) return { kind: "invalid" };

  const providers: CheckedOwnerModel[] = [];
  for (const [id, rawProvider] of Object.entries(document.data.providers)) {
    if (!providerIdSchema.safeParse(id).success) continue;
    const provider = ownerProviderCatalogSchema.safeParse(rawProvider);
    if (!provider.success || !isPinnedTallyBaseUrl(provider.data.baseUrl, provider.data.api)) continue;

    const compiled = compileModels(id, provider.data.api, provider.data.models);
    if (compiled === undefined || compiled.length === 0) continue;
    providers.push({
      id,
      api: provider.data.api,
      baseUrl: TALLY_BASE_URL_BY_API[provider.data.api],
      models: compiled,
    });
  }
  return { kind: "loaded", providers };
}

export function isPinnedTallyBaseUrl(value: string, api: OwnerModelApi): boolean {
  try {
    const url = new URL(value);
    const expected = new URL(TALLY_BASE_URL_BY_API[api]);
    return url.protocol === "https:"
      && url.hostname === expected.hostname
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname === expected.pathname
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function compileModels(
  providerId: string,
  api: OwnerModelApi,
  descriptors: readonly OwnerModelDescriptor[],
): Model<OwnerModelApi>[] | undefined {
  const ids = new Set<string>();
  const models: Model<OwnerModelApi>[] = [];
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) return undefined;
    ids.add(descriptor.id);
    if (descriptor.cost === undefined) continue;
    const model = compileModel(providerId, api, descriptor);
    if (model === undefined) return undefined;
    models.push(model);
  }
  return models;
}

function compileModel(providerId: string, api: OwnerModelApi, descriptor: OwnerModelDescriptor): Model<OwnerModelApi> | undefined {
  if (descriptor.cost === undefined) return undefined;
  const common = {
    id: descriptor.id,
    name: descriptor.name,
    provider: providerId,
    baseUrl: TALLY_BASE_URL_BY_API[api],
    input: descriptor.input,
    reasoning: descriptor.reasoning,
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    cost: descriptor.cost,
    ...(descriptor.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: descriptor.thinkingLevelMap }),
  };

  switch (api) {
    case "openai-responses": {
      const compat = descriptor.compat === undefined ? undefined : responseCompatSchema.safeParse(descriptor.compat);
      if (compat !== undefined && !compat.success) return undefined;
      return {
        ...common,
        api,
        ...(compat?.data === undefined ? {} : { compat: compat.data }),
      };
    }
    case "openai-completions": {
      const compat = descriptor.compat === undefined ? undefined : completionsCompatSchema.safeParse(descriptor.compat);
      if (compat !== undefined && !compat.success) return undefined;
      return {
        ...common,
        api,
        ...(compat?.data === undefined ? {} : { compat: compat.data }),
      };
    }
    case "anthropic-messages":
      // This owner config uses OpenAI compatibility keys that pi-ai does not apply to Anthropic.
      return { ...common, api };
  }
  return undefined;
}
