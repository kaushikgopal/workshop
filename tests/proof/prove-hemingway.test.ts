import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(REPO_ROOT, "src/proof/prove-hemingway.ts");
const MOCK = join(REPO_ROOT, "tests/mock/hemingway-node.ts");
const MOCK_SENTENCE = "The old man rowed until the sea forgot the shore.";
const MOCK_SUMMARY = "One Hemingway sentence, written by the deterministic mock.";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "workshop-proof-"));
}

function runProof(stateDir: string, args: readonly string[] = []): RunResult {
  const result = spawnSync("bun", [CLI, "--state-dir", stateDir, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function launchRecords(stateDir: string): Array<Record<string, unknown>> {
  const path = join(stateDir, "launches.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function launchCount(stateDir: string, nodeId: string): number {
  return launchRecords(stateDir).filter((record) => record.event === "launch" && record.nodeId === nodeId).length;
}

function findReceipt(stateDir: string, nodeId: string): string | undefined {
  const runsDir = join(stateDir, "runs");
  if (!existsSync(runsDir)) return undefined;
  for (const run of readdirSync(runsDir)) {
    const path = join(runsDir, run, "receipts", `${nodeId}.json`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

async function waitFor<T>(check: () => T | undefined | false | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function descendantRecord(stateDir: string): Record<string, unknown> | undefined {
  return launchRecords(stateDir).find((record) => record.event === "descendant");
}

const sleepingCommand = `WORKSHOP_MOCK_SLEEP_MS=15000 WORKSHOP_MOCK_DESCENDANT=1 bun "${MOCK}"`;

test("runs the deterministic chain, checks the result JSON, and publishes one archive", async () => {
  const stateDir = makeStateDir();
  const run = runProof(stateDir);
  expect(run.code).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result.version).toBe(1);
  expect(result.status).toBe("completed");
  expect(result.output).toBe(MOCK_SENTENCE);
  expect(result.summary).toBe(MOCK_SUMMARY);
  expect(result.timestamp.length).toBeGreaterThan(0);
  expect(result.artifacts).toHaveLength(1);
  expect(result.artifacts[0].kind).toBe("archive");
  expect(existsSync(result.artifacts[0].path)).toBe(true);
  expect(readFileSync(result.artifacts[0].path, "utf8").trim()).toBe(result.output);
  // The runtime published the checked result's output as the node output.
  const nodeOutput = join(stateDir, "runs", result.runId, "outputs", "node-generate.txt");
  expect(readFileSync(nodeOutput, "utf8").trim()).toBe(MOCK_SENTENCE);
  expect(launchCount(stateDir, "node-generate")).toBe(1);
}, 60_000);

test("keeps the stored output authoritative when the on-disk result changes", async () => {
  const stateDir = makeStateDir();
  const first = JSON.parse(runProof(stateDir).stdout);
  expect(first.status).toBe("completed");

  // Tamper with everything the run wrote on disk after it settled.
  const resultFile = join(stateDir, "runs", first.runId, "generated.json");
  writeFileSync(
    resultFile,
    JSON.stringify({ version: 1, output: "A different sentence.", summary: "A different summary.", artifacts: [] }) + "\n",
    "utf8",
  );
  writeFileSync(join(stateDir, "runs", first.runId, "outputs", "node-generate.txt"), "tampered\n", "utf8");

  const second = runProof(stateDir);
  expect(second.code).toBe(0);
  const again = JSON.parse(second.stdout);
  expect(again.output).toBe(first.output);
  expect(again.summary).toBe(first.summary);
  expect(again.nodes).toEqual(first.nodes);
  expect(again.artifacts).toEqual(first.artifacts);
  expect(launchCount(stateDir, "node-generate")).toBe(1);
}, 60_000);

test("reopens a terminal run without another run or duplicate publication", async () => {
  const stateDir = makeStateDir();
  const first = JSON.parse(runProof(stateDir).stdout);
  const archiveDir = join(stateDir, "archive");
  const before = readdirSync(archiveDir);
  expect(before).toHaveLength(1);
  const archiveBefore = readFileSync(join(archiveDir, before[0]!), "utf8");
  const launchesBefore = launchRecords(stateDir).length;

  const second = runProof(stateDir);
  expect(second.code).toBe(0);
  const again = JSON.parse(second.stdout);
  expect(again.runId).toBe(first.runId);
  expect(again.taskId).toBe(first.taskId);
  expect(again.status).toBe("completed");
  expect(readdirSync(archiveDir)).toHaveLength(1);
  expect(readFileSync(join(archiveDir, before[0]!), "utf8")).toBe(archiveBefore);
  expect(launchRecords(stateDir).length).toBe(launchesBefore);
}, 60_000);

test("pauses at a clean checkpoint and resumes without rerunning the completed node", async () => {
  const stateDir = makeStateDir();
  const pausedRun = runProof(stateDir, ["--pause-after", "timestamp"]);
  expect(pausedRun.code).toBe(0);
  const paused = JSON.parse(pausedRun.stdout);
  expect(paused.status).toBe("paused");
  expect(paused.timestamp.length).toBeGreaterThan(0);
  expect(paused.output).toBe("");
  expect(paused.summary).toBe("");
  expect(launchCount(stateDir, "node-generate")).toBe(0);

  const resumedRun = runProof(stateDir);
  expect(resumedRun.code).toBe(0);
  const result = JSON.parse(resumedRun.stdout);
  expect(result.status).toBe("completed");
  // The timestamp node's committed output survives; it was not rerun.
  expect(result.timestamp).toBe(paused.timestamp);
  expect(launchCount(stateDir, "node-generate")).toBe(1);
}, 60_000);

test("retires the process group after a normal exit, descendants included", async () => {
  const stateDir = makeStateDir();
  const command = `WORKSHOP_MOCK_DESCENDANT=1 bun "${MOCK}"`;
  const run = runProof(stateDir, ["--agent-command", command]);
  expect(run.code).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result.status).toBe("completed");
  const descendant = descendantRecord(stateDir);
  expect(descendant).toBeDefined();
  // The leader exited normally, but the whole group was retired before settle.
  await waitFor(() => !isAlive(descendant!.pid as number), 10_000, "descendant cleanup");
  expect(isAlive(descendant!.pid as number)).toBe(false);
}, 60_000);

test("blocks when a recorded process outlives the runner, preserving unknown effects", async () => {
  const stateDir = makeStateDir();
  const proc = Bun.spawn(["bun", CLI, "--state-dir", stateDir, "--agent-command", sleepingCommand], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const receiptPath = await waitFor(() => findReceipt(stateDir, "node-generate"), 15_000, "the launch receipt");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const descendant = await waitFor(() => descendantRecord(stateDir), 15_000, "the descendant record");

    process.kill(proc.pid, "SIGKILL");
    await proc.exited;
    expect(isAlive(receipt.identity.pid)).toBe(true);

    const reopened = runProof(stateDir);
    expect(reopened.code).toBe(2);
    const blocked = JSON.parse(reopened.stdout);
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("effects unknown");
    expect(blocked.cleanup.confirmed).toBe(true);
    const archiveDir = join(stateDir, "archive");
    expect(existsSync(archiveDir) ? readdirSync(archiveDir) : []).toHaveLength(0);
    expect(launchCount(stateDir, "node-generate")).toBe(1);

    await waitFor(() => !isAlive(descendant.pid as number), 10_000, "descendant cleanup");
  } finally {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}, 60_000);

test("a crash after the durable intent commit blocks on reopen instead of relaunching", async () => {
  const stateDir = makeStateDir();
  const crashed = spawnSync("bun", [CLI, "--state-dir", stateDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, WORKSHOP_PROOF_CRASH_AFTER_INTENT: "1" },
  });
  expect(crashed.status).toBe(137);
  expect(findReceipt(stateDir, "node-timestamp")).toBeUndefined();
  const runDir = join(stateDir, "runs", readdirSync(join(stateDir, "runs"))[0]!);
  expect(existsSync(join(runDir, "outputs", "node-timestamp.txt"))).toBe(false);

  const reopened = runProof(stateDir);
  expect(reopened.code).toBe(2);
  const blocked = JSON.parse(reopened.stdout);
  expect(blocked.status).toBe("blocked");
  expect(blocked.reason).toContain("launch intent recorded without a process identity");
}, 60_000);

test("a crash after a validator intent commit blocks that validator on reopen", async () => {
  const stateDir = makeStateDir();
  const crashed = spawnSync("bun", [CLI, "--state-dir", stateDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, WORKSHOP_PROOF_CRASH_AFTER_INTENT: "node-timestamp-validator" },
  });
  expect(crashed.status).toBe(137);
  expect(findReceipt(stateDir, "node-timestamp-validator")).toBeUndefined();

  const reopened = runProof(stateDir);
  expect(reopened.code).toBe(2);
  const blocked = JSON.parse(reopened.stdout);
  expect(blocked.status).toBe("blocked");
  expect(blocked.reason).toContain("launch intent recorded without a process identity");
  expect(blocked.reason).toContain("validator of node-timestamp");
}, 60_000);

test("rejects a malformed result JSON and never publishes the run", async () => {
  const stateDir = makeStateDir();
  const command = `WORKSHOP_MOCK_RESULT=malformed bun "${MOCK}"`;
  const run = runProof(stateDir, ["--agent-command", command]);
  expect(run.code).toBe(2);
  const result = JSON.parse(run.stdout);
  expect(result.status).toBe("blocked");
  expect(result.reason).toContain("not JSON");
  expect(result.artifacts).toHaveLength(0);
  expect(launchCount(stateDir, "node-generate")).toBe(1);
}, 60_000);

test("rejects unknown result keys and an empty result output", async () => {
  const unknownDir = makeStateDir();
  const unknown = runProof(unknownDir, ["--agent-command", `WORKSHOP_MOCK_RESULT=unknown bun "${MOCK}"`]);
  expect(unknown.code).toBe(2);
  const unknownResult = JSON.parse(unknown.stdout);
  expect(unknownResult.status).toBe("blocked");
  expect(unknownResult.reason).toContain("version-1 check");

  const emptyDir = makeStateDir();
  const empty = runProof(emptyDir, ["--agent-command", `WORKSHOP_MOCK_RESULT=empty-output bun "${MOCK}"`]);
  expect(empty.code).toBe(2);
  const emptyResult = JSON.parse(empty.stdout);
  expect(emptyResult.status).toBe("blocked");
  expect(emptyResult.reason).toContain("version-1 check");
}, 60_000);

test("stop file aborts and confirms process-group cleanup, descendants included", async () => {
  const stateDir = makeStateDir();
  const stopFile = join(stateDir, "stop-now");
  const proc = Bun.spawn(
    ["bun", CLI, "--state-dir", stateDir, "--stop-file", stopFile, "--agent-command", sleepingCommand],
    { cwd: REPO_ROOT, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  const stdoutPromise = new Response(proc.stdout).text();
  try {
    await waitFor(() => findReceipt(stateDir, "node-generate"), 15_000, "the launch receipt");
    const descendant = await waitFor(() => descendantRecord(stateDir), 15_000, "the descendant record");

    writeFileSync(stopFile, "stop\n", "utf8");
    const code = await proc.exited;
    const stdout = await stdoutPromise;
    expect(code).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("aborted");
    expect(result.cleanup.confirmed).toBe(true);
    await waitFor(() => !isAlive(descendant.pid as number), 10_000, "descendant cleanup");
    expect(isAlive(descendant.pid as number)).toBe(false);
  } finally {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}, 60_000);

test("stop after the leader is gone still retires the surviving process group", async () => {
  const stateDir = makeStateDir();
  const stopFile = join(stateDir, "stop-now");
  const proc = Bun.spawn(["bun", CLI, "--state-dir", stateDir, "--agent-command", sleepingCommand], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const receiptPath = await waitFor(() => findReceipt(stateDir, "node-generate"), 15_000, "the launch receipt");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const descendant = await waitFor(() => descendantRecord(stateDir), 15_000, "the descendant record");

    process.kill(proc.pid, "SIGKILL");
    await proc.exited;
    // Kill only the leader: the descendant keeps the recorded group alive.
    process.kill(receipt.identity.pid, "SIGKILL");
    await waitFor(() => !isAlive(receipt.identity.pid), 10_000, "leader death");
    expect(isAlive(descendant.pid as number)).toBe(true);

    writeFileSync(stopFile, "stop\n", "utf8");
    const stopped = runProof(stateDir, ["--stop-file", stopFile]);
    expect(stopped.code).toBe(1);
    const result = JSON.parse(stopped.stdout);
    expect(result.status).toBe("aborted");
    expect(result.cleanup.confirmed).toBe(true);
    await waitFor(() => !isAlive(descendant.pid as number), 10_000, "descendant cleanup");
    expect(isAlive(descendant.pid as number)).toBe(false);
  } finally {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}, 60_000);

test("refuses a second live owner of the same state dir", async () => {
  const stateDir = makeStateDir();
  const command = `WORKSHOP_MOCK_SLEEP_MS=10000 bun "${MOCK}"`;
  const proc = Bun.spawn(["bun", CLI, "--state-dir", stateDir, "--agent-command", command], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  try {
    const receiptPath = await waitFor(() => findReceipt(stateDir, "node-generate"), 15_000, "the launch receipt");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));

    const second = runProof(stateDir);
    expect(second.code).toBe(3);
    expect(second.stderr).toContain("singleton lock");

    process.kill(proc.pid, "SIGKILL");
    await proc.exited;
    process.kill(-receipt.identity.pgid, "SIGKILL");
    await stdoutPromise;
  } finally {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}, 60_000);
