export interface ProofOptions {
  stateDir: string;
  agentCommand?: string;
  pauseAfter?: string;
  stopFile?: string;
  timeoutMs: number;
}

/**
 * `--pause-after` accepts a bare flag, in which case it pauses after the
 * timestamp node, or a node id / node-id suffix such as `timestamp`.
 */
export function parseProofOptions(argv: readonly string[]): ProofOptions {
  let stateDir: string | undefined;
  let agentCommand: string | undefined;
  let pauseAfter: string | undefined;
  let stopFile: string | undefined;
  let timeoutMs = 120_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--state-dir": {
        stateDir = argv[++i];
        break;
      }
      case "--agent-command": {
        agentCommand = argv[++i];
        break;
      }
      case "--pause-after": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          pauseAfter = "timestamp";
        } else {
          pauseAfter = next;
          i++;
        }
        break;
      }
      case "--stop-file": {
        stopFile = argv[++i];
        break;
      }
      case "--timeout-ms": {
        timeoutMs = Number(argv[++i]);
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (stateDir === undefined || stateDir === "") throw new Error("--state-dir <dir> is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  return { stateDir, agentCommand, pauseAfter, stopFile, timeoutMs };
}
