/**
 * Model strings: `<provider>/<model-id>:<thinking-level>`, parsed once at the
 * boundary so the rest of the runtime handles parts rather than a string it has
 * to re-split. The split is on the *first* slash and the *last* colon, because
 * model ids contain both.
 */
export interface ParsedModel {
  provider: string;
  modelId: string;
  thinking: string;
  full: string;
}

export function parseModel(full: string): ParsedModel {
  const slash = full.indexOf("/");
  const colon = full.lastIndexOf(":");
  if (slash <= 0 || colon <= slash + 1 || colon === full.length - 1) {
    throw new Error(`invalid model string "${full}" — expected <provider>/<model-id>:<thinking-level>`);
  }
  return {
    provider: full.slice(0, slash),
    modelId: full.slice(slash + 1, colon),
    thinking: full.slice(colon + 1),
    full,
  };
}

