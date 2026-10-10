import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { locateServiceSocket } from "../src/service/locate-service-socket.js";
import { probeServiceHealth } from "../src/service/probe-service-health.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/serve-workshop-service.ts");
const FAILED_OPEN_FIXTURE = join(process.cwd(), "tests/fixtures/hold-service-after-open-failure.ts");
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await stopChildren("SIGKILL");
});

describe("Durable service ownership", () => {
  test("serializes independent startup races and serves health through a private socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-race-"));
    const stateDirectory = join(directory, "a".repeat(44), "b".repeat(44), "c".repeat(28));
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const location = locateServiceSocket(stateDirectory);
    const runtimeDirectory = location.runtimeDirectory;
    if (runtimeDirectory === null) throw new Error("long state path did not use a private runtime directory");
    const contenders = Array.from({ length: 4 }, (_, index) => launchOwner(stateDirectory, directory, `race-${index}`, { delayMs: 500 }));

    try {
      const outcomes = await Promise.all(contenders.map((child) => waitForStartup(child, 10_000)));
      const owners = outcomes.filter((outcome) => outcome === "ready");
      expect(owners).toHaveLength(1);
      const winnerIndex = outcomes.findIndex((outcome) => outcome === "ready");
      const winner = contenders[winnerIndex];
      if (winner === undefined) throw new Error("service ownership race produced no winner");
      const metadata = JSON.parse(readFileSync(winner.readyPath, "utf8")) as { status: string; socketPath: string; bootId: string };
      expect(metadata.status).toBe("ready");
      expect(metadata.socketPath).toBe(location.socketPath);
      for (const [index, outcome] of outcomes.entries()) {
        if (index === winnerIndex) continue;
        expect(outcome).toBe("conflict");
        expect(existsSync(contenders[index]?.openedPath ?? "")).toBe(false);
      }

      expect(privateMode(stateDirectory)).toBe(0o700);
      expect(privateMode(join(stateDirectory, "service.lock"))).toBe(0o600);
      expect(privateMode(join(stateDirectory, "service.json"))).toBe(0o600);
      expect(privateMode(runtimeDirectory)).toBe(0o700);
      expect(privateMode(location.socketPath)).toBe(0o600);
      const health = await probeServiceHealth(stateDirectory);
      expect(health.kind).toBe("ready");
      if (health.kind === "ready") expect(health.metadata.bootId).toBe(metadata.bootId);

      winner.process.kill("SIGTERM");
      await waitForMarker(winner.shutdownStartedPath, winner, 5_000);
      const duringShutdown = launchOwner(stateDirectory, directory, "during-shutdown");
      expect(await waitForStartup(duringShutdown, 5_000)).toBe("conflict");
      expect(existsSync(duringShutdown.openedPath)).toBe(false);
      await waitForMarker(winner.shutdownCompletePath, winner, 5_000);
      await waitForExit(winner.process, 5_000);
      expect(winner.process.exitCode).toBe(0);
      expect(existsSync(location.socketPath)).toBe(false);
      expect(existsSync(runtimeDirectory)).toBe(true);
      expect(readdirSync(runtimeDirectory)).toEqual([]);
      expect(JSON.parse(readFileSync(join(stateDirectory, "service.json"), "utf8")).status).toBe("stopped");
      expect(existsSync(join(stateDirectory, "service.lock"))).toBe(true);
      const afterShutdown = launchOwner(stateDirectory, directory, "after-shutdown");
      expect(await waitForStartup(afterShutdown, 5_000)).toBe("ready");
      await stopGracefully(afterShutdown);
    } finally {
      await stopChildren("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("takes over after runner death and removes its stale socket only under the new lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-restart-"));
    const stateDirectory = join(directory, "state");
    const first = launchOwner(stateDirectory, directory, "first");
    try {
      expect(await waitForStartup(first, 10_000)).toBe("ready");
      const oldMetadata = JSON.parse(readFileSync(first.readyPath, "utf8")) as { bootId: string; socketPath: string };
      expect((await probeServiceHealth(stateDirectory)).kind).toBe("ready");
      const lockPath = join(stateDirectory, "service.lock");
      writeFileSync(lockPath, "malformed lock metadata");
      const malformedContender = launchOwner(stateDirectory, directory, "malformed-concurrent");
      expect(await waitForStartup(malformedContender, 5_000)).toBe("conflict");
      expect(readFileSync(lockPath, "utf8")).toBe("malformed lock metadata");
      first.process.kill("SIGKILL");
      await waitForExit(first.process, 5_000);
      expect(existsSync(oldMetadata.socketPath)).toBe(true);
      expect((await probeServiceHealth(stateDirectory)).kind).toBe("not_ready");

      const restarted = launchOwner(stateDirectory, directory, "restarted");
      expect(await waitForStartup(restarted, 10_000)).toBe("ready");
      const newMetadata = JSON.parse(readFileSync(restarted.readyPath, "utf8")) as { bootId: string; socketPath: string };
      const newLock = JSON.parse(readFileSync(lockPath, "utf8")) as { bootId: string; pid: number; startIdentity: string };
      expect(newMetadata.bootId).not.toBe(oldMetadata.bootId);
      expect(newMetadata.socketPath).toBe(oldMetadata.socketPath);
      expect(newLock.bootId).toBe(newMetadata.bootId);
      expect(newLock.pid).toBeGreaterThan(0);
      expect(newLock.startIdentity.length).toBeGreaterThan(0);
      await stopGracefully(restarted);
    } finally {
      await stopChildren("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("bounds shutdown and keeps ownership until the failed owner exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-shutdown-"));
    const stateDirectory = join(directory, "state");
    const slow = launchOwner(stateDirectory, directory, "slow", { delayMs: 5_000, timeoutMs: 100 });
    try {
      expect(await waitForStartup(slow, 10_000)).toBe("ready");
      const shutdownStartedAt = Date.now();
      slow.process.kill("SIGTERM");
      await waitForMarker(slow.errorPath, slow, 3_000);
      expect(Date.now() - shutdownStartedAt).toBeLessThan(1_000);
      expect(readFileSync(slow.errorPath, "utf8")).toContain("timed out");
      expect(JSON.parse(readFileSync(join(stateDirectory, "service.json"), "utf8")).status).toBe("shutdown_failed");

      const contender = launchOwner(stateDirectory, directory, "during-timeout");
      expect(await waitForStartup(contender, 5_000)).toBe("conflict");
      expect(existsSync(contender.openedPath)).toBe(false);

      slow.process.kill("SIGKILL");
      await waitForExit(slow.process, 5_000);
      const restarted = launchOwner(stateDirectory, directory, "after-timeout");
      expect(await waitForStartup(restarted, 10_000)).toBe("ready");
      await stopGracefully(restarted);
    } finally {
      await stopChildren("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("keeps service ownership after partial-open cleanup fails until the failed owner exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workshop-service-open-failure-"));
    const root = join(directory, "installation");
    const configDirectory = join(root, ".workshop");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "workshop.yaml"), "\n", "utf8");
    const stateDirectory = join(root, ".workshop", "state");
    const markerPath = join(directory, "partial-open-failed.txt");
    let stderr = "";
    const failed = spawn(process.execPath, [FAILED_OPEN_FIXTURE, root, markerPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    failed.stderr?.setEncoding("utf8");
    failed.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(markerPath) && Date.now() < deadline) {
        if (failed.exitCode !== null || failed.signalCode !== null) throw new Error(`partial-open owner exited: ${stderr}`);
        await delay(10);
      }
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(join(stateDirectory, "service.json"), "utf8")).toContain('"status":"failed"');

      const contender = launchOwner(stateDirectory, directory, "during-partial-open-failure");
      expect(await waitForStartup(contender, 5_000)).toBe("conflict");
      expect(existsSync(contender.openedPath)).toBe(false);

      failed.kill("SIGKILL");
      await waitForExit(failed, 5_000);
      const takeover = launchOwner(stateDirectory, directory, "after-partial-open-failure");
      expect(await waitForStartup(takeover, 10_000)).toBe("ready");
      await stopGracefully(takeover);
    } finally {
      if (failed.exitCode === null && failed.signalCode === null) {
        failed.kill("SIGKILL");
        await waitForExit(failed, 5_000);
      }
      await stopChildren("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

interface ServiceChild {
  readonly process: ReturnType<typeof spawn>;
  readonly readyPath: string;
  readonly openedPath: string;
  readonly shutdownStartedPath: string;
  readonly shutdownCompletePath: string;
  readonly errorPath: string;
  readonly stderr: () => string;
}

function launchOwner(
  stateDirectory: string,
  markerDirectory: string,
  name: string,
  options: { readonly delayMs?: number; readonly timeoutMs?: number } = {},
): ServiceChild {
  const marker = (suffix: string): string => join(markerDirectory, `${name}-${suffix}.txt`);
  let stderr = "";
  const child = spawn(process.execPath, [
    FIXTURE,
    stateDirectory,
    marker("ready"),
    marker("opened"),
    marker("shutdown-started"),
    marker("shutdown-complete"),
    marker("error"),
    String(options.delayMs ?? 0),
    String(options.timeoutMs ?? 1_000),
  ], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  children.push(child);
  return {
    process: child,
    readyPath: marker("ready"),
    openedPath: marker("opened"),
    shutdownStartedPath: marker("shutdown-started"),
    shutdownCompletePath: marker("shutdown-complete"),
    errorPath: marker("error"),
    stderr: () => stderr,
  };
}

async function waitForStartup(child: ServiceChild, timeoutMs: number): Promise<"ready" | "conflict"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(child.readyPath)) return "ready";
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      if (child.process.exitCode !== 2) {
        throw new Error(`service exited without ownership-conflict status: ${child.stderr()}`);
      }
      return "conflict";
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for service startup: ${child.stderr()}`);
}

async function waitForMarker(path: string, child: ServiceChild, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`service exited before marker ${path}: ${child.stderr()}`);
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}: ${child.stderr()}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for service process exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopGracefully(child: ServiceChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGTERM");
  await waitForMarker(child.shutdownCompletePath, child, 5_000);
  await waitForExit(child.process, 5_000);
  expect(exitCodeOf(child.process)).toBe(0);
}

async function stopChildren(signal: NodeJS.Signals): Promise<void> {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = waitForExit(child, 5_000).catch(() => {});
    child.kill(signal);
    await exited;
  }
}

function exitCodeOf(child: ReturnType<typeof spawn>): number | null {
  return child.exitCode;
}

function privateMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
