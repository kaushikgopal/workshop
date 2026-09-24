import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WorklogIntegrityError } from "./worklog.js";

/** Create missing pristine evidence; refuse any existing byte mismatch. */
export function ensurePristineFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.prepare-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path); // hard-link installation is atomic and never replaces
    fsyncDirectory(dirname(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    try { rmSync(tmp); } catch { /* crash debris is harmless */ }
  }
  if (readFileSync(path, "utf8") !== content) {
    throw new WorklogIntegrityError(`existing evidence at ${path} does not match its pristine scaffold`);
  }
}


/** Write + fsync + rename, so readers never see a partial file. */
export function atomicWriteFileSync(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
  return content;
}

/** Flush an externally written file without changing its bytes or inode. */
export function fsyncFileSync(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort on platforms that disallow it.
  }
}
