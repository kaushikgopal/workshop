/**
 * Model strings: `<provider>/<model-id>:<thinking-level>`, parsed once at the
 * boundary so the rest of the runtime handles parts rather than a string it has
 * to re-split. The split is on the *first* slash and the *last* colon, because
 * model ids contain both.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ParsedModel {
  provider: string;
  modelId: string;
  thinking: ThinkingLevel;
  full: string;
}

/** Parse a model string and check its thinking level against the workflow contract. */
export function parseModel(full: string): ParsedModel {
  if (/\s/.test(full)) {
    throw new Error("model strings cannot contain whitespace");
  }

  const slash = full.indexOf("/");
  const colon = full.lastIndexOf(":");
  if (slash <= 0 || colon <= slash + 1 || colon === full.length - 1) {
    throw new Error(`invalid model string "${full}" — expected <provider>/<model-id>:<thinking-level>`);
  }

  const thinking = full.slice(colon + 1);
  if (!isThinkingLevel(thinking)) {
    throw new Error(
      `unsupported thinking level "${thinking}" — expected one of ${THINKING_LEVELS.join(", ")}`,
    );
  }

  return {
    provider: full.slice(0, slash),
    modelId: full.slice(slash + 1, colon),
    thinking,
    full,
  };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}
