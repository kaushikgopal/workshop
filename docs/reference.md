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

Workshop reads `.env.local` from the config file's directory. Existing process environment variables take precedence. `${NAME}` references in YAML string values expand from the environment. An unset variable is an error. Expansion does not apply to YAML keys, workflow files, or command output. Keep secrets in `.env.local`, not in tracked config.

## Orchestrator conversation

Workshop keeps one root conversation in `state/workshop.sqlite`. It uses `orchestrator.model` and the Pi registry/auth store. Automatic failure rounds and chat submissions use the same conversation.

The system prompt includes `agent/instructions.md` and a live Workshop status section. Status lists blocked runs, broken workflows, paused workflows, and recent actions. The root has in-process tools to list workflows and runs, read a run, start or cancel a run, decide a blocked run, pause or resume a workflow, and list actions.

The `consult` tool creates a read-only child conversation with `orchestrator.escalation_model`. It can inspect workflows, runs, and recent actions, but it has no tools that mutate Workshop state. The failure round can use `consult` for independent advice before it calls `decide_blocked_run`.

## Workflow folders and validation

Put each workflow in its own folder under `workflows/`. The folder name and each step name use lowercase letters, digits, and hyphens.

```text
workflows/<name>/
├─ workflow.md
├─ 10-fetch.sh
├─ 20-draft.md
├─ 20-draft.check.md
├─ 25-tidy.ts
└─ 30-save.sh
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

A workflow start stores its validated settings and ordered step list in the durable task. Workshop does not copy a run snapshot. It reads each step file and its check when that step starts, including when a retry starts. An edit to a later step can therefore affect an active run; an edit to the current step does not change an attempt that has already started.

Steps execute in order. The first step receives empty input. A command step runs as `sh <file>` for `.sh` or `node <file>` for `.ts`, with its working directory set to `data/<workflow>/`. An agent step runs the selected profile command with its prompt on stdin. Workshop does not invoke a shell to start profile commands.

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

A command step that exits with code `99` ends the run successfully with status `nothing-to-do`; its check does not run. Exit `99` from an agent or check has no special meaning. Each command or profile process starts in its own process group. A step timeout or run cancellation sends `SIGTERM`, then `SIGKILL` after 250 ms if the process group remains. This also stops descendants while the service is alive.

Pi-durable resumes unfinished tasks from their last checkpoint. It cannot reattach to an operating-system process after a hard service crash. An unfinished command may start again, and the original child process may still be running. Make external side effects safe to repeat. Workshop does not provide exactly-once effects. A normal service shutdown aborts active task signals so Workshop can stop their process groups.

## Checks, retries, and blocked runs

Command checks receive the step's output on stdin. Exit code `0` accepts it. Any other exit, timeout, or launch error rejects the attempt. Stdout and stderr help explain a nonzero result. A Markdown check runs as an agent. Its first output line must start with `ACCEPT` or `REJECT`, case-insensitively, followed by an optional separator and reason. `ACCEPTED` is not a valid verdict. Other output is not the verdict.

A check rejection retries the whole step, then checks the new output. `retries` means extra attempts: `retries: 2` permits up to three total attempts. The retry count resolves as `step.retries`, then `check.retries`, then `workflow.retries`, then zero. A check's `retries` is a fallback count for the step, not a separate check-only loop. A failure, timeout, or rejected result consumes one attempt.

Timeouts resolve from the check, then the step, then the workflow. They must be positive integer durations in seconds, minutes, or hours that fit within `2,147,483,647` milliseconds. There is no default timeout. After a failed attempt, command processes receive its reason in `WORKSHOP_FEEDBACK`; agent prompts receive it under `## Feedback`.

After local retries run out, the task saves the failed step and attempt history, then submits one durable failure round to the root orchestrator conversation. The submission uses `round:<run_id>:<step_id>:<attempt>` as its request ID and `followUp` when the conversation is busy. The root model can call Workshop tools to retry, skip, accept non-empty output, or fail the run. It can call `consult` for read-only advice from the escalation model. If the round is unanswered or takes no action, Workshop records `give_up` with source `round` and leaves the run blocked. The settled round is not submitted again after recovery; chat can still resolve the blocked run.

A blocked run remains a non-terminal durable task, so the scheduler treats its workflow as busy. The service API accepts these decisions:

- `retry`, with an optional hint, an allowed profile, and a delay (`after`);
- `skip` the failed step;
- `accept` its last output, when that output is non-empty;
- `fail` the run.

A retry applies the step's existing profile and feedback rules. An agent step can switch profiles only when the executable at the start of both profile commands matches. A command step cannot switch profiles. `skip` keeps the last successful pipe input for the next step. `accept` uses the failed attempt's last output. `fail` ends the run. Decisions are saved in a durable task document before the task resumes.

## Scheduling, pause, and cancellation

The service checks schedules once a minute in UTC. On each tick it loads config and valid workflows, then considers each enabled workflow. It finds the latest cron slot at or before the current time. After downtime it considers only the latest due slot, not every missed slot. A new workflow is eligible at the first tick.

A paused workflow's newly observed slot is recorded as skipped with reason `paused`; resuming never replays it. The service starts at most one non-terminal task per workflow. If a run is active, waiting, sleeping before retry, or blocked, a later scheduled occurrence is recorded as skipped, not queued. Different workflows can run at the same time.

`max_runs` counts distinct run IDs recorded as started, including manual starts. It limits scheduled starts only; manual starts ignore the limit but count toward it on later ticks. Manual starts refuse workflows with `enabled: false`. Pausing prevents manual starts and skips newly observed scheduled slots; it does not stop an active run. Resuming allows later ticks to start new slots. It does not replay skipped slots or start a run immediately.

Cancelling a run aborts its durable workflow task and owned step-attempt task. The task's abort signal stops the active process group. A cancellation request against a terminal run reports that it was not cancelled.

## Durable state and files

Run Workshop from the project root. `state/workshop.sqlite` is the only record of run admission, task checkpoints and outcomes, step results, blocked details, decisions, pause state, and the persistent root and consult conversations. Each run has a durable reference from its run ID to its task ID, so the service can inspect older runs without scanning every task.

The session document keeps the most recent 1,000 admission records, actions, and mutation receipts. Separate per-workflow counters preserve `max_runs` and the latest scheduled slot after older records roll off. Run tasks and their references remain in SQLite. There are no run snapshots, JSONL indexes, paused-workflow files, blocked-step files, or process registry files.

```text
workshop.yaml                    local config; ignored upstream
.env.local                       local secrets; ignored
workflows/<name>/                user workflow folders
examples/workflows/<name>/       shipped examples; not auto-started
data/<workflow>/                persistent shared working files for steps
state/
├─ workshop.sqlite               durable tasks and Workshop state documents
├─ service.sock                  private local JSON API socket
└─ service.log                   launch-agent stdout and stderr
```

`data/<workflow>/` belongs to workflow steps, not to Workshop's run-state record. It remains in place between runs. Runtime state, data, and logs are ignored by Git. The service removes its socket when it shuts down.

## Local service API

The service listens on `state/service.sock`, a Unix socket with mode `0600`. It does not open a network port. Requests and responses are JSON lines, with a 1 MiB limit per request. Standard requests receive one response and close the connection. `watch_chat` keeps a connection open for chat events and later requests. Responses include `ok`; errors include `error` and may include `request_id`.

Each request requires a `request_id` from 1 to 128 characters and a `type`. The service supports:

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `list_workflows` | — | — |
| `list_runs` | — | `workflow`, `limit` |
| `read_run` | `run_id` | — |
| `start_workflow` | `workflow` | — |
| `watch_chat` | — | — |
| `submit_chat` | `content` | — |
| `decide_blocked_run` | `run_id`, `decision_number`, `decision` | `source`, `note` |
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

Workflow names use lowercase letters, digits, and hyphens. `decision_number` identifies the current blocked occurrence in a run; a delayed decision for an earlier step is rejected. `source` is `chat` or `round`; include `note` for a round decision. `limit` is an integer from 0 to 1,000; list requests default to 20. The decision object uses the actions described above. The service rejects unknown request fields and invalid values. A repeated blocked-run decision with the same request ID and payload returns its saved response while that receipt remains in the most recent 1,000; reusing that ID for a different payload is an error.

The service claims a SQLite owner row before opening pi-durable, so a second process cannot recover the first process's tasks or race stale-socket cleanup. It removes a stale socket only when it can confirm the socket is not active, and it will not replace a non-socket file. A fatal durable-storage error closes the service and exits with a nonzero status. `service/start-service.ts` requires Node.js 24 or newer. It registers the workflow, step-attempt, and schedule-tick tasks with pi-durable, opens SQLite, starts the scheduler, and serves requests.

The daily-summary activity step uses this API to read recent runs and actions. `make chat` is the interactive terminal client; `make chat print="message"` sends one message, prints its reply, and exits.

## Make targets

| Target | Behavior |
| --- | --- |
| `make setup` | Requires Node.js 24+. On macOS it can install Node with Homebrew if missing; elsewhere install Node first. Runs `npm ci` and creates missing config and environment files. |
| `make copy to=<dir>` | Creates and sets up a private copy of the current committed branch. It does not copy uncommitted changes, secrets, data, or service state. |
| `make check` | Checks config and profile executables, validates private workflows and examples, runs `npx tsc --noEmit`, and runs `npm test`. |
| `make dev` | Starts the service in Node watch mode. It stays in the foreground; stop it with Ctrl-C. |
| `make start` | Starts the service in the foreground; stop it with Ctrl-C. |
| `make chat` | Attaches to the persistent orchestrator conversation; use `make chat print="message"` for one reply. |
| `make service-install` | Runs checks, then installs a macOS per-user LaunchAgent for the Node service. |
| `make service-uninstall` | Removes the macOS LaunchAgent. It leaves workflow data and runtime state in place. |

The LaunchAgent writes stdout and stderr to `state/service.log`. Foreground `make start` and `make dev` output goes to the terminal instead.
