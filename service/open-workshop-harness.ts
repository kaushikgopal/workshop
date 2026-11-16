import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, type Report, type Storage } from "@earendil-works/pi-durable";
import { WorkflowTask } from "../workflow/define-workflow-task.ts";
import { executeWorkflowProcess } from "../run/execute-workflow-process.ts";
import { createStepAttemptTask } from "../workflow/define-step-attempt-task.ts";
import { WorkflowTickTask } from "../schedule/tick-workflows.ts";
import { createWorkshopExtension, type WorkshopServiceRequest } from "./create-workshop-extension.ts";
import type { OrchestratorModel } from "./create-orchestrator-runtime.ts";

export type WorkshopHarnessOptions = {
  projectRoot: string;
  request: WorkshopServiceRequest;
  models: Models;
  model: OrchestratorModel;
  escalationModel: OrchestratorModel;
};

export async function openWorkshopHarness(
  storage: Storage,
  onStorageFailure?: (report: Report) => void,
  options?: WorkshopHarnessOptions,
): Promise<Harness> {
  let harness: Harness | undefined;
  let harnessOpenAttempted = false;
  try {
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "workshop-workflows",
      tasks: [WorkflowTask, createStepAttemptTask(executeWorkflowProcess), WorkflowTickTask],
    }));
    const workshop = options === undefined ? undefined : createWorkshopExtension(options);
    if (workshop) registry.install(workshop);
    harnessOpenAttempted = true;
    harness = await Harness.open(storage, {
      models: options?.models ?? createModels(),
      registry,
      onReport: (report) => {
        const message = report.error instanceof Error ? report.error.message : String(report.error);
        console.error(`[workshop] durable ${report.kind}: ${message}`);
        if (report.kind === "storage_failed") onStorageFailure?.(report);
      },
    }, BACKGROUND_CONTEXT);
    if (workshop && options) {
      const tools = workshop.tools ?? [];
      const agent = {
        model: options.model.model,
        thinkingLevel: options.model.thinkingLevel,
        extensions: [workshop],
        tools,
        modelTools: tools,
      };
      const root = await harness.root(BACKGROUND_CONTEXT, { agent });
      await root.configure(agent, BACKGROUND_CONTEXT);
    } else {
      await harness.root(BACKGROUND_CONTEXT);
    }
    return harness;
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else if (!harnessOpenAttempted) await storage.close(BACKGROUND_CONTEXT);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Workshop harness initialization failed and cleanup was incomplete");
    }
    throw error;
  }
}
