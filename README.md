# Workshop

A small TypeScript + Bun runtime for responsibly running one-shot and
autonomous agent workflows. Workshop is a **durable linked-list runner**, not a
general workflow platform:

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

- `src/` — the runtime (definition, store, worklog, runner, orchestrator, daemon, status, CLI)
- `tests/` — deterministic mock harness and acceptance tests (`bun test`)
- `examples/workflows/hemingway-clock.yaml` — the POC example and copyable template
- `.workshop/` — machine-local state (gitignored): config, SQLite, run dirs

## Running

```bash
bun install
```

Create a machine-local installation (repo root is the default project dir):

```bash
mkdir -p .workshop/config/workflows
cp examples/workflows/hemingway-clock.yaml .workshop/config/workflows/
```

Validate, start, observe:

```bash
bun src/cli.ts help
bun src/cli.ts validate hemingway-clock
bun src/cli.ts start hemingway-clock
bun src/cli.ts status            # human view
bun src/cli.ts status --json     # stable versioned DTO (viewer contract)
bun src/cli.ts logs hemingway-clock --follow
bun src/cli.ts diagram hemingway-clock --mermaid
bun src/cli.ts node describe hemingway-clock node-generate-line
bun src/cli.ts stop hemingway-clock
```

For recurring workflows, run the guardian daemon in a separate terminal:

```bash
bun src/cli.ts orchestrate
```

`workshop start` takes no task payload — the workflow YAML contains or
discovers the whole task. Starting while a run is unresolved is an idempotent
no-op.

### Manual Pi smoke (the Hemingway clock)

The example runs with the checked-in defaults (Pi 0.85 +
`openai-codex/gpt-5.3-codex:medium`):

```bash
mkdir -p .workshop/config/workflows
cp examples/workflows/hemingway-clock.yaml .workshop/config/workflows/
bun src/cli.ts start hemingway-clock
```

Expected: preflight passes (`pi` on PATH), `node-timestamp` completes with a
UTC stamp, `node-generate-line` writes one Hemingway-inspired sentence into
`<workflow-output>` through the mock-free real harness, the fresh validator
passes it, and the run completes with the sentence in `WORKSHOP_LOG.md`:

```bash
cat .workshop/state/runs/*/WORKSHOP_LOG.md | tail -40
```

Six occurrences, ten minutes apart, require the daemon; `max_runs: 6`
exhausts the activation afterward.

## Harness compatibility

Workshop is harness-neutral: every agent site resolves to a shell command
template plus a fully qualified model string
(`<provider>/<model-id>:<thinking-level>`). The runtime renders the prompt to a
file and exposes `WORKSHOP_PROMPT_FILE`; harness commands read it with
`"$(cat "$WORKSHOP_PROMPT_FILE")"`.

| Harness | Command (trusted-local flags) | Notes |
|---|---|---|
| Pi 0.85 | `pi --print --mode json --approve --no-session --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` | `--approve` auto-approves tool use; the default in the checked-in example. |
| OpenCode 1.18 | `opencode run --format json --auto --model "$WORKSHOP_MODEL" --variant "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` | `--auto` enables permissions bypass; `--variant` carries the thinking level. Non-gating compatibility example. |
| Claude Code 2.1 | `claude --print --output-format text --permission-mode auto --no-session-persistence --model "$WORKSHOP_MODEL_ID" --effort "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` | `--permission-mode auto` is trusted-local; not a gating check. |

The automated acceptance gates run against the deterministic mock harness
(`tests/mock/harness.ts`); exactly one manual gate (the Pi smoke above)
exercises the real model path.

## POC boundaries

Trusted machine-local workflows with the current user's permissions. No
sandbox, no untrusted intake, no general graphs, no budget system. Starting a
workflow authorizes its commands, agents, and validators; automatic retry
assumes a node is repeat-safe (set `max_attempts: 1` for non-repeatable
external effects).

## Development

```bash
bun test          # acceptance gates against the mock harness
bunx tsc --noEmit # typecheck
```
