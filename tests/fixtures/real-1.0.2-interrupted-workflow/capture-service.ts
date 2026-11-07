import { appendFileSync } from "node:fs";
import { loadInstallation } from "../../../src/installation/load-installation.js";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { startWorkshopService } from "../../../src/service/open-service-runtime.js";

const [root, requestLog] = process.argv.slice(2);
if (root === undefined || requestLog === undefined) throw new Error("usage: capture-service.ts <root> <request-log>");
const provider = fauxProvider({ provider: "fixture", models: [{ id: "legacy-worker" }] });
provider.setResponses(Array.from({ length: 100 }, () => () => {
  appendFileSync(requestLog, "request\n", "utf8");
  return fauxAssistantMessage("<status>succeeded</status>\n<reason>Historical faux worker completed the preparation step.</reason>\n<output>HISTORICAL_INTERRUPTED_CAPTURE</output>");
}));
const models = createModels();
models.setProvider(provider.provider);
const owner = await startWorkshopService(loadInstallation(root), models);
process.once("SIGTERM", () => {
  void owner.shutdown().then(() => process.exit(0), (error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exit(1);
  });
});
await new Promise<void>(() => {});
