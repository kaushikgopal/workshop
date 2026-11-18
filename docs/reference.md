# Workshop reference

This reference defines Workshop v2's configuration, workflow files, execution, scheduling, durable state, and local service API. See the [README](../README.md) for a quick start.

## Configuration

`workshop.yaml` has two top-level keys: `agent_profiles` and `orchestrator`.

```yaml
agent_profiles:
  writer:
    command: [pi, -p, --no-session, --model, "<provider>/<model>"]
orchestrator:
  model: <provider>/<model>
  escalation_model: <provider>/<model>
```

`agent_profiles` configures command-line agents for workflow steps. A profile name uses lowercase letters, digits, and hyphens. Its required `command` is a non-empty argument list. Workshop starts it directly, without a shell. `context_window` is an optional positive integer; Workshop does not use it.

`orchestrator.model` selects the persistent root conversation's model. `orchestrator.escalation_model` selects the model for its read-only `consult` subagent. Both fields accept Pi CLI model patterns and are optional; Workshop resolves them through Pi's model registry, settings, and auth store. If either field is omitted, that model uses Pi's configured default. Keep provider credentials in Pi's auth store, not in `workshop.yaml`.

Every profile's first command argument must resolve to an executable on `PATH`. Relative executable paths resolve from the config file's directory. Startup and `make check` validate all profiles, including unused ones. They do not check model access or login.

Workshop reads `WORKSHOP_CONFIG` when set. Otherwise it reads `workshop.yaml` from the current directory. Make targets expect the project root. `make setup` copies `workshop.example.yaml` and `.env.example` only when the destination files do not exist. Upstream ignores `workshop.yaml` and `.env.local`.

`WORKSHOP_NOTHING_TO_DO` is a built-in agent-step output convention, not a `workshop.yaml` key or Markdown frontmatter field.

Workshop reads `.env.local` from the config file's directory. Existing process environment variables take precedence. Workshop parses and stages values from `.env.local`, expands `${NAME}` in YAML string values, and applies staged values to `process.env` only after YAML parsing, interpolation, and config-schema validation succeed. A failure in those checks leaves staged values unapplied. An unset variable is an error. Expansion does not apply to YAML keys, workflow files, or command output. Keep secrets in `.env.local`, not in tracked config.

## Orchestrator conversation

Workshop keeps one root conversation in `state/workshop.sqlite`. It uses
`orchestrator.model` and Pi's registry and auth store. After local retries fail,
each failed workflow step gets one keyed failure round in this conversation;
chat messages use the same root.

The system prompt includes `agent/instructions.md` and a live Workshop status
section. Status lists active and blocked runs, scheduler definition blocks, broken
workflows, paused workflows, and recent actions. Run rows include phase, status
message, and allowed actions; the list is capped at 100 rows. The root has
in-process tools to list workflows and runs, read a run, start or cancel a run,
decide a blocked run, pause or resume a workflow, and list actions.

The `consult` tool creates a read-only child conversation with
`orchestrator.escalation_model`. It can inspect workflows, runs, and recent
actions, but it has no tools that mutate Workshop state. A failure round can
call `consult` for advice before deciding what to do. A consult that ends
without an answer returns `consult_unanswered` with a reason category, not
raw provider error details.

## Workflow folders and validation

Each workflow goes in its own folder under `workflows/`. Folder and step names
use lowercase letters, digits, and hyphens. The shipped
`examples/workflows/hemingway-clock/` folder shows a valid layout:

```text
examples/workflows/hemingway-clock/
├─ workflow.md
├─ 10-get-timestamp.sh
├─ 20-write-line.md
├─ 20-write-line.check.md
└─ 30-save-line.sh
```

`workflow.md` is required. Its YAML frontmatter accepts only these keys:

| Key | Rule |
| --- | --- |
| `cron` | Required; must parse as a cron expression. |
| `max_runs` | Optional positive safe integer limiting scheduled starts. |
| `enabled` | Optional boolean; defaults to enabled. |
| `profile` | Optional default profile for Markdown steps and checks. |
| `retries` | Optional nonnegative safe integer for extra step attempts. |
| `timeout` | Optional positive duration in `s`, `m`, or `h`, within Node's timer limit. |

`workflow.md` needs a non-empty description body. Every workflow needs at least one step.

Step files are named `N-name.md`, `N-name.sh`, or `N-name.ts`. Markdown files are agent steps; shell and TypeScript files are command steps. `N` is a safe integer. Leading zeros and gaps are allowed, but numbers must be unique. Steps execute in numeric order.

A check must match both the number and name of an existing step: `N-name.check.md`, `.check.sh`, or `.check.ts`. Only one check may belong to each step. A Markdown step or check needs YAML frontmatter followed by a non-empty body. Its frontmatter accepts `profile`, `retries`, and `timeout` only. Each agent step and Markdown check needs its own profile or a workflow-level default. A check does not inherit a worker's explicit profile override during validation. Shell and TypeScript files have no frontmatter settings.

Unknown files, subfolders, malformed frontmatter, unknown keys, invalid profile names, duplicate numbers, unmatched checks, and missing profiles invalidate that workflow. Invalid workflows are reported and omitted while valid siblings remain available. `make check` reports errors in both `workflows/` and `examples/workflows/`; service startup logs and skips invalid workflows. The examples in `examples/workflows/` are not scheduled automatically. Copy a workflow folder into `workflows/` to use it.

## Step execution

A workflow start stores its validated settings and ordered step list in the
durable task. It loads each step file and its check when that step starts,
including when a retry starts. Command steps run from their file paths rather than
from durable source snapshots, so a file edit before a process starts can affect
that attempt.

Workshop reloads the main step file when it builds a failure brief. If you edit
the file after an attempt fails, the brief uses the newer contents, which may
differ from what the failed attempt saw. If Workshop cannot read the file,
the brief reports that separately and keeps the original attempt error.

Steps execute in order. The first step receives empty input. A command step runs as `sh <file>` for `.sh` or `node <file>` for `.ts`, with its working directory set to `data/<workflow>/`. Node.js applies built-in type stripping to supported TypeScript syntax. An agent step runs the selected profile command with its prompt on stdin. Workshop does not invoke a shell to start profile commands.

The durable `workshop.workflow` task owns the whole workflow lifecycle. The former `interpretWorkflow` whole-workflow coordinator is retired; `executeWorkflowAttempt` handles one step and its check.

A successful step's stdout becomes the next step's input without trimming. A command receives it on stdin. An agent receives it below an `Input` heading in its prompt. Steps can also pass longer-lived data through their shared `data/<workflow>/` working folder.

Every child process inherits the service environment and receives these variables:

| Variable | Meaning |
| --- | --- |
| `WORKSHOP_WORKFLOW` | Workflow folder name. |
| `WORKSHOP_RUN_ID` | Workshop workflow run ID. |
| `WORKSHOP_STEP` | Current step or check ID. |
| `WORKSHOP_DATA_DIR` | Absolute path to the workflow's shared data folder. |
| `WORKSHOP_STATE_DIR` | Absolute path to the Workshop state folder. |
| `WORKSHOP_PROJECT_ROOT` | Absolute path to the project root. |
| `WORKSHOP_FEEDBACK` | Failure reason and any retry hint for the current attempt. |

Command processes receive workflow input through stdin. Agent processes receive the step prompt, then optional `## Input` and `## Feedback` sections. A check receives the worker's output as its input; its result does not replace the worker's output.

A command step that exits with code `99` ends the run successfully with status `nothing-to-do`; its check does not run. An agent worker step also ends the run this way only after a clean process success: exit code `0`, no timeout, launch or I/O error, signal, or cancellation. Its stdout's last nonblank line must match `WORKSHOP_NOTHING_TO_DO`: Workshop splits on LF or CRLF, drops trailing whitespace-only lines, trims the last remaining line, and compares it case-sensitively. It ignores stderr, earlier lines, quoted or fenced tokens, and text after the token. It does not strip ANSI codes or parse Markdown or JSON. Workshop keeps the original stdout, including the token. Later steps do not run. Exit `99` from an agent or check has no special meaning. Each command or profile process starts in its own process group. A step timeout or run cancellation sends `SIGTERM`, then `SIGKILL` after 250 ms if the process group remains. This also stops descendants while the service is alive. Only a deadline expiration sets `timedOut`; an abort never becomes a timeout. If timeout and cancellation overlap, the first stop cause wins and later signals do not relabel the process.

Pi-durable resumes unfinished tasks from their last checkpoint. It cannot reattach to an operating-system process after a hard service crash. An unfinished command may start again, and the original child process may still be running. If a step-attempt task completed before its parent checkpoint, the parent reuses that durable result after restart. Make external side effects safe to repeat for unfinished commands. Workshop does not provide exactly-once effects. A normal service shutdown aborts active task signals so Workshop can stop their process groups. An invalid saved checkpoint fails with a `Workflow checkpoint integrity error` that names the bad field; Workshop does not interpret it as successful completion.

## Checks, retries, and blocked runs

Command checks receive the step's output on stdin. Exit code `0` accepts it. Any other exit, timeout, or launch error rejects the attempt. Stdout and stderr help explain a nonzero result. A Markdown check runs as an agent. Its first output line must start with `ACCEPT` or `REJECT`, case-insensitively, followed by an optional separator and reason. `ACCEPTED` is not a valid verdict. Other output is not the verdict.

An agent worker step that matches `WORKSHOP_NOTHING_TO_DO` ends the workflow successfully instead of entering check or retry handling; its check, later steps, local retries, and failure round do not run. The token is not a Markdown verdict: a judge still has to start with `ACCEPT` or `REJECT`, and a command check still follows its exit-code rules.

A check rejection retries the whole step, then checks the new output. `retries` means extra attempts: `retries: 2` permits up to three total attempts. The retry count resolves as `step.retries`, then `check.retries`, then `workflow.retries`, then zero. A check's `retries` is a fallback count for the step, not a separate check-only loop. A failure, timeout, rejected result, or expected step/check load error consumes one attempt. Missing or unreadable files, incomplete Markdown frontmatter, and empty Markdown bodies follow the normal retry and blocking rules. Unexpected loader or programming errors still fault the task.

Timeouts resolve from the check, then the step, then the workflow. They must be positive integer durations in seconds, minutes, or hours that fit within `2,147,483,647` milliseconds. There is no default timeout. After a failed attempt, command processes receive its reason in `WORKSHOP_FEEDBACK`; agent prompts receive it under `## Feedback`.

After local retries run out, the task saves the failed step and attempt history, then submits one durable failure round to the root orchestrator conversation. The submission uses `round:<run_id>:<step_id>:<attempt>` as its request ID and `followUp` when the conversation is busy. Workshop binds any decision made during that turn to the matching run, step, and attempt; different `run_id` or `decision_number` arguments cannot redirect it. The root model can call Workshop tools to retry, skip, accept non-empty output, or fail the run. It can call `consult` for read-only advice from the escalation model. If the round is unanswered or takes no action, Workshop records `give_up` with source `round` and leaves the run blocked. Workshop submits at most one automatic failure round for each step in a run. If a retry fails after that round, the step stays blocked for chat. A settled round is not submitted again after recovery; chat can still resolve the blocked run.

A blocked run remains a non-terminal durable task, so the scheduler treats its workflow as busy. The service API accepts these decisions:

- `retry`, with an optional hint, an allowed profile, and a delay (`after`);
- `skip` the failed step;
- `accept` its last output, when that output is non-empty;
- `fail` the run.

A retry applies the step's existing profile and feedback rules. An agent step can switch profiles only when the executable at the start of both profile commands matches. A command step cannot switch profiles. `skip` keeps the last successful pipe input for the next step. `accept` uses the failed attempt's last output. `fail` ends the run. Decisions are saved in a durable task document before the task resumes.

## Scheduling, pause, and cancellation

The service checks schedules once a minute in UTC. On each tick it loads config and valid workflows, then considers each enabled workflow. It finds the latest cron slot at or before the current time. After downtime it considers only the latest due slot, not every missed slot. A new workflow is eligible at the first tick. After config and workflow loading, one workflow's admission failure does not stop the tick from considering its siblings; Workshop logs and records that failure as a skipped admission.

A paused workflow's newly observed slot is recorded as skipped with reason `paused`; resuming never replays it. The service starts at most one non-terminal task per workflow. If a run is active, waiting, sleeping before retry, or blocked, a later scheduled occurrence is recorded as skipped, not queued. Different workflows can run at the same time.

`max_runs` counts distinct run IDs recorded as started, including manual starts. It limits scheduled starts only; manual starts ignore the limit but count toward it on later ticks. Manual starts refuse workflows with `enabled: false`. A fresh scheduled admission rechecks the loaded workflow: if it is now disabled, the slot is skipped with reason `workflow is disabled`; if its cron changed and the slot is no longer due, it is skipped with reason `schedule slot is no longer due`. Other scheduled skip reasons are `paused`, `max_runs reached`, `workflow lock held`, and `admission failed`. A slot already recorded at or after the requested slot is rejected as `slot_already_indexed`. Pausing prevents manual starts and skips newly observed scheduled slots; it does not stop an active run. Resuming allows later ticks to start new slots. It does not replay skipped slots or start a run immediately.

Cancelling a live run asks pi-durable to abort its workflow task and owned step-attempt task before Workshop saves the cancellation action and receipt. The task's abort signal stops the active process group. Repeating the abort is safe. A cancellation request against a terminal non-cancelled run reports `cancelled: false` and its current status. A new request for a terminal-cancelled run also reports `cancelled: false` with status `cancelled` when that run already has a cancel action. If cancellation reached a terminal outcome before Workshop saved its action, a later request acknowledges recovery once with `cancelled: true` and status `cancellation-requested`, then records the action and receipt. The same request ID replays its saved response. An in-process keyed gate serializes receipt-namespace mutations that share a request ID from receipt lookup through effect and receipt write. No request-bound cancellation intent is persisted, so a hard crash can leave an abort without its original request identity.

## Durable state and files

Run Workshop from the project root. `state/workshop.sqlite` is the durable
record for workflow admissions, task checkpoints and outcomes, step results,
blocked details, decisions, pause state, and the root and consult conversations.
Each run ID maps to a durable task ID so the service can inspect older runs.

The session-scoped Workshop state document keeps the latest 1,000 admission
records, actions, and mutation receipts. Per-workflow counters preserve
`max_runs` and the latest scheduled slot after older admission records roll off.

Project inputs and runtime files are:

```text
workshop.yaml                    local config; ignored upstream
.env.local                       local secrets; ignored
workflows/<name>/                user workflow folders
examples/workflows/<name>/       shipped examples; not auto-started
data/<workflow>/                persistent shared working files for steps
state/workshop.sqlite            durable task store and Workshop state documents
state/service.sock               private local JSON API socket
state/service.log               LaunchAgent stdout and stderr
```

`data/<workflow>/` belongs to workflow steps, not to Workshop's durable state.
It remains in place between runs. Runtime state, data, and logs are ignored by
Git. Workshop removes the socket when the service shuts down.

## Upgrading with open runs

pi-durable stores a version with each task's input and checkpoint. The current
task definitions are:

| Task kind | Version | Migration |
| --- | ---: | --- |
| `workshop.workflow` | 3 | None |
| `workshop.step-attempt` | 1 | None |
| `workshop.schedule-tick` | 1 | None |

A task at the same version resumes from its saved checkpoint. The current task
definitions have no migration functions. An open `workshop.workflow` task
stored below version 3 cannot resume under the current version 3 definition.
When a newer definition replaces an older version without a migration,
pi-durable blocks the task and reports `migration_failed`. If the installed
definition is older than the stored task, it reports `task_too_old`; if the
task kind is no longer registered, it reports `missing_task`. Add migrations
for supported older versions before changing a task's version. A compatible
code change can keep the existing version only if it can still read the saved
input and checkpoint.

A `workshop.step-attempt` task can store an expected step or check load error
as its input. Builds before that change cannot read this input. Upgrading
keeps open runs resumable, but finish open runs before you downgrade.

An older build rejects an agent `nothing-to-do` result saved mid-run; finish open runs before downgrading.

The `workshop.state` document is version 3 and migrates versions 1 and 2.
The version-2 migration normalizes historical action source `round-1` to
`round`, preserving scheduling counters and all other saved state. Once saved
at version 3, the document cannot be read by an older build. The
`workshop.workflow-decision` and `workshop.run-reference` documents are version
1. Keep document migrations in step with their stored shapes.

## Local service API

The service listens on `state/service.sock`, a Unix socket with mode `0600`. It does not open a network port. Requests and responses are JSON lines, with a 1 MiB limit per request. An oversized request ends the connection and discards requests that have not started. Standard requests receive one response and close the connection. `watch_chat` keeps a connection open for chat events and later requests. Responses include `ok`; errors include `error` and may include `request_id`. Failed mutation responses also include `error_code`; `error` remains the human-readable explanation.

Each request requires a `request_id` from 1 to 128 characters and a `type`. The service supports:

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `list_workflows` | — | — |
| `list_runs` | — | `workflow`, `limit` |
| `read_run` | `run_id` | — |
| `start_workflow` | `workflow` | — |
| `watch_chat` | — | — |
| `submit_chat` | `content` | — |
| `decide_blocked_run` | `run_id`, `decision_number`, `decision` | `note` |
| `cancel_run` | `run_id` | — |
| `pause_workflow` | `workflow` | — |
| `resume_workflow` | `workflow` | — |
| `list_actions` | — | `workflow`, `limit` |

Send `watch_chat` first to attach a client to the root conversation. It returns `chat.attached`, then streams `assistant.delta`, `tool.call`, `tool.result`, `assistant.final`, and `run.end` JSON lines. `assistant.final` carries the complete answer for every watcher; `run.end` includes `status: "error"` and a reason when the model did not answer. A new attachment starts from the current live state, so a client can reconnect after a service restart. Multiple clients can watch at once. Close the socket to stop watching.

While attached, send `submit_chat` lines on the same socket. The service uses `whenBusy: "followUp"`, streams progress to every watcher, and returns the full answer in the matching response when the turn settles. Use a new stable `request_id` for each message and reuse it to retry that request. All messages use the same root conversation. Example attachment and message:

```json
{"request_id":"watch-1","type":"watch_chat"}
{"request_id":"chat-1","type":"submit_chat","content":"What is running?"}
```

Workflow names use lowercase letters, digits, and hyphens. `decision_number` identifies the current blocked occurrence in a run; a delayed decision for an earlier step is rejected. The service assigns decision source: `chat` for chat decisions and `round` for decisions made during an automatic failure round. The model cannot set `source`. Include `note` for a round decision. `limit` is an integer from 0 to 1,000; list requests default to 20. The decision object uses the actions described above. The service rejects unknown request fields and invalid values. A repeated blocked-run decision with the same request ID and payload returns its saved response while that receipt remains in the most recent 1,000; reusing that ID for a different payload returns `error_code: "request_id_conflict"`.

A retained `start_workflow` receipt replays before Workshop reads config or checks profiles. A new start rechecks the request receipt atomically with admission. Current mutation error codes include `cancellation_in_progress`, `stale_decision`, `choice_already_recorded`, `empty_output`, `incompatible_profile`, `request_id_conflict`, `run_not_found`, `admission_skipped`, `workflow_busy`, and `slot_already_indexed`. Other mutation failures use `mutation_failed` when no narrower code applies.

`read_run.run` keeps its existing `status` string and adds `phase`, `status_message`, and `allowed_actions`. `phase` distinguishes `waiting-for-round`, `awaiting-decision`, `decision-recorded`, and `cancellation-requested` without changing the existing `status`; `status_message` is one line. Run-level `allowed_actions` may include `cancel_run` and `decide_blocked_run`; the list is advisory, and each mutation rechecks its guards. A `completing` phase means an outcome is decided but owned work still holds the workflow lock. A `definition-unavailable` phase identifies scheduler compatibility blocks such as `migration_failed`, `task_too_old`, or `missing_task`; it is not an actionable user-decision block. Faulted reads keep their error text in `error`.

A blocked `read_run.run.blocked_step` adds `allowed_actions` and `retry_profiles`. Decision actions are `retry`, `skip`, `accept`, and `fail`; `accept` appears only when the last output is trim-nonempty. Retry profiles come from the run's captured allowed list. `list_runs.runs[]` adds compact `phase`, `status_message`, and `allowed_actions` fields while keeping its existing string `blocked_step`; blocked rows add `blocked_step_allowed_actions` and `blocked_step_retry_profiles`. Terminal failed and cancelled reads reconstruct prior `steps` and `output` from child step-attempt receipts when those receipts make reconstruction possible. Workshop stores no new terminal evidence.

The service claims a SQLite owner row before opening pi-durable, so a second process cannot recover the first process's tasks or race stale-socket cleanup. It removes a stale socket only when it can confirm the socket is not active, and it will not replace a non-socket file. A fatal durable-storage error closes the service and exits with a nonzero status. `service/start-service.ts` requires Node.js 24 or newer. It registers the workflow, step-attempt, and schedule-tick tasks with pi-durable, opens SQLite, starts the scheduler, and serves requests.

The daily-summary activity step uses this API to read recent runs and actions. `make chat` is the interactive terminal client; `make chat print="message"` sends one message, prints its reply, and exits.

## Make targets

| Target | Behavior |
| --- | --- |
| `make setup` | Requires Node.js 24+. On macOS it can install Node with Homebrew if missing; elsewhere install Node first. Runs `npm ci` and creates missing config and environment files. |
| `make copy to=<dir>` | Creates and sets up a private copy of the current committed branch. From detached HEAD it creates the `workshop-copy` branch at the source revision. It does not copy uncommitted changes, secrets, data, or service state. On failure it retains partial files and prints the failed stage and an exact recovery command. |
| `make check` | Checks config and profile executables, validates private workflows and examples, runs `npx tsc --noEmit`, and runs `npm test`. |
| `make dev` | Starts the service in Node watch mode. It stays in the foreground; stop it with Ctrl-C. |
| `make start` | Starts the service in the foreground; stop it with Ctrl-C. |
| `make chat` | Attaches to the persistent orchestrator conversation; use `make chat print="message"` for one reply. |
| `make service-install` | Runs checks, then installs a per-user macOS LaunchAgent that starts `node service/start-service.ts` from the project root. The agent writes stdout and stderr to `state/service.log`. On failure the installer reports the stage and a recovery command; it leaves partial files in place for inspection. |
| `make service-uninstall` | Removes the macOS LaunchAgent and plist. It leaves runtime state and workflow data in place. |

Make expands `print`, `LABEL`, and `to` as usual, then passes each expanded value as one literal argument. Quotes, backticks, dollar signs, backslashes, and newlines in that value are not evaluated again by the recipe shell. The installer receives the current project directory in the same way. Label validation still applies in the launch-agent scripts.

Quote assignments for your calling shell and double literal dollar signs for Make. For example:

```fish
make chat 'print=Explain `git status` and $$PATH'
```

This sends ``Explain `git status` and $PATH`` without executing `git status` or expanding `$PATH`. An absent, empty, or whitespace-only `print` still selects interactive chat.

The foreground `make start` and `make dev` commands write output to the terminal.
