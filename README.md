# Workshop

## v2 development

The v2 work-in-progress lives at the repository root and runs on Eve. It requires Node 24+ and npm. Run `make setup` to install dependencies and create local config files. Run `make check` to check config, types, and tests; use `make dev` for local development or `make start` to build and start Eve.

The rest of this README describes v1, which remains in the tree until v2 reaches M6.

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

Workshop is a small TypeScript runtime built on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). It runs
what people call software factories and what I call
[autonomous loops](https://kau.sh/blog/responsible-loop-engineering).

## The idea

You write a workflow as a YAML chain of steps. Each step is a shell command or
a headless agent. A verifier can check each result before the chain moves on.
Workflows run once or on a schedule, and progress survives restarts.

- **It is** a background service. One service per project owns the state and
  the schedules. The CLI talks to it.
- **It is not** a coding harness. You do not pair with it. It runs loops you
  already trust.
- **It has** a chat bot. Use `workshop chat` to ask about runs, start
  workflows, and retry or fail blocked runs.

WARNING: Workflows run with your permissions. Agents use coding tools without
asking. Review a workflow before you start it.

## Demo: hemingway-clock

This workflow writes one original Hemingway-style sentence per run. An agent
verifier rejects repeats. It runs six times, three minutes apart.

You need [Bun](https://bun.sh), [fish](https://fishshell.com), and a model in
your Pi catalog.

1. Open a shell with a temporary `workshop` command:

   ~~~fish
   make cli
   ~~~

2. Create a demo project:

   ~~~fish
   mkdir -p /tmp/workshop/demo/.workshop/workflows
   cd /tmp/workshop/demo
   cp $workshop_repo/examples/workflows/hemingway-clock.yaml .workshop/workflows/
   cp $workshop_repo/examples/workshop.yaml .workshop/
   ~~~

3. Edit `.workshop/workshop.yaml`. Replace both `example/pi-model:medium`
   values with `<provider>/<model-id>:<thinking>`.

4. Start the workflow and watch it:

   ~~~fish
   workshop start hemingway-clock --detach
   workshop watch
   ~~~

   Press Enter on a workflow to see its steps. Press `q` to quit.

5. Read the accepted sentences in `.workshop/hemingway-clock/results.md`.

6. Stop everything before you exit:

   ~~~fish
   workshop stop hemingway-clock
   workshop service stop
   exit
   ~~~

## Project layout

~~~text
.workshop/
├─ workshop.yaml           you write: models, shell, limits (commit it)
├─ workflows/
│  └─ <workflow>.yaml      you write: one workflow; filename is the ID (commit it)
├─ <workflow>/             Workshop writes: readable output (git-ignored)
│  ├─ results.md           accepted output and human answers
│  └─ execution.log        optional; set execution_log: true
└─ .state/                 Workshop writes: database and service files (never edit)
~~~

You edit only `workshop.yaml` and `workflows/`. Everything else is output.
Deleting `results.md` is safe; the service rebuilds it.

WARNING: Durable 1.4.0 migrates `.workshop/.state/durable.db` to SQLite schema
version 2 on first open. Durable 1.3.0 and earlier cannot open the migrated
file. Before starting the upgraded service, stop the old service and make a
SQLite-consistent backup. A copy of `durable.db` alone can omit committed WAL
data. Do not restore an old backup without checking later external effects.

## Commands

| Command | Does |
| --- | --- |
| `validate <path>` | Check a workflow file offline |
| `start <workflow> [--detach]` | Start a run and enable its schedule |
| `pause` / `resume` / `stop <workflow>` | Pause, resume, or stop a workflow |
| `watch [<workflow>]` | Open the live viewer |
| `status [<workflow>] [--json]` | Print a snapshot (viewer on a TTY) |
| `runs <workflow>` | List run history |
| `logs <workflow> [--verbose]` | Show the worklog and process output |
| `step describe <workflow> <step>` | Show settings and evidence for one step |
| `diagram <workflow>` | Draw the chain with run status |
| `reply <workflow> --continue\|--reject --answer TEXT` | Answer a human wait |
| `resolve <workflow> --action retry\|accept\|fail --reason TEXT` | Resolve a blocked run |
| `chat` | Talk to the shared bot |
| `service start\|serve\|status\|stop` | Manage the background service |
| `service recover inspect\|receipt\|apply` | Inspect stopped Durable work and apply confirmed recovery |

Run `workshop help` for all flags. See [the reference](docs/reference.md)
for the workflow format, result contracts, and configuration.

## Things that can go wrong

Ask the bot (`workshop chat`) or your coding agent. Example prompts follow.

**A run is blocked.** A verifier rejected the result, or the same failure
happened twice.

> Why is hemingway-clock blocked? Read its logs. Retry if the cause is fixed.

**An outside effect is unknown.** A step crashed during an action that can
change the outside world. Only a human can retry this.

> Run `workshop step describe <workflow> <step>` and `workshop logs <workflow> --verbose`.
> Did the action finish? Tell me which `workshop resolve` command to run.

**A run waits for an answer.** A step asked a question.

> Show me the open question for <workflow> and the proposal it wants approved.

Then run `workshop reply`, or use `/continue` or `/reject` in chat.

**My YAML edit did nothing.** A run keeps the definition it started with.

> Validate .workshop/workflows/<workflow>.yaml, then stop and start <workflow>.

**The service does not start.** Ordinary startup refuses blocked tasks and uncertain prior-boot process evidence. Check `workshop service status` for a historical startup-park snapshot; it does not resume work.

Run `workshop service recover inspect` before explicit recovery. Inspect validates retained process evidence, including terminal tasks. Choose `--verify-retired` for unresolved terminal process records. Recovery can resume unrelated installation work. Read the full [recovery contract](docs/reference.md#durable-recovery-commands) first.

> For other startup errors, run `workshop service serve` and fix the error it prints.

**A model is not found.** The model string does not match your Pi catalog.

> Check the models in .workshop/workshop.yaml against my Pi catalog and fix them.

WARNING: `retries: unlimited` can keep spending on model calls.

WARNING: Durable 1.4.0 migrates `.workshop/.state/durable.db` to SQLite schema version 2 on first open. Stop the old service and make a SQLite-consistent backup before upgrading. See [the reference](docs/reference.md#what-lands-on-disk).

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for the architecture, conventions, and
checks.

## License

[MIT](LICENSE)
