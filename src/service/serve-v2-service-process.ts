import { findV2Installation } from "../installation/load-v2-installation.js";
import { startV2WorkshopService } from "./open-v2-service-runtime.js";
import { ServiceShutdownError } from "./serve-workshop-service.js";

export async function serveV2ServiceProcess(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "serve") {
    console.error("error: usage: workshop service serve");
    process.exitCode = 64;
    return;
  }
  const installation = findV2Installation();
  let owner: Awaited<ReturnType<typeof startV2WorkshopService>>;
  try {
    owner = await startV2WorkshopService(installation);
  } catch (error) {
    console.error(`error: ${errorText(error)}`);
    process.exitCode = 1;
    if (error instanceof ServiceShutdownError) await keepProcessAlive();
    return;
  }

  await new Promise<void>((resolveStop) => {
    let stopping = false;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const onSignal = (): void => {
      if (stopping) return;
      stopping = true;
      void owner.shutdown().then(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        if (keepAlive !== undefined) clearInterval(keepAlive);
        resolveStop();
      }, (error) => {
        console.error(`error: ${errorText(error)}`);
        keepAlive ??= setInterval(() => {}, 60_000);
      });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function keepProcessAlive(): Promise<never> {
  setInterval(() => {}, 60_000);
  return await new Promise<never>(() => {});
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorText).join("; ");
  return error instanceof Error ? error.message : String(error);
}
