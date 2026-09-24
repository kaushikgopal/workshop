/**
 * Machine-local formatting shared by every human surface: the status tree, the
 * CLI's inspection commands, and the TUI panes.
 *
 * This module exists as its own file for one reason: it has no imports. The
 * formatter was previously part of `status/tree.ts`, so the TUI — which needs
 * only a glyph and a clock — transitively pulled in the store, the recovery
 * module, and `node:fs` through it. A pure formatter keeps the viewer's import
 * graph honest, and lets the tree renderer be deleted without taking the
 * viewer with it.
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

/** Machine-local `YYYY-MM-DD`. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`;
}
