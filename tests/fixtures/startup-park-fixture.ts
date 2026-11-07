import { writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { loadInstallation } from "../../src/installation/load-installation.js";
import { startWorkshopService } from "../../src/service/open-service-runtime.js";
import { openDurableStorage } from "../../src/storage/durable/open-durable-storage.js";

interface HoldInput { readonly markerPath: string }
interface HoldCheckpoint { readonly phase: "hold" }
interface HoldResult { readonly held: true }

function defineHoldTask(name: string) {
  return defineTask<HoldInput, HoldCheckpoint, HoldResult>({
    name,
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (task) => {
        writeFileSync(task.input.markerPath, "x", { flag: "a" });
        await new Promise<void>(() => {});
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "fixture stopped" } }), context);
    },
  });
}

export const StartupParkTaskOne = defineHoldTask("workshop.test.startup-park-one");
export const StartupParkTaskTwo = defineHoldTask("workshop.test.startup-park-two");

export const StartupParkPendingTask = defineTask<HoldInput, { readonly phase: "settle" }, { readonly started: true }>({
  name: "workshop.test.startup-park-pending",
  version: 1,
  initial: () => ({ phase: "settle" }),
  phases: {
    settle: async (task, runtime, context) => {
      writeFileSync(task.input.markerPath, "started");
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { started: true } } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "fixture stopped" } }), context);
  },
});

const [mode, ...args] = process.argv.slice(2);
if (mode === "crash") await leaveTasksRunning(args);
if (mode === "serve") await serveParkedInstallation(args);

async function leaveTasksRunning(args: string[]): Promise<void> {
  const [databasePath, firstMarker, secondMarker] = args;
  if (databasePath === undefined || firstMarker === undefined || secondMarker === undefined) throw new Error("crash fixture requires database and marker paths");
  const opened = await openDurableStorage(databasePath);
  if (!opened.ok) throw new Error(opened.failure.message);
  const registry = createRegistry();
  registry.install({ name: "startup-park-crash-fixture", tasks: [StartupParkTaskOne, StartupParkTaskTwo] });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry, settings: { restartLimit: 1 } }, BACKGROUND_CONTEXT);
  harness.resume();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await Promise.all([firstMarker, secondMarker].map(async (path) => {
        const { access } = await import("node:fs/promises");
        await access(path);
      }));
      setInterval(() => undefined, 1_000);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("startup park tasks did not enter their held phases");
}

async function serveParkedInstallation(args: string[]): Promise<void> {
  const [root, resultPath, pendingMarker, resumeMarker, inspectionMode = "graph-only"] = args;
  if (root === undefined || resultPath === undefined || pendingMarker === undefined || resumeMarker === undefined) throw new Error("service fixture requires installation and marker paths");
  const originalOpen = Harness.open;
  Harness.open = async (storage, options, context) => {
    const registry = options.registry as unknown as { install(extension: unknown): void };
    registry.install({ name: "startup-park-pending-fixture", tasks: [StartupParkPendingTask] });
    const harness = await originalOpen(storage, { ...options, settings: { ...options.settings, restartLimit: 1 } }, context);
    const originalInspect = harness.inspect.bind(harness);
    const originalTaskGraph = harness.taskGraph.bind(harness);
    const originalResume = harness.resume.bind(harness);
    if (inspectionMode === "initialization-fails") {
      Object.defineProperty(harness, "commit", {
        configurable: true,
        value: async () => { throw new Error("fixture initialization commit failed"); },
      });
      Object.defineProperty(harness, "taskGraph", {
        configurable: true,
        value: async () => ({ value: { tasks: {} }, dispose: () => undefined }) as Awaited<ReturnType<Harness["taskGraph"]>>,
      });
    }
    if (inspectionMode === "graph-unavailable") {
      Object.defineProperty(harness, "taskGraph", {
        configurable: true,
        value: async () => { throw new Error("fixture task graph unavailable"); },
      });
    }
    Object.defineProperty(harness, "inspect", {
      configurable: true,
      value: async (inspectContext: Parameters<Harness["inspect"]>[0]) => {
        if (inspectionMode === "inspection-unavailable") throw new Error("fixture task inspection unavailable");
        if (inspectionMode === "initialization-fails") return { scheduling: "paused", tasks: [], submissions: [] };
        const inspection = await originalInspect(inspectContext);
        return {
          ...inspection,
          tasks: inspection.tasks.map((task) => {
            if ((task.record.kind === StartupParkTaskOne.definition.name || task.record.kind === StartupParkTaskTwo.definition.name)
              && task.state.kind === "blocked") {
              return { ...task, state: { kind: "sleeping" as const, until: Date.now() } };
            }
            if (task.record.kind === StartupParkPendingTask.definition.name && inspectionMode !== "initialization-fails") {
              return { ...task, record: { ...task.record, kind: "workshop.process-execution" } };
            }
            return task;
          }),
        };
      },
    });
    Object.defineProperty(harness, "resume", {
      configurable: true,
      value: () => {
        writeFileSync(resumeMarker, "resumed");
        originalResume();
      },
    });
    return harness;
  };
  try {
    await startWorkshopService(loadInstallation(root));
    writeFileSync(resultPath, "unexpected service readiness");
  } catch (error) {
    writeFileSync(resultPath, describeError(error));
  }
  Harness.open = originalOpen;
  if (await exists(pendingMarker)) writeFileSync(resultPath, "pending task executed during failed startup");
  process.exit(0);
}

async function exists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "startup failed";
  const details = [error.name + ": " + error.message];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) details.push(describeError(nested));
  } else if (error.cause !== undefined) {
    details.push(describeError(error.cause));
  }
  return details.join("\n");
}
