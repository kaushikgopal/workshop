# Workshop

Workshop runs agent workflows on your machine, once or on a schedule, and
survives crashes while it does.

A workflow is a YAML file that describes a **chain of steps** (nodes). Each node
runs either a shell command or an AI agent (Pi, Claude Code, OpenCode, …). Each
node's output feeds the next node. An optional validator checks each result
before the chain moves on.

Three things hold all the state:

| Piece | Holds | Who writes it |
| --- | --- | --- |
| Workflow YAML | what to do | you |
| SQLite (`workshop.db`) | where every run stands: status, attempts, owners | the runtime only |
| `WORKSHOP_LOG.md` (one per run) | what happened, in prose, for agents and humans | the runtime only; agents write their own packet file |

The runtime moves normal work forward without any model. It calls an
**orchestrator** agent only when an attempt fails and someone must judge what
to do next.

## A workflow

The bundled example, trimmed
([full file](examples/workflows/hemingway-clock.yaml)):

```yaml
id: hemingway-clock
schedule: { every: 10m, max_runs: 6 }   # omit for a one-shot workflow

defaults:
  max_attempts: 2
  agent:
    harness:
      command: 'pi --print --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"'
    model: "openai-codex/gpt-5.3-codex:medium"

nodes:
  node-timestamp:                       # 1. shell command
    run: { command: "date -u +%FT%TZ" }
    validator: { command: 'test -n "$(cat "$WORKSHOP_NODE_OUTPUT_FILE")"' }
    next: node-generate-line

  node-generate-line:                   # 2. AI agent, checked by a second agent
    run:
      agent:
        instructions: Generate one original Hemingway-inspired sentence …
    validator:
      agent:
        instructions: Pass only if the output is one original sentence …
    next: node-append-quote

  node-append-quote:                    # 3. shell command, consumes node 2's output
    run:
      command: cat "$WORKSHOP_PREVIOUS_OUTPUT_FILE" >> hemingway.quotes.md
    max_attempts: 1                     # appending twice would duplicate the quote
    next: null
```

## What happens when you run it

`workshop start hemingway-clock` runs the whole chain in the foreground:

```mermaid
sequenceDiagram
  participant You
  participant CLI as CLI + runner
  participant DB as SQLite
  participant Dir as Run directory
  participant Proc as Command / agent

  You->>CLI: workshop start hemingway-clock
  CLI->>CLI: parse + validate YAML
  CLI->>DB: reserve run
  CLI->>Dir: freeze definition.yaml, create WORKSHOP_LOG.md
  CLI->>CLI: run preflight check
  CLI->>DB: create pending attempt for node 1
  loop each node in the chain
    CLI->>DB: claim attempt
    CLI->>Proc: spawn with WORKSHOP_* env
    Proc->>Dir: write packet.md (agents) or stdout (commands)
    CLI->>Proc: run validator
    CLI->>Dir: merge packet into WORKSHOP_LOG.md
    CLI->>DB: complete attempt + create next node's attempt
  end
  CLI->>You: run → completed
```

Step by step:

1. **Load.** `definition/` parses the YAML strictly, checks it with a Zod
   schema, and confirms the nodes form one linear chain.
2. **Admit.** `admission.ts` creates the run row in SQLite, then writes a frozen
   copy of the YAML and an empty worklog into the run directory. The run uses
   the frozen copy from here on, so editing the YAML mid-run changes nothing.
   A second `start` while a run is open does nothing.
3. **Preflight.** The optional `environment.preflight` command (here,
   `command -v pi`) must exit 0. Workshop caches a pass per definition hash.
4. **Run each node.** `execute.ts#runChain` loops. For each pending attempt,
   `runner/attempt.ts` does the work described in the next section.
5. **Finish.** When the last node completes, the run completes. The final
   output sits in the worklog under `<workflow-output>`.

### One attempt, up close

Each node execution is an **attempt**. `runner/attempt.ts` takes it through a
fixed sequence:

1. **Claim** the attempt in SQLite, which issues an owner token. Only the
   token's holder may change the attempt, so two runners never overlap.
2. **Prepare** `packet.md`, a scaffold with headings and one marker pair. For
   an agent, render `prompt`: the node's instructions plus the contract (read
   the worklog, write only your packet, put your handoff between the markers).
3. **Spawn** the command or harness in its own process group, with these
   variables:

   | Variable | Meaning |
   | --- | --- |
   | `WORKSHOP_PROMPT_FILE` | the rendered prompt (agents) |
   | `WORKSHOP_NODE_PACKET_FILE` | the one file an agent may write |
   | `WORKSHOP_PREVIOUS_OUTPUT_FILE` | the previous node's output |
   | `WORKSHOP_NODE_OUTPUT_FILE` | this node's extracted output (validators read it) |
   | `WORKSHOP_LOG` | the run's worklog, read-only |
   | `WORKSHOP_MODEL`, `WORKSHOP_THINKING`, … | the resolved model, split several ways |
   | `WORKSHOP_CLI` | lets an agent call `runtime progress` or `runtime block` |

4. **Check integrity.** An agent must leave the worklog untouched and its
   packet well-formed, marker pair included.
5. **Extract output.** A command's output is its stdout. An agent's output is
   the text between `<next-node-output id="…">` markers in its packet (or
   `<workflow-output>` on the last node).
6. **Validate**, if the node has a validator. A command validator passes on
   exit 0; an agent validator writes `validation.json` with `{"passed": …}`.
7. **Merge** the packet into `WORKSHOP_LOG.md` under a file lock, and write a
   receipt so a repeated merge does nothing.
8. **Complete** the attempt and create the next node's pending attempt in one
   SQLite transaction.

Attempt states: `pending → running → finishing → completed`, or `failed`,
`blocked`, `cancelled`.

### When something fails

A timeout, a non-zero exit, a broken packet, or a validator rejection fails the
attempt and marks the run as needing judgment. Workshop then starts a fresh
orchestrator agent. It reads the worklog and the failed attempt's evidence,
then writes one decision to `result.json`:

- `retry` creates a new attempt for the same node, up to `max_attempts`.
- `block` pauses the run until you fix something and run `workshop resume`.
- `fail` ends the run.

Workshop records the decision in the worklog's "Global decision log" and
applies it. A crash needs no judgment: recovery confirms the old process is
dead and retries the attempt deterministically.

### Recurring workflows: the daemon

`start` runs only the first occurrence. For a `schedule:`, run the guardian in
another terminal:

```bash
bun src/cli/main.ts orchestrate
```

`daemon.ts` is a single process that polls SQLite once a second. Each tick it:

1. recovers interrupted work (`recovery.ts`),
2. admits due occurrences, one open run per workflow (`scheduler.ts`),
3. creates first attempts for queued runs,
4. runs pending orchestrator judgments,
5. launches pending attempts within `max_concurrent_runs`, through the same
   `runChain` the CLI uses.

## What lands on disk

```text
.workshop/                          machine-local, gitignored
├─ config/
│  ├─ workshop.yaml                 machine defaults (optional)
│  └─ workflows/<id>.yaml           your workflows
└─ state/
   ├─ workshop.db                   SQLite: workflows, runs, node_attempts
   └─ runs/<run-id>/
      ├─ definition.yaml            frozen YAML
      ├─ WORKSHOP_LOG.md            the run's shared log
      ├─ nodes/002-node-generate-line/attempt-001/
      │  ├─ prompt  packet.md  stdout  stderr  output
      │  ├─ validation/             validator prompt, logs, verdict
      │  └─ merge-receipt.json
      └─ orchestrator/<token>/      prompt.md  result.json  logs
```

## Code map

```text
src/
├─ cli/
│  ├─ main.ts            entrypoint: argv dispatch and help
│  ├─ run-controls.ts    start · stop · pause · resume
│  ├─ inspect.ts         validate · status · runs · logs · diagram · node
│  ├─ watch.ts           lazy-loads the TUI viewer
│  ├─ agent-callbacks.ts runtime progress · block, called by agents
│  └─ errors.ts          die · errorText · requireArg
├─ admission.ts           step 2: reserve a run, freeze its definition
├─ execute.ts             steps 3–5: preflight, first attempt, runChain loop
├─ runner/                one attempt: resolve, env, spawn, validate
├─ worklog/               packets, markers, locked merges into WORKSHOP_LOG.md
├─ store/                 SQLite schema and every guarded state transition
├─ definition/            YAML parsing, schema, chain, model/harness resolution
├─ orchestrator.ts        failure judgment: retry, block, or fail
├─ daemon.ts              polling loop for schedules and recovery
├─ scheduler.ts           which occurrences are due
├─ recovery.ts            reconcile attempts orphaned by a crash
├─ status/                versioned JSON views (status --json, runs --json)
├─ tui-*.ts               the `watch` terminal viewer (OpenTUI)
└─ util/                  clock, durations, ids, processes, stream caps
```

Dependencies point one way: commands → lifecycle (`execute`, `runner`,
`daemon`) → `definition/`, `store/`, `worklog/`. Two rules keep it that way:

- `status/` is the contract for outside readers. `status --json` and
  `runs --json` have versioned shapes, and the viewer reads those, never SQLite
  or run directories.
- Only `tui-*` files import a UI library, and they load lazily. A test fails
  if runtime code imports one.

## Quick start

```bash
bun install
mkdir -p .workshop/config/workflows
cp examples/workflows/hemingway-clock.yaml .workshop/config/workflows/

bun src/cli/main.ts validate hemingway-clock
bun src/cli/main.ts start hemingway-clock
cat .workshop/state/runs/*/WORKSHOP_LOG.md | tail -40
```

The example needs `pi` on your PATH. A successful run stamps the time, writes
and validates one sentence, and appends it to `hemingway.quotes.md`.

### Commands

| Command | Does |
| --- | --- |
| `start <id>` | start a run (and enable its schedule) |
| `pause` / `resume` / `stop <id>` | control the open run and its schedule |
| `status [<id>] [--json]` | tree of workflows, runs, nodes, attempts |
| `runs <id> [--json]` | occurrence history, newest first |
| `logs <id> [--follow \| --all]` | worklog and process logs |
| `watch [<id>]` | live TUI: `j`/`k` history, `f` follow, `a` all logs, `q` quit |
| `diagram <id> [--mermaid]` | the chain with live status |
| `node describe <id> <node>` | a node's resolved settings and status |
| `orchestrate` | the daemon |

Run any of them as `bun src/cli/main.ts <command>`.

## Configuration

`.workshop/config/workshop.yaml` holds machine defaults; every field is
optional:

```yaml
shell: /bin/bash
max_concurrent_runs: 1
default_timeout: 10m
stream_cap: 256kb     # per captured stream: bytes | kb | mb | unlimited
agent:
  model: "openai-codex/gpt-5.3-codex:medium"
```

Agent settings resolve field by field: node, then workflow `defaults`, then
machine. Models take the form `<provider>/<model-id>:<thinking-level>`.

Workshop caps raw stdout and stderr, since an agent's stdout can grow to
megabytes. It keeps the head and tail and records the original size in a
`<stream>.truncation.json` sidecar. It never truncates packets, outputs, or the
worklog. A node may set its own `stream_cap:`.

### Harnesses

Any CLI agent works if a shell command can launch it with a prompt file:

| Harness | Command |
| --- | --- |
| Pi 0.85 | `pi --print --mode json --approve --no-session --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` |
| OpenCode 1.18 | `opencode run --format json --auto --model "$WORKSHOP_MODEL" --variant "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` |
| Claude Code 2.1 | `claude --print --output-format text --permission-mode auto --no-session-persistence --model "$WORKSHOP_MODEL_ID" --effort "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` |

These flags auto-approve tool use, so run them only on a trusted machine.

## Scope and status

Workshop is a proof of concept for trusted, local workflows. It runs with your
permissions and has no sandbox, no untrusted input, no branching graphs, and
no budgets. Starting a workflow authorizes every command and agent in it.
Automatic retry assumes a node is safe to repeat; set `max_attempts: 1` when it
is not.

| Stage | Proves | Status |
| --- | --- | --- |
| POC-A | runtime: durable chain, worklog, SQLite, validators, recovery | done |
| POC-B | status viewer over the CLI projections | done |
| POC-C | `$build-workflow` authoring skill | next |
| POC-D | notification channels | later |

## Development

```bash
bun test          # acceptance tests against a mock harness (tests/mock/harness.ts)
bunx tsc --noEmit # typecheck
```

The real-model path has one manual check: the quick start above.

- Spec: `.agents/dox/workshop-spec-v3.md`
- Build history and bug log: `.agents/dox/2026-09-10-workshop-execution.md`
