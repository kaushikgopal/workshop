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
| Workflow YAML (`version: 2`) | what to do | you |
| Durable SQLite (`durable.db`) | every run, attempt, process, and decision | the Workshop service only |
| `WORKLOG.md` (one per run) | a readable rendering of the run for agents and humans | the service only; agents write a checked result file |

One background **service** per installation owns that state, runs schedules,
and answers the CLI over a private Unix socket. The runtime moves normal work
forward without any model. It asks a native **orchestrator** model only when an
attempt fails and someone must judge what to do next.

## Engines

The default engine is v4, described in this README. A leading `--engine v3`
selects the legacy v3 engine, which keeps reading version 1 YAML and the
existing `.workshop/state/workshop.db`; `--engine v4` names the default
explicitly. The selector must be the first argument, and an invalid, repeated,
or misplaced selector fails with exit 64 instead of falling back.

```bash
bun src/cli/main.ts status               # v4
bun src/cli/main.ts --engine v3 status   # legacy v3
bun src/cli/main.ts --engine v3 help     # v3 commands
```

Two unqualified commands keep their legacy meaning. `runtime progress|block`
still goes to v3, because running v3 agents call back through
`"$WORKSHOP_CLI" runtime ...` without a selector. `orchestrate` exits 64 and
points to `service start` or `--engine v3 orchestrate`, so the v3 daemon never
starts by accident. Workshop never migrates v3 files or state; see
[Migrating from v3](#migrating-from-v3).

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

The agent model comes from the machine config; see
[examples/workshop.yaml](examples/workshop.yaml).

## What happens when you run it

`workshop start hemingway-clock` admits a run and waits for it:

```mermaid
sequenceDiagram
  participant You
  participant CLI
  participant Svc as Service
  participant DB as Durable SQLite
  participant Proc as Command / agent

  You->>CLI: workshop start hemingway-clock
  CLI->>Svc: start (spawns the service if needed)
  Svc->>Svc: parse + check YAML, resolve settings
  Svc->>DB: admit run, freeze definition
  loop each node in the chain
    Svc->>Proc: spawn with WORKSHOP_* env
    Proc->>Svc: stdout (commands) or result file (agents)
    Svc->>Proc: validator, if any
    Svc->>DB: commit attempt, render WORKLOG.md
  end
  Svc->>CLI: run completed
  CLI->>You: completed <run-id>
```

- **Admission.** The service checks the YAML strictly, confirms one linear
  chain, freezes the definition, and admits the run in one Durable
  transaction. Editing the YAML mid-run changes nothing.
- **Attempts.** Each node execution is an attempt in its own process group.
  Agents get `WORKSHOP_PROMPT_FILE` and must write checked JSON to
  `WORKSHOP_RESULT_FILE`; stdout stays diagnostic. Commands produce stdout.
- **Failure.** A timeout, non-zero exit, invalid result, or validator rejection
  asks the native orchestrator for `retry`, `block`, or `fail`. A blocked run
  waits for `workshop resolve`.
- **Crashes.** After a restart the service reconciles every interrupted
  process. It repeats work automatically only where the node says
  `replay: safe`; otherwise the run blocks for an explicit decision.
- **Schedules.** The service owns recurrence. It keeps running after `start`
  returns, until `workshop service stop`.

### Worker processes

Workers, validators, and preflight run as `<shell> -lc '<command>'`, as in v3.
The login flag sources your shell profile, so its environment applies, and
anything the profile prints to stderr appears in each process's stderr
capture. Keep profile output quiet if it clutters `workshop logs`.

## What lands on disk

```text
.workshop/                          machine-local, gitignored
├─ config/
│  ├─ workshop.yaml                 machine defaults, `version: 2`
│  └─ workflows/<id>.yaml           your workflows, `version: 2`
└─ state/
   ├─ durable.db                    Durable SQLite, owned by the service
   ├─ service.json  service.lock  service.sock
   └─ runs/<workflow>-<uuid>/
      ├─ definition.yaml            frozen YAML
      ├─ WORKLOG.md                 rendered run log
      ├─ input/  output/            each node's previous and extracted output
      └─ captures/                  retained stdout and stderr per process
```

## Code map

Folders follow the domain nouns: a **workflow** definition, a **run** of it,
and each **attempt** at a node. Filenames lead with a verb that says what the
file does; `CONTRIBUTING.md` lists the verbs.

```text
src/
├─ cli/                  command groups; main.ts selects the engine (v4 default)
│  ├─ dispatch-v4-command.ts default v4 route and top-level help
│  ├─ dispatch-v4-public-command.ts public socket-only v4 client
│  ├─ service-v4.ts        `service start|status|stop`
│  ├─ watch-v4.ts          service-backed v4 viewer adapter
│  └─ dispatch-v3-command.ts legacy v3 route behind `--engine v3`
├─ load-installation.ts  v3: find .workshop/ and read machine defaults
├─ definition/           v1 definitions plus v2 contracts
│  ├─ parse-yaml.ts            strict YAML: no duplicate keys or anchors
│  ├─ schema.ts                v1 Zod workflow and machine schemas
│  ├─ check-chain.ts           shared v1/v2 linear-chain policy
│  ├─ load-definition.ts       v1 file/snapshot loader
│  ├─ resolve-node-settings.ts v1 node → workflow → machine settings
│  ├─ parse-model.ts           v1 provider/model:thinking parser
│  ├─ hash-canonical-json.ts   canonical definition and exact source hashes
│  ├─ schema-v2.ts             v2 workflow and machine schemas
│  ├─ schema-resolved-v2.ts    frozen node and internal-judge settings
│  ├─ check-v2-definition.ts   strict v2 text/schema/topology check
│  ├─ parse-v2-model.ts        supported v2 thinking-level parser
│  ├─ resolve-v2-agent-settings.ts v2 site → workflow → machine resolution
│  ├─ resolve-v2-workflow-settings.ts v2 workflow → machine resolution
│  └─ render-v3-migration-guidance.ts the error shown for v3 YAML
├─ installation/         session-scoped installation index and service receipts
│  ├─ load-v2-installation.ts  find .workshop/, refuse v3 config, load v2 workflows
│  └─ schema-v2.ts             run references, activations, reservations, preflight cache, receipts
├─ run/                  one run, start to finish
│  ├─ schema-v2.ts             v2 outcomes, judgment decisions, failure/block states
│  ├─ records-v2.ts            canonical run document and immutable evidence contracts
│  ├─ prepare-admission-v2.ts  check frozen definition, settings, and paths
│  ├─ decide-fixed-rate-schedule.ts fixed-rate slots, deadlines, and skip decisions
│  ├─ create-run.ts            reserve a run, freeze its definition
│  ├─ check-environment.ts     preflight, cached per definition hash
│  ├─ start-run.ts             create, preflight, first attempt
│  ├─ advance-chain.ts         execute pending attempts until the chain ends
│  ├─ orchestrate-failure.ts   an agent decides: retry, block, or fail
│  └─ recover-after-crash.ts   reconcile work orphaned by a crash
├─ attempt/              one node, once
│  ├─ parse-v2-result.ts          strict worker-result and validator-verdict envelopes
│  ├─ render-v2-agent-prompt.ts   fresh worker and validator prompts
│  ├─ execute-attempt.ts          claim → spawn → check → judge → merge → complete
│  ├─ build-attempt-env.ts        the WORKSHOP_* variables
│  ├─ render-agent-prompt.ts      node instructions plus the packet contract
│  └─ judge-output.ts             the node's validator
├─ service/              owner lifecycle and private versioned Unix protocol
│  ├─ acquire-service-lock.ts    kernel flock with process identity metadata
│  ├─ launch-v2-service-process.ts reuse a healthy owner or spawn a detached one
│  ├─ locate-service-socket.ts   short private path for long installations
│  ├─ open-v2-service-runtime.ts Durable Harness handlers, reconciliation, and close
│  ├─ parse-service-protocol.ts  checks bounded v1 requests and responses
│  ├─ probe-service-health.ts    checks metadata against a live socket
│  ├─ project-v2-service-reads.ts status, bounded run pages, and logs
│  ├─ send-service-request.ts    correlated response reassembly and retry
│  ├─ serve-v2-service-process.ts service-only process lifecycle
│  ├─ serve-workshop-service.ts  acquire-before-open, request dispatch, bounded shutdown
│  ├─ stop-v2-service-process.ts verified SIGTERM and bounded wait for exit
│  └─ schema.ts                 strict service methods, requests, and responses
├─ daemon/               v3 `orchestrate` loop: schedules and recovery
├─ model/                checked owner Pi model catalog and private Tally auth
│  ├─ schema-owner-models.ts       checked owner configuration shapes
│  ├─ create-workshop-models.ts    public pi-ai provider registry
│  ├─ load-owner-models.ts         loads provider metadata without retaining keys
│  ├─ parse-owner-models.ts        compiles supported model descriptors
│  └─ resolve-owner-provider-auth.ts request-time credential resolution
├─ process/              launch, identify, and kill child processes
│  ├─ launch-process.ts  bounded capture, stream evidence, and process groups
│  └─ schema-v2.ts       typed incarnation, exit, cleanup, and capture evidence
├─ proof/                isolated Pi Durable Hemingway experiment; not the CLI runtime
├─ worklog/              the packet and marker protocol, merges into WORKLOG.md
├─ storage/
│  ├─ durable/                 production Durable SQLite ownership and record tokens
│  │  ├─ open-durable-storage.ts      verifies FULL synchronization before opening
│  │  ├─ define-workshop-records.ts   versioned documents and immutable entries
│  │  ├─ admit-run.ts                 atomic prepared-run admission and idempotency
│  │  ├─ define-scheduler-wakeup-task.ts durable fixed-rate scheduler and run admission
│  │  ├─ commit-service-mutation.ts   atomic mutation effects and response receipts
│  │  ├─ define-workshop-tasks.ts         Durable workflow and judgment orchestration
│  │  ├─ define-node-attempt-task.ts       worker/validator execution, replay, stop, settlement
│  │  ├─ define-process-execution-task.ts shared role-aware process supervision and capture
│  │  ├─ define-capacity-gate-task.ts     persisted capacity wait and slot acquisition
│  │  ├─ render-v2-worklog.ts             renders the canonical run as Markdown
│  │  └─ materialize-run-views.ts          rebuilds local files from committed run state
│  ├─ db/                      SQLite schema and every guarded transition
│  └─ disk/                    run-directory paths, crash-safe writes, locks
├─ views/                versioned JSON and human renderings of state
│  └─ schema-v2.ts       strict version-2 public DTOs for status, runs, details, logs
├─ tui/                  the `watch` terminal viewer (OpenTUI)
└─ util/                 clock, ids, hashing, unit parsing, shared v2 schemas
   ├─ parse-units.ts     bounded v1/v2 duration and byte-cap parsing
   └─ schema-v2.ts      UTC timestamps, SHA-256 values, and shared replay policy
```

Dependencies point one way: `cli/` and `daemon/` → `run/` → `attempt/` →
`definition/`, `worklog/`, `storage/`, and `process/`. `service/` uses `model/` to assemble native-judgment providers. Two rules keep it that way:

- `views/` is the contract for outside readers. `status --json` and
  `runs --json` have versioned shapes, and the viewer reads those, never SQLite
  or run directories.
- Only `tui/` imports a UI library; `cli/watch.ts` and `cli/watch-v4.ts` load
  it lazily. A test fails if runtime code imports it.
## Quick start

```bash
bun install
mkdir -p .workshop/config/workflows
cp examples/workshop.yaml .workshop/config/
cp examples/workflows/hemingway-clock.yaml .workshop/config/workflows/

bun src/cli/main.ts validate hemingway-clock
bun src/cli/main.ts start hemingway-clock
bun src/cli/main.ts logs hemingway-clock
bun src/cli/main.ts service stop
```

Edit the copied `workshop.yaml` first: its models are placeholders. The example
needs `pi` on your PATH, a model your Pi installation can use, and a
Tally-backed orchestrator model for failure judgment (see below). A successful
run stamps the time, writes and validates one sentence, and publishes it to
`.workshop/state/v4/quotes/<run-id>.md`. `validate` is offline; `start` starts
the service if it is not running.

### Commands

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

Run any of them as `bun src/cli/main.ts <command>`; `help` lists them. Exit
codes: 0 success, 1 failed or cancelled run, 2 blocked run, 3 service
unavailable, 64 usage or configuration error.

`service stop` has no protocol shutdown call. It sends SIGTERM only after the
service's socket answers with the recorded PID and boot ID and the PID's
process-start time still matches, then waits up to 15 s for the process to
exit. A PID that cannot be verified is never signalled; the command exits 3.

The viewer reads service-backed projections, shows selected historical chains, and retains the picker, occurrence navigation, follow/collated worklogs, narrow-terminal layout, and clean quit. Human run times use the machine-local clock; JSON retains UTC timestamps.
Raw worker and validator streams retain a UTF-8-safe head/tail window after the process group retires. For successful command workers, semantic stdout is extracted before raw-file retention. `logs` reports total, retained, omitted, head, and tail byte counts. The cap applies to raw diagnostics, not extracted command output, and it is not a live disk quota. Use `stream_cap: unlimited` to opt out.

Native failure judgment compiles Tally-backed provider entries from `~/.pi/agent/models.json` (or `PI_CODING_AGENT_DIR/models.json`) through public `@earendil-works/pi-ai` APIs. It accepts the checked OpenAI Responses, OpenAI Completions, and Anthropic Messages adapters at their fixed Tally routes. Model entries need explicit pricing; entries without rates are omitted rather than assigned a zero cost. Credentials and the `X-Tally-User`/`X-Tally-Hostname` headers are resolved from the owner file for each auth operation; command credentials, custom auth headers, and non-Tally endpoints are rejected. Fake-fetch tests check request URLs, auth and attribution headers, and a synthetic streamed response. This proves SDK wiring only, not Gateway availability or real-model judgment; no live or paid request ran.

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

These shell flags have **not** been checked against installed Pi, OpenCode, or Claude Code binaries by the v4 tests. The automation checks the workflow contract and exercises two different mock harness mappings; it makes no vendor CLI or model call. Confirm each installed CLI's current flags and permission behavior before using a template. Approval/auto modes can grant broad project access; run only on a trusted machine.

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

## Migrating from v3

A v3 installation keeps working unchanged through `--engine v3`. The default
engine refuses it with exit 64 and a list of edits when the machine config has
no `version: 2`, when there is no machine config but `state/workshop.db`
exists, or when a workflow says `version: 1`. Workshop never rewrites v3 YAML,
config, or state. To migrate, edit the files yourself:

- Add `version: 2` to `.workshop/config/workshop.yaml` and every workflow.
- Replace packet-write instructions with result-file instructions: agents
  write checked JSON to `WORKSHOP_RESULT_FILE`.
- The internal orchestrator no longer takes a harness command; configure its
  native model under `orchestrator: { model }`.
- Mark repeat-safe workers and validators `replay: safe`.
- Use `max_runs: unlimited` for an indefinite schedule instead of a numeric
  `max_runs` <= 0.
- Read `status --json` and `runs --json` as JSON `version: 2`.
- Replace `workshop orchestrate` with `workshop service start` (detached) or
  `workshop service serve` (foreground).
- Drop `WORKSHOP_NODE_PACKET_FILE`, packet markers, and
  `"$WORKSHOP_CLI" runtime progress|block` from agent instructions; v4 has no
  packet runtime commands. Progress belongs in the agent's streams or result
  summary.
- Replace shared-file appends with idempotent per-run files, as the Hemingway
  example does. Old archives are not rewritten.

The legacy example lives at
[examples/workflows/v3/hemingway-clock.yaml](examples/workflows/v3/hemingway-clock.yaml).

### Running both engines

Both engines use `.workshop/state`, but their files are distinct: v3 owns
`workshop.db`, `daemon.lock`, and `preflight-*`; v4 owns `durable.db`,
`service.json`, `service.lock`, and `service.sock`. They also share
`state/runs/`. Run IDs cannot collide there, because v3 names runs
`<workflow>-YYYYMMDD-NNN` and v4 names them `<workflow>-<uuid>`, and neither
engine scans the directory. Each engine still reads only its own runs, so
inspect v3 history with `--engine v3`.

The v3 daemon and the v4 service do not coordinate. The supported path is to
stop the v3 daemon and let open v3 runs finish, then write the `version: 2`
files and start the v4 service. Running both daemons against one installation
is untested.

## Legacy v3 engine

Everything in this section applies only with `--engine v3`.

### What happens when you run it (v3)

`workshop --engine v3 start hemingway-clock` runs the whole chain in the foreground:

```mermaid
sequenceDiagram
  participant You
  participant CLI as CLI + runner
  participant DB as SQLite
  participant Dir as Run directory
  participant Proc as Command / agent

  You->>CLI: workshop --engine v3 start hemingway-clock
  CLI->>CLI: parse + validate YAML
  CLI->>DB: reserve run
  CLI->>Dir: freeze definition.yaml, create WORKLOG.md
  CLI->>CLI: check environment (preflight)
  CLI->>DB: create pending attempt for node 1
  loop each node in the chain
    CLI->>DB: claim attempt
    CLI->>Proc: spawn with WORKSHOP_* env
    Proc->>Dir: write packet.md (agents) or stdout (commands)
    CLI->>Proc: judge output (validator)
    CLI->>Dir: merge packet into WORKLOG.md
    CLI->>DB: complete attempt + create next node's attempt
  end
  CLI->>You: run → completed
```

Step by step:

1. **Load.** `definition/` parses the YAML strictly, checks it with a Zod
   schema, and confirms the nodes form one linear chain.
2. **Create the run.** `run/create-run.ts` adds the run row to SQLite, then writes a frozen
   copy of the YAML and an empty worklog into the run directory. The run uses
   the frozen copy from here on, so editing the YAML mid-run changes nothing.
   A second `start` while a run is open does nothing.
3. **Check the environment.** `run/check-environment.ts` executes the optional
   `environment.preflight` command (here, `command -v pi`), which must exit 0.
   Workshop caches a pass per definition hash.
4. **Advance the chain.** `run/advance-chain.ts` loops. For each pending attempt,
   `attempt/execute-attempt.ts` does the work described in the next section.
5. **Finish.** When the last node completes, the run completes. The final
   output sits in the worklog under `<workflow-output>`.

#### One attempt, up close

Each node execution is an **attempt**. `attempt/execute-attempt.ts` takes it through a
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
   | `WORKSHOP_WORKLOG_FILE` | the run's worklog, read-only |
   | `WORKSHOP_MODEL`, `WORKSHOP_THINKING`, … | the resolved model, split several ways |
   | `WORKSHOP_CLI` | lets an agent call `runtime progress` or `runtime block` |

4. **Check integrity.** An agent must leave the worklog untouched and its
   packet well-formed, marker pair included.
5. **Extract output.** A command's output is its stdout. An agent's output is
   the text between `<next-node-output id="…">` markers in its packet (or
   `<workflow-output>` on the last node).
6. **Judge**, if the node has a `validator:`. A command validator passes on
   exit 0; an agent validator writes `validation.json` with `{"passed": …}`.
7. **Merge** the packet into `WORKLOG.md` under a file lock, and write a
   receipt so a repeated merge does nothing.
8. **Complete** the attempt and create the next node's pending attempt in one
   SQLite transaction.

Attempt states: `pending → running → finishing → completed`, or `failed`,
`blocked`, `cancelled`.

#### When something fails

A timeout, a non-zero exit, a broken packet, or a validator rejection fails the
attempt and marks the run as needing judgment. Workshop then starts a fresh
orchestrator agent. It reads the worklog and the failed attempt's evidence,
then writes one decision to `result.json`:

- `retry` creates a new attempt for the same node, up to `max_attempts`.
- `block` pauses the run until you fix something and run `workshop --engine v3 resume`.
- `fail` ends the run.

Workshop records the decision in the worklog's "Global decision log" and
applies it. A crash needs no judgment: recovery confirms the old process is
dead and retries the attempt deterministically.

#### Recurring workflows: the daemon

`start` runs only the first occurrence. For a `schedule:`, run the guardian in
another terminal:

```bash
bun src/cli/main.ts --engine v3 orchestrate
```

`daemon/reconcile-loop.ts` is a single process that polls SQLite once a second. Each tick it:

1. recovers interrupted work (`run/recover-after-crash.ts`),
2. creates due occurrences, one open run per workflow (`daemon/create-due-runs.ts`),
3. creates first attempts for queued runs,
4. runs pending orchestrator judgments,
5. launches pending attempts within `max_concurrent_runs`, through the same
   `advanceChain` the CLI uses.

### What lands on disk (v3)

```text
.workshop/                          machine-local, gitignored
├─ config/
│  ├─ workshop.yaml                 machine defaults (optional)
│  └─ workflows/<id>.yaml           your workflows
└─ state/
   ├─ workshop.db                   SQLite: workflows, runs, node_attempts
   └─ runs/<run-id>/
      ├─ definition.yaml            frozen YAML
      ├─ WORKLOG.md                 the run's shared log
      ├─ nodes/002-node-generate-line/attempt-001/
      │  ├─ prompt  packet.md  stdout  stderr  output
      │  ├─ validation/             validator prompt, logs, verdict
      │  └─ merge-receipt.json
      └─ orchestrator/<token>/      prompt.md  result.json  logs
```

### Configuration (v3)

A v3 `.workshop/config/workshop.yaml` holds machine defaults, has no
`version` key, and every field is optional:

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

#### Harnesses

Any CLI agent works if a shell command can launch it with a prompt file:

| Harness | Command |
| --- | --- |
| Pi 0.85 | `pi --print --mode json --approve --no-session --model "$WORKSHOP_MODEL_WITH_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` |
| OpenCode 1.18 | `opencode run --format json --auto --model "$WORKSHOP_MODEL" --variant "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` |
| Claude Code 2.1 | `claude --print --output-format text --permission-mode auto --no-session-persistence --model "$WORKSHOP_MODEL_ID" --effort "$WORKSHOP_THINKING" -- "$(cat "$WORKSHOP_PROMPT_FILE")"` |

These are legacy v1 templates. Their listed versions and flags are historical examples, not verified v4 support; check current CLI behavior before use. Approval modes can grant broad tool access, so run only on a trusted machine.

## Scope and status

Workshop is a proof of concept for trusted, local workflows. It runs with your
permissions and has no sandbox, no untrusted input, no branching graphs, and
no budgets. Starting a workflow authorizes every command and agent in it.
Workshop repeats a node after a crash only when it says `replay: safe`; mark
only idempotent work that way.

| Stage | Proves | Status |
| --- | --- | --- |
| POC-A | runtime: durable chain, worklog, SQLite, validators, recovery | done |
| POC-B | status viewer over the CLI projections | done |
| v4 | Pi Durable engine as the default, with v3 parity | done |
| POC-C | `$build-workflow` authoring skill | next |
| POC-D | notification channels | later |

Known limitations of the v4 engine:

- Tested on macOS only. The service loads a native SQLite binding and refuses
  to start if that binding cannot load; Linux (glibc and musl) is untested.
- No upgrade migration. Each run records the task versions it started with.
  If a later Workshop release changes a task version incompatibly, it blocks
  the old run instead of guessing. Finish or stop runs before upgrading.
- `service start` discards the service's stdout and stderr, so a failed
  startup shows only the CLI error. Run `workshop service serve` in the
  foreground to see the cause.
- `workshop --engine v3` against a `version: 2` config fails with v3's raw
  schema error rather than migration guidance.

## Pi Durable proof

Before the v4 service existed, an isolated proof checked Pi Durable for
Workshop's task execution and one subprocess interface for every command,
headless agent, and validator. Read the implementation contract in
[workshop-spec-v4.md](.agents/dox/workshop-spec-v4.md).

The isolated proof uses real Durable SQLite storage and launches a mock agent
in a separate process. It checks result JSON, publishes one quote file per run,
and preserves the same run on reopen:

```fish
set proof .workshop/state/proofs/hemingway/mock-(date +%s)
bun src/proof/prove-hemingway.ts --state-dir $proof
bun src/proof/prove-hemingway.ts --state-dir $proof
bun test tests/proof/
```

Use a new state directory for a new run. Add `--pause-after timestamp` to
close at a committed boundary, then reopen without that flag. To use real Pi
with its configured default model and credentials:

```fish
set real .workshop/state/proofs/hemingway/real-(date +%s)
bun src/proof/prove-hemingway.ts --state-dir $real \
  --agent-command 'pi --print --approve --no-session --tools write -- "$(cat "$WORKSHOP_PROMPT_FILE")"'
```

The quoted agent command is a Bash template executed by the proof, not fish.
The proof archives inside its own state directory; it leaves existing quotes
and v3 state untouched. Tests cover actual reopen/crash/stop behavior, whole
process-group cleanup, strict result checking, and upstream SQLite storage
conformance under Bun with FULL synchronization.

The proof is not the v4 service and does not load workflow YAML. Its
scratch-directory lock is not the service ownership protocol.

## Development

```bash
bun test          # acceptance tests against mock harnesses
bunx tsc --noEmit # typecheck
```

`tests/check-v2-service-restart.test.ts` runs the deterministic Hemingway mock
through the v4 CLI in a temporary installation, restarts the service,
and checks the same Durable run. It needs no model credentials. The real-model
path has one manual check: the quick start above. Read `CONTRIBUTING.md`
before adding or renaming a file.

- Current spec: `.agents/dox/workshop-spec-v4.md`
- Legacy v3 spec: `.agents/dox/workshop-spec-v3.md`
- Build history and bug log: `.agents/dox/2026-09-10-workshop-execution.md`
