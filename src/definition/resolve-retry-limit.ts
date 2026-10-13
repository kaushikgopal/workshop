import type { ResolvedNodeSettings } from "./schema-resolved.js";

/**
 * Retries allowed after the first attempt. Format 3 runs stored total attempts,
 * which converts exactly, so history and the current format share one rule.
 */
export function resolveRetryLimit(settings: ResolvedNodeSettings): number | "unlimited" {
  return "retries" in settings ? settings.retries : settings.maxAttempts - 1;
}
