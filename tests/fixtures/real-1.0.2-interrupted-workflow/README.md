# Real 1.0.2 interrupted workflow capture

This fixture records a Workshop service database created at commit
`70ba39324a8c2eac2c2c15a817ffb8547e603a42`, with pi-durable 1.0.2. The
capture uses the real service protocol and a faux provider. It contains a
running process task, one completed occurrence of an unrelated scheduled
workflow, and that workflow's next wakeup checkpoint waiting for run capacity.

The installation limit is one concurrent run. The interrupted workflow makes
one faux-provider request, then writes one marker and waits in a process step.
The scheduled workflow writes its first marker before that run starts. Its next
scheduled occurrence reaches the capacity-wait state while the process step is
still active. The capture kills the service with SIGKILL, then kills and
confirms death of the recorded worker process group. This prevents an orphan
worker from surviving fixture generation.

The generator replaces only the disposable workspace root in stored database
text. It does not change task states, process evidence, IDs, or checkpoints.
The manifest records every replaced database field and the interruption
identities. The marker files and faux-provider request log record pre- and
post-interruption effects.

Regenerate this fixture from the exact historical Workshop commit. The
`generate-real-interrupted-workflow-fixture.ts` script imports Workshop
source files, starts the historical service, and writes the verified database,
manifest, and effect files into this directory.
