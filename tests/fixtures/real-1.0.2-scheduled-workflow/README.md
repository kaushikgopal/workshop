# Legacy scheduled workflow capture

`durable.db` is a path-normalized copy of a real capture made by pi-durable 1.0.2 and the Workshop task definitions at commit 70ba39324a8c2eac2c2c15a817ffb8547e603a42. The generator starts the historical Workshop service in a disposable workspace, admits the workflow through the service protocol, completes one agent step with a faux provider, closes the service, and confirms that the actual `workshop.schedule-wakeup` task waits on its persisted deadline.

The capture workspace root is replaced with `/WORKSHOP_FIXTURE_ROOT` in exactly 13 stored path strings. The generator changes only those strings, after the historical Harness closes. It preserves task state, checkpoint, record IDs, workflow result, prompt content, and other evidence. It then runs SQLite `VACUUM` to remove old page bytes. `path-normalization.json` records the affected rows and fields. The checked-in database is not an untouched byte-for-byte capture; the manifest describes this limited normalization.

| Persisted record | Fields with normalized roots | Count |
| --- | --- | ---: |
| `document_revisions` document 12, seq 2 (`workshop.run`) | frozen run cwd, project cwd, workflow directory | 3 |
| `document_revisions` document 23, seq 10 (`pi.agent`) | cwd | 1 |
| `document_revisions` document 24, seq 10 (`workshop.agent-execution-environment`) | results and log paths | 2 |
| `tasks` task 17 (`workshop.agent-execution`) | input cwd, prompt paths, environment paths | 5 |
| `entries` entry 27 (`pi.user`) | prompt results and log paths | 2 |

The migration test checks these record IDs and the 13 placeholders. It restores the root only in a disposable database copy before Workshop 1.4.0 opens it. It does not change the checked-in fixture or product SQLite behavior.

## Recreate

Run from the repository root. Build the historical source tree from the pinned commit, then use its pinned dependencies and this fixture generator.

~~~fish
set repo (pwd)
set capture (mktemp -d)
git archive 70ba393 | tar -x -C $capture
mkdir -p $capture/tests/fixtures/real-1.0.2-scheduled-workflow
cp $repo/tests/fixtures/real-1.0.2-scheduled-workflow/{workshop.yaml,scheduled-migration.yaml,generate-real-scheduled-workflow-fixture.ts} $capture/tests/fixtures/real-1.0.2-scheduled-workflow/
cd $capture
bun install --frozen-lockfile
bun run tests/fixtures/real-1.0.2-scheduled-workflow/generate-real-scheduled-workflow-fixture.ts
cp $capture/tests/fixtures/real-1.0.2-scheduled-workflow/durable.db $repo/tests/fixtures/real-1.0.2-scheduled-workflow/durable.db
cp $capture/tests/fixtures/real-1.0.2-scheduled-workflow/path-normalization.json $repo/tests/fixtures/real-1.0.2-scheduled-workflow/path-normalization.json
rm -rf $capture
~~~
