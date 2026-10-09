import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** Remove a derived file and flush its containing directory. */
export function removeFileSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
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
