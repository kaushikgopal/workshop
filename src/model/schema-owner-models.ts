import { z } from "zod";

export const ownerModelApiSchema = z.enum([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
]);
export type OwnerModelApi = z.infer<typeof ownerModelApiSchema>;

export const TALLY_BASE_URL_BY_API = {
  "openai-responses": "https://api-tally-infra.icprivate.com/api/proxy/pi.dev/v1",
  "openai-completions": "https://api-tally-infra.icprivate.com/api/proxy/pi.dev/v1",
  "anthropic-messages": "https://api-tally-infra.icprivate.com/api/proxy/pi.dev",
} as const satisfies Record<OwnerModelApi, string>;

const safeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const nonnegativeRate = z.number().finite().nonnegative();

const modelCostSchema = z.object({
  input: nonnegativeRate,
  output: nonnegativeRate,
  cacheRead: nonnegativeRate,
  cacheWrite: nonnegativeRate,
  tiers: z.array(z.object({
    inputTokensAbove: safeInteger,
    input: nonnegativeRate,
    output: nonnegativeRate,
    cacheRead: nonnegativeRate,
    cacheWrite: nonnegativeRate,
  })).optional(),
});

const thinkingLevelMapSchema = z.object({
  off: z.string().nullable().optional(),
  minimal: z.string().nullable().optional(),
  low: z.string().nullable().optional(),
  medium: z.string().nullable().optional(),
  high: z.string().nullable().optional(),
  xhigh: z.string().nullable().optional(),
  max: z.string().nullable().optional(),
});

export const ownerModelDescriptorSchema = z.object({
  id: z.string().min(1).max(256).refine((value) => !/[\s\u0000-\u001f\u007f]/u.test(value)),
  name: z.string().min(1).max(256),
  contextWindow: safeInteger,
  maxTokens: safeInteger,
  input: z.array(z.enum(["text", "image"])).nonempty().default(["text"]),
  reasoning: z.boolean().default(false),
  cost: modelCostSchema.optional(),
  thinkingLevelMap: thinkingLevelMapSchema.optional(),
  compat: z.unknown().optional(),
});
export type OwnerModelDescriptor = z.infer<typeof ownerModelDescriptorSchema>;

/** Model catalog fields only; Zod strips apiKey, headers, and other provider data. */
export const ownerProviderCatalogSchema = z.object({
  api: ownerModelApiSchema,
  baseUrl: z.string().min(1),
  models: z.array(ownerModelDescriptorSchema).nonempty(),
});
export type OwnerProviderCatalog = z.infer<typeof ownerProviderCatalogSchema>;

/** Request-time auth fields. This schema deliberately omits the provider model catalog. */
export const ownerProviderCredentialSchema = z.object({
  api: ownerModelApiSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  authHeader: z.string().nullable().optional(),
});
export type OwnerProviderCredential = z.infer<typeof ownerProviderCredentialSchema>;

export const ownerModelsFileSchema = z.object({
  providers: z.record(z.string(), z.unknown()),
});
