import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ConversationId } from "@earendil-works/pi-durable";
import { locateWorkflowDirectory } from "../run/locate-run-files.js";
import { renderRunFiles, type RunFileSnapshot } from "../run/render-run-files.js";

export type ProjectionResult = { available: true } | { available: false; message: string };
const DEFAULT_FILE_CAP_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
type ProjectionKind = "results" | "execution";
type RotationFloor = { readonly names: string; readonly sequence: number | null };

/** Serialize projections by workflow and load committed state after the prior replacement. */
export function createRunFileWriter(options: {
  readonly load: (conversationId: ConversationId) => Promise<RunFileSnapshot>;
  readonly diagnostic: (conversationId: ConversationId, message: string, stepId: string | null) => Promise<void>;
  readonly settled?: (snapshot: RunFileSnapshot) => Promise<void>;
  readonly executionLog?: boolean;
  readonly maxFileBytes?: number;
  readonly now?: () => Date;
}) {
  const queues = new Map<string, Promise<ProjectionResult>>();
  const rotationFloors = new Map<string, RotationFloor>();
  return {
    async project(conversationId: ConversationId): Promise<ProjectionResult> {
      try {
        const initial = await options.load(conversationId);
        const directory = locateWorkflowDirectory(initial.run);
        const previous = queues.get(directory) ?? Promise.resolve({ available: true } as const);
        const next = previous.then(async (): Promise<ProjectionResult> => {
          try {
            const snapshot = await options.load(conversationId);
            const rendered = renderRunFiles(snapshot, options.executionLog === true);
            await prepareWorkflowDirectory(directory, snapshot.run.workflowId);
            await projectSection(join(directory, "results.md"), rendered.results, "results", snapshot, options, rotationFloors);
            if (options.executionLog === true) {
              await projectSection(join(directory, "execution.log"), rendered.executionLog, "execution", snapshot, options, rotationFloors);
            }
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
        queues.set(directory, next);
        void next.then(() => { if (queues.get(directory) === next) queues.delete(directory); });
        return await next;
      } catch (error) {
        const message = "unavailable view: " + (error instanceof Error ? error.message : String(error));
        try { await options.diagnostic(conversationId, message, null); }
        catch (diagnosticError) { console.error("projection diagnostic unavailable: " + String(diagnosticError)); }
        return { available: false, message };
      }
    },
    async drain(): Promise<void> { await Promise.all([...queues.values()]); },
  };
}

async function prepareWorkflowDirectory(directory: string, workflowId: string): Promise<void> {
  const parent = dirname(directory);
  if (basename(parent) !== ".workshop" || basename(directory) !== workflowId) {
    throw new Error("workflow projection path is outside its installation namespace");
  }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("workflow projection parent must be a real .workshop directory");
  }
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("workflow projection path must be a real directory");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await mkdir(directory);
  }
}

async function projectSection(
  path: string,
  section: string,
  kind: ProjectionKind,
  snapshot: RunFileSnapshot,
  options: { readonly maxFileBytes?: number; readonly now?: () => Date },
  rotationFloors: Map<string, RotationFloor>,
): Promise<void> {
  const runId = snapshot.run.runId;
  const finished = ["completed", "failed", "cancelled"].includes(snapshot.run.status);
  const current = await readText(path);
  const matches = findRunSections(current, runId);

  if (matches.length > 0 && finished && matches[0]?.mutable === false) {
    if (matches.length > 1) await replaceFile(path, removeDuplicateSections(current, matches));
    return;
  }
  if (matches.length > 0) {
    await replaceFile(path, replaceRunSection(current, matches, section));
    return;
  }
  if (finished) {
    const floor = await oldestRotatedSequence(path, kind, rotationFloors);
    if (floor !== null && snapshot.run.admissionSequence < floor) return;
    if (await sectionIsRotated(path, kind, runId)) return;
  }

  let base = current;
  const separator = base === "" ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  const cap = options.maxFileBytes ?? DEFAULT_FILE_CAP_BYTES;
  if (base !== "" && Buffer.byteLength(base + separator + section, "utf8") > cap) {
    await rotateFile(path, kind, base, options.now?.() ?? new Date(), rotationFloors);
    base = "";
  }
  await replaceFile(path, base + (base === "" ? "" : separator) + section);
}

async function readText(path: string): Promise<string> {
  try { return (await readRegularFile(path)).toString("utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("projection file must be a regular file");
  return readFile(path);
}

type RunSection = { readonly id: string; readonly admissionSequence: number; readonly mutable: boolean; readonly start: number; readonly end: number };
function findRunSections(text: string, runId?: string): RunSection[] {
  const sections: RunSection[] = [];
  const opening = /^<workshop-run id="([a-z0-9-]+)" [^>]*mutable="(true|false)" admission-sequence="([0-9]+)"[^>]*>\n/gmu;
  for (const match of text.matchAll(opening)) {
    const start = match.index;
    const contentStart = start + match[0].length;
    const close = text.indexOf("</workshop-run>\n", contentStart);
    if (close < 0) continue;
    if (runId === undefined || match[1] === runId) sections.push({ id: match[1]!, admissionSequence: Number(match[3]), mutable: match[2] === "true", start, end: close + "</workshop-run>\n".length });
  }
  return sections;
}

function replaceRunSection(text: string, matches: readonly RunSection[], section: string): string {
  const first = matches[0];
  if (first === undefined) return text;
  let result = text.slice(0, first.start) + section + text.slice(first.end);
  const duplicates = findRunSections(result, first.id).slice(1).reverse();
  for (const duplicate of duplicates) result = result.slice(0, duplicate.start) + result.slice(duplicate.end);
  return result;
}

function removeDuplicateSections(text: string, matches: readonly RunSection[]): string {
  let result = text;
  for (const duplicate of matches.slice(1).reverse()) result = result.slice(0, duplicate.start) + result.slice(duplicate.end);
  return result;
}

function rotationNames(directory: string, kind: ProjectionKind, names: readonly string[]): string[] {
  const stem = kind === "results" ? "results-" : "execution-";
  const suffix = kind === "results" ? ".md.gz" : ".log.gz";
  return names.filter((name) => name.startsWith(stem) && name.endsWith(suffix)).sort();
}

async function oldestRotatedSequence(path: string, kind: ProjectionKind, cache: Map<string, RotationFloor>): Promise<number | null> {
  const directory = dirname(path);
  const names = rotationNames(directory, kind, await readdir(directory));
  const signature = names.join("\n");
  const cached = cache.get(path);
  if (cached?.names === signature) return cached.sequence;
  let sequence: number | null = null;
  for (const name of names) {
    const text = gunzipSync(await readRegularFile(join(directory, name))).toString("utf8");
    for (const section of findRunSections(text)) sequence = sequence === null ? section.admissionSequence : Math.min(sequence, section.admissionSequence);
  }
  cache.set(path, { names: signature, sequence });
  return sequence;
}

async function sectionIsRotated(path: string, kind: ProjectionKind, runId: string): Promise<boolean> {
  const directory = dirname(path);
  const names = rotationNames(directory, kind, await readdir(directory));
  for (const name of names) {
    const text = gunzipSync(await readRegularFile(join(directory, name))).toString("utf8");
    if (findRunSections(text, runId).length > 0) return true;
  }
  return false;
}

async function rotateFile(path: string, kind: ProjectionKind, content: string, now: Date, floors: Map<string, RotationFloor>): Promise<void> {
  const directory = dirname(path);
  const stem = kind === "results" ? "results-" : "execution-";
  const suffix = kind === "results" ? ".md.gz" : ".log.gz";
  const bytes = Buffer.from(content, "utf8");
  const names = (await readdir(directory)).filter((name) => name.startsWith(stem) && name.endsWith(suffix));
  let archived: string | undefined;
  for (const name of names) {
    try {
      if (gunzipSync(await readRegularFile(join(directory, name))).equals(bytes)) { archived = name; break; }
    } catch { /* Ignore a damaged rotation and preserve the current file. */ }
  }
  if (archived === undefined) {
    const sequence = findRunSections(content).reduce((maximum, section) => Math.max(maximum, section.admissionSequence), 0);
    archived = stem + now.toISOString().replaceAll(":", "-") + "-" + String(sequence).padStart(16, "0") + "-" + randomUUID() + suffix;
    const archivePath = join(directory, archived);
    const temporary = archivePath + ".tmp-" + randomUUID();
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await file.writeFile(gzipSync(bytes));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, archivePath);
      await syncDirectory(directory);
    } catch (error) {
      throw new Error("cannot rotate " + basename(path), { cause: error });
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  await retainNewest(directory, stem, suffix);
  await oldestRotatedSequence(path, kind, floors);
}

async function retainNewest(directory: string, stem: string, suffix: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.startsWith(stem) && name.endsWith(suffix)).sort().reverse();
  for (const name of names.slice(MAX_ROTATED_FILES)) await rm(join(directory, name), { force: true });
  await syncDirectory(directory);
}

async function replaceFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const prefix = basename(path) + ".projection-";
  const temporary = path + ".projection-" + randomUUID();
  try {
    for (const name of await readdir(directory)) {
      if (name.startsWith(prefix)) await rm(join(directory, name), { force: true });
    }
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "write_failed";
    throw new Error("cannot replace " + basename(path) + " (" + code + ")", { cause: error });
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
