# Workshop reference

This document defines Workshop v2's configuration, workflow folders, execution, scheduling, files on disk, and operations. See the [README](../README.md) for a quick start.

## Configuration

`workshop.yaml` has two top-level keys: `agent_profiles` and `orchestrator`.

```yaml
agent_profiles:
  writer:
    command: [pi, -p, --no-session, --model, "<provider>/<model>"]
  orchestrator:
    command: [pi, -p, --no-session, --no-tools, --no-extensions, --no-skills, --model, "<provider>/<model>"]
    context_window: 32000
orchestrator:
  profile: orchestrator
  escalation_profile: writer
```

`agent_profiles` must contain at least one profile. A profile name uses lowercase letters, digits, and hyphens. Its required `command` is a non-empty argument list; Workshop starts it directly, without a shell. `context_window` is an optional positive integer. It sets the Eve chat model's context size when used on `orchestrator.profile` (default 32,000); it does not configure worker or automatic-round processes.

Both orchestrator profile names must refer to declared profiles. Every profile's first command argument must resolve to an executable on `PATH`. A command beginning with a relative path is resolved from the config file's directory. Startup and `make check` validate all profiles, including unused ones. They do not check the CLI's model access or login.

Workshop reads `WORKSHOP_CONFIG` when set; otherwise it reads `workshop.yaml` from the current directory. The Make targets expect the project root. `make setup` copies `workshop.example.yaml` and `.env.example` only when the destination files do not exist. Upstream ignores `workshop.yaml` and `.env.local`.

Workshop loads `.env.local` from the config file's directory. Existing process environment variables take precedence. `${NAME}` references in YAML string values expand from the environment; an unset variable is an error. Expansion does not apply to YAML keys, workflow files, or command output. Keep secrets in `.env.local`, not in tracked config.

## Workflow folders and validation

Put each workflow in its own folder under `workflows/`. The folder name and the `name` part of each step use lowercase letters, digits, and hyphens.

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

The body of `workflow.md` describes the workflow for people and the orchestrator. The current validator permits an empty body and a workflow with no steps.

Step files are named `N-name.md`, `N-name.sh`, or `N-name.ts`. Markdown files are agent steps; shell and TypeScript files are command steps. `N` is a safe integer. Leading zeros and gaps are allowed, but numbers must be unique. Steps execute in numeric order.

A check must match both the number and name of an existing step: `N-name.check.md`, `.check.sh`, or `.check.ts`. Only one check may belong to each step. A Markdown step or check needs YAML frontmatter followed by a non-empty body. Its frontmatter accepts `profile`, `retries`, and `timeout` only. Each agent step and Markdown check needs its own `profile` or a workflow-level default. A check does not inherit a worker's explicit profile override during validation. Shell and TypeScript files have no frontmatter settings.

Unknown files, subfolders, malformed frontmatter, unknown keys, invalid profile names, duplicate numbers, unmatched checks, and missing profiles invalidate that workflow. Invalid workflows are reported and omitted while valid siblings remain available. `make check` reports errors in both `workflows/` and `examples/workflows/`; service startup logs invalid workflows and skips them. Workshop validates a run's workflow again when it creates that run's snapshot.

The examples in `examples/workflows/` are not scheduled automatically. Copy a workflow folder into `workflows/` to use it.

## Step execution

A run copies its workflow into `state/snapshots/<run_id>/<workflow>/` before executing. Each run uses that snapshot even if you edit the source folder. Workshop removes the snapshot when the run ends normally, including after a blocked run receives a decision.

Steps execute in order. The first step receives empty input. A command step runs as `sh <file>` for `.sh` or `node <file>` for `.ts`, with its working directory set to `data/<workflow>/`. An agent step runs the selected profile command with its prompt on stdin. Workshop does not invoke a shell to start profile commands.

A successful step's stdout becomes the next step's input without trimming. A command receives it on stdin. An agent receives it below an `Input` heading in its prompt. Steps can also pass longer-lived data through their shared `data/<workflow>/` working folder.

Every child process inherits the service environment and receives these variables:

| Variable | Meaning |
| --- | --- |
| `WORKSHOP_WORKFLOW` | Workflow folder name. |
| `WORKSHOP_RUN_ID` | Eve workflow run ID. |
| `WORKSHOP_STEP` | Current step or check ID. |
| `WORKSHOP_DATA_DIR` | Absolute path to the workflow's shared data folder. |
| `WORKSHOP_STATE_DIR` | Absolute path to the Workshop state folder. |
| `WORKSHOP_FEEDBACK` | Failure reason and any retry hint for the current attempt. |

Command processes receive workflow input through stdin. Agent processes receive the step prompt, then optional `## Input` and `## Feedback` sections. A check receives the worker's output as its input; its result does not replace the worker's output.

A command step that exits with code `99` ends the run successfully with status `nothing-to-do`; its check does not run. Exit `99` from an agent or a check does not have this meaning. A command that exceeds its timeout is sent `SIGTERM`, then `SIGKILL` one second later. A parent-service crash can leave a child process running, and an unfinished step can repeat when Eve resumes it. Make external effects safe to repeat; Workshop does not provide exactly-once effects.

## Checks, attempts, and feedback

Command checks receive the step's output on stdin. Exit code `0` accepts it. Any other exit, timeout, or launch error rejects the attempt; stdout and stderr help explain a nonzero result. A Markdown check runs as an agent. Its first output line must start with the token `ACCEPT` or `REJECT`, case-insensitively, followed by an optional separator and reason. `ACCEPTED` is not a valid verdict. Other output is not the verdict.

A check rejection retries the whole step, then checks the new output. `retries` means extra attempts: `retries: 2` permits up to three total attempts. The retry count resolves as `step.retries`, then `check.retries`, then `workflow.retries`, then zero. A check's `retries` is a fallback count for the step, not a separate check-only loop. A failure, timeout, or rejected result consumes one attempt.

Timeouts resolve from the check, then the step, then the workflow. They must be positive integer durations in seconds, minutes, or hours that fit within `2,147,483,647` milliseconds. There is no default timeout. After a failed attempt, command processes receive its reason in `WORKSHOP_FEEDBACK`; agent prompts receive it under `## Feedback`.

## Blocked runs and decisions

After local retries run out, Workshop asks the configured orchestrator to decide twice: first with `orchestrator.profile`, then with `orchestrator.escalation_profile` if another round is needed. Each automatic round receives a failure brief with the workflow description, step content, last output and error, attempt history, and allowed actions. It must return strict JSON for one of these actions:

- `retry`, with an optional hint, allowed profile, and delay (`after`);
- `skip` the failed step;
- `accept` its last output, when that output is non-empty;
- `fail` or `give_up`.

A retry runs the step once. If it fails, the next round gets a chance. A `fail` or `give_up` in round one escalates to round two. In round two, either action leaves the run waiting for chat; it does not fail the run automatically. Invalid JSON, an invalid choice, or an orchestrator process failure counts as `give_up`. An automatic retry can switch an agent step to another profile only when both profile commands have the exact same first argument. Command steps cannot switch profiles.

A run waiting on chat keeps its per-workflow lock. Its decision record is written to `state/blocked/<run_id>.json`, and Eve holds a durable hook for the answer. Chat can choose `retry`, `skip`, `accept`, or `fail`. A chat retry can include a hint, a profile allowed for that step, and a delay. It resets the local retry budget. `skip` keeps the last successful pipe input for the next step. `accept` uses the failed attempt's last output. `fail` ends the run. The orchestrator can also cancel a run, pause or resume a workflow, and start a workflow.

Eve's chat agent uses `orchestrator.profile` and the Workshop tools below. Its model adapter sends the conversation and tool definitions to the profile command and parses a JSON reply. Workshop disables Eve's default tools and instructs the agent not to use shell commands or edit workflow files. These restrictions are not an operating-system sandbox: the configured CLI may have its own tools, and child processes run with the service account's permissions.

On its first message in a chat session, the agent lists runs, reads blocked runs, lists workflows, and reads recent actions. It can use these tools:

| Tool | Purpose |
| --- | --- |
| `list_workflows` | List valid workflows and their settings. |
| `list_runs` | List recent runs and all runs waiting on a decision. |
| `read_run` | Read a run's status, available outputs, errors, or blocked-step history. |
| `start_workflow` | Start a workflow manually. |
| `decide_blocked_run` | Retry, skip, accept, or fail a blocked step. |
| `cancel_run` | Request cancellation through Eve. |
| `pause_workflow` / `resume_workflow` | Pause or resume future workflow starts. |
| `list_actions` | Read recent automatic and chat actions. |

Run output is not written to a separate log file. `read_run` reads Eve's completed return value or the saved blocked-step record; it is not a live process log. Cancelling asks Eve to cancel a workflow, but Workshop does not promise that an external child process stops immediately.

## Scheduling and admission

One Eve schedule ticks every minute in UTC. On each tick, Workshop loads config and valid workflows, then considers each enabled, unpaused workflow. It finds the latest cron slot at or before the current time. If that slot is newer than the last indexed slot and `max_runs` is not reached, Workshop starts the workflow. After downtime it considers only the latest due slot, not every missed slot. A new workflow is eligible at the first tick.

A hook lock is named for each workflow. It skips another occurrence of that same workflow while a run is active, waiting, sleeping before retry, or blocked. The skipped slot is recorded, not queued. Different workflows can run at the same time. The README's “one run at a time” wording is broader than the implementation: the current lock is per workflow, not global.

`max_runs` counts unique run IDs indexed as `started`, not successful completions. A manual start bypasses `max_runs` and `enabled: false`, but it counts toward the limit for later scheduled starts. Pausing a workflow prevents both manual and scheduled starts; it does not stop an active run. Resuming allows later ticks to start it again, but does not start it immediately. A scheduled run is indexed as started before config and snapshot preparation finishes, so failed preparation can count against `max_runs`.

## Files on disk

Run Workshop from the project root. Its working folders and records are relative to that directory:

```text
workshop.yaml                    local config; ignored upstream
.env.local                       local secrets; ignored
workflows/<name>/                user workflow folders
examples/workflows/<name>/       shipped examples; not auto-started
data/<workflow>/                persistent shared working files for steps
state/
├─ runs.jsonl                    run admission index
├─ actions.jsonl                 orchestrator and chat action history
├─ paused.json                   JSON list of paused workflow names
├─ blocked/<run_id>.json         current blocked-step decision details
├─ snapshots/<run_id>/<workflow>/ workflow copy used by a run
└─ service.log                   launch-agent stdout and stderr
.eve/                            Eve-managed local workflow state
.output/                         Eve build output
```

`state/runs.jsonl` has one JSON object per indexed start or skipped slot. Entries include `workflow`, `slot`, `run_id`, `outcome` (`started` or `skipped`), timestamp `at`, and an optional `reason`. A manual run has a null slot. The index supports scheduling, `max_runs`, and recent-run lookup; Eve owns run status and durable step results.

`state/actions.jsonl` records automatic round decisions and chat actions. Each entry includes a timestamp, workflow, nullable run and step IDs, source (`round-1`, `round-2`, or `chat`), decision, and note. `state/paused.json` is an array of workflow names. Workshop removes a blocked-step record after a decision settles.

The launch agent writes stdout and stderr to `state/service.log`. Foreground `make start` and `make dev` output goes to the terminal instead. `.eve/` and `.output/` belong to Eve; do not edit them. Runtime state, snapshots, data, and logs are ignored by Git.

## Make targets and service

| Target | Behavior |
| --- | --- |
| `make setup` | Requires Node.js 24+. On macOS it can install Node with Homebrew if missing; elsewhere install Node first. Runs `npm ci` and creates missing config and environment files. |
| `make copy to=<dir>` | Clones the current committed branch into a new destination, renames its remote to `upstream`, makes `workshop.yaml` trackable there, and runs setup. It does not copy uncommitted changes, secrets, data, or service state. |
| `make check` | Checks config and profile executables, validates private workflows and examples, runs `npx tsc --noEmit`, and runs `npm test`. |
| `make dev` | Starts `eve dev` on `127.0.0.1:2000`. |
| `make start` | Builds, then starts Eve on `127.0.0.1:3000` with local request auth enabled. It stays in the foreground; stop it with Ctrl-C. |
| `make chat` | Connects to the start port first, then the dev port. It does not start a service. |
| `make service-install` | Runs checks and a build, then installs a macOS per-user LaunchAgent that starts and keeps Eve running at login. |
| `make service-uninstall` | Removes the macOS LaunchAgent. It leaves workflow data and runtime state in place. |

The service binds to loopback. `make chat` connects locally; use SSH to reach a machine from another computer rather than opening the service port. The installed LaunchAgent writes to `state/service.log`.

## Eve version and upgrades

`package.json` and `package-lock.json` pin `eve` to exactly `1.0.0-rc.18`. Keep the exact pin in both files. Upgrade Eve only when no workflow runs are open, including runs waiting on a decision or retry delay. Local Workflow World runs can be stranded across Eve versions. Finish open work before changing the version. Do not treat a cancellation request as proof that its child process has stopped. The upgrade rule is an operator check, not an automatic guard.
