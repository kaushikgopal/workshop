import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { findInstallation } from "../installation/load-installation.js";
import { ServiceOwnershipConflict } from "../service/acquire-service-lock.js";
import {
  applyRecoveryInstallation,
  inspectRecoveryInstallation,
  readRecoveryReceipt,
  RecoveryRefusal,
  type RecoveryActionSelection,
  type RecoveryTerminal,
} from "../service/recover-service-tasks.js";
import type { WorkshopServiceOwner } from "../service/serve-workshop-service.js";
import { errorText } from "./errors.js";

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
      if (result.owner !== null) await waitForServiceOwner(result.owner);
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
  return `recovery inspection: ${manifest.complete ? "complete" : "incomplete"}\ndigest: ${manifest.digest}\n` + JSON.stringify({
    limitations: manifest.limitations,
    activeRequest: manifest.activeRequest,
    tasks: manifest.tasks,
    processIncarnations: manifest.processIncarnations,
    queuedSubmissions: manifest.queuedSubmissions,
    schedules: manifest.schedules,
  }, null, 2) + "\n";
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

async function waitForServiceOwner(owner: WorkshopServiceOwner): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const finish = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    const onSignal = (): void => {
      if (stopping) return;
      stopping = true;
      void owner.shutdown().then(finish, (error) => {
        console.error(`error: ${errorText(error)}`);
        process.exitCode = 1;
        finish();
      });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function fail(code: number, message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = code;
}
