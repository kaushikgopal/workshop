# Agent guide

Workshop is a Bun/TypeScript runner for local agent workflows. Start with
`README.md` for the architecture and code map.

- Before creating, renaming, or splitting a file, read `CONTRIBUTING.md`. It
  defines the folder nouns, the verb each filename must start with, and the
  rule against using "run" as a verb.
- Validate every change with `bunx tsc --noEmit` and `bun test`. The suite
  takes about a minute.
- Keep the README code map in sync when files move.
