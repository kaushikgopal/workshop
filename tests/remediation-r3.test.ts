import { describe, test, expect } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeInstallation, runCli, dbRuns, readWorklog } from "./helpers.js";
import { openDb } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { loadAndValidateDefinition, startWorkflow } from "../src/execute.js";
import { findInstallation, ensureDirs } from "../src/config.js";
import { recoverInstallation } from "../src/recovery.js";
import { SystemClock } from "../src/util/clock.js";
import { processStartId } from "../src/util/process.js";
import {
  RunLock,
  attemptDir,
  atomicWriteFileSync,
  mergePacket,
  packetPath,
  sha256File,
  sha256String,
} from "../src/worklog/worklog.js";

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
    const folder = attemptDir(run.run_dir, 1, "node-a");
    writeFileSync(
      packetPath(folder),
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
        attemptFolder: folder, successorId: "node-b", ownerToken: claim.ownerToken, now: new Date(),
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
    const { orchestratorResultFile } = await import("../src/orchestrator.js");
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
    const child = spawn("bun", [join(import.meta.dir, "..", "src/cli.ts"), "start", "chain"], {
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
