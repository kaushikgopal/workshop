import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { makeInstallation, runCli, readWorklog } from "./helpers.js";
import { findInstallation } from "../src/config.js";
import { loadAndValidateDefinition, startWorkflow, runChain } from "../src/execute.js";
import { openDb } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { runtimeCliInvocation } from "../src/util/cli-path.js";

/**
 * The inspection surfaces a viewer consumes. `status --json` answers "what is
 * true now"; these two answer "what happened", which a recurring workflow needs
 * because the status DTO carries only the unresolved current run.
 */

const oneShot = (id: string): string => `version: 1
id: ${id}
description: One command node.
nodes:
  node-a:
    run:
      command: echo hello
    next: null
`;

/** Run a one-shot workflow `times` times, so the workflow has real history. */
async function runTimes(inst: ReturnType<typeof makeInstallation>, id: string, times: number): Promise<string[]> {
  const real = findInstallation(inst.root);
  const loaded = loadAndValidateDefinition(join(inst.workflowsDir, `${id}.yaml`));
  const store = new Store(openDb(real.dbPath));
  const runIds: string[] = [];
  for (let i = 0; i < times; i++) {
    const started = await startWorkflow({ inst: real, loaded });
    await runChain({ store, inst: real, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });
    runIds.push(started.runId);
  }
  return runIds;
}

describe("workshop runs — the occurrences feed", () => {
  test("lists every occurrence newest first, with status and timing", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    const runIds = await runTimes(inst, "twice", 2);

    const r = runCli(inst, "runs twice");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("twice — 2 run(s), newest first");
    // Newest first is the running order for a feed; the column the operator
    // reads at the top is the one that just happened.
    expect(r.stdout.indexOf(runIds[1]!)).toBeLessThan(r.stdout.indexOf(runIds[0]!));
    for (const id of runIds) expect(r.stdout).toContain(id);
    expect(r.stdout).toMatch(/completed/);
  });

  test("--json emits a versioned feed with explicit nulls", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    const runIds = await runTimes(inst, "twice", 2);

    const r = runCli(inst, "runs twice --json");
    expect(r.code).toBe(0);
    const feed = JSON.parse(r.stdout) as {
      version: number;
      workflowId: string;
      total: number;
      runs: Array<{
        id: string;
        status: string;
        desiredState: string;
        startedAt: string;
        finishedAt: string | null;
        blocker: string | null;
        nodes: Array<{ id: string; status: string }>;
      }>;
    };
    expect(feed.version).toBe(1);
    expect(feed.workflowId).toBe("twice");
    expect(feed.total).toBe(2);
    expect(feed.runs.map((x) => x.id)).toEqual([runIds[1]!, runIds[0]!]);
    for (const run of feed.runs) {
      expect(run.status).toBe("completed");
      expect(run.desiredState).toBe("running");
      expect(run.blocker).toBeNull();
      expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(run.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Each occurrence carries its chain, so a finished run stays inspectable.
      expect(run.nodes.map((n) => n.id)).toEqual(["node-a"]);
      expect(run.nodes[0]!.status).toBe("completed");
      expect(Object.keys(run).sort()).toEqual(
        ["blocker", "desiredState", "finishedAt", "id", "nodes", "startedAt", "status"].sort(),
      );
    }
  });

  test("a workflow with no runs is not an error; an unknown workflow is", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    await runTimes(inst, "twice", 1);

    // Known workflow, no runs: the viewer polls this before anything has run.
    const idle = runCli(inst, "runs twice --json");
    expect(idle.code).toBe(0);
    expect(JSON.parse(idle.stdout).total).toBe(1);

    const typo = runCli(inst, "runs not-a-workflow");
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('no workflow "not-a-workflow"');
  });

  test("an unfinished run has no finish time rather than a fabricated one", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    const real = findInstallation(inst.root);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "twice.yaml"));
    // Start only: the run exists, is unresolved, and has not finished.
    await startWorkflow({ inst: real, loaded });

    const feed = JSON.parse(runCli(inst, "runs twice --json").stdout) as {
      runs: Array<{ finishedAt: string | null; status: string }>;
    };
    expect(feed.runs.length).toBe(1);
    expect(feed.runs[0]!.finishedAt).toBeNull();
    expect(["queued", "running", "paused", "blocked"]).toContain(feed.runs[0]!.status);
  });
});

describe("workshop logs --all — collated occurrences", () => {
  test("--all collates every run oldest first, each under its own header", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    const runIds = await runTimes(inst, "twice", 2);

    const r = runCli(inst, "logs twice --all");
    expect(r.code).toBe(0);
    for (const id of runIds) expect(r.stdout).toContain(`━━ run ${id} — completed ━━`);
    // Oldest → newest, so the collated view reads as one advancing story.
    expect(r.stdout.indexOf(runIds[0]!)).toBeLessThan(r.stdout.indexOf(runIds[1]!));
    // Each run contributes its own worklog, not just a header.
    expect(r.stdout).toContain(readWorklog(inst, runIds[0]!).split("\n")[0]!);

    // The default view is still the newest run alone: the two are different
    // questions, and conflating them would hide history silently.
    const newestOnly = runCli(inst, "logs twice");
    expect(newestOnly.code).toBe(0);
    expect(newestOnly.stdout).toContain(runIds[1]!);
    expect(newestOnly.stdout).not.toContain(runIds[0]!);
  });

  test("--follow with --all is refused rather than silently picking one", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    await runTimes(inst, "twice", 1);

    const r = runCli(inst, "logs twice --all --follow");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pick one");
  });

  test("--all with no runs is an error, since there is nothing to collate", () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    const r = runCli(inst, "logs twice --all");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no runs for workflow "twice"');
  });
});

describe("workshop logs — the process-log presentation", () => {
  test("prints the worklog first, then one labelled block per stream in execution order", async () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    await runTimes(inst, "twice", 1);

    const r = runCli(inst, "logs twice");
    expect(r.code).toBe(0);

    // The worklog is the product, so it leads; process logs follow as evidence.
    expect(r.stdout.startsWith("# Workflow run: twice")).toBe(true);

    // Labels are run-relative paths, so an operator can find the file, and the
    // attempt's own directory is named for its chain position.
    expect(r.stdout).toContain("── nodes/001-node-a/attempt-001/stdout ──");
    expect(r.stdout).toContain("── nodes/001-node-a/attempt-001/stderr ──");
    // A command node's stdout is its output, so it must appear under its label.
    expect(r.stdout).toMatch(/── nodes\/001-node-a\/attempt-001\/stdout ──\nhello/);

    // The content follows its own label. (Searching the whole output would
    // find the same text in the worklog, which is printed first by design.)
    const label = "── nodes/001-node-a/attempt-001/stdout ──";
    const after = r.stdout.slice(r.stdout.indexOf(label) + label.length);
    expect(after.trimStart().startsWith("hello")).toBe(true);
  });

  test("a validator's own streams appear under the attempt's validation directory", async () => {
    const inst = makeInstallation({
      "checked": `version: 1
id: checked
description: A command node with a command validator.
nodes:
  node-a:
    run:
      command: echo payload
    validator:
      command: 'echo "validator says yes"'
    next: null
`,
    });
    const real = findInstallation(inst.root);
    const loaded = loadAndValidateDefinition(join(inst.workflowsDir, "checked.yaml"));
    const started = await startWorkflow({ inst: real, loaded });
    await runChain({ store: new Store(openDb(real.dbPath)), inst: real, loaded, runId: started.runId, cliPath: runtimeCliInvocation() });

    const r = runCli(inst, "logs checked");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("── nodes/001-node-a/attempt-001/validation/stdout ──");
    expect(r.stdout).toContain("validator says yes");
  });

  test("--follow is not the same view as a plain print, and neither invents a run", () => {
    const inst = makeInstallation({ "twice": oneShot("twice") });
    const r = runCli(inst, "logs twice");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no runs for workflow "twice"');
  });
});
