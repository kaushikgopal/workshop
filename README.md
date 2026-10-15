# Workshop

Workshop runs local workflows, once or on a schedule, and records progress so
runs survive service restarts.

A workflow is a YAML **chain of steps**. Each step starts a shell command or a
headless agent. Its accepted output feeds the next step. An optional verifier
checks the result before the chain advances. Normal progress needs no model;
only agent workers and agent verifiers make model calls.

## Quick start

Workshop keeps configuration and state in a project's `.workshop/` directory.
Run these commands from this repository in fish:

```fish
bun install
set -g workshop_repo $PWD
function workshop
    bun "$workshop_repo/src/cli/main.ts" $argv
end
mkdir -p ~/scratch/hemingway/.workshop/workflows
cp "$workshop_repo/examples/workshop.yaml" ~/scratch/hemingway/.workshop/
cp "$workshop_repo"/examples/workflows/*.yaml ~/scratch/hemingway/.workshop/workflows/
cd ~/scratch/hemingway
```

Set `agent.model` in `.workshop/workshop.yaml` to a model your Pi installation
can use. The example model is a placeholder.

WARNING: Workflows use your permissions. Review commands and agent instructions
before starting a workflow. Agent workers and verifiers run coding tools
without asking.

### Watch it work

hemingway-retry rejects the timestamp's first attempt with a command verifier.
The retry passes. An agent writes an original sentence, and an agent verifier
checks it. Both agents read earlier accepted sentences from the workflow's
results.md file. There is no publish step. A successful first agent attempt
makes two model calls.

~~~fish
workshop validate hemingway-retry
workshop start hemingway-retry --detach
workshop watch hemingway-retry
~~~

Press q to close the viewer. Inspect the completed run:

~~~fish
workshop status
workshop diagram hemingway-retry
workshop step describe hemingway-retry timestamp --json
workshop logs hemingway-retry
cat .workshop/state-v5/hemingway-retry/results.md
workshop service stop
~~~

The other example, hemingway-clock, schedules six runs ten minutes apart.
Each run adds a tagged section to the same results.md and execution.log files.
workshop stop hemingway-clock disables its schedule and cancels its open run
after safe process cleanup. service stop shuts down the service, not the saved
schedule.

Try the human approval example:

~~~fish
workshop start hemingway-approve --detach
workshop status hemingway-approve
workshop reply hemingway-approve --continue --answer 'Approved.'
cat .workshop/state-v5/hemingway-approve/results.md
~~~

Continue completes the draft run. The answer appears after its result block.
The workflow needs no publish step.

## How it works

One background service per installation owns the database and schedules. The
CLI uses a private Unix socket. The service commits progress before taking the
next action. It retires leftover command process groups before recovery can repeat work.

Command workers, command verifiers, and preflight are processes. Agent
workers and agent verifiers run as native conversations inside the service.
Command processes share the same channels:

| Channel | Contents |
| --- | --- |
| stdin | Input: previous output for command workers, the candidate output for command verifiers; preflight gets empty stdin |
| stdout | Result, parsed after exit |
| stderr | Progress and diagnostics, available as live previews and retained evidence |

For a command, exit zero is necessary for success. Nonzero exit fails even when
stdout claims success. A process may ignore stdin or close it early; early
closure is evidence, not a failure by itself.

Agent conversations take the prompt as text and return the final assistant
text. Each turn and each tool result commits before the next. This gives
recovery, not exactly-once: a replayed segment may repeat model calls. An
interrupted tool call whose outside outcome is unknown blocks the run; a
completed call with a committed receipt resumes.

Each attempt starts a worker, parses its result stream, and checks a configured verifier.
Accepted results advance the chain, complete it early, or create a human wait.
Failures follow fixed retry rules. Blocks require an explicit resolution.
When the concurrent-run limit is full, new work waits for capacity.

### Things that are easy to get wrong

- **Admission freezes the definition and settings.** YAML edits affect new runs only.
- **Retries and crash replay differ.** `retries: 2` permits three attempts.
  Crash replay does not consume retries; each command process execution
  permits at most two crash relaunches.
- **Every step needs an explicit policy.** Set `retries` and `replay` on
  the step or in workflow `defaults`. Workshop supplies neither default.
- **Repeating work needs permission.** `replay: safe` permits configured retries
  and automatic crash replay. `replay: never` requires `retries: 0`;
  an unknown external outcome blocks instead of repeating automatically.
- **Agent interruptions recover, not repeat.** An agent commits each turn and
  tool result. An interrupted tool call with an unknown outside outcome blocks
  the run; a completed call with a committed receipt resumes.
- **Verifiers must not mutate external state.** They always replay safely after
  a crash. Workshop repeats a verifier on saved evidence, not its successful worker.
- **Retry exhaustion fails the run.** Two identical consecutive failures block
  as `repeated_failure` instead. A broken verifier blocks as `verifier_failed`.
- **Open runs suppress overlapping scheduled occurrences.** Blocks and human
  waits keep a run open. Terminal failures release capacity and allow the schedule
  to continue. After downtime, only the latest missed slot runs.

WARNING: `retries: unlimited` can incur continuing model and tool costs.
The repeated-failure guard stops only identical consecutive failures.

See [CONTRIBUTING](CONTRIBUTING.md#how-the-code-works) for the architecture.

## A workflow

Save this as `.workshop/workflows/hemingway-clock.yaml`. The filename is the
workflow ID. The full example checks for Pi and compares earlier accepted
sentences in results.md.

~~~yaml
version: 4
schedule: { every: 10m, max_runs: 6 }
defaults:
  retries: 1
  timeout: 10m
  replay: safe
environment:
  preflight: { command: 'command -v pi >/dev/null' }
steps:
  - timestamp: date -u +%FT%TZ
  - generate-line:
      agent: |
        Read earlier accepted sentences from $WORKSHOP_RESULTS_PATH.
        Draft one original sentence.
        Write only the sentence to stdout. Do not add an explanation or commentary.
      verify:
        agent: Compare the candidate with earlier accepted sentences in $WORKSHOP_RESULTS_PATH.
~~~

A step body is a command string, `run: <command>`, or `agent: <instructions>`.
An agent also accepts `{ instructions, model, harness }`. Step options are
`retries`, `replay`, `verify`, `result`, `timeout`, and `stream_cap`.

`verify` accepts a command string, `run: <command>`, or `agent: …`, with
no other fields. It inherits the step's timeout and stream cap. Agent verifier
settings resolve from the verifier, workflow defaults, and machine defaults,
not from the worker's agent settings.

Top-level `instructions` adds shared text to all worker and verifier prompts.
Workflow, worker, and verifier instructions each permit at most 64 KiB in UTF-8.
An optional `environment.preflight` object takes `command` and optional
`timeout`. It runs before the first step with empty stdin.

### Result formats

`result: text` is the default for every worker, including agents. The complete
result stream — stdout for a command, final assistant text for an agent —
becomes the output without trimming or tag interpretation. A zero exit or a
completed agent execution creates a `succeeded` candidate. A configured
verifier must accept it before the step succeeds. Set `result: tagged`
explicitly when a worker needs
`needs_input` or `success_and_complete`. Text mode never infers those statuses
from instructions or output. Agent verifiers use a strict decision-line format.

Existing runs keep their frozen result modes. New admissions of YAML that relied
on the former implicit tagged default for agents use text.

A tagged worker writes these blocks to its result stream in this order:

```text
<status>success_and_complete</status>
<reason>No new findings.</reason>
<output>
Nothing requires action.
</output>
```

- `status` is required: `succeeded`, `success_and_complete`, or `needs_input`.
- `reason` is optional explanatory text.
- `question` follows `reason` when present. It is required only for
  `needs_input` and forbidden for the other statuses.
- `output` is required. It may be empty except with `needs_input`.

Accepted `success_and_complete` completes the run immediately and marks
unexecuted successors `skipped`. It never bypasses a configured verifier.

An agent verifier writes a decision line and a reason:

```text
accept
The candidate is original and distinct from earlier results.
```

After trimming each line, exactly one line must equal accept, retry, or block.
Analysis before the decision line is allowed but optional. Ignore that analysis
for the decision; retain the raw output as evidence. The text after the decision
line, trimmed, is the required, nonempty reason. For retry, the reason tells the worker
what to change. Do not search inside sentences, change case, or strip Markdown.
The reason permits at most 64 KiB in UTF-8.
No compatibility mode exists; all other formats are invalid. Command verifiers
accept by exiting zero; their stdout is evidence, not a verdict.

Tagged worker blocks are flat, without attributes or escaping. Workshop ignores
preamble and trailer text but retains both as evidence. The opening status
block must start a line. Blocks follow the declared order with only whitespace
between them. The last block ends at its last closing tag, so output can contain
its own closing-tag text. Workshop removes one boundary newline, not all
whitespace.

Workshop rejects invalid UTF-8, duplicate or unknown worker blocks, and output
over 1 MiB. Tagged worker reason and question fields permit at most 64 KiB.
When present, these fields must contain non-whitespace text. A tagged status is
only a proposal until verification accepts it. Agent verifier output also
rejects invalid UTF-8 and output over 1 MiB.

### Verification and feedback

Command verifiers receive the candidate output on stdin. They run only on valid
candidates. Agent verifiers receive a prompt with candidate status, output,
retry state, and earlier feedback. When a worker fails and retries remain,
an agent verifier can inspect failure evidence and request `retry` or `block`,
never `accept`.

A rejection retries only when retries remain and `replay: safe` permits it.
Otherwise the run fails. A verifier always checks a valid candidate, even with
`retries: 0`. Verifier launch errors, timeout, invalid verdicts, and command exit
126/127 block rather than repeating worker effects. Other nonzero command
verifier exits reject the candidate. A native verifier that ends without a
checked receipt blocks.

Workshop saves bounded feedback before a retry. Agent workers receive it in
the next prompt. Command workers receive the same stdin without feedback.
Feedback cannot grant replay permission or human approval.

### Human waits

A tagged worker can request a decision:

```text
<status>needs_input</status>
<question>Submit this proposal?</question>
<output>
Submit request R-42 for 120 USD to the fake service.
</output>
```

After verification, Workshop saves the exact proposal and question with a wait
ID. The worker stops; the wait holds no capacity slot. Read the proposal with
`workshop status <workflow>` or `workshop step describe <workflow> <step> --json`.
Reply explicitly:

```fish
workshop reply submission --continue --answer 'Approved.'
# Or reject the proposal:
workshop reply submission --reject --answer 'The amount is too high.'
```

Here `submission` is the workflow that requested the wait. Continue accepts
the saved output and starts only the successor after capacity is available.
The run keeps its identity: it releases its slot while waiting and reacquires
one for the successor.
The successor receives the proposal on stdin and `WORKSHOP_ANSWER` for a
command, or the answer in an agent prompt. Reject cancels this occurrence without
disabling its schedule. A conflicting or stale reply cannot advance the run.

Continue while paused saves the next position; Resume starts it exactly once.
Final-step Continue completes even while paused. Stop cancels a waiting run.

### Process environment

| Variable | Contents |
| --- | --- |
| `WORKSHOP_RUN_ID`, `WORKSHOP_WORKFLOW_ID` | Run and workflow identity |
| `WORKSHOP_STEP_ID`, `WORKSHOP_ATTEMPT` | Step and attempt number; preflight uses empty step and attempt 0 |
| `WORKSHOP_EXECUTION_ID` | Process execution identity |
| WORKSHOP_RESULTS_PATH, WORKSHOP_LOG_PATH | The workflow's single live results.md and execution.log files in .workshop/state-v5/<workflow-id>/ |
| `WORKSHOP_CANDIDATE_STATUS`, `WORKSHOP_RETRIES_LEFT` | Command verifier candidate status and retries left (`n` or `unlimited`) |
| `WORKSHOP_ANSWER` | Committed answer for an answered wait's immediate successor and its verifier |
| `WORKSHOP_PROVIDER`, `WORKSHOP_MODEL_ID`, `WORKSHOP_MODEL` | Agent provider, bare model ID, and provider/model |
| `WORKSHOP_THINKING`, `WORKSHOP_MODEL_WITH_THINKING` | Agent thinking level and full model string |

Command processes and agent tool shells receive these values for their execution.

## Commands

| Command | Does |
| --- | --- |
| `validate <workflow>` | Check YAML and resolved settings offline |
| `start <workflow> [--detach]` | Admit a run and enable its schedule; wait unless detached |
| `pause <workflow>` | Stop new dispatch; let the active step finish |
| `resume <workflow>` | Resume paused work |
| `stop <workflow>` | Disable the schedule and cancel the open run after cleanup |
| `resolve <workflow> --action retry\|accept\|fail --reason <text> [options]` | Resolve a permitted block action |
| `reply <workflow> --continue\|--reject --answer TEXT` | Answer the current human wait |
| `chat` | Open the shared bot conversation and pending decisions |
| `status [<workflow>] [--json]` | Open the viewer on a TTY; otherwise print a snapshot |
| `watch [<workflow>] [--json]` | Alias for status |
| `runs <workflow> [--json] [--all]` | Run history, newest first; default page is byte-bounded |
| `logs <workflow> [--run <run-id>] [--follow \| --all] [--json \| --verbose]` | Worklog and retained process captures |
| `diagram <workflow> [--run <run-id>] [--mermaid]` | Chain with run status |
| `step describe <workflow> <step> [--run <run-id>] [--json]` | Frozen settings and attempt evidence |
| `service start` | Start or reuse the detached service |
| `service serve` | Serve in the foreground |
| `service status [--json]` | Service health, PID, and boot ID; exit 3 if not running |
| `service stop` | Graceful, idempotent service shutdown |

`bun src/cli/main.ts help` lists commands. Except for help and validation,
commands use the service. Public workflow commands start it when needed.

Exit codes: 0 success or a saved human wait; 1 failed or cancelled run; 2 blocked
run; 3 service unavailable; 64 usage or configuration error.

`service stop` signals only a verified service owner. It waits up to 15 seconds.
If it cannot verify the owner, it exits 3 without signaling another process.

### Blocks and resolution

The service enforces actions by block kind. The CLI acts with human authority:

| Block kind | Allowed actions |
| --- | --- |
| `verifier_block`, `repeated_failure`, `preflight_failed` | `retry` or `fail` |
| `verifier_failed` | `retry` the verifier on saved evidence, or `fail` |
| `external_outcome_unknown` | `retry --allow-repeat`, `accept --result-file … --acknowledge-effects`, or `fail` |
| `process_death_unconfirmed` | `retry --allow-repeat` or `fail`; cleanup must still be confirmed |
| `integrity_failed`, `runtime_incompatible` | `fail` only |

All actions require `--action` and a nonempty `--reason`. Optional `--run`
pins the current blocked run. A block retry grants one dispatch outside the
configured retry count. Acceptance supplies UTF-8 worker output in the frozen
text or tagged mode; it cannot fabricate a verifier pass.

WARNING: `--allow-repeat` permits repeated external effects. Confirm the
outside outcome before choosing it. Workshop provides no exactly-once guarantee.

## Configuration

`.workshop/workshop.yaml` holds optional machine defaults
([example](examples/workshop.yaml)):

```yaml
shell: /bin/bash
max_concurrent_runs: 1
default_timeout: 10m
stream_cap: 256kb
agent:
  model: example/pi-model:medium
```

Machine `version` is optional; when present it must be `3`. Workflows must
declare `version: 4`. `project_dir` resolves relative to `.workshop/`.

NOTE: Machine `keep_files` is accepted but ignored. Machine `orchestrator` is removed. Set `bot.model` to configure the shared bot.

Agent fields resolve independently: worker or verifier, then workflow
`defaults.agent`, then machine `agent`. A model must resolve; there is no
default model. Model strings use `<provider>/<model-id>:<thinking-level>`.
Timeout resolves from step, workflow defaults, machine `default_timeout`,
then 10 minutes. Stream cap resolves the same way, then 256 KiB.
Durations accept `ms`, `s`, `m`, `h`, `d`, or `w`. Timeout and stream
cap also accept `unlimited`. Byte caps use strings such as `"1024"`,
`256kb`, or `1mb`.

### Agent runtime

`harness: pi` is the default and the only agent runtime; the selector is
optional. Agents run as native conversations inside the service, not as
subprocesses. Each execution gets its own conversation with a fixed
coding-tool set. Model, thinking level, working directory, and shell resolve
at admission and freeze for the run.

Each turn and each tool result commits to the conversation. After an
interruption the execution resumes from the last commit. Recovery is not
exactly-once: a replayed segment may repeat model calls.

The final assistant text is the worker's or verifier's result stream, capped
at 1 MiB. Worker results follow the step's result mode. Agent verifiers emit
exactly one line containing only accept, retry, or block. Analysis may come
first; a nonempty reason follows the decision.

Custom `harness.command` values are no longer supported; validation rejects
them.

### Command processes

Command workers, command verifiers, and preflight use
`<shell> -c '<command>'` in separate process groups. This has "sh -c"-style semantics, not login-shell semantics. Login dotfiles are not sourced.
Stdout retains at most 1 MiB independently of `stream_cap`. Stderr retains a
head-and-tail window under the cap. Logs report retained and omitted bytes.

Separate preparation from hard-to-undo actions. Verify the exact proposal,
request a human wait when approval is required, and submit the approved stdin
unchanged. Action commands must enforce limits and prevent duplicates themselves.

## What lands on disk

~~~text
.workshop/
├─ workshop.yaml                    optional machine defaults
├─ workflows/<workflow>.yaml        workflow definitions
└─ state-v5/
   ├─ durable.db                    service-owned database
   ├─ service.json  service.lock    service identity and ownership
   ├─ captures/<run-id>/            temporary process captures
   └─ <workflow-id>/
      ├─ results.md                 accepted outputs and human answers
      ├─ execution.log              labeled execution evidence
      ├─ results-<UTC timestamp>-<admission-sequence>-<rotation-id>.md.gz  rotated results
      └─ execution-<UTC timestamp>-<admission-sequence>-<rotation-id>.log.gz  rotated execution evidence
~~~

The private socket may live outside state-v5/ to meet Unix socket path limits.
Ignore .workshop/ in Git.

Each workflow has one live results.md and one live execution.log. Each file
holds whole run sections in admission order. Each wrapper shows the run ID,
run tag, admission time, admission sequence, and mutable state. The mutable
state is true while the run is open. It becomes false after terminal settlement. Result tags
remain result-<step-id>-<run-tag>, answer-<step-id>-<run-tag>, and
skipped-<step-id>-<run-tag>. Answered waits add an answer block directly after
the result. Agents search results.md for earlier accepted output by its exact
tag. Older run sections live in timestamped .gz files beside results.md.

Before adding a run section would push a live file past 10 MiB, Workshop gzips
the current file and starts a new file. Workshop never splits a run section.
One oversized run may exceed the cap in a fresh file. Workshop keeps the five
newest rotations per file kind per workflow. Rotation names include the maximum
admission sequence and a unique ID. A restart does not restore runs older than
the oldest retained rotation.

execution.log contains engine events, stderr, invalid stdout, preamble, trailer,
feedback, and resolutions. Every section and process record has run and process
labels. The database retains raw evidence. workshop logs exposes it through the
service. Native agent executions surface as receipts: execution ID,
conversation ID, assistant entry ID, and final-text hash. They carry no
process identity.
Stdout and stderr remain separate, without reconstructed interleaving.

The captures/ directory holds temporary command stdout and stderr files. The service
imports retained bytes into Durable state before cleanup, and it keeps unresolved
captures across restart.

These live files are read-only views of committed state. Deleting them lets the
service rebuild missing sections without repeating work. Refreshes add missing
sections, update open sections, and preserve existing finished sections. Editing a
file changes neither accepted output nor run state. The service never deletes existing
.workshop/runs/ or .workshop/archive/ directories from older installations; it
leaves them in place and does not use them.

CAUTION: Workshop adds no automatic expiration or database purging. Evidence
grows with each attempt, including unlimited retries.

## Shared bot and chat

Set `bot.model` in `.workshop/workshop.yaml` to enable the one shared service bot:

```yaml
bot:
  model: example/pi-model:medium
```

The bot has no default model. Without `bot.model`, Workshop shows `Bot not configured`
and makes no bot model calls. At service startup, Workshop resolves `bot.model`
against built-in Pi providers and supported providers in `~/.pi/agent/models.json`.
Set `PI_CODING_AGENT_DIR` to use another Pi agent directory. Startup fails with a
configuration error when the provider or model is unavailable. Service status and
`chat.view` show the resolved provider ID and model ID. They never show credentials.
The bot reads status, runs, and logs. It can start
workflows and resolve only the block kinds that section 7 permits. Its block resolution
uses the same checked service path as the CLI. The service limits the bot to one
resolution per node in each run.

The service stores the bot conversation and its event cursor in Durable state.
It submits committed wait, block, and terminal events with their stable event IDs.
The cursor advances after Durable accepts each submission. A service restart can
retry a submission without creating a second turn. First-time bot configuration
starts at current history and does not replay older events.

Run `workshop chat` in a TTY to open the conversation. Enter sends a message.
The pending area shows open waits and human-only blocks. Select a wait with Tab.
Enter `/continue ANSWER` or `/reject ANSWER` to submit an explicit human decision.
Select a block with Tab. Enter `/resolve retry REASON`, `/resolve fail REASON`,
or `/resolve accept FILE --acknowledge-effects` when its block permits that action.
A retry for an unknown outside outcome also requires `--allow-repeat` before its reason.
Ordinary chat text never answers a wait. The bot has no wait-reply tool.

On a TTY, `status` opens two screens. The overview has three columns:
**Title**, **Status**, and **Next run**. The shared bot feed appears below the table.
Arrow keys or `j`/`k` select a workflow; Enter opens its detail screen.
Next-run times use the machine's local time.

The detail screen shows the chain vertically. Running command steps preview
live stderr; agent steps have no process stream;
succeeded steps show accepted output; failed or blocked steps show failure evidence.
Skipped steps have no preview. Previews show 40 lines; `e` expands the selected
step. Escape or Backspace returns to the overview. `q` quits.

`status <workflow>` opens detail directly. `watch` is an alias. JSON output
and non-TTY output remain snapshots. Reads use only service projections, without
model calls. Bot failures do not stop deterministic workflow chains. Bot model calls require bot.model.

Workshop is for trusted local workflows. It has no sandbox, branching, rollback,
or exactly-once external effects. Tested on macOS; Linux is untested. The service
requires its native SQLite binding. Use `service serve` to diagnose startup errors;
detached startup discards service stdout and stderr.

### Upgrade

WARNING: Run one build at a time against an installation. Overlapping old and
new runs can repeat external effects. v5 cannot enforce draining because it
never reads the old state.

Finish or stop open runs and stop the old service using the old build first.
Then start the new build. v5 keeps all state in `.workshop/state-v5/`. It never
opens, migrates, or deletes older state directories. Existing `.workshop/runs/`
and `.workshop/archive/` folders stay in place, unused. Incompatible task
definitions still block as `runtime_incompatible` instead of continuing under
different code.

Migrate workflow files to `version: 4`. Replace `max_attempts: N` with
`retries: N-1`. Replace `check` with `verify`. Remove machine and workflow
`orchestrator` settings and workflow `keep_files` settings. Set `bot.model` only
when you want the shared bot. Declare `retries` and `replay` for every step
or in `defaults`. Remove custom uses of WORKSHOP_ARCHIVE. WORKSHOP_RESULTS_PATH
and WORKSHOP_LOG_PATH point to workflow-owned files in
state-v5/<workflow-id>/.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for conventions, checks, and the code map.
