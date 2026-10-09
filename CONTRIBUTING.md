# Contributing

These rules keep the codebase easy to navigate and easy to delete from. The
first sections apply to any project; the last section records choices specific
to this one.

## Naming files

A reader should know what a file does from its path alone, before opening it.

### Folders are nouns, files are verbs

- **Folders** name the domain things the code is about: `definition/`, `run/`,
  `attempt/`, `storage/`. Pick the nouns your data model already uses (table
  names, directory names, words in the UI) so one word means one thing
  everywhere.
- **Files** lead with a verb that says what the file does to that thing:
  `run/create-run.ts`, `attempt/judge-output.ts`, `storage/disk/lock-run.ts`.
  A noun alone (`packet.ts`, `utils.ts`, `helpers.ts`) says what a file is
  about, not what it does, and invites unrelated code to pile in.
- **Exception: pure shape.** A file that only declares types, a schema, or an
  interface keeps a noun name: `schema.ts`, `types.ts`, `data-source.ts`.
  So does an entrypoint (`main.ts`) and a file named after the command it
  implements (`cli/watch.ts`).

### Use one verb per kind of work

Each verb below has one meaning. Reuse it for that meaning, and never borrow it
for another.

| Verb | Means | Example |
| --- | --- | --- |
| `parse` | turn text into structure | `parse-yaml.ts`, `parse-units.ts` |
| `check` | apply a fixed rule; pass or throw, no judgment | `check-chain.ts`, `check-packet.ts` |
| `judge` | ask an agent or command whether output is good enough | `judge-output.ts` |
| `resolve` | combine layered settings into one value | `resolve-node-settings.ts` |
| `load` | read a file and return checked data | `load-definition.ts` |
| `build` | assemble data for another program to consume | `build-status-json.ts` |
| `render` | produce text for a person or an agent to read | `render-agent-prompt.ts` |
| `locate` | compute a path without touching disk | `locate-run-files.ts` |
| `create` | add a new record | `create-run.ts` |
| `execute` | carry out one unit of work to its end | `execute-attempt.ts` |
| `recover` | repair state left behind by a crash | `recover-after-crash.ts` |

Other plain verbs (`launch`, `merge`, `verify`, `format`) are fine when no verb
above already covers the job. Before adding a verb, check that it does not
overlap one in the table; if it will recur, add it to the table.

### Rules that prevent collisions

- **Never use "run" as a verb.** In a workflow runner, "run" is the most
  important noun. A function named `runChain` or a file named `run-paths.ts`
  forces the reader to guess which meaning you meant. Use `execute`, `advance`,
  `launch`, or a more specific verb.
- **Never use "validate" for two things.** If the product has a user-facing
  concept called a validator, code that applies fixed rules says `check`, and
  code that invokes the validator says `judge`.
- **Name the logic, not the area.** `run-paths.ts` leaves open whether the
  file builds, checks, or cleans paths. `locate-run-files.ts` does not.
- **Match exported symbols to the file's verb.** `judge-output.ts` exports
  `judgeOutput`; `locate-run-files.ts` exports `locateWorklog`.
- **Split a file when its name needs "and".** `open-and-migrate.ts` is the
  ceiling: two steps that always happen together. Three verbs means three files.

## Code

- **Optimize for deletion.** Keep behavior local. Prefer a small duplicated
  helper over a shared abstraction that couples two features.
- **Point dependencies one way.** Entry points depend on domain folders, and
  domain folders depend on storage and utilities. Never the reverse. When a
  rule matters, write a test that reads the import graph and fails on a
  violation.
- **Comment the why.** Explain non-obvious reasons and constraints. Do not
  narrate what the next line does.
- **Test behavior that could regress.** Test what the code promises: its
  outputs, state transitions, and error cases. Do not test how it is built.

## Changes

- Keep each change small and about one thing. A rename and a behavior change
  belong in separate commits.
- Write commit subjects that say what changed and why; put the reasoning a
  reviewer needs in the body.
- Run the typecheck and tests before asking for review.

## This project

- Domain nouns: **workflow** (the YAML definition), **run** (one occurrence of
  a workflow), **attempt** (one try at one node). These match the stored
  records and the run-directory layout.
- `orchestrate` has a fixed meaning: an agent decides what happens after an
  attempt fails. The legacy v3 daemon's command is also named `orchestrate`
  (`--engine v3 orchestrate`), for historical reasons, but its code lives under
  `daemon/`. The default v4 engine replaces it with `service`.
- v4 is the default engine. Files for the legacy engine stay reachable only
  through `cli/dispatch-v3-command.ts`; new behavior goes to v4.
- Checks before review:

  ```bash
  bunx tsc --noEmit
  bun test
  ```

- The README's code map and dependency rules describe the folders; update them
  when you add or move a file.
