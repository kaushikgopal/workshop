import { writeFileSync } from "node:fs";
import { startWorkshopService } from "../../../src/service/serve-workshop-service.js";

const args = process.argv.slice(2);
const stateDirectory = requiredArgument(args[0], "state directory");
const readyPath = requiredArgument(args[1], "ready marker");
const openedPath = requiredArgument(args[2], "opened marker");
const shutdownStartedPath = requiredArgument(args[3], "shutdown-started marker");
const shutdownCompletePath = requiredArgument(args[4], "shutdown-complete marker");
const errorPath = requiredArgument(args[5], "error marker");
const delayMs = Number(args[6] ?? "0");
const shutdownTimeoutMs = Number(args[7] ?? "1000");
if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error("invalid shutdown delay");

async function main(): Promise<void> {
  const owner = await startWorkshopService({
    stateDirectory,
    shutdownTimeoutMs,
    openRuntime: async (metadata) => {
      writeFileSync(openedPath, JSON.stringify({ bootId: metadata.bootId, status: metadata.status }));
      return {
        async handleRequest() { return { accepted: true }; },
        async shutdown(deadlineMs) {
          writeFileSync(shutdownStartedPath, String(deadlineMs));
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          writeFileSync(shutdownCompletePath, "closed");
        },
      };
    },
  });
  writeFileSync(readyPath, JSON.stringify(owner.metadata));

  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });

  try {
    await owner.shutdown();
  } catch (error) {
    writeFileSync(errorPath, error instanceof Error ? error.message : String(error));
    await new Promise<void>(() => {});
  }
}

function requiredArgument(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
