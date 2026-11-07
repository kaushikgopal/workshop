import { writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { serveServiceProcess } from "../../src/service/serve-service-process.js";
import { openDurableStorage } from "../../src/storage/durable/open-durable-storage.js";
import { ParkedTask, PendingTask } from "./define-parked-service-owner-tasks.js";

const [mode, ...args] = process.argv.slice(2);
if (mode === "crash") await crashParkedTask(args);
if (mode === "serve") await serveFailedOwner(args);

async function crashParkedTask(args: string[]): Promise<void> {
  const [databasePath, heldMarker] = args;
  if (databasePath === undefined || heldMarker === undefined) throw new Error("crash fixture requires database and held-task marker paths");
  const opened = await openDurableStorage(databasePath);
  if (!opened.ok) throw new Error(opened.failure.message);
  const registry = createRegistry();
  registry.install({ name: "parked-service-owner-crash-fixture", tasks: [ParkedTask] });
  const harness = await Harness.open(opened.storage, { models: createModels(), registry, settings: { restartLimit: 1 } }, BACKGROUND_CONTEXT);
  harness.resume();
  const deadline = Date.now() + 10_000;
  while (!await fileExists(heldMarker) && Date.now() < deadline) await delay(10);
  if (!await fileExists(heldMarker)) throw new Error("parked task did not enter its held phase");
  setInterval(() => {}, 60_000);
}

async function serveFailedOwner(args: string[]): Promise<void> {
  const [root, inspectionMode = "normal", ownerHeldMarker] = args;
  if (root === undefined) throw new Error("service fixture requires an installation root");
  process.chdir(root);
  const originalOpen = Harness.open;
  Harness.open = async (storage, options, context) => {
    const registry = options.registry as unknown as { install(extension: unknown): void };
    registry.install({ name: "parked-service-owner-fixture", tasks: [ParkedTask, PendingTask] });
    const harness = await originalOpen(storage, {
      ...options,
      settings: { ...options.settings, restartLimit: 1 },
    }, context);
    if (inspectionMode === "graph-only") {
      const originalInspect = harness.inspect.bind(harness);
      Object.defineProperty(harness, "inspect", {
        configurable: true,
        value: async (inspectContext: Parameters<Harness["inspect"]>[0]) => {
          const inspection = await originalInspect(inspectContext);
          return {
            ...inspection,
            tasks: inspection.tasks.filter((task) => task.record.kind !== ParkedTask.definition.name),
          };
        },
      });
    }
    return harness;
  };
  await serveServiceProcess(["serve"]);
  if (ownerHeldMarker !== undefined) {
    writeFileSync(ownerHeldMarker, "failed owner retains lock\n", "utf8");
    setInterval(() => {}, 60_000);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
