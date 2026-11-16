# Agent guide

Workshop is a Node.js/TypeScript runner for local agent workflows, built on pi-durable.
Start with `README.md` for the product and `CONTRIBUTING.md` ("How the code works") for the architecture and code map.

- Before creating, renaming, or splitting a file, read `CONTRIBUTING.md`. It
  defines the folder nouns, the verb each filename must start with, and the
  rule against using "run" as a verb.
- Keep the CONTRIBUTING code map in sync when files move.
- With each change, check `README.md` and update it in the same commit when
  the change affects commands, configuration, the workflow format, files on
  disk, or the demo. Keep the README brief. Put full contracts in
  `docs/reference.md`.

## Validation

Run all checks from the repository root before finishing:

```fish
npx tsc --noEmit
npm test
make check
```

## Manual workflow

- Run commands from the repository root. Start with `make setup`, then edit
  `workshop.yaml`: set `agent_profiles` for workflow commands. Optionally set
  `orchestrator.model` and `orchestrator.escalation_model`; otherwise Workshop
  uses Pi's configured default model.
- Copy an example into `workflows/`, such as
  `cp -R examples/workflows/hemingway-clock workflows/`, then run `make check`.
- Start the scheduled service with `make start`. In another terminal, use
  `make chat` to attach to the persistent orchestrator conversation or
  `make chat print="What is running?"` for one reply. Use Ctrl-C to stop
  `make start` and Ctrl-C or Ctrl-D to leave interactive chat.
- Use `make dev` to run the service in Node watch mode during development.
- Use `make copy to=<dir>` to create a private copy. Run its commands from
  that copy's root.
- Machine-specific model choices live in `AGENTS.local.md` (gitignored, not
  tracked). Keep public docs and examples provider-neutral.
- `make service-install` and `make service-uninstall` manage the macOS
  LaunchAgent for the Node service.

## Live benchmark tests

- Use `examples/workflows/hemingway-clock/` as the standard live benchmark.
  Copy it into `workflows/` and configure its profile before starting the
  service. Restart the service during a run and verify that the durable task
  resumes. A hard service crash can replay an unfinished command, so make
  external effects safe to repeat.
- Automated unit and integration tests use fake profile commands.

## Private agent documents

- Store agent-authored documents (plans, specs, reviews, research, reports) in `.agents/dox/ignored/`. Git ignores that folder. This rule overrides any global instruction to store them in `.agents/dox/`.
- Never commit a path under `.agents/`. Before each commit, run `git diff --cached --name-only`. Stop if a path starts with `.agents/`.
- Do not reference private documents from tracked files, such as code comments, `README.md`, or `CONTRIBUTING.md`. Put the needed reasoning in the tracked file itself.
- Do not commit credentials, tokens, absolute machine-specific paths, or
  machine-specific model choices. Use fixtures, placeholders, and
  repository-relative paths.
- Stage named paths only. Do not use `git add -A` or `git add .`.
- If a private file reaches a commit, stop and ask. Removal needs a history rewrite and a force push.
