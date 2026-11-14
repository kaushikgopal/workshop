import { resolve } from "node:path";

export function locateBlockedStep(stateRoot: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid workflow run ID: ${runId}`);
  return resolve(stateRoot, "blocked", `${runId}.json`);
}
