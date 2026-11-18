import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harness } from "@earendil-works/pi-durable";
import { checkProfileCommands, readConfig } from "../config/read-workshop-config.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";
import { ensureWorkflowTicker } from "./tick-workflows.ts";
import { acquireStoreLock } from "./acquire-store-lock.ts";
import { createOrchestratorRuntime, type OrchestratorRuntime } from "./create-orchestrator-runtime.ts";
import { createWorkshopService, type WorkshopService } from "./create-workshop-service.ts";
import { openWorkshopHarness } from "./open-workshop-harness.ts";
import { serveServiceSocket } from "./serve-service-socket.ts";
import { parseServiceRequest } from "./types.ts";

const sqliteFile = "workshop.sqlite";

type ServiceStage =
  | "validate-project"
  | "acquire-store-lock"
  | "bind-socket"
  | "open-storage"
  | "open-model-runtime"
  | "open-harness"
  | "create-service"
  | "ensure-ticker"
  | "resume-harness"
  | "runtime";

type ServiceStorage = Awaited<ReturnType<typeof openNodeSqliteStorage>>;
type HarnessOwnedStore = { kind: "harness-owned"; harness: Harness };
type ServiceStoreOwnership =
  | { kind: "not-opened" }
  | { kind: "storage-owned"; storage: ServiceStorage }
  | HarnessOwnedStore
  | { kind: "closed" };

type ServiceResources = {
  storeLock?: Awaited<ReturnType<typeof acquireStoreLock>>;
  socket?: Awaited<ReturnType<typeof serveServiceSocket>>;
  store: ServiceStoreOwnership;
  orchestratorRuntime?: OrchestratorRuntime;
  workshop?: WorkshopService;
};

type BootstrapStopRequest =
  | { kind: "signal"; signal: string }
  | { kind: "startup-failure"; error: unknown }
  | { kind: "storage-failure"; error: unknown };

type ServiceCompletion =
  | { kind: "return" }
  | { kind: "throw"; error: unknown };

type ServiceStorageFailure = { error: unknown };

export type ServiceLifecycle =
  | { kind: "starting"; stage: ServiceStage; resources: ServiceResources }
  | { kind: "boot-stop-requested"; stage: ServiceStage; request: BootstrapStopRequest; resources: ServiceResources; storageFailure?: ServiceStorageFailure }
  | { kind: "ready"; resources: ServiceResources }
  | { kind: "cleaning"; cause: string; completion: ServiceCompletion; result: "success" | "failed"; resources: ServiceResources; storageFailure?: ServiceStorageFailure }
  | { kind: "stopped"; completion: ServiceCompletion; result: "success" | "failed"; storageFailure?: ServiceStorageFailure };

export type ServiceLifecycleEvent =
  | { type: "stage"; stage: ServiceStage }
  | { type: "ready" }
  | { type: "fail"; error: unknown }
  | { type: "stop"; signal: string }
  | { type: "bootstrap-settled"; error: unknown }
  | { type: "storage-failure"; error: unknown }
  | { type: "cleanup-failed" }
  | { type: "stopped" };

export type ServiceLifecycleTransition =
  | { kind: "accepted"; state: ServiceLifecycle }
  | { kind: "already-stopping"; state: ServiceLifecycle }
  | { kind: "already-stopped"; state: ServiceLifecycle }
  | { kind: "ignored"; state: ServiceLifecycle }
  | { kind: "rejected"; code: "invalid-transition"; state: ServiceLifecycle };

export function createServiceLifecycle(resources: ServiceResources = { store: { kind: "not-opened" } }): ServiceLifecycle {
  return { kind: "starting", stage: "validate-project", resources };
}

export function serviceCanDispatchRequests(state: ServiceLifecycle): boolean {
  return state.kind === "ready";
}

export function transitionServiceLifecycle(
  state: ServiceLifecycle,
  event: ServiceLifecycleEvent,
): ServiceLifecycleTransition {
  if (event.type === "storage-failure") {
    const storageFailure = { error: event.error };
    if (state.kind === "starting") {
      return {
        kind: "accepted",
        state: {
          kind: "boot-stop-requested",
          stage: state.stage,
          request: { kind: "storage-failure", error: event.error },
          resources: state.resources,
          storageFailure,
        },
      };
    }
    if (state.kind === "boot-stop-requested") {
      return state.storageFailure !== undefined
        ? { kind: "ignored", state }
        : { kind: "accepted", state: { ...state, storageFailure } };
    }
    if (state.kind === "ready") {
      return {
        kind: "accepted",
        state: {
          kind: "cleaning",
          cause: "fatal durable storage failure",
          completion: { kind: "return" },
          result: "failed",
          resources: state.resources,
          storageFailure,
        },
      };
    }
    return state.storageFailure !== undefined
      ? { kind: "ignored", state }
      : { kind: "accepted", state: { ...state, storageFailure } };
  }
  if (event.type === "stage") {
    return state.kind === "starting"
      ? { kind: "accepted", state: { ...state, stage: event.stage } }
      : { kind: "rejected", code: "invalid-transition", state };
  }
  if (event.type === "ready") {
    return state.kind === "starting"
      ? { kind: "accepted", state: { kind: "ready", resources: state.resources } }
      : { kind: "rejected", code: "invalid-transition", state };
  }
  if (event.type === "fail") {
    if (state.kind === "starting") {
      return {
        kind: "accepted",
        state: {
          kind: "boot-stop-requested",
          stage: state.stage,
          request: { kind: "startup-failure", error: event.error },
          resources: state.resources,
        },
      };
    }
    return state.kind === "ready"
      ? {
          kind: "accepted",
          state: {
            kind: "cleaning",
            cause: "startup failure",
            completion: { kind: "throw", error: event.error },
            result: "success",
            resources: state.resources,
          },
        }
      : { kind: "rejected", code: "invalid-transition", state };
  }
  if (event.type === "stop") {
    if (state.kind === "boot-stop-requested" || state.kind === "cleaning") {
      return { kind: "already-stopping", state };
    }
    if (state.kind === "stopped") return { kind: "already-stopped", state };
    if (state.kind === "starting") {
      return {
        kind: "accepted",
        state: {
          kind: "boot-stop-requested",
          stage: state.stage,
          request: { kind: "signal", signal: event.signal },
          resources: state.resources,
        },
      };
    }
    return {
      kind: "accepted",
      state: {
        kind: "cleaning",
        cause: event.signal,
        completion: { kind: "return" },
        result: "success",
        resources: state.resources,
      },
    };
  }
  if (event.type === "bootstrap-settled") {
    if (state.kind !== "boot-stop-requested") {
      return { kind: "rejected", code: "invalid-transition", state };
    }
    const interruptedBySignal = state.request.kind === "signal" && state.storageFailure === undefined;
    return {
      kind: "accepted",
      state: {
        kind: "cleaning",
        cause: state.request.kind === "signal" ? state.request.signal : "startup failure",
        completion: interruptedBySignal ? { kind: "return" } : { kind: "throw", error: event.error },
        result: state.storageFailure === undefined ? "success" : "failed",
        resources: state.resources,
        ...(state.storageFailure === undefined ? {} : { storageFailure: state.storageFailure }),
      },
    };
  }
  if (event.type === "cleanup-failed") {
    return state.kind === "cleaning"
      ? { kind: "accepted", state: { ...state, result: "failed" } }
      : { kind: "rejected", code: "invalid-transition", state };
  }
  return state.kind === "cleaning"
    ? {
        kind: "accepted",
        state: {
          kind: "stopped",
          completion: state.completion,
          result: state.result,
          ...(state.storageFailure === undefined ? {} : { storageFailure: state.storageFailure }),
        },
      }
    : { kind: "rejected", code: "invalid-transition", state };
}
export type ServiceStoreCleanup =
  | { kind: "closed" }
  | { kind: "failed"; stage: "close" | "release"; error: unknown };

export async function openServiceHarness(
  resources: ServiceResources,
  open: (storage: ServiceStorage) => Promise<Harness>,
): Promise<HarnessOwnedStore> {
  const store = resources.store;
  if (store.kind !== "storage-owned") throw new Error("Durable storage is not available for harness startup");
  const harness = await open(store.storage);
  const ownership: HarnessOwnedStore = { kind: "harness-owned", harness };
  resources.store = ownership;
  return ownership;
}

export async function closeServiceStore(resources: ServiceResources): Promise<ServiceStoreCleanup> {
  const store = resources.store;
  if (store.kind === "not-opened") {
    resources.store = { kind: "closed" };
  } else if (store.kind === "storage-owned" || store.kind === "harness-owned") {
    try {
      if (store.kind === "storage-owned") await store.storage.close(BACKGROUND_CONTEXT);
      else await store.harness.close(BACKGROUND_CONTEXT);
      resources.store = { kind: "closed" };
    } catch (error) {
      return { kind: "failed", stage: "close", error };
    }
  }
  if (resources.store.kind === "closed" && resources.storeLock) {
    try {
      await resources.storeLock.release();
      resources.storeLock = undefined;
    } catch (error) {
      return { kind: "failed", stage: "release", error };
    }
  }
  return { kind: "closed" };
}



function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) throw new Error("Workshop requires Node.js 24 or newer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logServiceError(label: string, error: unknown): void {
  console.error(`[workshop] ${label}: ${errorMessage(error)}`);
}

class ServiceStartupInterrupted extends Error {
  constructor() {
    super("Service startup was interrupted");
    this.name = "ServiceStartupInterrupted";
  }
}

export async function startService(): Promise<void> {
  const resources: ServiceResources = { store: { kind: "not-opened" } };
  let lifecycle = createServiceLifecycle(resources);
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<void>((resolveStopPromise) => { resolveStop = resolveStopPromise; });

  const setStage = (stage: ServiceStage): void => {
    const transition = transitionServiceLifecycle(lifecycle, { type: "stage", stage });
    if (transition.kind !== "accepted") throw new Error(`Cannot enter service startup stage ${stage} from ${lifecycle.kind}`);
    lifecycle = transition.state;
  };

  const assertStartupCanContinue = (): void => {
    if (lifecycle.kind === "boot-stop-requested") {
      if (lifecycle.storageFailure !== undefined) throw lifecycle.storageFailure.error;
      throw new ServiceStartupInterrupted();
    }
    if (lifecycle.kind !== "starting") throw new ServiceStartupInterrupted();
  };

  const markCleanupFailed = (): void => {
    const transition = transitionServiceLifecycle(lifecycle, { type: "cleanup-failed" });
    if (transition.kind !== "accepted") throw new Error(`Cannot record cleanup failure from ${lifecycle.kind}`);
    lifecycle = transition.state;
  };

  const finishStop = async (): Promise<void> => {
    if (lifecycle.kind !== "cleaning") return await stopPromise;
    console.log(JSON.stringify({ event: "stopping", signal: lifecycle.cause }));
    try {
      await resources.socket?.close();
      resources.socket = undefined;
    } catch (error) {
      process.exitCode = 1;
      logServiceError("socket shutdown failed", error);
      markCleanupFailed();
    }
    const failedResult = await closeServiceStore(resources);
    if (failedResult.kind === "failed") {
      process.exitCode = 1;
      logServiceError(failedResult.stage === "close" ? "durable store shutdown failed" : "store lock release failed", failedResult.error);
      markCleanupFailed();
    }
    try {
      await resources.orchestratorRuntime?.models.settleCredentialWrites();
      resources.orchestratorRuntime = undefined;
    } catch (error) {
      process.exitCode = 1;
      logServiceError("model runtime shutdown failed", error);
      markCleanupFailed();
    }
    const transition = transitionServiceLifecycle(lifecycle, { type: "stopped" });
    if (transition.kind !== "accepted") throw new Error(`Cannot finish service shutdown from ${lifecycle.kind}`);
    lifecycle = transition.state;
    console.log(JSON.stringify({ event: "stopped" }));
    resolveStop?.();
  };

  const requestStop = (signal: string): Promise<void> => {
    const transition = transitionServiceLifecycle(lifecycle, { type: "stop", signal });
    if (transition.kind === "accepted") {
      lifecycle = transition.state;
      if (lifecycle.kind === "cleaning") void finishStop();
    } else if (transition.kind === "already-stopped") {
      return stopPromise;
    } else if (transition.kind !== "already-stopping") {
      throw new Error(`Cannot stop service from ${lifecycle.kind}`);
    }
    return stopPromise;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (lifecycle.kind === "starting" || lifecycle.kind === "ready") void requestStop(signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    setStage("validate-project");
    checkNodeVersion();
    const projectRoot = resolve(process.cwd());
    const stateDirectory = resolve(projectRoot, "state");
    mkdirSync(stateDirectory, { recursive: true });
    const configFile = process.env.WORKSHOP_CONFIG ?? resolve(projectRoot, "workshop.yaml");
    const config = readConfig(configFile);
    const commandIssues = checkProfileCommands(config, process.env.PATH, configFile);
    if (commandIssues.length > 0) throw new Error(commandIssues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
    const workflows = loadWorkflows(resolve(projectRoot, "workflows"), new Set(Object.keys(config.agent_profiles)));
    for (const issue of workflows.errors) console.error(`[workshop] workflow skipped (${issue.file}): ${issue.reason}`);
    assertStartupCanContinue();

    setStage("acquire-store-lock");
    resources.storeLock = await acquireStoreLock(join(stateDirectory, sqliteFile));
    assertStartupCanContinue();

    setStage("bind-socket");
    resources.socket = await serveServiceSocket(join(stateDirectory, "service.sock"), async (request, send, connection) => {
      const workshop = resources.workshop;
      if (!serviceCanDispatchRequests(lifecycle) || !workshop) {
        send({ ok: false, error: "Workshop service is starting" });
        return;
      }
      const parsed = parseServiceRequest(request);
      if (parsed.type === "watch_chat") {
        if (connection.persistent) throw new Error("A chat watch is already attached");
        return await workshop.watchChat(parsed.request_id, send);
      }
      send(await workshop.handleRequest(parsed));
    });
    assertStartupCanContinue();

    setStage("open-storage");
    resources.store = { kind: "storage-owned", storage: await openNodeSqliteStorage(join(stateDirectory, sqliteFile)) };
    assertStartupCanContinue();

    setStage("open-model-runtime");
    resources.orchestratorRuntime = await createOrchestratorRuntime(projectRoot, config);
    assertStartupCanContinue();

    setStage("open-harness");
    const orchestratorRuntime = resources.orchestratorRuntime;
    if (!orchestratorRuntime) throw new Error("Orchestrator runtime is not available for harness startup");
    const { harness } = await openServiceHarness(resources, (storage) => openWorkshopHarness(storage, (report) => {
      const wasReady = lifecycle.kind === "ready";
      const transition = transitionServiceLifecycle(lifecycle, { type: "storage-failure", error: report.error });
      if (transition.kind !== "accepted") return;
      lifecycle = transition.state;
      process.exitCode = 1;
      logServiceError("fatal durable storage failure", report.error);
      if (wasReady) void finishStop();
    }, {
      projectRoot,
      models: orchestratorRuntime.models,
      model: orchestratorRuntime.model,
      escalationModel: orchestratorRuntime.escalationModel,
      request: async (request, invocation) => {
        const workshop = resources.workshop;
        if (!serviceCanDispatchRequests(lifecycle) || !workshop) throw new Error("Workshop service is starting");
        return await workshop.handleRequest(request, invocation);
      },
    }));
    assertStartupCanContinue();

    setStage("create-service");
    resources.workshop = createWorkshopService({ projectRoot, harness });

    setStage("ensure-ticker");
    await ensureWorkflowTicker({ projectRoot, harness });
    assertStartupCanContinue();

    setStage("resume-harness");
    harness.resume();
    assertStartupCanContinue();

    const ready = transitionServiceLifecycle(lifecycle, { type: "ready" });
    if (ready.kind !== "accepted") throw new Error(`Cannot ready service from ${lifecycle.kind}`);
    lifecycle = ready.state;
    console.log(JSON.stringify({ event: "ready", pid: process.pid, node: process.version, socket: "state/service.sock", store: `state/${sqliteFile}` }));
    await stopPromise;
  } catch (error) {
    if (lifecycle.kind === "cleaning" || lifecycle.kind === "stopped") {
      await stopPromise;
      throw error;
    }
    if (lifecycle.kind === "starting" || lifecycle.kind === "ready") {
      const failed = transitionServiceLifecycle(lifecycle, { type: "fail", error });
      if (failed.kind !== "accepted") throw new Error(`Cannot fail service startup from ${lifecycle.kind}`);
      lifecycle = failed.state;
    }
    if (lifecycle.kind === "boot-stop-requested") {
      const settled = transitionServiceLifecycle(lifecycle, { type: "bootstrap-settled", error });
      if (settled.kind !== "accepted") throw new Error(`Cannot settle service bootstrap from ${lifecycle.kind}`);
      lifecycle = settled.state;
    }
    if (lifecycle.kind === "cleaning") void finishStop();
    await stopPromise;
    if (lifecycle.kind === "stopped" && lifecycle.completion.kind === "return") return;
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try {
    await startService();
  } catch (error) {
    logServiceError("service failed", error);
    process.exitCode = 1;
  }
}
