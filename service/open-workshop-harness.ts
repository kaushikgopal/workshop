import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, type Report, type Storage } from "@earendil-works/pi-durable";
import { WorkflowTask } from "../workflow/define-workflow-task.ts";
import { StepAttemptTask } from "../workflow/define-step-attempt-task.ts";
import { WorkflowTickTask } from "../schedule/tick-workflows.ts";

export async function openWorkshopHarness(storage: Storage, onStorageFailure?: (report: Report) => void): Promise<Harness> {
  const registry = createRegistry();
  registry.install(defineExtension({
    name: "workshop",
    tasks: [WorkflowTask, StepAttemptTask, WorkflowTickTask],
  }));
  const harness = await Harness.open(storage, {
    models: createModels(),
    registry,
    onReport: (report) => {
      const message = report.error instanceof Error ? report.error.message : String(report.error);
      console.error(`[workshop] durable ${report.kind}: ${message}`);
      if (report.kind === "storage_failed") onStorageFailure?.(report);
    },
  }, BACKGROUND_CONTEXT);
  await harness.root(BACKGROUND_CONTEXT);
  return harness;
}
