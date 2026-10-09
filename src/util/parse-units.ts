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
/**
 * Evidence retention for raw process streams. A harness can emit megabytes of
 * streaming events per attempt, so each captured stream is bounded to a head
 * window and a tail window: the start shows what the process set out to do,
 * the end shows how it finished. The cap never touches a node's extracted
 * output, its packet, or the worklog — only the raw capture — and it never
 * drops bytes silently: whatever it removes is recorded beside the stream.
 */
/** Applied when neither the machine config nor the node declares a cap. */
export const DEFAULT_STREAM_CAP_BYTES = 256 * 1024;
/** A cap is a byte count, or the explicit opt-out. */
export type StreamCap = number | "unlimited";
export const BYTE_SIZE_RE = /^([1-9][0-9]*)(kb|mb)?$/;
/** Parse a `bytes | kb | mb | unlimited` value. Schema validation runs first. */
export function parseByteSize(value: string): StreamCap {
  if (value === "unlimited") return "unlimited";
  const match = BYTE_SIZE_RE.exec(value);
  if (!match) throw new Error(`not a byte size: "${value}"`);
  const size = Number(match[1]);
  const unit = match[2];
  if (unit === "kb") return size * 1024;
  if (unit === "mb") return size * 1024 * 1024;
  return size;
}

const V2_DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  ...UNIT_MS,
};

/** Parse a v2 duration; keep the v1 grammar unchanged for the default runtime. */
export function parseV2Duration(raw: string): DurationMs {
  const match = /^([1-9][0-9]*)(ms|[smhdw])$/.exec(raw);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `invalid duration "${raw}" — expected a positive integer with unit ms|s|m|h|d|w, e.g. "10ms"`,
    );
  }
  const unit = V2_DURATION_UNITS_MS[match[2]];
  if (unit === undefined) {
    throw new Error(`invalid duration unit in "${raw}"`);
  }
  const durationMs = Number(match[1]) * unit;
  if (!Number.isSafeInteger(durationMs)) {
    throw new Error(`duration "${raw}" exceeds the finite safe-integer millisecond range`);
  }
  return durationMs;
}

/** Reject v2 byte caps that overflow the numeric limit representation. */
export function parseV2ByteSize(raw: string): StreamCap {
  const cap = parseByteSize(raw);
  if (typeof cap === "number" && !Number.isSafeInteger(cap)) {
    throw new Error(`byte size "${raw}" exceeds the finite safe-integer byte value`);
  }
  return cap;
}
