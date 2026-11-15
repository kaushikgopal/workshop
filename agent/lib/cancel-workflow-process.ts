import { readFileSync } from "node:fs";
import { join } from "node:path";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function readProcessGroupIds(stateDirectory: string, runId: string): number[] {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid workflow run ID: ${runId}`);
  const file = join(stateDirectory, "processes", `${runId}.json`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("run_id" in value) || value.run_id !== runId || !("process_group_ids" in value) || !Array.isArray(value.process_group_ids)) {
    throw new Error(`Invalid process record for workflow run ${runId}`);
  }
  const processGroupIds: number[] = [];
  for (const pid of value.process_group_ids) {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process group ID for workflow run ${runId}`);
    processGroupIds.push(pid);
  }
  return processGroupIds;
}

function terminateGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

export async function cancelWorkflowProcesses(runId: string, stateDirectory: string): Promise<void> {
  const groups = readProcessGroupIds(stateDirectory, runId);
  if (groups.length === 0) return;
  let firstError: unknown;
  for (const pid of groups) {
    try {
      terminateGroup(pid, "SIGTERM");
    } catch (error) {
      firstError ??= error;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const pid of groups) {
    try {
      terminateGroup(pid, "SIGKILL");
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
