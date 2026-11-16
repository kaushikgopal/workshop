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
5. **One durable orchestrator conversation.** I can ask what is running, why
   something failed, or nudge stuck work along. After local retries, the root
   model gets one durable failure round. It can act on a failed run or consult
   the escalation model for read-only advice. If no action is safe, it records
   `give_up` and leaves the run blocked for chat.
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
5. Run `make start` to start the scheduled service. It exposes a private JSON API at `state/service.sock`; clients submit messages to the same root conversation with `submit_chat`.

Use `make dev` while developing. It restarts the service when source files change.

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

Workshop stores durable state in `state/workshop.sqlite`. It does not copy run snapshots. It loads each step and check file when that step starts. Steps share `data/<workflow>/`. See [the reference](docs/reference.md) for validation and execution rules.

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

Omit either orchestrator field to use Pi's configured default model. Put provider credentials in Pi's auth store, not in `workshop.yaml`. Put secrets for workflow commands in `.env.local` and refer to them as `${NAME}` in `workshop.yaml`.

## Make targets

| Target | Purpose |
| --- | --- |
| `make setup` | Install dependencies and create missing local config files. |
| `make copy to=<dir>` | Create and set up a private copy of the current committed branch. |
| `make check` | Validate config and workflows, typecheck, and run tests. |
| `make dev` | Start the service in watch mode and restart it when source files change. |
| `make start` | Start the durable service in the foreground. |
| `make chat` | Placeholder until the interactive chat client is ported in part 2. |
| `make service-install` | Install the macOS launch agent for the durable service. |
| `make service-uninstall` | Remove the macOS launch agent. |

The service listens on the private Unix socket `state/service.sock` and accepts one JSON request per connection. A chat client sends `{"request_id":"chat-1","type":"submit_chat","content":"What is running?"}` to reach the persistent root conversation. The response includes its `conversation_id` and answer. The service does not open a network port. See [the reference](docs/reference.md) for the full API and workflow behavior.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for the architecture, conventions, and checks.

## License

[MIT](LICENSE)
