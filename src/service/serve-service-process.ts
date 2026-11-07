import { findInstallation } from "../installation/load-installation.js";
import { startWorkshopService } from "./open-service-runtime.js";

export async function recoverServiceProcess(args: readonly string[]): Promise<void> {
  const { cmdRecover } = await import("../cli/recover.js");
  return cmdRecover(args);
}

export async function serveServiceProcess(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "serve") {
    console.error("error: usage: workshop service serve");
    process.exitCode = 64;
    return;
  }
  const installation = findInstallation();
  let owner: Awaited<ReturnType<typeof startWorkshopService>>;
  try {
    owner = await startWorkshopService(installation);
  } catch (error) {
    console.error(`error: ${errorText(error)}`);
    process.exitCode = 1;
    return;
  }

  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const finish = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveStop();
    };
    const onSignal = (): void => {
      if (stopping) return;
      stopping = true;
      void owner.shutdown().then(finish, (error) => {
        console.error(`error: ${errorText(error)}`);
        process.exitCode = 1;
        finish();
      });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorText).join("; ");
  return error instanceof Error ? error.message : String(error);
}
