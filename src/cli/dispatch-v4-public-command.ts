import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadCheckedV2Workflow, findV2Installation } from "../installation/load-v2-installation.js";
import type { V2Installation } from "../installation/load-v2-installation.js";
import { launchV2ServiceProcess } from "../service/launch-v2-service-process.js";
import { readServiceWorklog, sendServiceRequest, streamServiceLogChunks, ServiceConnectionError } from "../service/send-service-request.js";
import { runIdV2Schema } from "../run/schema-v2.js";
import { glyph, localClock } from "../views/format-for-terminal.js";
import {
  diagramDtoV2Schema,
  nodeDescriptionDtoV2Schema,
  runsDtoV2Schema,
  statusDtoV2Schema,
  type RunSummaryDtoV2,
} from "../views/schema-v2.js";
import {
  serviceRunsPageV1Schema,
  serviceStartResultV1Schema,
  serviceResolveResultV1Schema,
  type ServiceLogSectionPageV1,
  type ServiceRequestV1,
} from "../service/schema.js";
import { errorText } from "./errors.js";

const CLI_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const SERVICE_START_TIMEOUT_MS = 10_000;

type PublicCommand = "start" | "pause" | "resume" | "stop" | "resolve" | "status" | "runs" | "logs" | "diagram" | "watch" | "node.describe";

export async function dispatchV4PublicCommand(command: PublicCommand, args: readonly string[]): Promise<void> {
  try {
    switch (command) {
      case "start": await startCommand(args); return;
      case "pause":
      case "resume":
      case "stop": await controlCommand(command, args); return;
      case "resolve": await resolveCommand(args); return;
      case "status": await statusCommand(args); return;
      case "runs": await runsCommand(args); return;
      case "logs": await logsCommand(args); return;
      case "diagram": await diagramCommand(args); return;
      case "watch": await watchCommand(args); return;
      case "node.describe": await nodeDescribeCommand(args); return;
    }
  } catch (error) {
    console.error(`error: ${errorText(error)}`);
    process.exitCode = error instanceof V4CliUsageError ? 64 : error instanceof ServiceConnectionError ? 3 : 1;
  }
}


async function startCommand(args: readonly string[]): Promise<void> {
  const detach = args.includes("--detach");
  const positional = args.filter((argument) => argument !== "--detach");
  if (positional.length !== 1 || args.some((argument) => argument.startsWith("-") && argument !== "--detach")) {
    return usage("usage: workshop start <workflow> [--detach]");
  }
  const installation = loadInstallationForCommand();
  try { loadCheckedV2Workflow(installation, positional[0]!); }
  catch (error) { throw new V4CliUsageError(errorText(error), { cause: error }); }
  const socketPath = await ensureService(installation);
  const response = await request(socketPath, {
    version: 1,
    method: "start",
    requestId: randomUUID(),
    workflowId: positional[0]!,
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const started = serviceStartResultV1Schema.parse(response.result);
  process.stdout.write(`${started.duplicate ? "Using existing run" : "Started run"} ${started.runId}\n`);
  if (detach) return;
  const result = await waitForRun(socketPath, started.workflowId, started.runId);
  process.stdout.write(`${result.status} ${result.runId}\n`);
  if (result.status === "blocked") process.exitCode = 2;
  else if (result.status === "failed" || result.status === "cancelled") process.exitCode = 1;
}

async function controlCommand(command: "pause" | "resume" | "stop", args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0]!.startsWith("-")) {
    return usage(`usage: workshop ${command} <workflow>`);
  }
  const workflowId = args[0]!;
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const response = await request(socketPath, {
    version: 1,
    method: command,
    requestId: randomUUID(),
    workflowId,
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  if (typeof response.result !== "object" || response.result === null || Array.isArray(response.result)) {
    throw new Error("service returned an invalid control result");
  }
  const result = response.result as Record<string, unknown>;
  if (result.workflowId !== workflowId || typeof result.status !== "string" || typeof result.desiredState !== "string") {
    throw new Error("service returned an invalid control result");
  }
  const run = typeof result.runId === "string" ? ` ${result.runId}` : "";
  process.stdout.write(`${command} ${workflowId}: ${result.status} (${result.desiredState})${run}\n`);
  if (result.status === "blocked") process.exitCode = 2;
}


async function resolveCommand(args: readonly string[]): Promise<void> {
  let action: "retry" | "accept" | "fail" | undefined;
  let reason: string | undefined;
  let runId: string | undefined;
  let retryTarget: "judgment" | undefined;
  let resultFile: string | undefined;
  let allowRepeat = false;
  let extraAttempt = false;
  let acknowledgeEffects = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--action") {
      const value = args[++index];
      if (action !== undefined || (value !== "retry" && value !== "accept" && value !== "fail")) return usage("--action requires retry, accept, or fail");
      action = value;
      continue;
    }
    if (argument === "--target") {
      const value = args[++index];
      if (retryTarget !== undefined || value !== "judgment") return usage("--target supports only judgment");
      retryTarget = value;
      continue;
    }
    if (argument === "--reason") {
      const value = args[++index];
      if (reason !== undefined || value === undefined) return usage("--reason requires one text value");
      reason = value;
      continue;
    }
    if (argument === "--run") {
      const value = args[++index];
      if (runId !== undefined || value === undefined) return usage("--run requires one run ID");
      runId = parseRunIdArgument(value);
      continue;
    }
    if (argument === "--result-file") {
      const value = args[++index];
      if (resultFile !== undefined || value === undefined) return usage("--result-file requires one path");
      resultFile = value;
      continue;
    }
    if (argument === "--allow-repeat") {
      if (allowRepeat) return usage("--allow-repeat may be supplied once");
      allowRepeat = true;
      continue;
    }
    if (argument === "--extra-attempt") {
      if (extraAttempt) return usage("--extra-attempt may be supplied once");
      extraAttempt = true;
      continue;
    }
    if (argument === "--acknowledge-effects") {
      if (acknowledgeEffects) return usage("--acknowledge-effects may be supplied once");
      acknowledgeEffects = true;
      continue;
    }
    if (argument.startsWith("-")) return usage(`unsupported v4 resolve option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length !== 1 || action === undefined || reason === undefined || reason.trim() === "") {
    return usage("usage: workshop resolve <workflow> --action retry|accept|fail --reason <text> [--run <id>] [--target judgment] [--allow-repeat] [--extra-attempt] [--result-file <path> --acknowledge-effects]");
  }
  if ((action === "accept") !== (resultFile !== undefined && acknowledgeEffects)) {
    return usage("accept requires both --result-file and --acknowledge-effects");
  }
  if (action !== "accept" && (resultFile !== undefined || acknowledgeEffects)) return usage("accept-only flags cannot be used with retry or fail");
  if (action !== "retry" && (allowRepeat || extraAttempt || retryTarget !== undefined)) return usage("retry-only flags cannot be used with accept or fail");
  if (retryTarget === "judgment" && (allowRepeat || extraAttempt)) return usage("--target judgment cannot be combined with --allow-repeat or --extra-attempt");

  const workflowId = positional[0]!;
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const statusResponse = await request(socketPath, { version: 1, method: "status", workflowId });
  if (!statusResponse.ok) throw new Error(`${statusResponse.error.code}: ${statusResponse.error.message}`);
  const status = statusDtoV2Schema.parse(statusResponse.result);
  const workflow = status.workflows.find((entry) => entry.workflowId === workflowId);
  const blockedRun = workflow?.unresolvedRun;
  if (blockedRun === null || blockedRun === undefined || blockedRun.status !== "blocked") {
    throw new Error(`workflow ${workflowId} has no current blocked run to resolve`);
  }
  if (runId !== undefined && runId !== blockedRun.runId) throw new Error(`run ${runId} is not the current blocked run`);
  const resolvedRunId = runIdV2Schema.parse(blockedRun.runId);
  process.stdout.write(`Resolving run ${resolvedRunId}\n`);
  const response = await request(socketPath, {
    version: 1, method: "resolve", requestId: randomUUID(), workflowId, runId: resolvedRunId, action, reason,
    ...(retryTarget === undefined ? {} : { target: retryTarget }),
    ...(allowRepeat ? { allowRepeat: true } : {}),
    ...(extraAttempt ? { extraAttempt: true } : {}),
    ...(resultFile === undefined ? {} : { resultFile, acknowledgeEffects: true }),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const resolved = serviceResolveResultV1Schema.parse(response.result);
  if (resolved.workflowId !== workflowId || resolved.runId !== resolvedRunId) throw new Error("service resolved a different run");
  process.stdout.write(`resolved ${workflowId} ${resolvedRunId}: ${resolved.status} (${resolved.resolutionId})\n`);
  if (resolved.status === "failed") process.exitCode = 1;
}

async function statusCommand(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  const positional = args.filter((argument) => argument !== "--json");
  if (positional.length > 1 || args.some((argument) => argument.startsWith("-") && argument !== "--json")) {
    return usage("usage: workshop status [<workflow>] [--json]");
  }
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const workflowId = positional[0];
  const response = await request(socketPath, {
    version: 1,
    method: "status",
    ...(workflowId === undefined ? {} : { workflowId }),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const status = statusDtoV2Schema.parse(response.result);
  if (json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else {
    for (const workflow of status.workflows) {
      const activation = workflow.activation === null ? "inactive" : `${workflow.activation.state} (${workflow.activation.admittedCount}/${workflow.activation.maxRuns})`;
      const run = workflow.unresolvedRun === null ? "no unresolved run" : `${workflow.unresolvedRun.status} ${workflow.unresolvedRun.runId}`;
      process.stdout.write(`${workflow.workflowId}: ${activation}; ${run}\n`);
      if (workflow.configurationError !== null) process.stdout.write(`  configuration error: ${workflow.configurationError}\n`);
    }
  }
}

async function runsCommand(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  const all = args.includes("--all");
  const positional = args.filter((argument) => argument !== "--json" && argument !== "--all");
  if (positional.length !== 1 || args.some((argument) => argument.startsWith("-") && argument !== "--json" && argument !== "--all")) {
    return usage("usage: workshop runs <workflow> [--json] [--all]");
  }
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const workflowId = positional[0]!;
  const pageLimit = all ? 100 : 50;
  const runs: RunSummaryDtoV2[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  let highWaterMark: number | undefined;
  const seenCursors = new Set<string>();
  do {
    const response = await request(socketPath, {
      version: 1,
      method: "runs",
      workflowId,
      limit: pageLimit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    const page = serviceRunsPageV1Schema.parse(response.result);
    if (total !== undefined && (page.total !== total || page.highWaterMark !== highWaterMark)) {
      throw new Error("run pages changed their admission snapshot");
    }
    total = page.total;
    highWaterMark = page.highWaterMark;
    runs.push(...page.runs);
    if (!all || page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) throw new Error("service repeated a run-page cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);

  const projection = runsDtoV2Schema.parse({
    version: 2,
    workflowId,
    total: total ?? 0,
    truncated: (total ?? 0) > runs.length,
    runs,
  });
  if (json) process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
  else {
    process.stdout.write(`${workflowId} — ${projection.total} run(s), newest first\n`);
    for (const run of projection.runs) {
      const began = localClock(run.startedAt ?? run.admittedAt);
      const span = run.finishedAt === null ? `since ${began}` : `${began} → ${localClock(run.finishedAt)}`;
      const detail = run.block?.kind ?? run.failure?.kind;
      const suffix = detail === undefined ? "" : ` (${detail})`;
      process.stdout.write(`${glyph(run.status)} ${run.runId}  ${run.status}  ${span}${suffix}\n`);
    }
    const hidden = projection.total - projection.runs.length;
    if (hidden > 0) process.stdout.write(`… ${hidden} older run(s); pass --all to include them\n`);
  }
}

async function logsCommand(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  let all = false;
  let follow = false;
  let runId: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") continue;
    if (argument === "--all") { all = true; continue; }
    if (argument === "--follow") { follow = true; continue; }
    if (argument === "--run") {
      if (runId !== undefined) return usage("--run may be supplied once");
      runId = args[++index];
      if (runId === undefined) return usage("--run requires a run ID");
      continue;
    }
    if (argument.startsWith("-")) return usage(`unsupported v4 logs option: ${argument}`);
    positional.push(argument);
  }
  const usageText = "usage: workshop logs <workflow> [--run <run-id>] [--follow | --all] [--json]";
  if (positional.length !== 1) return usage(usageText);
  if ((follow && all) || (all && runId !== undefined)) return usage("--all cannot be combined with --follow or --run");
  const workflowId = positional[0]!;
  const checkedRunId = runId === undefined ? undefined : parseRunIdArgument(runId);
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);

  if (all) {
    const history = await readAllRunSummaries(socketPath, workflowId);
    if (history.runs.length === 0) throw new Error(`workflow ${workflowId} has no runs`);
    if (json) await writeStdout(`{"version":2,"workflowId":${JSON.stringify(workflowId)},"runs":[`);
    let firstRun = true;
    for (const run of history.runs.slice().reverse()) {
      if (json) {
        if (!firstRun) await writeStdout(",");
        await writeStdout(`{"version":2,"runId":${JSON.stringify(run.runId)},"sections":[`);
      } else {
        await writeStdout(`\n━━ run ${run.runId} — ${run.status} ━━\n`);
      }
      firstRun = false;
      let firstSection = true;
      const result = await streamServiceLogChunks(socketPath, workflowId, run.runId, async (section, selectedRunId, chunk) => {
        if (chunk.offsetBytes === 0) {
          if (json) {
            if (!firstSection) await writeStdout(",");
            if (firstSection && selectedRunId !== run.runId) throw new Error("service changed the selected run during logs");
            await writeJsonLogSectionStart(section);
          } else {
            await writeTextLogSectionStart(section);
            if (section.kind === "capture" && section.content === null) await writeStdout(`[unavailable: ${section.unavailableReason}]\n`);
          }
          firstSection = false;
        }
        if (json) {
          if (section.content !== null) await writeStdout(JSON.stringify(section.content).slice(1, -1));
          if (chunk.complete && section.content !== null) await writeStdout('"}');
        } else if (section.content !== null) {
          await writeStdout(section.content);
          if (chunk.complete) await writeStdout("\n");
        }
      });
      if (json) await writeStdout(`],"projection":${JSON.stringify(result.projection)}}`);
    }
    if (json) await writeStdout("]}\n");
    return;
  }

  if (follow) {
    const followedRunId = checkedRunId ?? await readNewestRunId(socketPath, workflowId);
    if (!json) {
      await followRunWorklog(socketPath, workflowId, followedRunId);
      await streamServiceLogChunks(socketPath, workflowId, followedRunId, async (section, _selectedRunId, chunk) => {
        if (section.kind !== "capture") return;
        if (chunk.offsetBytes === 0) {
          await writeTextLogSectionStart(section);
          if (section.content === null) await writeStdout(`[unavailable: ${section.unavailableReason}]\n`);
        }
        if (section.content !== null) {
          await writeStdout(section.content);
          if (chunk.complete) await writeStdout("\n");
        }
      });
      return;
    }
    await waitForTerminalRun(socketPath, workflowId, followedRunId);
    await writeSingleRunLogs(socketPath, workflowId, followedRunId, true);
    return;
  }

  await writeSingleRunLogs(socketPath, workflowId, checkedRunId, json);
}

async function writeSingleRunLogs(
  socketPath: string,
  workflowId: string,
  runId: RunSummaryDtoV2["runId"] | undefined,
  json: boolean,
): Promise<void> {
  let firstSection = true;
  const result = await streamServiceLogChunks(socketPath, workflowId, runId, async (section, selectedRunId, chunk) => {
    if (chunk.offsetBytes === 0) {
      if (json) {
        if (firstSection) await writeStdout(`{"version":2,"runId":${JSON.stringify(selectedRunId)},"sections":[`);
        else await writeStdout(",");
        await writeJsonLogSectionStart(section);
      } else {
        await writeTextLogSectionStart(section);
        if (section.kind === "capture" && section.content === null) await writeStdout(`[unavailable: ${section.unavailableReason}]\n`);
      }
      firstSection = false;
    }
    if (json) {
      if (section.content !== null) await writeStdout(JSON.stringify(section.content).slice(1, -1));
      if (chunk.complete && section.content !== null) await writeStdout('"}');
    } else if (section.content !== null) {
      await writeStdout(section.content);
      if (chunk.complete) await writeStdout("\n");
    }
  });
  if (json) {
    if (firstSection) throw new Error("service returned no log sections");
    await writeStdout(`],"projection":${JSON.stringify(result.projection)}}\n`);
  }
}

type PublicLogSection = ServiceLogSectionPageV1["section"];

async function writeJsonLogSectionStart(section: PublicLogSection): Promise<void> {
  if (section.content === null) {
    await writeStdout(JSON.stringify(section));
    return;
  }
  const { content: _content, ...metadata } = section;
  const emptyContent = JSON.stringify({ ...metadata, content: "" });
  await writeStdout(emptyContent.slice(0, -2));
}

async function writeTextLogSectionStart(section: PublicLogSection): Promise<void> {
  const retainedWindow = section.kind !== "capture" || section.capture.keptHeadBytes === undefined
    || section.capture.keptTailBytes === undefined
    ? section.kind === "capture" ? `${section.capture.retainedBytes} retained` : ""
    : `${section.capture.retainedBytes} retained (${section.capture.keptHeadBytes} head + ${section.capture.keptTailBytes} tail)`;
  const captureSummary = section.kind !== "capture" ? ""
    : ` (${section.capture.totalBytes} bytes total; ${retainedWindow}${section.capture.truncatedBytes > 0 ? `, ${section.capture.truncatedBytes} omitted` : ""}${section.capture.complete ? "" : "; incomplete"})`;
  await writeStdout(`\n── ${section.label} ──${captureSummary}\n`);
}

async function followRunWorklog(socketPath: string, workflowId: string, runId: RunSummaryDtoV2["runId"]): Promise<void> {
  let previous = await readWorklogSnapshot(socketPath, workflowId, runId);
  await writeStdout(previous);
  for (;;) {
    const summary = await findRunSummary(socketPath, workflowId, runId);
    const current = await readWorklogSnapshot(socketPath, workflowId, runId);
    if (current.startsWith(previous)) await writeStdout(current.slice(previous.length));
    else if (current !== previous) {
      await writeStdout("\n[worklog updated]\n");
      await writeStdout(current);
    }
    previous = current;
    if (isTerminalRun(summary.status)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

async function readWorklogSnapshot(socketPath: string, workflowId: string, runId: RunSummaryDtoV2["runId"]): Promise<string> {
  return readServiceWorklog(socketPath, workflowId, runId);
}

async function waitForTerminalRun(socketPath: string, workflowId: string, runId: RunSummaryDtoV2["runId"]): Promise<void> {
  for (;;) {
    const summary = await findRunSummary(socketPath, workflowId, runId);
    if (isTerminalRun(summary.status)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

function isTerminalRun(status: RunSummaryDtoV2["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function diagramCommand(args: readonly string[]): Promise<void> {
  let mermaid = false;
  let runId: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--mermaid") {
      if (mermaid) return usage("--mermaid may be supplied once");
      mermaid = true;
      continue;
    }
    if (argument === "--run") {
      if (runId !== undefined) return usage("--run may be supplied once");
      runId = args[++index];
      if (runId === undefined) return usage("--run requires a run ID");
      continue;
    }
    if (argument.startsWith("-")) return usage(`unsupported v4 diagram option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length !== 1) {
    return usage("usage: workshop diagram <workflow> [--run <run-id>] [--mermaid]");
  }
  const checkedRunId = runId === undefined ? undefined : parseRunIdArgument(runId);
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const response = await request(socketPath, {
    version: 1,
    method: "diagram",
    workflowId: positional[0]!,
    ...(checkedRunId === undefined ? {} : { runId: checkedRunId }),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const diagram = diagramDtoV2Schema.parse(response.result);
  if (mermaid) {
    const lines = ["flowchart LR", `%% ${diagram.workflowId}${diagram.runId === null ? "" : ` ${diagram.runId}`}`];
    for (const node of diagram.nodes) {
      const id = node.nodeId.replaceAll("-", "_");
      const label = node.status === null ? node.nodeId : `${node.nodeId} [${node.status}]`;
      lines.push(`  ${id}["${label}"]`);
      if (node.successorId !== null) lines.push(`  ${id} --> ${node.successorId.replaceAll("-", "_")}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  const chain = diagram.nodes.map((node) => {
    const status = node.status === null ? "" : ` (${node.status})`;
    return `${glyph(node.status ?? "pending")} ${node.nodeId}${status}`;
  });
  process.stdout.write(`${chain.join(" → ")}\n`);
}


async function readNewestRunId(socketPath: string, workflowId: string): Promise<RunSummaryDtoV2["runId"]> {
  const response = await request(socketPath, { version: 1, method: "runs", workflowId, limit: 1 });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const page = serviceRunsPageV1Schema.parse(response.result);
  const newest = page.runs[0];
  if (newest === undefined) throw new Error(`workflow ${workflowId} has no runs`);
  return newest.runId;
}

async function readAllRunSummaries(socketPath: string, workflowId: string): Promise<{ readonly total: number; readonly runs: RunSummaryDtoV2[] }> {
  const runs: RunSummaryDtoV2[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  let highWaterMark: number | undefined;
  const seenCursors = new Set<string>();
  do {
    const response = await request(socketPath, {
      version: 1, method: "runs", workflowId, limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    const page = serviceRunsPageV1Schema.parse(response.result);
    if (total !== undefined && (page.total !== total || page.highWaterMark !== highWaterMark)) {
      throw new Error("run pages changed their admission snapshot");
    }
    total = page.total;
    highWaterMark = page.highWaterMark;
    runs.push(...page.runs);
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) throw new Error("service repeated a run-page cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  if (runs.length !== (total ?? 0)) throw new Error("service ended run history before its snapshot was complete");
  return { total: total ?? 0, runs };
}

async function findRunSummary(socketPath: string, workflowId: string, runId: RunSummaryDtoV2["runId"]): Promise<RunSummaryDtoV2> {
  let cursor: string | undefined;
  let total: number | undefined;
  let highWaterMark: number | undefined;
  const seenCursors = new Set<string>();
  do {
    const response = await request(socketPath, {
      version: 1, method: "runs", workflowId, limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    const page = serviceRunsPageV1Schema.parse(response.result);
    if (total !== undefined && (page.total !== total || page.highWaterMark !== highWaterMark)) {
      throw new Error("run pages changed their admission snapshot");
    }
    total = page.total;
    highWaterMark = page.highWaterMark;
    const found = page.runs.find((run) => run.runId === runId);
    if (found !== undefined) return found;
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) throw new Error("service repeated a run-page cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  throw new Error(`service no longer lists admitted run ${runId}`);
}

async function watchCommand(args: readonly string[]): Promise<void> {
  if (args.length > 1 || args.some((argument) => argument.startsWith("-"))) {
    return usage("usage: workshop watch [<workflow>]");
  }
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const { openV4Watch } = await import("./watch-v4.js");
  await openV4Watch(socketPath, args[0] ?? null);
}

async function nodeDescribeCommand(args: readonly string[]): Promise<void> {
  let runId: string | undefined;
  const positional: string[] = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") { json = true; continue; }
    if (argument === "--run") {
      runId = args[++index];
      if (runId === undefined) return usage("--run requires a run ID");
      continue;
    }
    if (argument.startsWith("-")) return usage(`unsupported v4 node describe option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length !== 2) return usage("usage: workshop node describe <workflow> <node> [--run <run-id>] [--json]");
  const checkedRunId = runId === undefined ? undefined : parseRunIdArgument(runId);
  const installation = loadInstallationForCommand();
  const socketPath = await ensureService(installation);
  const response = await request(socketPath, {
    version: 1,
    method: "node.describe",
    workflowId: positional[0]!,
    nodeId: positional[1]!,
    ...(checkedRunId === undefined ? {} : { runId: checkedRunId }),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const description = nodeDescriptionDtoV2Schema.parse(response.result);
  if (json) process.stdout.write(`${JSON.stringify(description, null, 2)}\n`);
  else {
    const { node } = description;
    process.stdout.write(`${description.workflowId}/${node.nodeId}  ${node.status}  ${description.runId ?? "no run"}\n`);
    if (node.successfulOutput !== null) process.stdout.write(`${node.successfulOutput}\n`);
  }
}

async function waitForRun(socketPath: string, workflowId: string, runId: string): Promise<RunSummaryDtoV2> {
  for (;;) {
    let cursor: string | undefined;
    let found: RunSummaryDtoV2 | undefined;
    do {
      const response = await request(socketPath, {
        version: 1,
        method: "runs",
        workflowId,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      const page = serviceRunsPageV1Schema.parse(response.result);
      found = page.runs.find((run) => run.runId === runId);
      if (found !== undefined || page.nextCursor === null) break;
      cursor = page.nextCursor;
    } while (true);
    if (found === undefined) throw new Error(`service no longer lists admitted run ${runId}`);
    if (["completed", "failed", "blocked", "cancelled", "paused"].includes(found.status)) return found;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
}

async function ensureService(installation: V2Installation): Promise<string> {
  const launched = await launchV2ServiceProcess({
    root: installation.root,
    stateDirectory: installation.stateDirectory,
    serveArguments: [CLI_PATH, "--engine", "v4", "service", "serve"],
    timeoutMs: SERVICE_START_TIMEOUT_MS,
  });
  return launched.metadata.socketPath;
}

function request(socketPath: string, value: ServiceRequestV1) {
  return sendServiceRequest(socketPath, value);
}
function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => error === null || error === undefined ? resolve() : reject(error));
  });
}


function loadInstallationForCommand(): V2Installation {
  try { return findV2Installation(); }
  catch (error) { throw new V4CliUsageError(errorText(error), { cause: error }); }
}

function parseRunIdArgument(value: string) {
  try { return runIdV2Schema.parse(value); }
  catch (error) { throw new V4CliUsageError(errorText(error), { cause: error }); }
}

class V4CliUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "V4CliUsageError";
  }
}

function usage(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 64;
}
