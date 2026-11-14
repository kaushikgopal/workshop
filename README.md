# Workshop

## What is Workshop

Workshop runs my agent workflows round the clock, cheaply and safely, and
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
  waiting, or blocked) is skipped. After downtime, only the latest missed
  slot runs.
- **Optional checks per step.** A step can name a command or a judge agent
  to check its output. A rejected result retries the step with the reason as
  feedback. The orchestrator steps in only when retries run out.
- **Shared working folder.** Steps pass data through files, not through a
  data contract between steps.
- **Steps are safe to repeat.** A step interrupted by a crash runs again from
  its start.
- **One Workshop per machine.** Each machine has its own workflows, so
  personal and work loops stay apart.

## Quick start

Workshop v2 needs Node.js 24 or later and npm. Run these commands from the repository root:

1. Run `make setup` to install dependencies and create `workshop.yaml` and `.env.local` from their templates.
2. Edit `workshop.yaml`. Set `agent_profiles` to commands available on this machine. Point `orchestrator.profile` and `orchestrator.escalation_profile` at profiles you keep.
3. Copy an example workflow into `workflows/`, for example:

   ```fish
   cp -R examples/workflows/hemingway-clock workflows/
   ```

4. Run `make check`.
5. Run `make start` to build and start the scheduled service. In another terminal, run `make chat` to talk to the orchestrator.

Use `make dev` instead of `make start` while developing. It starts Eve's development server with reloads.

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

`workflow.md` holds schedule settings and defaults. A numbered `.md` file is an agent step; `.sh` and `.ts` files are command steps. A matching `.check.md`, `.check.sh`, or `.check.ts` checks a step's output. See [the reference](docs/reference.md) for validation and execution rules.

## Agent profiles

Profiles in `workshop.yaml` name command-line agents. Steps select a profile, not a command or model. For example, `pi` can use a local login and model:

```yaml
agent_profiles:
  writer:
    command: [pi, -p, --no-session, --model, "<provider>/<model>"]
  orchestrator:
    command: [pi, -p, --no-session, --no-tools, --no-extensions, --no-skills, --model, "<provider>/<model>"]
orchestrator:
  profile: orchestrator
  escalation_profile: writer
```

Replace the placeholder and remove profiles for tools you do not use. Put secrets in `.env.local` and refer to them as `${NAME}` in `workshop.yaml`.

## Make targets

| Target | Purpose |
| --- | --- |
| `make setup` | Install dependencies and create missing local config files. |
| `make copy to=<dir>` | Create and set up a private copy of the current committed branch. |
| `make check` | Validate config and workflows, typecheck, and run tests. |
| `make dev` | Start Eve's local development server on port 2000. |
| `make start` | Build and start the service on port 3000. |
| `make chat` | Connect to the service started by `make start` or `make dev`. |
| `make service-install` | Install the macOS launch agent. |
| `make service-uninstall` | Remove the macOS launch agent. |

The service listens on loopback. See [the v2 contract](docs/reference.md) for config, scheduling, blocked runs, files on disk, and service details.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for the architecture, conventions, and checks.

## License

[MIT](LICENSE)
