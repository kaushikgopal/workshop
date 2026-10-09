import { Harness } from "@earendil-works/pi-durable";
import { writeFileSync } from "node:fs";
import { loadV2Installation } from "../../../src/installation/load-v2-installation.js";
import { startV2WorkshopService } from "../../../src/service/open-v2-service-runtime.js";
import { ServiceShutdownError } from "../../../src/service/serve-workshop-service.js";

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
  await startV2WorkshopService(loadV2Installation(root));
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
