import type { RunIndexEntry } from "./types.ts";

export async function cancelWorkflowRun(
  runId: string,
  entries: readonly RunIndexEntry[],
  ports: {
    getStatus(runId: string): Promise<string>;
    cancel(runId: string): Promise<void>;
    recordAction(input: { workflow: string; runId: string }): Promise<void> | void;
  },
): Promise<{ run_id: string; workflow: string; status: string; cancelled: boolean }> {
  const entry = [...entries].reverse().find((candidate) => candidate.run_id === runId);
  if (!entry) throw new Error(`Workflow run ${runId} is not in the run index`);
  const status = await ports.getStatus(runId);
  if (status !== "pending" && status !== "running") {
    return { run_id: runId, workflow: entry.workflow, status, cancelled: false };
  }
  await ports.cancel(runId);
  await ports.recordAction({ workflow: entry.workflow, runId });
  return { run_id: runId, workflow: entry.workflow, status: "cancellation-requested", cancelled: true };
}
