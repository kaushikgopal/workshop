import { parseModel, type ParsedModel } from "./parse-model.js";

export const THINKING_LEVELS_V2 = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelV2 = (typeof THINKING_LEVELS_V2)[number];

export interface ParsedModelV2 extends Omit<ParsedModel, "thinking"> {
  thinking: ThinkingLevelV2;
}

/** Parse the v2 model contract without changing the v1 parser used by the default CLI. */
export function parseV2Model(full: string): ParsedModelV2 {
  if (/\s/.test(full)) {
    throw new Error("model strings cannot contain whitespace");
  }

  const parsed = parseModel(full);
  if (!(THINKING_LEVELS_V2 as readonly string[]).includes(parsed.thinking)) {
    throw new Error(
      `unsupported thinking level "${parsed.thinking}" — expected one of ${THINKING_LEVELS_V2.join(", ")}`,
    );
  }

  return { ...parsed, thinking: parsed.thinking as ThinkingLevelV2 };
}
