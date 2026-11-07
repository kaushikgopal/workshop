# Legacy agent interruption capture

This SQLite file records a real Durable Harness capture. Commit 70ba39324a8c2eac2c2c15a817ffb8547e603a42 pins @earendil-works/pi-durable to 1.0.2 in both package.json and bun.lock. Its tests/native-agent-execution.test.ts contains the same interrupted-sibling scenario. The capture uses only faux model responses and fake shell effects.

The generator waits until the first unsafe tool has an execute checkpoint and its sibling remains in call. It closes the old harness, then copies the SQLite database and first-effect marker. The task input uses a fixed workspace path. The shell environment accepts only the two fixture commands and fails on every other command without starting a shell. No provider credentials are used.

## Recreate

Run these commands from the repository root. They use the historical lockfile in a temporary source tree, not this package's production dependencies.

1. Save the repository path and create a temporary historical tree.

   ```fish
   set repo (pwd)
   set capture (mktemp -d)
   git archive 70ba393 | tar -x -C $capture
   ```

2. Copy the generator into that tree and install its pinned dependencies.

   ```fish
   mkdir -p $capture/tests/fixtures/real-1.0.2-agent-interruption
   cp $repo/tests/fixtures/real-1.0.2-agent-interruption/generate-real-agent-interruption-fixture.ts $capture/tests/fixtures/real-1.0.2-agent-interruption/
   cd $capture
   bun install --frozen-lockfile
   ```

3. Generate the capture and copy its files back.

   ```fish
   bun run tests/fixtures/real-1.0.2-agent-interruption/generate-real-agent-interruption-fixture.ts
   cp $capture/tests/fixtures/real-1.0.2-agent-interruption/durable.db $repo/tests/fixtures/real-1.0.2-agent-interruption/durable.db
   cp $capture/tests/fixtures/real-1.0.2-agent-interruption/effects.txt $repo/tests/fixtures/real-1.0.2-agent-interruption/effects.txt
   ```
