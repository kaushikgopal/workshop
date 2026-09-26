import { findInstallation } from "../load-installation.js";
import { openDb } from "../storage/db/open-and-migrate.js";
import { Store, type BlockKind } from "../storage/db/store.js";
import { SystemClock } from "../util/clock.js";
import { die } from "./errors.js";

/**
 * `workshop runtime progress|block` — the commands a running agent calls back
 * through `$WORKSHOP_CLI`. Hidden from help: humans never type these.
 */

/** Internal agent-facing commands. Owner-authenticated via environment. */
export function cmdRuntime(args: string[]): void {
  const [sub, ...rest] = args;
  const inst = findInstallation();
  const store = new Store(openDb(inst.dbPath));

  const runId = process.env.WORKSHOP_RUN_ID;
  const nodeId = process.env.WORKSHOP_NODE_ID;
  const attempt = Number(process.env.WORKSHOP_ATTEMPT);
  const ownerToken = process.env.WORKSHOP_OWNER_TOKEN;
  if (!runId || !nodeId || !Number.isInteger(attempt) || !ownerToken) {
    die("runtime commands require WORKSHOP_RUN_ID, WORKSHOP_NODE_ID, WORKSHOP_ATTEMPT, WORKSHOP_OWNER_TOKEN");
  }
  const row = store.getAttempt(runId, nodeId, attempt);
  if (!row || row.owner_token !== ownerToken) {
    die("runtime command rejected: owner token does not match the live attempt");
  }
  const now = new SystemClock().now();

  if (sub === "progress") {
    const text = flagValue(rest, "--text") ?? "";
    if (!text) die("--text is required");
    const ok = store.setProgress({ runId, nodeId, attempt, ownerToken, progress: text, now });
    process.exit(ok ? 0 : 1);
  }
  if (sub === "block") {
    const kind = flagValue(rest, "--kind") ?? "agent_requested";
    const blockKind = blockKindFor(kind);
    if (!blockKind) die(`unknown block kind "${kind}"`);
    if (kind !== "agent_requested" && kind !== "unknown_external") {
      die(`runtime block supports agent_requested (default) or unknown_external, not "${kind}"`);
    }
    const reason = flagValue(rest, "--reason") ?? "";
    if (!reason) die("--reason is required");
    const ok = store.blockAttempt({ runId, nodeId, attempt, ownerToken, blockKind, reason, now });
    process.exit(ok ? 0 : 1);
  }
  die(`unknown runtime subcommand "${sub}" (expected progress or block)`);
}

function flagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function blockKindFor(kind: string): BlockKind | null {
  const valid: BlockKind[] = [
    "agent_requested",
    "preflight",
    "orchestrator",
    "orchestrator_unresolved",
    "unknown_external",
    "operator",
  ];
  return valid.includes(kind as BlockKind) ? (kind as BlockKind) : null;
}
