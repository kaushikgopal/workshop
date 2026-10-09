# Workshop

Workshop runs agent workflows on your machine, once or on a schedule, and
survives crashes while it does.

A workflow is a YAML file that describes a **chain of steps** (nodes). Each node
runs either a shell command or a headless AI agent (Pi, Claude Code, OpenCode,
…). Each node's output feeds the next node, and an optional validator checks
each result before the chain moves on. Normal progress never needs a model. A
built-in judge model is asked only when an attempt fails.

## Quick start

Workshop keeps its config and state in a `.workshop/` directory inside whatever
project you run it from.

```bash
alias workshop="bun $PWD/src/cli/main.ts"   # run from this repo after `bun install`

mkdir -p ~/scratch/hemingway/.workshop/config/workflows && cd ~/scratch/hemingway
cp $OLDPWD/examples/workshop.yaml .workshop/config/
cp $OLDPWD/examples/workflows/hemingway-*.yaml .workshop/config/workflows/
```

Edit `.workshop/config/workshop.yaml` before the first run. Its models are
placeholders: set `agent.model` to a model your Pi installation can use, and
`orchestrator.model` to a priced model from `~/.pi/agent/models.json` (see
[The failure judge](#the-failure-judge)).

### Watch it work

`hemingway-judge` is the most instructive example. Its first attempt at the
timestamp node is rigged to fail, so you see the judge decide a retry. One run
makes about three agent calls and one judge call.

```bash
workshop validate hemingway-judge          # offline YAML and settings check
workshop start hemingway-judge --detach    # starts the service, prints the run id
workshop watch hemingway-judge             # live viewer; q quits
```

When the run finishes, inspect what happened:

```bash
workshop status                                          # every workflow and its schedule
workshop diagram hemingway-judge                         # the chain with node status
workshop node describe hemingway-judge node-timestamp    # attempt 1 rejected, judge said retry
workshop logs hemingway-judge                            # WORKLOG.md plus every process capture
ls .workshop/state/runs/*/captures                       # prompts, result.json, stdout, stderr
cat .workshop/state/quotes-judge/*.md                    # the published sentence
workshop service stop
```

To see crash recovery, run `workshop start hemingway-clock --detach`. While
`node-generate-line` is running, find the service pid with
`workshop service status` and `kill -9` it. The next `workshop status` starts a
new service, which retires the orphaned process group before doing anything
else. That node says `replay: safe`, so it then runs again on its own. A node
without `replay: safe` would block until you decide with `workshop resolve`.
The example schedules six runs ten minutes apart; `workshop stop
hemingway-clock` ends the schedule.

## How it works

You drive Workshop through its CLI. Behind it, one background service per
project owns all state and runs your schedules. It keeps going after `start`
returns, until `workshop service stop`. The service records each step before it
takes the next one, so after a crash or reboot a run resumes where it stopped.

A run walks the chain one node at a time:

```mermaid
flowchart TD
  S[start or schedule] --> PF[preflight, optional]
  PF --> W[node worker]
  W --> R{result accepted?}
  R -->|yes| V{validator passes?}
  V -->|yes| N[next node, or done]
  R -->|no| J[failure judge]
  V -->|no| J
  J -->|retry| W
  J -->|block| B[wait for workshop resolve]
  J -->|fail| F[run fails]
```

Every process leaves its prompt, result, stdout, and stderr in the run
directory, and `WORKLOG.md` tells the story of the run. When
`max_concurrent_runs` runs are already going, a new run waits for a slot.

### Things that are easy to get wrong

- **There are two kinds of model call.**
  - Workers and validators run your harness command (`pi --print …`) as
    ordinary subprocesses, so any headless agent can replace `pi`.
  - Only the failure judge is a direct model call. Its model comes from
    `~/.pi/agent/models.json` through Tally, and it can only record one
    decision.
- **The definition freezes when the run is admitted.** Editing the YAML
  mid-run changes nothing; the next run picks it up.
- **Replay is opt-in per node.** After a crash, a node marked `replay: safe`
  reruns. Anything else blocks, because the service cannot prove the process
  had no side effects yet.
- **A retry needs more than `max_attempts`.** The judge may choose retry only
  when the worker, and its validator if there is one, are both `replay: safe`
  and attempts remain. Otherwise it can only block or fail.
- **The service owns the state.** Every command, `watch` included, asks the
  service instead of reading files. `status --json` is the stable,
  machine-readable view.
- **Agent stdout is not the output.** An agent node succeeds only by writing
  checked JSON to `WORKSHOP_RESULT_FILE`. For command nodes, stdout is the
  output.
- **A blocked run stalls its schedule.** Slots that come due while a run is
  unresolved are skipped. After service downtime, only the latest missed slot
  runs.

To see how the code is structured, see
[CONTRIBUTING](CONTRIBUTING.md#how-the-code-works).

## A workflow

The bundled example, trimmed
([full file](examples/workflows/hemingway-clock.yaml)):

```yaml
version: 2
id: hemingway-clock
schedule: { every: 10m, max_runs: 6 }   # omit for a one-shot workflow

defaults:
  max_attempts: 2
  replay: never                         # nodes opt in to automatic repeats
  agent:
    harness:
      command: 'pi --print --approve --no-session --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"'

nodes:
  node-timestamp:                       # 1. shell command
    run: { command: "date -u +%FT%TZ" }
    replay: safe
    validator: { command: 'test -s "$WORKSHOP_NODE_OUTPUT_FILE"', replay: safe }
    next: node-generate-line

  node-generate-line:                   # 2. AI agent, checked by a second agent
    run:
      agent:
        instructions: Generate one original Hemingway-inspired sentence …
    replay: safe
    validator:
      agent:
        instructions: Pass only if it is one original sentence …
      replay: safe
    next: node-publish-quote

  node-publish-quote:                   # 3. shell command, consumes node 2's output
    run:
      command: … copy "$WORKSHOP_PREVIOUS_OUTPUT_FILE" to one quote file per run …
    replay: safe                        # rewriting the same per-run file is idempotent
    max_attempts: 1
    next: null
```

Commands produce their output on stdout. Agents get their prompt in
`WORKSHOP_PROMPT_FILE` and must write checked JSON to `WORKSHOP_RESULT_FILE`;
their stdout is diagnostic only. The next node reads the output from
`WORKSHOP_PREVIOUS_OUTPUT_FILE`. An optional `environment.preflight` command
runs before the first node.

## Commands

| Command | Does |
| --- | --- |
| `validate <id>` | check YAML and resolved settings, offline |
| `start <id> [--detach]` | admit a run (and enable its schedule); wait unless detached |
| `pause` / `resume` / `stop <id>` | control the open run and its schedule |
| `resolve <id> --action retry\|accept\|fail --reason <text>` | decide a blocked run |
| `status [<id>] [--json]` | workflows, activations, and each unresolved run |
| `runs <id> [--json] [--all]` | run history, newest first |
| `logs <id> [--run <id>] [--follow \| --all] [--json]` | worklog and process captures |
| `watch [<id>]` | live TUI: `j`/`k` history, `f` follow, `a` all logs, `q` quit |
| `diagram <id> [--run <id>] [--mermaid]` | the chain with run status |
| `node describe <id> <node> [--run <id>] [--json]` | frozen settings and attempt evidence |
| `service start` | start the detached service; does nothing if it is running |
| `service serve` | run the service in the foreground |
| `service status [--json]` | health, PID, and boot ID; exit 3 when not running |
| `service stop` | graceful shutdown; does nothing if it is not running |

Run any of them as `bun src/cli/main.ts <command>`; `help` lists them. Any
command that needs the service starts it. The service keeps running schedules
after `start` returns, until `service stop`.

Exit codes: 0 success, 1 failed or cancelled run, 2 blocked run, 3 service
unavailable, 64 usage or configuration error.

`service stop` signals only a process it can verify as this project's service,
then waits up to 15 s for it to exit. If it cannot verify the process, it exits
3 without signaling anything.

## Configuration

`.workshop/config/workshop.yaml` holds machine defaults and must declare
`version: 2` ([example](examples/workshop.yaml)):

```yaml
version: 2
shell: /bin/bash
max_concurrent_runs: 1
default_timeout: 10m
stream_cap: 256kb     # per captured stream: bytes | kb | mb | unlimited
agent:
  model: "example/pi-model:medium"
orchestrator:
  model: "example/judge-model:low"
```

Agent settings resolve field by field: node, then workflow `defaults`, then
machine. Models take the form `<provider>/<model-id>:<thinking-level>`.

### Headless-agent command templates

Choose one command for each agent site; Workshop uses the same supervised process and strict result-file contract for every harness. The model names below are syntax examples, not available provider claims. Workshop passes the rendered prompt through `WORKSHOP_PROMPT_FILE` and names `WORKSHOP_RESULT_FILE` in that prompt. The harness must write the checked JSON result there; stdout remains diagnostic output.

```yaml
pi:
  model: example/pi-model:medium
  model_env: [WORKSHOP_MODEL_WITH_THINKING]
  prompt_env: WORKSHOP_PROMPT_FILE
  result_env: WORKSHOP_RESULT_FILE
  command: 'pi --print --approve --no-session --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"'
opencode:
  model: example/opencode-model:medium
  model_env: [WORKSHOP_MODEL, WORKSHOP_THINKING]
  prompt_env: WORKSHOP_PROMPT_FILE
  result_env: WORKSHOP_RESULT_FILE
  command: 'opencode run --format json --auto --model "$WORKSHOP_MODEL" --variant "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"'
claude-code:
  model: example/claude-model:medium
  model_env: [WORKSHOP_MODEL_ID, WORKSHOP_THINKING]
  prompt_env: WORKSHOP_PROMPT_FILE
  result_env: WORKSHOP_RESULT_FILE
  command: 'claude --print --output-format text --permission-mode auto --no-session-persistence --model "$WORKSHOP_MODEL_ID" --effort "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"'
```

The Pi template ran against Pi 1.1.0 in a live smoke test. The OpenCode and
Claude Code flags have not been checked against installed binaries; confirm
them before use. Approval and auto modes can grant broad project access, so
run them only on a trusted machine.

### The failure judge

The judge does not go through a harness. Workshop calls `orchestrator.model`
directly, using its Tally-backed entry in `~/.pi/agent/models.json` (or
`PI_CODING_AGENT_DIR/models.json`). The entry needs explicit pricing;
entries without rates are left out rather than assigned zero cost. Credentials
and Tally attribution headers are read from the owner file at request time and
never stored. Command credentials, custom auth headers, and non-Tally endpoints
are rejected.

### Worker processes

Workers, validators, and preflight run as `<shell> -lc '<command>'` in their
own process group. The login flag sources your shell profile, so anything the
profile prints to stderr shows up in every process's stderr capture.

Raw stdout and stderr keep a UTF-8-safe head and tail window of `stream_cap`
bytes each; `logs` reports total, retained, and omitted byte counts. A command
node's output is saved before the cap applies.

## What lands on disk

```text
.workshop/                          machine-local, gitignored
├─ config/
│  ├─ workshop.yaml                 machine defaults, `version: 2`
│  └─ workflows/<id>.yaml           your workflows, `version: 2`
└─ state/
   ├─ durable.db                    run database, owned by the service
   ├─ service.json  service.lock  service.sock
   └─ runs/<workflow>-<uuid>/
      ├─ definition.yaml            frozen YAML
      ├─ WORKLOG.md                 rendered run log
      ├─ input/  output/            each node's previous and extracted output
      └─ captures/                  prompt, result.json, stdout, stderr per process
```

Workflows may write elsewhere. The Hemingway examples publish to
`.workshop/state/quotes*/<run-id>.md`.

## Status and limitations

Workshop is a proof of concept for trusted, local workflows. It runs with your
permissions and has no sandbox, no untrusted input, no branching graphs, and
no budgets. Starting a workflow authorizes every command and agent in it.

| Stage | Proves | Status |
| --- | --- | --- |
| POC-A | runtime: durable chain, worklog, SQLite, validators, recovery | done |
| POC-B | status viewer over the CLI projections | done |
| Service | background service on Pi Durable with crash recovery | done |
| POC-C | `$build-workflow` authoring skill | next |
| POC-D | notification channels | later |

Known limitations:

- Tested on macOS only. The service loads a native SQLite binding and refuses
  to start if that binding cannot load; Linux (glibc and musl) is untested.
- No upgrade migration. Each run records the task versions it started with.
  If a later release changes a task version incompatibly, the old run blocks
  instead of guessing. Finish or stop runs before upgrading.
- `service start` discards the service's stdout and stderr, so a failed
  startup shows only the CLI error. Run `workshop service serve` to see the
  cause.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for conventions, checks, and how the code
works.
