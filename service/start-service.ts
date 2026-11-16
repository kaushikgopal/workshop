import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harness } from "@earendil-works/pi-durable";
import { checkProfileCommands, readConfig } from "../config/read-workshop-config.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";
import { ensureWorkflowTicker } from "../schedule/tick-workflows.ts";
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

type ServiceResources = {
  storeLock?: Awaited<ReturnType<typeof acquireStoreLock>>;
  socket?: Awaited<ReturnType<typeof serveServiceSocket>>;
  storage?: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
  storageClosed: boolean;
  orchestratorRuntime?: OrchestratorRuntime;
  harness?: Harness;
  workshop?: WorkshopService;
};

export type ServiceLifecycle =
  | { kind: "starting"; stage: ServiceStage; resources: ServiceResources }
  | { kind: "ready"; resources: ServiceResources }
  | { kind: "stopping"; cause: string; resources: ServiceResources }
  | { kind: "stopped"; result: "success" | "failed" }
  | { kind: "failed"; stage: ServiceStage; error: unknown; resources: ServiceResources };

export type ServiceLifecycleEvent =
  | { type: "stage"; stage: ServiceStage }
  | { type: "ready" }
  | { type: "fail"; error: unknown }
  | { type: "stop"; cause: string }
  | { type: "stopped"; result: "success" | "failed" };

export type ServiceLifecycleTransition =
  | { kind: "accepted"; state: ServiceLifecycle }
  | { kind: "already-stopping"; state: ServiceLifecycle }
  | { kind: "already-stopped"; state: ServiceLifecycle }
  | { kind: "rejected"; code: "invalid-transition"; state: ServiceLifecycle };

export function createServiceLifecycle(resources: ServiceResources = { storageClosed: false }): ServiceLifecycle {
  return { kind: "starting", stage: "validate-project", resources };
}

export function serviceCanDispatchRequests(state: ServiceLifecycle): boolean {
  return state.kind === "ready";
}

export function transitionServiceLifecycle(
  state: ServiceLifecycle,
  event: ServiceLifecycleEvent,
): ServiceLifecycleTransition {
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
    if (state.kind !== "starting" && state.kind !== "ready") {
      return { kind: "rejected", code: "invalid-transition", state };
    }
    return {
      kind: "accepted",
      state: {
        kind: "failed",
        stage: state.kind === "starting" ? state.stage : "runtime",
        error: event.error,
        resources: state.resources,
      },
    };
  }
  if (event.type === "stop") {
    if (state.kind === "stopping") return { kind: "already-stopping", state };
    if (state.kind === "stopped") return { kind: "already-stopped", state };
    return { kind: "accepted", state: { kind: "stopping", cause: event.cause, resources: state.resources } };
  }
  return state.kind === "stopping"
    ? { kind: "accepted", state: { kind: "stopped", result: event.result } }
    : { kind: "rejected", code: "invalid-transition", state };
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
  const resources: ServiceResources = { storageClosed: false };
  let lifecycle = createServiceLifecycle(resources);
  let storageFailed = false;
  let storageFailure: unknown;
  let startupSignal: string | undefined;
  let bootstrapRunning = true;
  let cleanupStarted = false;
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<void>((resolveStopPromise) => { resolveStop = resolveStopPromise; });

  const setStage = (stage: ServiceStage): void => {
    const transition = transitionServiceLifecycle(lifecycle, { type: "stage", stage });
    if (transition.kind !== "accepted") throw new Error(`Cannot enter service startup stage ${stage} from ${lifecycle.kind}`);
    lifecycle = transition.state;
  };

  const assertStartupCanContinue = (): void => {
    if (storageFailed) throw storageFailure;
    if (lifecycle.kind !== "starting") throw new ServiceStartupInterrupted();
  };

  const finishStop = async (): Promise<void> => {
    if (cleanupStarted) return await stopPromise;
    cleanupStarted = true;
    const cause = lifecycle.kind === "stopping" ? lifecycle.cause : "service shutdown";
    console.log(JSON.stringify({ event: "stopping", signal: cause }));
    let failed = storageFailed;
    let storeClosed = resources.storageClosed || (resources.harness === undefined && resources.storage === undefined);
    try {
      await resources.socket?.close();
      resources.socket = undefined;
    } catch (error) {
      failed = true;
      process.exitCode = 1;
      logServiceError("socket shutdown failed", error);
    }
    try {
      if (resources.harness) await resources.harness.close(BACKGROUND_CONTEXT);
      else if (resources.storage) await resources.storage.close(BACKGROUND_CONTEXT);
      storeClosed = true;
      resources.storageClosed = true;
      resources.harness = undefined;
      resources.storage = undefined;
    } catch (error) {
      failed = true;
      process.exitCode = 1;
      logServiceError("durable store shutdown failed", error);
    }
    try {
      await resources.orchestratorRuntime?.models.settleCredentialWrites();
      resources.orchestratorRuntime = undefined;
    } catch (error) {
      failed = true;
      process.exitCode = 1;
      logServiceError("model runtime shutdown failed", error);
    }
    if (storeClosed) {
      try {
        await resources.storeLock?.release();
        resources.storeLock = undefined;
      } catch (error) {
        failed = true;
        process.exitCode = 1;
        logServiceError("store lock release failed", error);
      }
    }
    if (failed) process.exitCode = 1;
    const transition = transitionServiceLifecycle(lifecycle, { type: "stopped", result: failed ? "failed" : "success" });
    if (transition.kind !== "accepted") throw new Error(`Cannot finish service shutdown from ${lifecycle.kind}`);
    lifecycle = transition.state;
    console.log(JSON.stringify({ event: "stopped" }));
    resolveStop?.();
  };

  const requestStop = (cause: string): Promise<void> => {
    const transition = transitionServiceLifecycle(lifecycle, { type: "stop", cause });
    if (transition.kind === "accepted") lifecycle = transition.state;
    else if (transition.kind === "already-stopped") return stopPromise;
    else if (transition.kind !== "already-stopping") throw new Error(`Cannot stop service from ${lifecycle.kind}`);
    if (!bootstrapRunning) void finishStop();
    return stopPromise;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (lifecycle.kind === "starting") startupSignal = signal;
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
    resources.storage = await openNodeSqliteStorage(join(stateDirectory, sqliteFile));
    assertStartupCanContinue();

    setStage("open-model-runtime");
    resources.orchestratorRuntime = await createOrchestratorRuntime(projectRoot, config);
    assertStartupCanContinue();

    setStage("open-harness");
    const storage = resources.storage;
    if (!storage) throw new Error("Durable storage is not available for harness startup");
    resources.storage = undefined;
    try {
      resources.harness = await openWorkshopHarness(storage, (report) => {
        if (storageFailed) return;
        storageFailed = true;
        storageFailure = report.error;
        process.exitCode = 1;
        logServiceError("fatal durable storage failure", report.error);
        if (lifecycle.kind === "starting") {
          const failed = transitionServiceLifecycle(lifecycle, { type: "fail", error: report.error });
          if (failed.kind === "accepted") lifecycle = failed.state;
        } else if (lifecycle.kind === "ready") {
          void requestStop("fatal durable storage failure");
        }
      }, {
        projectRoot,
        models: resources.orchestratorRuntime.models,
        model: resources.orchestratorRuntime.model,
        escalationModel: resources.orchestratorRuntime.escalationModel,
        request: async (request, invocation) => {
          const workshop = resources.workshop;
          if (!serviceCanDispatchRequests(lifecycle) || !workshop) throw new Error("Workshop service is starting");
          return await workshop.handleRequest(request, invocation);
        },
      });
    } catch (error) {
      resources.storageClosed = true;
      throw error;
    }
    assertStartupCanContinue();

    setStage("create-service");
    const harness = resources.harness;
    if (!harness) throw new Error("Durable harness is not available");
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
    bootstrapRunning = false;
    console.log(JSON.stringify({ event: "ready", pid: process.pid, node: process.version, socket: "state/service.sock", store: `state/${sqliteFile}` }));
    await stopPromise;
  } catch (error) {
    const interruptedBySignal = lifecycle.kind === "stopping" && startupSignal !== undefined && !storageFailed;
    if (!interruptedBySignal && lifecycle.kind === "starting") {
      const failed = transitionServiceLifecycle(lifecycle, { type: "fail", error });
      if (failed.kind === "accepted") lifecycle = failed.state;
    }
    bootstrapRunning = false;
    const cause = interruptedBySignal ? startupSignal ?? "signal" : "startup failure";
    await requestStop(cause);
    if (interruptedBySignal) return;
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
