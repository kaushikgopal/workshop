/**
 * Guidance shown when the default v4 engine meets v3 configuration. Workshop
 * never rewrites v3 files or state, so the operator either keeps the explicit
 * legacy engine or edits the files by hand.
 */
export function renderV3MigrationGuidance(problem: string): string {
  return [
    problem,
    "  Keep using it unchanged with the legacy engine: workshop --engine v3 <command> (v3 state is left untouched).",
    "  To move to the default v4 engine, edit the files yourself (Workshop never migrates them):",
    "    - add `version: 2` to .workshop/config/workshop.yaml and to every workflow",
    "    - replace packet-file instructions with result-file instructions (WORKSHOP_RESULT_FILE)",
    "    - give the internal orchestrator a native `orchestrator: { model }`; it no longer takes a harness command",
    "    - mark repeat-safe workers and validators `replay: safe`",
    "    - use `max_runs: unlimited` instead of a numeric max_runs <= 0",
    "    - replace `workshop orchestrate` with `workshop service start`",
    "  See README \"Migrating from v3\" for the full list.",
  ].join("\n");
}
