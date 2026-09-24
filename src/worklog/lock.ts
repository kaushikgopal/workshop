import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorklogIntegrityError } from "./worklog.js";

/** The run-scoped write lock. O_EXCL create; stale takeover by pid liveness. */
export class RunLock {
  private path: string;
  constructor(runDir: string) {
    this.path = join(runDir, "lock");
  }

  acquireSync(timeoutMs = 5000): void {
    const deadline = Date.now() + timeoutMs;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        const fd = openSync(this.path, "wx");
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        this.takeoverIfStale();
        if (Date.now() > deadline) {
          throw new WorklogIntegrityError(`run lock at ${this.path} is held by another process`);
        }
        Atomics.wait(wait, 0, 0, 10);
      }
    }
  }


  async acquire(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.path, "wx");
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        this.takeoverIfStale();
        if (Date.now() > deadline) {
          throw new WorklogIntegrityError(`run lock at ${this.path} is held by another process`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  release(): void {
    try {
      // Only remove if we still own it.
      const content = readFileSync(this.path, "utf8");
      const holder = JSON.parse(content) as { pid: number };
      if (holder.pid === process.pid) rmSync(this.path);
    } catch {
      /* already gone */
    }
  }

  private takeoverIfStale(): void {
    try {
      const content = readFileSync(this.path, "utf8");
      const holder = JSON.parse(content) as { pid: number };
      try {
        process.kill(holder.pid, 0);
        return; // alive
      } catch {
        // Dead holder: take over.
        rmSync(this.path);
      }
    } catch {
      /* lock vanished */
    }
  }
}
