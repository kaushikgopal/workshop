# Agent guide

Workshop is a Bun/TypeScript runner for local agent workflows. Start with
`README.md` for the product and `CONTRIBUTING.md` ("How the code works") for
the architecture and code map.

- Before creating, renaming, or splitting a file, read `CONTRIBUTING.md`. It
  defines the folder nouns, the verb each filename must start with, and the
  rule against using "run" as a verb.
- Validate every change with `bunx tsc --noEmit` and `bun test`. The suite
  takes about a minute.
- Keep the CONTRIBUTING code map in sync when files move.

## Manual CLI examples

- Start with `make cli` from this checkout. It runs `bun install
  --frozen-lockfile` first, then opens a fish child shell with a temporary
  `workshop` function.
- Inside the child, use plain `workshop` commands. Do not redefine the
  function, re-run `set -g workshop_repo`, or type absolute Bun paths.
- Create the demo workspace at the fixed path `/tmp/workshop-demo-hemingway`,
  and run `workshop` commands from that project root (the directory containing
  `.workshop`), never from inside `.workshop`.
- Machine-specific model choices live in `AGENTS.local.md` (gitignored, not
  tracked). Keep public docs and examples provider-neutral.
- Before exiting the child, stop the workflow (`workshop stop <workflow>`) and
  the service (`workshop service stop`). Exiting the child does not stop the
  service.

## Live benchmark tests

- Use `examples/workflows/hemingway-clock.yaml` as the standard live benchmark
  workflow.
- Automated unit and integration tests keep the faux providers.
