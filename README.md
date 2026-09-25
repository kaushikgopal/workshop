# Workshop

A small TypeScript + Bun runtime for responsibly running one-shot and autonomous
agent workflows.

```text
Workshop daemon — one deterministic process
  ├─ polls SQLite
  ├─ evaluates schedules
  ├─ prevents overlapping runs
  ├─ detects interrupted, blocked, or failed work
  └─ invokes a fresh orchestrator agent only for exception judgment
```

Agents read the runtime-owned `WORKSHOP_LOG.md` and write exactly one packet
file per attempt; SQLite owns lifecycle truth; the daemon advances normal work
without any model judgment.

## Layout

- `src/` — the runtime. Dependencies point one way: the entrypoint and the
  lifecycle down to `definition/`, `store/`, and `worklog/`; `status/` projects
  that state back out for humans and viewers; `src/tui-*.ts` is the terminal
  viewer and the only code that imports a UI library.
- `tests/` — deterministic mock harness and acceptance tests (`bun test`)
- `examples/workflows/hemingway-clock.yaml` — the POC example and copyable
  template
- `.workshop/` — machine-local state (gitignored): config, SQLite, run dirs

```text
src/
├─ cli.ts            dispatch, run controls, watch wiring
├─ cli-inspect.ts    status · runs · logs · diagram · node describe
├─ cli-errors.ts     die · errorText · requireArg
├─ admission · execute · daemon · scheduler · orchestrator · recovery
├─ definition/       parse · schema · chain · model · resolve · snapshot · hash
├─ store/            types · rows · workflows · runs · attempts · db
├─ worklog/          worklog · packet · markers · receipt · lock · fs
├─ runner/           attempt · resolve · validator · env · spawn
├─ status/           dto · runs-feed · tree · node-status · format
├─ tui-app · tui-panes · tui-source     the viewer (OpenTUI Core)
└─ util/             clock · duration · ids · process · retention · cli-path
```

Two conventions are worth knowing before you add a file. Files that exist only
for the terminal viewer are named `tui-*` and are loaded lazily, so no other
command pays for OpenTUI; a test enforces that the runtime never imports one as
a value. And `status/` is the contract layer: `status --json` and `runs --json`
are versioned shapes that outside consumers (including the viewer) parse, so a
viewer never reads SQLite or a run directory.

## Running

```bash
bun install
```

Create a machine-local installation (repo root is the default project dir):

```bash
mkdir -p .workshop/config/workflows
cp examples/workflows/hemingway-clock.yaml .workshop/config/workflows/
```

Observe — one run, a workflow's history, or both live:

```bash
bun src/cli.ts help
bun src/cli.ts validate hemingway-clock
bun src/cli.ts start hemingway-clock
bun src/cli.ts status            # human tree view
bun src/cli.ts status --json     # stable versioned DTO (viewer contract)
bun src/cli.ts runs hemingway-clock          # occurrences, newest first
bun src/cli.ts runs hemingway-clock --json   # versioned feed for a viewer
bun src/cli.ts logs hemingway-clock          # newest run: worklog + process logs
bun src/cli.ts logs hemingway-clock --all    # every run, oldest first
bun src/cli.ts watch hemingway-clock         # live TUI: chain, log, occurrences
bun src/cli.ts diagram hemingway-clock --mermaid
bun src/cli.ts node describe hemingway-clock node-generate-line
bun src/cli.ts stop hemingway-clock
```

`watch` opens a terminal UI: the occurrences feed on top, the selected run's
chain and log below it, keybindings along the bottom. Omit the workflow id to
pick from the configured workflows first. `j`/`k` walk history, `f` re-follows
the newest occurrence, `a` streams every run's log, `q` quits.

`workshop start` takes no task payload — the workflow YAML contains or discovers
the whole task. Starting while a run is unresolved is an idempotent no-op.

For recurring workflows, run the guardian daemon in a separate terminal:

```bash
bun src/cli.ts orchestrate
```

`workshop start` takes no task payload — the workflow YAML contains or discovers
the whole task. Starting while a run is unresolved is an idempotent no-op.

### Manual Pi smoke (the Hemingway clock)

The example runs with the checked-in defaults (Pi 0.85 +
`openai-codex/gpt-5.3-codex:medium`):

```bash
mkdir -p .workshop/config/workflows
cp examples/workflows/hemingway-clock.yaml .workshop/config/workflows/
bun src/cli.ts start hemingway-clock
```

Expected, for a three-node chain: preflight passes (`pi` on PATH),
`node-timestamp` completes with a UTC stamp; `node-generate-line` reads the
quote archive, drafts one Hemingway-inspired sentence into its packet's output
markers through the mock-free real harness, and a fresh agent validator passes
it only if the sentence is materially distinct from every archived line;
`node-append-quote` — one attempt only, because appending is not repeat-safe —
appends the sentence to `hemingway.quotes.md` as a `<quote run-id>` block; and
the run completes with all of it in `WORKSHOP_LOG.md`:

```bash
cat .workshop/state/runs/*/WORKSHOP_LOG.md | tail -40
cat .workshop/config/workflows/hemingway.quotes.md
```

If the validator rejects a paraphrase, a fresh orchestrator agent
(`instacart-openai/gpt-5.6-luna:low`) judges it and may authorise one retry —
the decision lands in the run's Global decision log. A rejected sentence that
exhausts `max_attempts: 2` fails the run instead.

Six occurrences, ten minutes apart, require the daemon; `max_runs: 6` exhausts
the activation afterward.

## Machine configuration

`.workshop/config/workshop.yaml` sets the runtime defaults. Everything is
optional:

```yaml
shell: /bin/bash
max_concurrent_runs: 1
default_timeout: 10m
stream_cap: 256kb     # per captured stream: bytes | kb | mb | unlimited
agent:
  model: "openai-codex/gpt-5.3-codex:medium"
```

Raw process streams are the one thing that grows without bound — an agent's
stdout is its whole event log — so each capture is capped: a head window and a
tail window survive, a notice marks the seam, and a `<stream>.truncation.json`
sidecar records the original size. Packets, extracted outputs, and the worklog
are never truncated. A node may override with `stream_cap:` of its own.

## Harness compatibility

Workshop is harness-neutral: every agent site resolves to a shell command
template plus a fully qualified model string
(`<provider>/<model-id>:<thinking-level>`). The runtime renders the prompt to a
file and exposes `WORKSHOP_PROMPT_FILE`; harness commands read it with
`"$(cat "$WORKSHOP_PROMPT_FILE")"`.

| Harness         | Command (trusted-local flags)                                                                                                                                                        | Notes                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Pi 0.85         | `pi --print --mode json --approve --no-session --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"`                                                          | `--approve` auto-approves tool use; the default in the checked-in example.                                     |
| OpenCode 1.18   | `opencode run --format json --auto --model "$WORKSHOP_MODEL" --variant "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"`                                                     | `--auto` enables permissions bypass; `--variant` carries the thinking level. Non-gating compatibility example. |
| Claude Code 2.1 | `claude --print --output-format text --permission-mode auto --no-session-persistence --model "$WORKSHOP_MODEL_ID" --effort "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` | `--permission-mode auto` is trusted-local; not a gating check.                                                 |

The automated acceptance gates run against the deterministic mock harness
(`tests/mock/harness.ts`); exactly one manual gate (the Pi smoke above)
exercises the real model path.

## POC boundaries

Trusted machine-local workflows with the current user's permissions. No sandbox,
no untrusted intake, no general graphs, no budget system. Starting a workflow
authorizes its commands, agents, and validators; automatic retry assumes a node
is repeat-safe (set `max_attempts: 1` for non-repeatable external effects).

Delivery stages, in the order they are built:

| Stage | What it proves | Status |
| --- | --- | --- |
| POC-A | the runtime: durable chain, worklog, SQLite truth, validators, recovery | done |
| POC-B | the status viewer, over the CLI's projections | done |
| POC-C | the `$build-workflow` authoring skill | next |
| POC-D | notification channels | after that |

Two things are deliberately deferred, with the reasoning in the spec: a
first-class typed-decision validator kind and typed triage (a `command`
validator can already shell out to one, and across twelve live runs the
orchestrator was invoked four times for $0.0023), and durable notification
delivery (a delivery worth reconciling is a step, so model it as a command
node).

## Development

```bash
bun test          # acceptance gates against the mock harness
bunx tsc --noEmit # typecheck
```

The spec is `.agents/dox/workshop-spec-v3.md`, and the build history — including
a bug log of every guard that exists because something actually broke — is
`.agents/dox/2026-09-10-workshop-execution.md`.
