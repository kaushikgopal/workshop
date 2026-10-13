/**
 * Machine-local formatting shared by every human surface: the CLI's inspection
 * commands and the TUI panes.
 *
 * This module has no imports, so the viewer can format a glyph and a clock
 * without pulling storage or `node:fs` into its import graph.
 */
const GLYPH: Record<string, string> = {
  pending: "○",
  running: "◎",
  finishing: "◑",
  blocked: "⊘",
  failed: "✗",
  completed: "◉",
  cancelled: "·",
  queued: "○",
  paused: "‖",
  waiting: "?",
};

/** Status glyph, with an unknown status degrading to the pending mark. */
export function glyph(status: string): string {
  return GLYPH[status] ?? "○";
}

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** Machine-local `HH:MM:SS`. Date getters, not `toLocaleTimeString`, so the
 *  output never varies with locale and never produces a `24:00` hour. */
export function localClock(iso: string): string {
  const d = new Date(iso);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`;
}
