import { readFile } from "node:fs/promises";
import {
  type ApiKeyAuth,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import { parseStrictYaml } from "../definition/parse-yaml.js";
import {
  ownerModelsFileSchema,
  ownerProviderCredentialSchema,
  type OwnerModelApi,
} from "./schema-owner-models.js";
import { isPinnedTallyBaseUrl } from "./parse-owner-models.js";

const source = "Pi Tally provider configuration";
const allowedHeaders = new Map([
  ["x-tally-user", "X-Tally-User"],
  ["x-tally-hostname", "X-Tally-Hostname"],
]);

interface OwnerProviderAuthInput {
  readonly modelsFile: string;
  readonly providerId: string;
  readonly api: OwnerModelApi;
  readonly baseUrl: string;
}

interface RequestCredential {
  readonly apiKey: string;
  readonly headers: Record<string, string>;
}

/** Builds public pi-ai auth that reads the owner's private key for each operation. */
export function resolveOwnerProviderAuth(input: OwnerProviderAuthInput): ProviderAuth {
  const apiKey: ApiKeyAuth = {
    name: source,
    async check() {
      const credential = await readRequestCredential(input);
      return credential === undefined ? undefined : { source, type: "api_key" };
    },
    async resolve() {
      const credential = await readRequestCredential(input);
      return credential === undefined
        ? undefined
        : { auth: { apiKey: credential.apiKey, headers: credential.headers }, source };
    },
  };
  return { apiKey };
}

async function readRequestCredential(input: OwnerProviderAuthInput): Promise<RequestCredential | undefined> {
  let parsed: unknown;
  try {
    const text = await readFile(input.modelsFile, "utf8");
    parsed = parseStrictYaml(text, "Pi provider configuration");
  } catch {
    return undefined;
  }
  const document = ownerModelsFileSchema.safeParse(parsed);
  if (!document.success) return undefined;
  const rawProvider = document.data.providers[input.providerId];
  const provider = ownerProviderCredentialSchema.safeParse(rawProvider);
  if (!provider.success
    || provider.data.api !== input.api
    || !isPinnedTallyBaseUrl(provider.data.baseUrl, input.api)
    || (provider.data.authHeader !== undefined && provider.data.authHeader !== null)) {
    return undefined;
  }

  const apiKey = provider.data.apiKey;
  if (apiKey === undefined || apiKey === null || apiKey.length === 0
    || apiKey.trim() !== apiKey || apiKey.startsWith("!") || /[\r\n\u0000]/u.test(apiKey)) {
    return undefined;
  }
  const headers = parseTallyHeaders(provider.data.headers);
  return headers === undefined ? undefined : { apiKey, headers };
}

function parseTallyHeaders(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(raw)) {
    const normalized = name.toLowerCase();
    if (!allowedHeaders.has(normalized) || value.length === 0 || value.length > 1024
      || /[\r\n\u0000-\u001f\u007f]/u.test(value) || values.has(normalized)) {
      return undefined;
    }
    values.set(normalized, value);
  }
  if (values.size !== allowedHeaders.size) return undefined;
  return Object.fromEntries([...allowedHeaders].map(([normalized, canonical]) => [canonical, values.get(normalized)!]));
}
