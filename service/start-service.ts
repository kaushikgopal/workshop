import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

async function startService(): Promise<void> {
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

  let harness: Harness | undefined;
  let workshop: WorkshopService | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let orchestratorRuntime: OrchestratorRuntime | undefined;
  let socket: Awaited<ReturnType<typeof serveServiceSocket>> | undefined;
  let storeLock: Awaited<ReturnType<typeof acquireStoreLock>> | undefined;
  let storageFailed = false;
  let stopForStorageFailure: (() => void) | undefined;
  try {
    storeLock = await acquireStoreLock(join(stateDirectory, sqliteFile));
    socket = await serveServiceSocket(join(stateDirectory, "service.sock"), async (request, send, connection) => {
      if (!workshop) {
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
    storage = await openNodeSqliteStorage(join(stateDirectory, sqliteFile));
    orchestratorRuntime = await createOrchestratorRuntime(projectRoot, config);
    harness = await openWorkshopHarness(storage, (report) => {
      if (storageFailed) return;
      storageFailed = true;
      process.exitCode = 1;
      logServiceError("fatal durable storage failure", report.error);
      stopForStorageFailure?.();
    }, {
      projectRoot,
      models: orchestratorRuntime.models,
      model: orchestratorRuntime.model,
      escalationModel: orchestratorRuntime.escalationModel,
      request: async (request, invocation) => {
        if (!workshop) throw new Error("Workshop service is starting");
        return await workshop.handleRequest(request, invocation);
      },
    });
    workshop = createWorkshopService({ projectRoot, harness });
    await ensureWorkflowTicker({ projectRoot, harness });
    harness.resume();
    console.log(JSON.stringify({ event: "ready", pid: process.pid, node: process.version, socket: "state/service.sock", store: `state/${sqliteFile}` }));

    await new Promise<void>((resolveClose) => {
      let closing = false;
      const closeService = async (signal: string) => {
        if (closing) return;
        closing = true;
        console.log(JSON.stringify({ event: "stopping", signal }));
        try {
          await socket?.close();
        } catch (error) {
          process.exitCode = 1;
          logServiceError("socket shutdown failed", error);
        }
        let storeClosed = false;
        try {
          if (harness) await harness.close(BACKGROUND_CONTEXT);
          else if (storage) await storage.close(BACKGROUND_CONTEXT);
          storeClosed = true;
        } catch (error) {
          process.exitCode = 1;
          logServiceError("durable store shutdown failed", error);
        }
        try {
          await orchestratorRuntime?.models.settleCredentialWrites();
        } catch (error) {
          process.exitCode = 1;
          logServiceError("model runtime shutdown failed", error);
        }
        if (storeClosed) {
          try {
            await storeLock?.release();
          } catch (error) {
            process.exitCode = 1;
            logServiceError("store lock release failed", error);
          }
        }
        console.log(JSON.stringify({ event: "stopped" }));
        resolveClose();
      };
      stopForStorageFailure = () => { void closeService("fatal durable storage failure"); };
      process.once("SIGINT", () => { void closeService("SIGINT"); });
      process.once("SIGTERM", () => { void closeService("SIGTERM"); });
      if (storageFailed) stopForStorageFailure();
    });
  } catch (error) {
    try {
      await socket?.close();
    } catch (closeError) {
      process.exitCode = 1;
      logServiceError("socket cleanup failed", closeError);
    }
    let storeClosed = false;
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else if (storage) await storage.close(BACKGROUND_CONTEXT);
      storeClosed = true;
    } catch (closeError) {
      process.exitCode = 1;
      logServiceError("durable store cleanup failed", closeError);
    }
    try {
      await orchestratorRuntime?.models.settleCredentialWrites();
    } catch (closeError) {
      process.exitCode = 1;
      logServiceError("model runtime cleanup failed", closeError);
    }
    if (storeClosed) {
      try {
        await storeLock?.release();
      } catch (closeError) {
        process.exitCode = 1;
        logServiceError("store lock release failed", closeError);
      }
    }
    throw error;
  }
}

try {
  await startService();
} catch (error) {
  logServiceError("service failed", error);
  process.exitCode = 1;
}
