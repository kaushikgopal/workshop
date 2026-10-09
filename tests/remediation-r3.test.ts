import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeInstallation, runCli, dbRuns, readWorklog } from "./helpers.js";
import { openDb } from "../src/storage/db/open-and-migrate.js";
import { Store } from "../src/storage/db/store.js";
import { advanceChain } from "../src/run/advance-chain.js";
import { startWorkflow } from "../src/run/start-run.js";
import { loadAndValidateDefinition } from "../src/definition/load-definition.js";
import { findInstallation, ensureDirs } from "../src/load-installation.js";
import { recoverInstallation } from "../src/run/recover-after-crash.js";
import { runtimeCliInvocation } from "../src/attempt/build-attempt-env.js";
import { SystemClock } from "../src/util/clock.js";
import { processStartId } from "../src/process/identify-process.js";
import { WorklogIntegrityError } from "../src/worklog/detect-tampering.js";
import { sha256String } from "../src/util/hash-content.js";
import { sha256File } from "../src/util/hash-content.js";
import { locatePacket } from "../src/storage/disk/locate-run-files.js";
import { attemptDirOfPacket } from "../src/storage/disk/locate-run-files.js";
import { atomicWriteFileSync } from "../src/storage/disk/write-crash-safe.js";
import { authorizedMarker } from "../src/worklog/apply-marker-rules.js";
import { validatePacket } from "../src/worklog/check-packet.js";
import { mergePacket } from "../src/worklog/merge-packet.js";
import { extractMarker } from "../src/worklog/check-packet.js";
import { RunLock } from "../src/storage/disk/lock-run.js";

const chainYaml = (id: string): string => `version: 1
id: ${id}
description: Two command nodes.
nodes:
  node-a:
    run:
      command: echo A
    next: node-b
  node-b:
    run:
      command: echo B
    next: null
`;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// S10 — packet merge replay: the marked block survives a lost receipt
// ---------------------------------------------------------------------------

describe("R3 packet replay — receipt loss", () => {
  test("a merged marked block without its receipt is verified and the receipt recreated, never appended twice", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const run = store.getRun(started.runId)!;
    const claim = store.claimAttempt({ runId: run.run_id, nodeId: "node-a", attempt: 1, now: new Date(), maxConcurrentRuns: 99 });
    const folder = attemptDirOfPacket(store.getAttempt(run.run_id, "node-a", 1)!.packet_path);
    writeFileSync(
      locatePacket(folder),
      `#### Attempt 1\n\n##### Progress\n\nDone.\n\n<next-node-output id="node-b">\nhandoff text\n</next-node-output>\n`,
      "utf8",
    );
    const outputPath = join(folder, "output");
    atomicWriteFileSync(outputPath, "handoff text\n");
    store.claimFinishing({
      runId: run.run_id, nodeId: "node-a", attempt: 1, ownerToken: claim.ownerToken,
      nodeOutputPath: outputPath, validatorStatus: null, validatorReason: null, now: new Date(),
    });
    const lock = new RunLock(run.run_dir);
    await lock.acquire();
    try {
      mergePacket({
        runDir: run.run_dir, runId: run.run_id, nodeId: "node-a", attempt: 1,
        attemptFolder: folder, successorId: "node-b", now: new Date(),
      });
    } finally {
      lock.release();
    }

    // Crash window: the merge published its marked block but the receipt was
    // lost, and the owner died before the completion transaction.
    rmSync(join(folder, "merge-receipt.json"));
    store.tx(() => {
      store.db
        .query(
          "UPDATE node_attempts SET wrapper_pid = 999999, wrapper_process_start_id = 'gone', worker_pid = 999999, worker_process_start_id = 'gone', worker_process_group = 999999 WHERE run_id = ? AND node_id = 'node-a' AND attempt = 1",
        )
        .run(run.run_id);
    });

    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.finishingRecovered).toContain(`${run.run_id}/node-a #1`);
    expect(store.getAttempt(run.run_id, "node-a", 1)!.status).toBe("completed");

    const worklog = readWorklog(inst, run.run_id);
    expect(worklog).toContain("handoff text");
    expect(countOccurrences(worklog, "workshop:merge begin")).toBe(1);
    const receipt = JSON.parse(readFileSync(join(folder, "merge-receipt.json"), "utf8")) as Record<string, unknown>;
    expect(receipt.version).toBe(2);
    expect(receipt.blockSha256).toBeTruthy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S11 — orchestrator replay: prose merged, DB effect missing
// ---------------------------------------------------------------------------

describe("R3 orchestrator replay — prose before DB", () => {
  test("recovery applies the decision after a prose-before-DB crash without duplicating prose or calling a model", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const run = store.getRun(started.runId)!;

    // A dead applying owner whose normalized result exists and whose prose
    // block was already merged before the DB effect could commit.
    const token = "tok1234567890";
    const { orchestratorResultFile } = await import("../src/run/orchestrate-failure.js");
    const resultPath = orchestratorResultFile(run.run_dir, token);
    atomicWriteFileSync(resultPath, JSON.stringify({ decision: "block", reason: "durable choice", notes: null }, null, 2) + "\n");
    const marker = {
      begin: `<!-- workshop:decision begin owner=${sha256String(token)} result=${sha256File(resultPath)} -->`,
      end: `<!-- workshop:decision end owner=${sha256String(token)} result=${sha256File(resultPath)} -->`,
    };
    const worklog = readWorklog(inst, run.run_id);
    const heading = "## Global decision log\n";
    const at = worklog.indexOf(heading) + heading.length;
    writeFileSync(
      run.worklog_path,
      `${worklog.slice(0, at)}\n${marker.begin}\n- ${new Date().toISOString()} — orchestrator block: durable choice\n${marker.end}\n${worklog.slice(at)}`,
      "utf8",
    );
    store.tx(() => {
      store.db
        .query(
          `UPDATE runs SET orchestrator_phase = 'applying', orchestrator_owner_token = ?,
             orchestrator_wrapper_pid = 999999, orchestrator_wrapper_process_start_id = 'gone',
             orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
             orchestrator_process_group = NULL, orchestrator_result_path = ?
           WHERE run_id = ?`,
        )
        .run(token, resultPath, run.run_id);
    });

    // No orchestrator is configured for this installation: if recovery tried
    // to call a fresh model, the invocation would block or fail — the decision
    // must come from the durable result file instead.
    const report = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(report.orchestratorFinished).toContain(run.run_id);
    const after = store.getRun(run.run_id)!;
    expect(after.status).toBe("blocked");
    expect(after.block_kind).toBe("orchestrator");
    expect(after.orchestrator_phase).toBe("idle");
    expect(countOccurrences(readWorklog(inst, run.run_id), "workshop:decision begin")).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Q1 — stop and recovery refuse to cancel while death is unconfirmed
// ---------------------------------------------------------------------------

describe("R3 terminate-confirm — stop and recovery", () => {
  test("stop records intent only while a recorded group's death is unconfirmed; terminate-confirm reconciles it", async () => {
    const inst = makeInstallation({
      "chain": `version: 1
id: chain
description: One sleeping node.
nodes:
  node-a:
    run:
      command: sleep 30
    next: null
`,
    });
    // The chain runs inline in the CLI process: the harness child (a shell
    // running sleep) is spawned detached there, and the CLI reaps it.
    const child = spawn("bun", [join(import.meta.dir, "..", "src/cli/main.ts"), "--engine", "v3", "start", "chain"], {
      cwd: inst.root,
      stdio: "ignore",
    });

    const store = new Store(openDb(inst.dbPath));
    let runId = "";
    let leaderPid = 0;
    for (let i = 0; i < 300; i++) {
      const run = dbRuns(inst)[0];
      const attempt = run ? store.getAttempt(run.run_id as string, "node-a", 1) : null;
      if (attempt?.worker_process_group != null && attempt.worker_process_start_id) {
        runId = attempt.run_id;
        leaderPid = attempt.worker_pid!;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(leaderPid).toBeGreaterThan(0);

    // Corrupt the recorded start identity: the live group cannot be verified,
    // so terminate-confirm must refuse — no signal, no cancellation.
    store.db
      .query("UPDATE node_attempts SET worker_process_start_id = 'mismatch' WHERE run_id = ? AND node_id = 'node-a' AND attempt = 1")
      .run(runId);
    const stopped = runCli(inst, `stop chain`);
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toContain("could not be confirmed dead");
    const intent = dbRuns(inst)[0]!;
    expect(intent.desired_state).toBe("stopped"); // durable intent recorded
    expect(intent.status).toBe("running"); // no final cancellation
    expect(store.getAttempt(runId, "node-a", 1)!.status).toBe("running");
    // The live group was never signalled.
    expect(processStartId(leaderPid)).not.toBeNull();

    // Recovery also refuses while death is unconfirmed.
    const report = await recoverInstallation({ store, inst: findInstallation(inst.root), clock: new SystemClock() });
    expect(report.skipped.some((s) => s.includes("process death unconfirmed"))).toBe(true);

    // Repair the identity: terminate-confirm now kills the live group and the
    // stopped intent reconciles to final cancellation.
    store.db
      .query("UPDATE node_attempts SET worker_process_start_id = ? WHERE run_id = ? AND node_id = 'node-a' AND attempt = 1")
      .run(processStartId(leaderPid)!, runId);
    const stoppedAgain = runCli(inst, `stop chain`);
    expect(stoppedAgain.code).toBe(0);
    expect(dbRuns(inst)[0]!.status).toBe("cancelled");
    expect(store.getAttempt(runId, "node-a", 1)!.status).toBe("cancelled");
    expect(processStartId(leaderPid)).toBeNull(); // the recorded group is gone
    child.kill("SIGKILL");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Hemingway smoke — standalone marker lines are the only structural delimiters
// ---------------------------------------------------------------------------

const HEMINGWAY_SENTENCE =
  "The rain came early to the harbor, and the old men drank their coffee slowly because the fish did not care when they started.";

/** The real failed packet: the authorized pair quoted in inline-code prose plus one live standalone pair. */
const hemingwayPacket = `#### Attempt 1

##### Progress

Generated one original Hemingway-inspired sentence and placed it in the next-node-output marker.

##### Validation

- Marker pair \`<next-node-output id="node-append-quote">\` / \`</next-node-output>\` preserved intact with the sentence between them.

##### Blockers

None.

<next-node-output id="node-append-quote">
${HEMINGWAY_SENTENCE}
</next-node-output>
`;

const hemingwayYaml = (id: string): string => `version: 1
id: ${id}
description: Two command nodes shaped like the Hemingway chain.
nodes:
  node-generate-line:
    run:
      command: echo line
    next: node-append-quote
  node-append-quote:
    run:
      command: echo quote
    next: null
`;

/** Start the Hemingway-shaped chain and return the first attempt's packet location. */
async function startGenerateLineAttempt(definitions: Record<string, string>) {
  const inst = makeInstallation(definitions);
  const real = findInstallation(inst.root);
  ensureDirs(real);
  const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "hemingway.yaml"));
  const started = await startWorkflow({ inst: real, loaded });
  const store = new Store(openDb(real.dbPath));
  const run = store.getRun(started.runId)!;
  const folder = attemptDirOfPacket(store.getAttempt(run.run_id, "node-generate-line", 1)!.packet_path);
  return { inst, run, folder, packetFile: locatePacket(folder) };
}

describe("Hemingway smoke — standalone marker lines", () => {
  test("the real packet — markers quoted in prose plus one standalone pair — validates, extracts, and merges with prose escaped", async () => {
    const { inst, run, folder, packetFile } = await startGenerateLineAttempt({ "hemingway": hemingwayYaml("hemingway") });
    writeFileSync(packetFile, hemingwayPacket, "utf8");

    // Validation counts standalone marker lines only: the pair quoted in
    // the packet's prose must not reject it as duplicated markers.
    validatePacket(packetFile, "node-generate-line", 1, "node-append-quote");

    // Output extraction finds the standalone pair, not the prose occurrence.
    const marker = authorizedMarker("node-append-quote");
    expect(extractMarker(hemingwayPacket, marker.opening, marker.closing)).toBe(HEMINGWAY_SENTENCE);

    const lock = new RunLock(run.run_dir);
    await lock.acquire();
    try {
      mergePacket({
        runDir: run.run_dir, runId: run.run_id, nodeId: "node-generate-line", attempt: 1,
        attemptFolder: folder, successorId: "node-append-quote", now: new Date(),
      });
    } finally {
      lock.release();
    }

    const worklog = readWorklog(inst, run.run_id);
    expect(worklog).toContain(HEMINGWAY_SENTENCE);
    // The quoted prose pair is escaped (inert); the structural pair stays live.
    expect(worklog).toContain('\\<next-node-output id="node-append-quote">');
    expect(worklog).toContain('\\</next-node-output>');
    expect(worklog).toContain('\n<next-node-output id="node-append-quote">\nThe rain came early');
    expect(worklog).toContain('\n</next-node-output>\n');
  }, 30_000);

  test("a second standalone authorized opening or closing still rejects", async () => {
    const { folder, packetFile } = await startGenerateLineAttempt({ "hemingway": hemingwayYaml("hemingway") });
    const marker = authorizedMarker("node-append-quote");

    writeFileSync(packetFile, hemingwayPacket + `${marker.opening}\n`, "utf8");
    expect(() => validatePacket(packetFile, "node-generate-line", 1, "node-append-quote")).toThrow(WorklogIntegrityError);

    writeFileSync(packetFile, hemingwayPacket + `${marker.closing}\n`, "utf8");
    expect(() => validatePacket(packetFile, "node-generate-line", 1, "node-append-quote")).toThrow(WorklogIntegrityError);
  }, 30_000);
});
// ---------------------------------------------------------------------------
// Ordered-node artifact layout — nodes/<chain-position>-<node-id>/attempt-<n>
// ---------------------------------------------------------------------------

describe("Ordered-node artifact layout", () => {
  test("first attempts land per node folder, a retry lands as attempt-002 in the same node folder, and execution order stays chronological", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const run = store.getRun(started.runId)!;

    // First attempt of the first node: chain position 0 → nodes/001-node-a.
    const first = store.getAttempt(run.run_id, "node-a", 1)!;
    expect(first.packet_path).toBe(join(run.run_dir, "nodes", "001-node-a", "attempt-001", "packet.md"));

    // A retry of the same node stays in that node folder as attempt-002;
    // the chain-position prefix and the attempt number never mix meanings.
    store.db.query("UPDATE node_attempts SET status = 'failed' WHERE run_id = ? AND node_id = 'node-a'").run(run.run_id);
    const retry = store.createRetryAttempt({
      runId: run.run_id, nodeId: "node-a", previousAttempt: 1, resolvedMaxAttempts: 2,
      resolvedTimeoutMs: 60_000, chainPosition: 0, now: new Date(),
    })!;
    expect(retry.packet_path).toBe(join(run.run_dir, "nodes", "001-node-a", "attempt-002", "packet.md"));

    // Running the chain completes node-a #2 and persists node-b #1 in the
    // second node folder — the physical layout never reorders execution.
    expect((await advanceChain({ store, inst: real, loaded, runId: run.run_id, cliPath: runtimeCliInvocation() })).status).toBe("completed");
    const second = store.getAttempt(run.run_id, "node-b", 1)!;
    expect(second.packet_path).toBe(join(run.run_dir, "nodes", "002-node-b", "attempt-001", "packet.md"));
    expect(existsSync(second.packet_path)).toBe(true);

    // Chronology stays SQLite's: the run's spine orders by execution_seq.
    const chronological = [first, retry, second].sort((a, b) => a.execution_seq - b.execution_seq);
    expect(chronological.map((a) => `${a.node_id}#${a.attempt}`)).toEqual(["node-a#1", "node-a#2", "node-b#1"]);
  }, 30_000);

  test("a legacy stored packet_path is repaired, executed, and merged in place — never re-derived from the new layout", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const run = store.getRun(started.runId)!;

    // Simulate a pre-layout pending row: its stored path points at the old
    // attempts/ folder, and that stored path stays authoritative.
    const legacyFolder = join(run.run_dir, "attempts", "001-node-a");
    const legacyPacket = join(legacyFolder, "packet.md");
    store.db
      .query("UPDATE node_attempts SET packet_path = ? WHERE run_id = ? AND node_id = 'node-a' AND attempt = 1")
      .run(legacyPacket, run.run_id);
    // Admission had already scaffolded the new-layout folder; a genuinely
    // pre-layout run directory never had one.
    rmSync(join(run.run_dir, "nodes"), { recursive: true });

    expect((await advanceChain({ store, inst: real, loaded, runId: run.run_id, cliPath: runtimeCliInvocation() })).status).toBe("completed");

    // The packet was repaired and its evidence merged at the stored path…
    expect(existsSync(legacyPacket)).toBe(true);
    expect(existsSync(join(legacyFolder, "merge-receipt.json"))).toBe(true);
    expect(readWorklog(inst, run.run_id)).toContain('<next-node-output id="node-b">\nA\n</next-node-output>');
    // …while the freshly created successor row still uses the new layout.
    expect(store.getAttempt(run.run_id, "node-b", 1)!.packet_path).toBe(
      join(run.run_dir, "nodes", "002-node-b", "attempt-001", "packet.md"),
    );
    expect(existsSync(join(run.run_dir, "nodes", "001-node-a"))).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S12 — orchestrator replay: a second decision on the same run
// ---------------------------------------------------------------------------

describe("R3 orchestrator replay — repeated decisions", () => {
  test("a later decision accumulates after the first instead of parking the run", async () => {
    const inst = makeInstallation({ "chain": chainYaml("chain") });
    const real = findInstallation(inst.root);
    ensureDirs(real);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "chain.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    const store = new Store(openDb(real.dbPath));
    const run = store.getRun(started.runId)!;
    const { orchestratorResultFile } = await import("../src/run/orchestrate-failure.js");

    // Stage a dead applying owner whose normalized result is durable on disk.
    const stage = (token: string, result: { decision: string; reason: string; notes: string | null }): void => {
      const resultPath = orchestratorResultFile(run.run_dir, token);
      atomicWriteFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      store.tx(() => {
        store.db
          .query(
            `UPDATE runs SET orchestrator_phase = 'applying', orchestrator_owner_token = ?,
               orchestrator_wrapper_pid = 999999, orchestrator_wrapper_process_start_id = 'gone',
               orchestrator_worker_pid = NULL, orchestrator_worker_process_start_id = NULL,
               orchestrator_process_group = NULL, orchestrator_result_path = ?
             WHERE run_id = ?`,
          )
          .run(token, resultPath, run.run_id);
      });
    };
    const decisionBlocks = (): number => countOccurrences(readWorklog(inst, run.run_id), "workshop:decision begin");

    // A second judgment arrives only after the first left the run unresolved,
    // so both recoveries see the same run.
    stage("tok-first-decision", { decision: "block", reason: "needs an operator", notes: null });
    await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(store.getRun(run.run_id)!.block_kind).toBe("orchestrator");
    expect(decisionBlocks()).toBe(1);

    // The same owner and result again: already merged, so nothing is written.
    stage("tok-first-decision", { decision: "block", reason: "needs an operator", notes: null });
    const replay = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(replay.orchestratorFinished).toContain(run.run_id);
    expect(decisionBlocks()).toBe(1);

    // A different decision must accumulate instead of parking the run in a
    // protected applying phase.
    stage("tok-second-decision", { decision: "fail", reason: "second judgment", notes: "nothing left to retry" });
    const second = await recoverInstallation({ store, inst: real, clock: new SystemClock() });
    expect(second.orchestratorFinished).toContain(run.run_id);

    const after = store.getRun(run.run_id)!;
    expect(after.status).toBe("failed");
    expect(after.orchestrator_phase).toBe("idle");
    expect(after.orchestrator_owner_token).toBeNull();

    const worklog = readWorklog(inst, run.run_id);
    expect(countOccurrences(worklog, "workshop:decision begin")).toBe(2);
    expect(countOccurrences(worklog, "workshop:decision end")).toBe(2);
    // Both decisions survive, oldest first, and the next section is intact.
    expect(worklog.indexOf("orchestrator block: needs an operator")).toBeGreaterThan(-1);
    expect(worklog.indexOf("orchestrator block: needs an operator")).toBeLessThan(
      worklog.indexOf("orchestrator fail: second judgment"),
    );
    expect(worklog).toContain("notes: nothing left to retry");
    expect(worklog).toContain("\n## Work packets\n");
  }, 30_000);
});
