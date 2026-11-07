import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1,
  MAX_STARTUP_PARK_TASKS_V1,
  startupParkDiagnosticV1Schema,
  type StartupParkDiagnosticV1,
  type StartupParkTaskV1,
} from "./schema.js";

export const STARTUP_PARK_DIAGNOSTIC_FILE = "startup-failure.json";

/** Keep the lowest task IDs in a fixed-size max-heap, then order the bounded result. */
export function selectLowestStartupParkTasks<T extends { readonly taskId: number }>(tasks: Iterable<T>): T[] {
  const selected: T[] = [];
  for (const task of tasks) {
    if (selected.length < MAX_STARTUP_PARK_TASKS_V1) {
      selected.push(task);
      let child = selected.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (selected[parent]!.taskId >= selected[child]!.taskId) break;
        const parentTask = selected[parent]!;
        selected[parent] = selected[child]!;
        selected[child] = parentTask;
        child = parent;
      }
    } else if (task.taskId < selected[0]!.taskId) {
      selected[0] = task;
      siftStartupParkTaskHeapDown(selected, 0);
    }
  }
  return selected.sort((left, right) => left.taskId - right.taskId);
}

function siftStartupParkTaskHeapDown<T extends { readonly taskId: number }>(heap: T[], start: number): void {
  let parent = start;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let greatest = parent;
    if (left < heap.length && heap[left]!.taskId > heap[greatest]!.taskId) greatest = left;
    if (right < heap.length && heap[right]!.taskId > heap[greatest]!.taskId) greatest = right;
    if (greatest === parent) return;
    const parentTask = heap[parent]!;
    heap[parent] = heap[greatest]!;
    heap[greatest] = parentTask;
    parent = greatest;
  }
}

export function createStartupParkDiagnostic(
  bootId: string,
  blockedTasks: readonly StartupParkTaskV1[],
  createdAt = new Date().toISOString(),
  limitations: readonly StartupParkDiagnosticV1["limitations"][number][] = [],
  totalBlockedTaskCount = blockedTasks.length,
): StartupParkDiagnosticV1 {
  if (!Number.isSafeInteger(totalBlockedTaskCount) || totalBlockedTaskCount < blockedTasks.length) {
    throw new Error("startup park diagnostic total is smaller than its supplied task set");
  }
  const ordered = selectLowestStartupParkTasks(blockedTasks);
  const maximumIncluded = Math.min(totalBlockedTaskCount, ordered.length);
  for (let included = maximumIncluded; included >= 0; included -= 1) {
    const diagnostic = startupParkDiagnosticV1Schema.parse({
      version: 1,
      state: "historical_not_ready",
      createdAt,
      bootId,
      blockedTaskCount: totalBlockedTaskCount,
      observationComplete: limitations.length === 0,
      limitations: [...new Set(limitations)],
      truncated: included < totalBlockedTaskCount,
      blockedTasks: ordered.slice(0, included),
    });
    if (Buffer.byteLength(serializeStartupParkDiagnostic(diagnostic), "utf8") <= MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1) {
      return diagnostic;
    }
  }
  throw new Error("startup park diagnostic cannot fit its size limit");
}

export function serializeStartupParkDiagnostic(diagnostic: StartupParkDiagnosticV1): string {
  return JSON.stringify(startupParkDiagnosticV1Schema.parse(diagnostic)) + "\n";
}

/** Write one private replacement without following a diagnostic symlink. */
export function writeStartupParkDiagnostic(stateDirectory: string, diagnostic: StartupParkDiagnosticV1): void {
  const data = Buffer.from(serializeStartupParkDiagnostic(diagnostic), "utf8");
  if (data.byteLength > MAX_STARTUP_PARK_DIAGNOSTIC_BYTES_V1) {
    throw new Error("startup park diagnostic exceeds its size limit");
  }
  const directoryStat = lstatSync(stateDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
    || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("startup park diagnostic directory is not private and owner-controlled");
  }

  const path = join(stateDirectory, STARTUP_PARK_DIAGNOSTIC_FILE);
  const temporary = path + ".tmp-" + process.pid + "-" + randomUUID();
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    renamed = true;
    try {
      const directoryDescriptor = openSync(stateDirectory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {
      // Some supported filesystems do not permit directory fsync.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed) rmSync(temporary, { force: true });
  }
}
