# Workshop

## What is Workshop

Workshop runs my [agent workflows](https://kau.sh/blog/responsible-loop-engineering) round the clock, cheaply and safely, and
brings me in only when something truly needs me.

### Requirements

1. **Always on.** Workflows run on a schedule, day and night, without me
   starting them. Repeatable work should happen whether or not I am at a
   keyboard.
2. **A model per step.** Each agent step picks its own model, from a cheap
   local one to a frontier one. I pay for quality only on the steps that need
   it.
3. **Workflows of commands and agents.** A workflow is a fixed sequence of
   steps, and each step is a shell command or a headless agent. Fixed
   structure keeps a run predictable, and agents add judgment only where a
   step needs it.
4. **Durable.** A run survives crashes, restarts, and reboots, and resumes
   where it stopped. Unattended work must not lose progress.
5. **An orchestrator I can talk to.** I can reach one agent directly, on the
   machine or over SSH from a laptop, to ask what is running, why something
   failed, or to nudge stuck work along. It also tries to fix failing steps
   on its own, escalating to a smarter model before it asks me. It records
   anything significant it does and flags runs it cannot fix. I need one
   place to understand and steer everything.
6. **Convention over configuration.** Dropping a folder of numbered step
   files into `workflows/` creates a workflow, with no registration or
   wiring. Adding a workflow should take minutes.

### Constraints

- **Inputs and outputs are steps.** A workflow starts on its schedule or
  with the start command. It pulls its own inputs and sends its own
  notifications in steps. A command step that exits with code 99 ends the
  run early because there is nothing to do.
- **One run at a time.** A slot that arrives while a run is open (working,
  waiting, or blocked) is skipped. Slots the scheduler sees while a workflow
  is paused are skipped for good; resuming never replays them. After downtime,
  only the latest missed slot runs.
- **Optional checks per step.** A step can name a command or a judge agent
  to check its output. A rejected result retries the step with the reason as
  feedback. The orchestrator steps in only when retries run out.
- **Shared working folder.** Steps pass data through files, not through a
  data contract between steps.
- **Cancellation stops active processes.** Cancelling a run stops its active
  command or profile process group.
- **Steps are safe to repeat.** A step interrupted by a crash runs again from
  its start.
- **One Workshop per machine.** Each machine has its own workflows, so
  personal and work loops stay apart.

## Quick start

Workshop v2 needs Node.js 24 or later and npm. Run these commands from the repository root:

1. Run `make setup` to install dependencies and create `workshop.yaml` and `.env.local` from their templates.
2. Edit `workshop.yaml`. Set `agent_profiles` to commands available on this machine. Optionally set `orchestrator.model` and `orchestrator.escalation_model` to Pi model patterns. If you omit either, Workshop uses Pi's configured default model.
3. Copy an example workflow into `workflows/`, for example:

   ```fish
   cp -R examples/workflows/hemingway-clock workflows/
   ```

4. Run `make check`.
5. Run `make start` to start the scheduled service.
6. Run `make chat` to attach to the persistent orchestrator conversation. Use Ctrl-C or Ctrl-D to exit. For a single reply, run `make chat print="What is running?"`.

Use `make dev` while developing. It restarts the service when source files change.

## Running a demo

The Quick start installs `hemingway-clock`, a small workflow that writes one original sentence every three minutes and stops after six runs. Each run has three steps:

1. `10-get-timestamp.sh` prints the current time.
2. `20-write-line.md` asks the `writer` agent for a new sentence. `20-write-line.check.md` has the agent judge it, and a rejected sentence is retried with the reason.
3. `30-save-line.sh` appends the accepted sentence to `data/hemingway-clock/results.md`.

With `make start` running, try these in a second terminal:

- `tail -F data/hemingway-clock/results.md` shows each new sentence as it lands.
- `make chat print="What is running?"` asks the orchestrator what it sees.
- `make chat print="Pause hemingway-clock"` pauses the workflow. Wait for the next three-minute slot to pass, then run `make chat print="Resume hemingway-clock"`. The slot that came while it was paused never runs.

To clean up, stop `make start` with Ctrl-C and remove the demo:

```fish
rm -r workflows/hemingway-clock data/hemingway-clock
```

## Workflow folders

Each workflow lives in its own folder. The filename extension sets the step type:

```text
workflows/hemingway-clock/
├─ workflow.md
├─ 10-get-timestamp.sh
├─ 20-write-line.md
├─ 20-write-line.check.md
└─ 30-save-line.sh
```

`workflow.md` holds schedule settings and defaults. A numbered `.md` file is an agent step; `.sh` and `.ts` files are command steps. A matching `.check.md`, `.check.sh`, or `.check.ts` checks a step's output.

### Ending a run early

A command step that exits with code `99` ends the run early as `nothing-to-do`: its check and later steps do not run, and the next scheduled run starts as usual. An agent step does the same when the last nonblank line of its output is `WORKSHOP_NOTHING_TO_DO`. To use it, add a line like this to the agent step's prompt:

```text
If there is nothing to do, finish your response with WORKSHOP_NOTHING_TO_DO alone on its own line, without quotes or a code fence. Emit nothing after it.
```

See [the reference](docs/reference.md) for the exact matching rules.

Workshop stores runs and orchestrator state in `state/workshop.sqlite`. State
upgrades migrate to version 3; see [downgrade limits](docs/reference.md#upgrading-with-open-runs).
Workshop reads each step and check file when that step starts. It rereads the main
step file when it builds a failure brief. Edits made after a failed attempt can
change what the orchestrator sees. Steps share `data/<workflow>/`. See [the
reference](docs/reference.md) for validation and execution rules.

## Several workflows

Each folder in `workflows/` is a separate workflow with its own schedule. Different workflows run at the same time, and each one has at most one open run. A blocked run holds up only its own workflow.

One orchestrator conversation watches every workflow. Chat messages and automatic failure rounds take turns in that conversation. When several runs fail at once, their rounds queue and the orchestrator handles them one at a time.

## Agent profiles

`agent_profiles` configure command-line agents for workflow steps. The orchestrator uses Pi's model registry and authentication instead. Example configuration:

```yaml
agent_profiles:
  writer:
    command: [pi, -p, --no-session, --model, "<provider>/<model>"]
orchestrator:
  model: <provider>/<model>
  escalation_model: <provider>/<model>
```

Omit either orchestrator field to use Pi's configured default model. Put provider credentials in Pi's auth store, not in `workshop.yaml`. Put secrets for workflow commands in `.env.local` and refer to them as `${NAME}` in `workshop.yaml`. See the [configuration reference](docs/reference.md#configuration) for `.env.local` rules.

## Make targets

| Target | Purpose |
| --- | --- |
| `make setup` | Install dependencies and create missing local config files. |
| `make copy to=<dir>` | Create and set up a private copy of the current committed branch. |
| `make check` | Validate config and workflows, typecheck, and run tests. |
| `make dev` | Start the service in watch mode and restart it when source files change. |
| `make start` | Start the durable service in the foreground. |
| `make chat` | Attach to the persistent orchestrator conversation; `make chat print="message"` sends one message and exits. |
| `make service-install` | Install the macOS launch agent for the durable service. |
| `make service-uninstall` | Remove the macOS launch agent. |

Quote message assignments for your shell. Make requires `$$` for each literal dollar sign; see [the argument rules](docs/reference.md#make-targets).

The service listens on the private Unix socket `state/service.sock` and does not open a network port. `make chat` attaches to the root conversation, streams assistant text and tool progress, and queues messages behind any current turn. See [the reference](docs/reference.md) for the socket protocol.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for the architecture, conventions, and checks.

## License

[MIT](LICENSE)
