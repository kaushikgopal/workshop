import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { findInstallation } from "../installation/load-installation.js";
import { ServiceOwnershipConflict } from "../service/acquire-service-lock.js";
import {
  applyRecoveryInstallation,
  inspectRecoveryInstallation,
  isRecoveryRequiredTask,
  readRecoveryReceipt,
  RecoveryRefusal,
  type RecoveryActionSelection,
  type RecoveryTerminal,
} from "../service/recover-service-tasks.js";
import { launchServiceProcess } from "../service/launch-service-process.js";
import { errorText } from "./errors.js";

const CLI_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const USAGE = "usage: workshop service recover inspect [--json] | receipt <request-id> [--json] | apply --request-id <uuid> --diagnostic <sha256> [--abort <task-id>]... [--retry <task-id>]... [--verify-retired <task-id>]... --resume-installation --reason <text> [--supersedes <request-id>] [--json]";
const uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const terminal: RecoveryTerminal = {
  isTerminal: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
  async readConfirmation() {
    const input = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try { return await input.question(""); } finally { input.close(); }
  },
  write: (message) => { process.stderr.write(message); },
};

/** Recovery commands bypass the normal service socket and require local ownership. */
export async function cmdRecover(args: readonly string[], terminalOverride?: RecoveryTerminal): Promise<void> {
  const command = parseArguments(args);
  if (command === undefined) return fail(64, USAGE);
  if (command.kind === "apply" && !(terminalOverride ?? terminal).isTerminal()) {
    return fail(64, "recovery apply requires terminal stdin and stderr");
  }
  let installation;
  try { installation = findInstallation(); } catch (error) { return fail(64, errorText(error)); }
  try {
    if (command.kind === "inspect") {
      const manifest = await inspectRecoveryInstallation(installation);
      process.stdout.write(command.json ? JSON.stringify(manifest, null, 2) + "\n" : renderManifest(manifest));
    } else if (command.kind === "receipt") {
      const receipt = await readRecoveryReceipt(installation, command.requestId);
      process.stdout.write(command.json ? JSON.stringify(receipt, null, 2) + "\n" : renderReceipt(receipt));
    } else {
      const result = await applyRecoveryInstallation(installation, command, terminalOverride ?? terminal);
      process.stdout.write(command.json ? JSON.stringify(result.receipt, null, 2) + "\n" : renderReceipt(result.receipt));
      if (result.owner !== null) {
        // The recovered owner is tied to this terminal; hand off to a detached service so closing the terminal does not interrupt work.
        await result.owner.shutdown();
        const launched = await launchServiceProcess({
          root: installation.root,
          stateDirectory: installation.stateDirectory,
          serveArguments: [CLI_PATH, "service", "serve"],
        });
        process.stderr.write(`service ${launched._tag === "started" ? "started" : "already running"} (pid ${launched.metadata.pid}, boot ${launched.metadata.bootId})\n`);
      }
    }
  } catch (error) {
    if (error instanceof RecoveryRefusal) return fail(3, `${error.code}: ${error.message}`);
    if (error instanceof ServiceOwnershipConflict) return fail(3, `service_owner_conflict: ${error.message}`);
    return fail(1, errorText(error));
  }
}

type Command =
  | { kind: "inspect"; json: boolean }
  | { kind: "receipt"; requestId: string; json: boolean }
  | { kind: "apply"; requestId: string; diagnosticDigest: string; actions: RecoveryActionSelection[]; resumeInstallation: true; reason: string; supersedesRequestId: string | null; json: boolean };

function parseArguments(args: readonly string[]): Command | undefined {
  const [kind, ...rest] = args;
  if (kind === "inspect") {
    if (rest.length === 0) return { kind, json: false };
    if (rest.length === 1 && rest[0] === "--json") return { kind, json: true };
    return undefined;
  }
  if (kind === "receipt") {
    const requestId = rest[0];
    if (requestId === undefined || !uuid.safeParse(requestId).success) return undefined;
    if (rest.length === 1) return { kind, requestId, json: false };
    if (rest.length === 2 && rest[1] === "--json") return { kind, requestId, json: true };
    return undefined;
  }
  if (kind !== "apply") return undefined;
  const values = new Map<string, string>();
  const actions: RecoveryActionSelection[] = [];
  let json = false;
  let resumeInstallation = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    if (flag === "--json") { if (json) return undefined; json = true; continue; }
    if (flag === "--resume-installation") { if (resumeInstallation) return undefined; resumeInstallation = true; continue; }
    if (!["--request-id", "--diagnostic", "--reason", "--supersedes", "--abort", "--retry", "--verify-retired"].includes(flag)) return undefined;
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) return undefined;
    if (flag === "--abort" || flag === "--retry" || flag === "--verify-retired") {
      if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
      const action = flag === "--verify-retired" ? "verify_retired" : flag.slice(2);
      actions.push({ taskId: Number(value), action: action as RecoveryActionSelection["action"] });
    } else {
      if (values.has(flag)) return undefined;
      values.set(flag, value);
    }
  }
  const requestId = values.get("--request-id");
  const diagnosticDigest = values.get("--diagnostic");
  const reason = values.get("--reason");
  const supersedesRequestId = values.get("--supersedes") ?? null;
  if (requestId === undefined || !uuid.safeParse(requestId).success || diagnosticDigest === undefined || !digest.safeParse(diagnosticDigest).success
    || reason === undefined || reason.trim().length === 0 || reason.length > 4096 || !resumeInstallation
    || (supersedesRequestId !== null && !uuid.safeParse(supersedesRequestId).success)) return undefined;
  return { kind, requestId, diagnosticDigest, actions, resumeInstallation: true, reason: reason.trim(), supersedesRequestId, json };
}

function renderManifest(manifest: Awaited<ReturnType<typeof inspectRecoveryInstallation>>): string {
  const lines = [`recovery inspection: ${manifest.complete ? "complete" : "incomplete"}`, `digest: ${manifest.digest}`];
  for (const limitation of manifest.limitations) lines.push(`limitation: ${limitation}`);
  if (manifest.activeRequest !== null) {
    lines.push(`active request: ${manifest.activeRequest.requestId} (global dispatch ${manifest.activeRequest.globalDispatch}); use --supersedes`);
  }
  const required = manifest.tasks.filter(isRecoveryRequiredTask);
  const choices: string[] = [];
  let blocked = false;
  for (const task of required) {
    const incarnation = manifest.processIncarnations.find((item) => item.taskId === task.taskId);
    const allowed = incarnation === undefined ? task.policy.permittedActions : [incarnation.action];
    const evidence = task.policy.abortEvidence === "host_death_proof_required" ? " (host death proof)"
      : task.policy.abortEvidence === "operator_attestation_required" ? " (operator attests the process is absent)" : "";
    const identity = incarnation?.process.identity ? `, pid ${incarnation.process.identity.pid}` : "";
    lines.push(`task ${task.taskId} ${task.kind} [${describeAttribution(task.attribution)}]: ${task.state}${task.blockedReason === null ? "" : ` (${task.blockedReason})`}${identity}`);
    if (allowed.length === 0) {
      blocked = true;
      lines.push(`  no permitted action: ${task.policy.abortUnavailableReason ?? task.policy.retryUnavailableReason ?? "unknown"}`);
    } else {
      lines.push(`  permitted: ${allowed.join(", ")}${evidence}`);
      choices.push(`--${allowed[0]!.replace("_", "-")} ${task.taskId}`);
    }
  }
  for (const incarnation of manifest.processIncarnations.filter((item) => item.action === "verify_retired")) {
    lines.push(`task ${incarnation.taskId} ${incarnation.taskKind}: finished with unresolved process ${incarnation.process.identity === null ? "(no recorded identity)" : `pid ${incarnation.process.identity.pid}`}`);
    lines.push("  permitted: verify_retired");
    choices.push(`--verify-retired ${incarnation.taskId}`);
  }
  lines.push(`other tasks: ${manifest.tasks.length - required.length}; queued submissions: ${manifest.queuedSubmissions.length}; schedules: ${manifest.schedules.length}`);
  if (!manifest.complete || blocked) {
    lines.push("recovery cannot proceed until the limitations above are resolved");
  } else if (choices.length === 0 && manifest.activeRequest === null) {
    lines.push("no recovery is required");
  } else {
    const supersedes = manifest.activeRequest === null ? "" : ` --supersedes ${manifest.activeRequest.requestId}`;
    lines.push("review, then run (choose another permitted action where listed):");
    const parts = ["workshop service recover apply --request-id (uuidgen | string lower)", `--diagnostic ${manifest.digest}`, ...choices, "--resume-installation", supersedes.trim(), '--reason "<reason>"'];
    lines.push("  " + parts.filter((part) => part !== "").join(" "));
  }
  return lines.join("\n") + "\n";
}

function describeAttribution(attribution: Awaited<ReturnType<typeof inspectRecoveryInstallation>>["tasks"][number]["attribution"]): string {
  switch (attribution.kind) {
    case "workflow_run": return `workflow ${attribution.workflowId} run ${attribution.runId}`;
    case "scheduler": return `scheduler ${attribution.workflowId}`;
    case "bot": return "shared bot";
    default: return attribution.kind;
  }
}

function renderReceipt(receipt: Awaited<ReturnType<typeof readRecoveryReceipt>>): string {
  const lines = [
    `recovery request ${receipt.requestId}: ${receipt.state}`,
    `  diagnostic ${receipt.diagnosticDigest}`,
    `  global dispatch ${receipt.globalDispatch}`,
  ];
  for (const action of receipt.actions) {
    lines.push(`  task ${action.taskId}: ${action.action}, ${action.state}, evidence ${action.evidence === "operator_attested_absent" ? "attested absent (operator)" : action.evidence === "confirmed_dead" ? "confirmed dead (host proof)" : action.evidence ?? "none"}, dispatch ${action.dispatch}`);
  }
  return lines.join("\n") + "\n";
}

function fail(code: number, message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = code;
}
