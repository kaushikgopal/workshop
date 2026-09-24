// Duration grammar: positive integers with units s|m|h|d|w.
// Used by schedules, timeouts, and deadlines everywhere.

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export type DurationMs = number;

/** "unlimited" is the explicit opt-out from deadlines. */
export type Timeout = { kind: "limited"; ms: DurationMs } | { kind: "unlimited" };

export function parseDuration(raw: string): DurationMs {
  const m = /^([1-9][0-9]*)([smhdw])$/.exec(raw);
  if (!m || !m[1] || !m[2]) {
    throw new Error(
      `invalid duration "${raw}" — expected a positive integer with unit s|m|h|d|w, e.g. "10m"`,
    );
  }
  const unit = UNIT_MS[m[2]!];
  if (unit === undefined) {
    throw new Error(`invalid duration unit in "${raw}"`);
  }
  return Number(m[1]!) * unit;
}

export function parseTimeout(raw: string | undefined): Timeout {
  if (raw === undefined) return { kind: "limited", ms: -1 }; // resolved later from defaults
  if (raw === "unlimited") return { kind: "unlimited" };
  return { kind: "limited", ms: parseDuration(raw) };
}
