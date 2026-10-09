import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableStorage } from "../../src/storage/durable/open-durable-storage.js";

registerStorageConformance({ describe, expect, it }, "Workshop SQLite under Bun", async (use) => {
  const path = join(mkdtempSync(join(tmpdir(), "workshop-storage-")), "durable.db");
  const opened = await openDurableStorage(path);
  if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
  const storage = opened.storage;
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});
