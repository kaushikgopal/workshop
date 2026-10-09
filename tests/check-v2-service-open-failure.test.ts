import { Harness } from "@earendil-works/pi-durable";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadV2Installation } from "../src/installation/load-v2-installation.js";
import { acquireServiceLock } from "../src/service/acquire-service-lock.js";
import { startV2WorkshopService } from "../src/service/open-v2-service-runtime.js";

describe("v4 service partial-open cleanup", () => {
  test("closes actual Durable storage when an opened Harness rejects before runtime ownership transfers", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-v4-partial-open-"));
    const configDirectory = join(root, ".workshop", "config");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "workshop.yaml"), "version: 2\n", "utf8");

    const originalOpen = Harness.open;
    let openedHarnesses = 0;
    let storageCloseCalls = 0;
    Harness.open = async (storage, options, context) => {
      const closeStorage = storage.close.bind(storage);
      Object.defineProperty(storage, "close", {
        configurable: true,
        value: async (...args: Parameters<typeof storage.close>) => {
          storageCloseCalls += 1;
          return await closeStorage(...args);
        },
      });
      const harness = await originalOpen(storage, options, context);
      openedHarnesses += 1;
      await harness.close(context);
      throw new Error("fixture startup failure after actual Harness open");
    };

    try {
      const installation = loadV2Installation(root);
      await expect(startV2WorkshopService(installation)).rejects.toThrow("fixture startup failure after actual Harness open");
      expect(openedHarnesses).toBe(1);
      expect(storageCloseCalls).toBe(2);

      const reacquiredLock = acquireServiceLock(join(installation.stateDirectory, "service.lock"));
      reacquiredLock.release();
    } finally {
      Harness.open = originalOpen;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
