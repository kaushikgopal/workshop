import { Harness } from "@earendil-works/pi-durable";
import { writeFileSync } from "node:fs";
import { loadInstallation } from "../../src/installation/load-installation.js";
import { startWorkshopService } from "../../src/service/open-service-runtime.js";
import { ServiceShutdownError } from "../../src/service/serve-workshop-service.js";

const root = requiredArgument(process.argv[2], "installation root");
const marker = requiredArgument(process.argv[3], "failure marker");
const originalOpen = Harness.open;

Harness.open = async (storage, options, context) => {
  const harness = await originalOpen(storage, options, context);
  Object.defineProperty(storage, "close", {
    configurable: true,
    value: async () => { throw new Error("injected partial storage-close failure"); },
  });
  void harness;
  throw new Error("injected failure after actual Durable Harness open");
};

try {
  await startWorkshopService(loadInstallation(root));
  throw new Error("injected open failure unexpectedly started the service");
} catch (error) {
  if (!(error instanceof ServiceShutdownError)) throw error;
  writeFileSync(marker, "partial cleanup unconfirmed");
  setInterval(() => {}, 60_000);
  await new Promise<void>(() => {});
}

function requiredArgument(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}
