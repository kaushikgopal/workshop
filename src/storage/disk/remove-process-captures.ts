import { rmSync } from "node:fs";
import type { z } from "zod";
import type { processIncarnationSchema } from "../../process/schema.js";

/** Only a committed, settled receipt with checked death authorizes capture deletion. */
export function removeProcessCaptures(process: z.infer<typeof processIncarnationSchema>, settled: boolean): void {
  if (!settled || process.cleanupState !== "confirmed_dead" || process.captures.length !== 2
    || process.captures.some((capture) => capture.retained === undefined)) return;
  for (const capture of process.captures) {
    for (const path of [capture.path, capture.path + ".retention.json", capture.path + ".retention-tmp"]) {
      try { rmSync(path, { force: true }); } catch { /* Retry cleanup from committed evidence on the next projection. */ }
    }
  }
}
