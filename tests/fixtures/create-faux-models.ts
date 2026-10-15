import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";

export type FauxResponses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

export function createFauxModels(
  responses: FauxResponses,
  options: { provider?: string; modelIds?: readonly string[]; reasoning?: boolean } = {},
) {
  const provider = options.provider ?? "fixture";
  const modelIds = options.modelIds ?? ["worker", "verifier"];
  const faux = fauxProvider({ provider, models: modelIds.map(id => ({ id, reasoning: options.reasoning ?? false })) });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
