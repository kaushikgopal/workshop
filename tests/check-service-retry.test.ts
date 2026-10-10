import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadInstallation } from "../src/installation/load-installation.js";
import { encodeServiceRequestLine } from "../src/service/parse-service-protocol.js";
import { sendServiceRequest } from "../src/service/send-service-request.js";
import { serviceRunsPageV1Schema, serviceStartResultV1Schema } from "../src/service/schema.js";
import { startWorkshopService } from "../src/service/open-service-runtime.js";

describe("service mutation retry", () => {
  test("replays a start request after its response is dropped without creating a second run", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-dropped-reply-"));
    const config = join(root, ".workshop");
    const workflows = join(config, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(config, "workshop.yaml"), "shell: /bin/bash\n", "utf8");
    writeFileSync(join(workflows, "clock.yaml"), [
      "steps:",
      "  - tick:",
      "      run: printf-tick",
      "",
    ].join("\n"), "utf8");

    let owner: Awaited<ReturnType<typeof startWorkshopService>> | undefined;
    try {
      owner = await startWorkshopService(loadInstallation(root));
      const request = {
        version: 1 as const,
        requestId: randomUUID(),
        method: "start" as const,
        workflowId: "clock",
      };
      await dropFirstReply(owner.metadata.socketPath, request);

      const retried = await sendServiceRequest(owner.metadata.socketPath, request);
      expect(retried.ok).toBe(true);
      if (!retried.ok) throw new Error(retried.error.message);
      const admitted = serviceStartResultV1Schema.parse(retried.result);
      expect(admitted.duplicate).toBe(false);

      const pageResponse = await sendServiceRequest(owner.metadata.socketPath, {
        version: 1,
        method: "runs",
        workflowId: "clock",
        limit: 10,
      });
      expect(pageResponse.ok).toBe(true);
      if (!pageResponse.ok) throw new Error(pageResponse.error.message);
      const page = serviceRunsPageV1Schema.parse(pageResponse.result);
      expect(page.runs).toHaveLength(1);
      expect(page.runs[0]?.runId).toBe(admitted.runId);
    } finally {
      if (owner !== undefined) await owner.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function dropFirstReply<TRequest extends { readonly version: 1; readonly requestId: string; readonly method: "start"; readonly workflowId: string }>(
  socketPath: string,
  request: TRequest,
): Promise<void> {
  return new Promise((resolveReplyDropped, rejectReplyDrop) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => socket.write(encodeServiceRequestLine(request)));
    socket.once("data", () => {
      socket.destroy();
      resolveReplyDropped();
    });
    socket.once("error", (error) => rejectReplyDrop(error));
  });
}
