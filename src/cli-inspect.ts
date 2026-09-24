import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findInstallation, workflowPath, type Installation } from "./config.js";
import { die, requireArg } from "./cli-io.js";
import { loadAndValidateDefinition } from "./execute.js";
import { openDb } from "./store/db.js";
import { Store, isTerminal, type AttemptRow } from "./store/store.js";
import { buildNodesForRun, buildStatusDto } from "./status/dto.js";
import { glyph, localClock } from "./status/format.js";
import { deriveNodeStatus } from "./status/node-status.js";
import { buildRunsFeed, DEFAULT_RUNS_LIMIT } from "./status/runs-feed.js";
import { renderTreeStatus } from "./status/tree.js";
import { resolveNode } from "./runner/attempt.js";
import { attemptFolderOfPacket } from "./worklog/worklog.js";
import { SystemClock } from "./util/clock.js";
import { readTruncationRecord } from "./util/retention.js";

/**
 * The read-only inspection commands: status, runs, logs, diagram, and node
 * describe.
 *
 * Split from `cli.ts` because they are a different job from controlling runs.
 * These only read the projections and print them, so the whole surface can be
 * deleted — or moved behind another entry point — without touching dispatch,
 * lifecycle control, or the viewer's lazy load.
 */

export function cmdStatus(args: string[]): void {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 1) die("usage: workshop status [<workflow-id>] [--json]");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const workflowId = positional[0];
  if (workflowId && !store.getWorkflow(workflowId)) die(`no workflow "${workflowId}"`);
  const dto = buildStatusDto(store, new SystemClock().now(), workflowId);
  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
  } else {
    process.stdout.write(renderTreeStatus(store, workflowId));
  }
}

/** The attempt's process-log files that exist: streams and validator streams. */
function attemptStreamFiles(attemptFolder: string): string[] {
  const candidates = [
    join(attemptFolder, "stdout"),
    join(attemptFolder, "stderr"),
    join(attemptFolder, "validation", "stdout"),
    join(attemptFolder, "validation", "stderr"),
  ];
  return candidates.filter((p) => existsSync(p));
}

export function cmdRuns(args: string[]): void {
  const all = args.includes("--all");
  const json = args.includes("--json");
  const workflowId = requireArg(args.filter((a) => !a.startsWith("--")), "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  // An unknown workflow is a typo; a known workflow with no runs is simply young.
  if (!store.getWorkflow(workflowId)) die(`no workflow "${workflowId}"`);
  const rows = store.listRuns(workflowId); // seq ascending
  const feed = buildRunsFeed({
    workflowId,
    runs: rows,
    all,
    limit: DEFAULT_RUNS_LIMIT,
    nodes: (runId) => buildNodesForRun(store, runId),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
    return;
  }

  if (feed.total === 0) {
    process.stdout.write(`${workflowId} — no runs yet\n`);
    return;
  }
  const hidden = feed.total - feed.runs.length;
  process.stdout.write(`${workflowId} — ${feed.total} run(s), newest first\n`);
  for (const r of feed.runs) {
    const began = localClock(r.startedAt);
    const ended = r.finishedAt ? localClock(r.finishedAt) : "";
    const span = ended ? `${began} → ${ended}` : `since ${began}`;
    const suffix = r.blocker ? `  (${r.blocker})` : "";
    process.stdout.write(`  ${glyph(r.status)} ${r.id}  ${r.status}  ${span}${suffix}\n`);
  }
  if (hidden > 0) process.stdout.write(`  … ${hidden} older run(s); pass --all to include them\n`);
}

/** Most recent run by seq; prints its worklog plus its attempt process logs
 *  in chronological execution order, optionally tailing to completion.
 *  `--all` instead collates every run's worklog, oldest → newest. */
export async function cmdLogs(args: string[]): Promise<void> {
  const follow = args.includes("--follow");
  const all = args.includes("--all");
  if (follow && all) die("--follow tails the newest run; --all collates every run — pick one");
  const workflowId = requireArg(args.filter((a) => !a.startsWith("--")), "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));

  if (all) {
    const every = store.listRuns(workflowId); // seq ascending → oldest first
    if (every.length === 0) die(`no runs for workflow "${workflowId}"`);
    for (const r of every) {
      process.stdout.write(`\n━━ run ${r.run_id} — ${r.status} ━━\n`);
      process.stdout.write(readFileSync(r.worklog_path, "utf8"));
    }
    return;
  }

  const run = store.getMostRecentRun(workflowId);
  if (!run) die(`no runs for workflow "${workflowId}"`);

  process.stdout.write(readFileSync(run.worklog_path, "utf8"));

  // Process logs in execution order: the run's chronological spine, one
  // labeled block per stream (agent/validator stdout + stderr).
  const attempts = store.listAttempts(run.run_id).sort((a, b) => a.execution_seq - b.execution_seq);
  for (const attempt of attempts) {
    const folder = attemptFolderOfPacket(attempt.packet_path);
    for (const stream of attemptStreamFiles(folder)) {
      const relative = stream.slice(run.run_dir.length + 1);
      // A capped stream says so in its header: the bytes it lost are recorded
      // beside it, never dropped silently.
      const truncation = readTruncationRecord(stream);
      const note = truncation
        ? ` (truncated: ${truncation.totalBytes} bytes → ${truncation.keptHeadBytes} head + ${truncation.keptTailBytes} tail)`
        : "";
      process.stdout.write(`\n── ${relative} ──${note}\n`);
      process.stdout.write(readFileSync(stream, "utf8"));
    }
  }

  if (!follow) return;

  // Tail: print appended worklog lines until the run reaches a terminal state.
  let offset = (readFileSync(run.worklog_path, "utf8")).length;
  for (;;) {
    const fresh = store.getRun(run.run_id)!;
    const content = readFileSync(fresh.worklog_path, "utf8");
    if (content.length > offset) {
      process.stdout.write(content.slice(offset));
      offset = content.length;
    }
    if (isTerminal(fresh.status)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Chain rendering with runtime status; --mermaid emits a flowchart. */
export function cmdDiagram(args: string[]): void {
  const mermaid = args.includes("--mermaid");
  const workflowId = requireArg(args.filter((a) => !a.startsWith("--")), "workflow-id");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const wf = store.getWorkflow(workflowId);
  if (!wf) die(`no workflow "${workflowId}"`);
  const run = store.getMostRecentRun(workflowId);
  const loaded = loadAndValidateDefinition(wf.canonical_definition_hash === "" ? workflowPath(inst, workflowId) : join(run?.run_dir ?? "", "definition.yaml"));
  const nodeStatus = new Map<string, string>();
  if (run) {
    const byNode = new Map<string, AttemptRow[]>();
    for (const attempt of store.listAttempts(run.run_id)) {
      const list = byNode.get(attempt.node_id) ?? [];
      list.push(attempt);
      byNode.set(attempt.node_id, list);
    }
    for (const [id, attempts] of byNode) nodeStatus.set(id, deriveNodeStatus(attempts));
  }

  if (mermaid) {
    const lines = ["flowchart LR"];
    for (const id of loaded.chain.order) {
      const status = nodeStatus.get(id);
      const label = status ? `${id} [${status}]` : id;
      lines.push(`  ${id.replaceAll("-", "_")}["${label}"]`);
      const next = loaded.chain.next.get(id);
      if (next) lines.push(`  ${id.replaceAll("-", "_")} --> ${next.replaceAll("-", "_")}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    const parts = loaded.chain.order.map((id) => {
      const status = nodeStatus.get(id);
      const glyph = status === "completed" ? "◉" : status === "failed" ? "✗" : status === "blocked" ? "⊘" : status ? "◎" : "○";
      return `${glyph} ${id}${status ? ` (${status})` : ""}`;
    });
    process.stdout.write(parts.join(" → ") + "\n");
  }
}

/** Snapshot properties + resolved settings + runtime status for one node. */
export function cmdNode(args: string[]): void {
  const [sub, workflowId, nodeId] = args;
  if (sub !== "describe" || !workflowId || !nodeId) die("usage: workshop node describe <workflow-id> <node-id> [--json]");
  const json = args.includes("--json");
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));
  const run = store.getMostRecentRun(workflowId);
  const snapshotPath = run ? join(run.run_dir, "definition.yaml") : workflowPath(inst, workflowId);
  const loaded = loadAndValidateDefinition(snapshotPath);
  const node = loaded.def.nodes[nodeId];
  if (!node) die(`no node "${nodeId}" in ${workflowId}`);
  const resolved = resolveNode(loaded.def, nodeId, inst);
  const attempts = run ? store.listAttempts(run.run_id).filter((a) => a.node_id === nodeId) : [];

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          id: nodeId,
          run: resolved.run.kind === "command" ? { command: resolved.run.command } : { agent: { model: resolved.run.resolution.model?.full, instructions: resolved.run.agent.instructions } },
          validator: resolved.validator
            ? resolved.validator.kind === "command"
              ? { command: resolved.validator.command, timeoutMs: resolved.validator.timeoutMs }
              : { agent: { model: resolved.validator.resolution.model?.full } }
            : null,
          successor: loaded.chain.next.get(nodeId) ?? null,
          resolvedMaxAttempts: resolved.maxAttempts,
          resolvedTimeoutMs: resolved.timeoutMs,
          attempts: attempts.map((a) => ({ number: a.attempt, status: a.status, failure: a.failure_kind, progress: a.current_progress, validator: a.validator_status })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [
    `Node      ${nodeId}`,
    `Run       ${resolved.run.kind === "command" ? "command" : "agent"}${resolved.run.kind === "command" ? ": " + resolved.run.command : ""}`,
    `Successor ${loaded.chain.next.get(nodeId) ?? "(end)"}`,
    `Attempts  ≤ ${resolved.maxAttempts} · timeout ${resolved.timeoutMs ?? "unlimited"}ms`,
  ];
  for (const a of attempts) {
    lines.push(`  #${a.attempt} ${a.status}${a.failure_kind ? ` (${a.failure_kind})` : ""}${a.current_progress ? ` — ${a.current_progress}` : ""}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}
