import type { BlockInfo } from "./schema.js";

const blockTable = {
  verifier_block: { actions: ["retry", "fail"], bot: true },
  verifier_failed: { actions: ["retry", "fail"], bot: true },
  repeated_failure: { actions: ["retry", "fail"], bot: true },
  preflight_failed: { actions: ["retry", "fail"], bot: true },
  external_outcome_unknown: { actions: ["retry", "accept", "fail"], bot: false },
  process_death_unconfirmed: { actions: ["retry", "fail"], bot: false },
  integrity_failed: { actions: ["fail"], bot: false },
  runtime_incompatible: { actions: ["fail"], bot: false },
} satisfies Partial<Record<BlockInfo["kind"], { actions: readonly string[]; bot: boolean }>>;

/** The same authority check applies before preparation and within the checked commit. */
export function checkBlockResolution(input: {
  readonly formatVersion: number | undefined;
  readonly blockKind: BlockInfo["kind"] | undefined;
  readonly action: "retry" | "accept" | "fail";
  readonly resolver?: "human" | "bot";
  readonly botAlreadyResolved?: boolean;
  readonly allowRepeat?: boolean;
  readonly extraAttempt?: boolean;
  readonly target?: "judgment";
}): string | null {
  if (input.formatVersion !== 4) return null;
  const kind = input.blockKind;
  if (kind === undefined || !(kind in blockTable)) return "format 4 block kind has no resolution authority; inspect the run with a compatible build";
  // SAFETY: the membership check above limits kind to the eight authority rows.
  const row = blockTable[kind as keyof typeof blockTable];
  if (input.extraAttempt !== undefined || input.target !== undefined) {
    return "format 4 removes --extra-attempt and --target judgment; retry grants exactly one attempt outside retries";
  }
  if (!row.actions.some((action) => action === input.action)) {
    return "format 4 " + kind + " permits only " + row.actions.join(", ") + "; accept is only available for external_outcome_unknown";
  }
  if (input.resolver === "bot") {
    if (!row.bot || input.allowRepeat !== undefined) return "format 4 " + kind + " requires a human; bots cannot use --allow-repeat";
    if (input.botAlreadyResolved) return "the bot already resolved a block on this node in this run; a human must resolve later blocks";
  }
  if (input.action === "retry") {
    const repeat = kind === "external_outcome_unknown" || kind === "process_death_unconfirmed";
    if (repeat ? input.allowRepeat !== true : input.allowRepeat !== undefined) {
      return "format 4 " + kind + (repeat ? " retry requires --allow-repeat after checking external effects" : " retry does not allow --allow-repeat");
    }
  }
  return null;
}
