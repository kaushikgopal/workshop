import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { renderRunFiles, type RunFileSnapshot } from "../run/render-run-files.js";

export type ProjectionResult = { available: true } | { available: false; message: string };

/** Each queue reads committed state only after the previous replacement finishes. */
export function createRunFileWriter(options: {
  readonly load: (conversationId: ConversationId) => Promise<RunFileSnapshot>;
  readonly diagnostic: (conversationId: ConversationId, message: string, stepId: string | null) => Promise<void>;
  readonly settled?: (snapshot: RunFileSnapshot) => Promise<void>;
}) {
  const queues = new Map<ConversationId, Promise<ProjectionResult>>();
  return {
    project(conversationId: ConversationId): Promise<ProjectionResult> {
      const previous = queues.get(conversationId) ?? Promise.resolve({ available: true } as const);
      const next = previous.then(async (): Promise<ProjectionResult> => {
        try {
          const snapshot = await options.load(conversationId);
          const rendered = renderRunFiles(snapshot);
          await mkdir(snapshot.run.paths.runDirectory, { recursive: true });
          await replaceFile(join(snapshot.run.paths.runDirectory, "results.md"), rendered.results);
          await replaceFile(join(snapshot.run.paths.runDirectory, "execution.log"), rendered.executionLog);
          for (const diagnostic of rendered.diagnostics) {
            await options.diagnostic(conversationId, diagnostic.message, diagnostic.stepId);
          }
          await options.settled?.(snapshot);
          return { available: true };
        } catch (error) {
          const message = "unavailable view: " + (error instanceof Error ? error.message : String(error));
          try { await options.diagnostic(conversationId, message, null); }
          catch (diagnosticError) { console.error("projection diagnostic unavailable: " + String(diagnosticError)); }
          return { available: false, message };
        }
      });
      queues.set(conversationId, next);
      void next.then(() => { if (queues.get(conversationId) === next) queues.delete(conversationId); });
      return next;
    },
    async drain(): Promise<void> { await Promise.all([...queues.values()]); },
  };
}

async function replaceFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const prefix = basename(path) + ".projection-";
  const temporary = path + ".projection-" + randomUUID();
  try {
    // The service lock and per-run queue prove these files have no live writer.
    for (const name of await readdir(directory)) {
      if (name.startsWith(prefix)) await rm(join(directory, name), { force: true });
    }
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "write_failed";
    throw new Error("cannot replace " + basename(path) + " (" + code + ")", { cause: error });
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
