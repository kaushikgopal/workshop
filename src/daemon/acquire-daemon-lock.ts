import { readFileSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class DaemonLockHeld extends Error {
  constructor(public holderPid: number | null) {
    super(`another daemon holds the singleton lock${holderPid ? ` (pid ${holderPid})` : ""}`);
    this.name = "DaemonLockHeld";
  }
}

export interface SingletonLock {
  release: () => void;
}
export function unlinkLock(path: string): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}
export function rmLock(path: string): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}
/** O_EXCL singleton with stale takeover by pid liveness. */
export function acquireSingletonLock(stateDir: string): SingletonLock {
  const path = join(stateDir, "daemon.lock");
  for (; ;) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return { release: () => unlinkLock(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holderPid: number | null = null;
      try {
        const holder = JSON.parse(readFileSync(path, "utf8")) as { pid: number; };
        holderPid = holder.pid;
        process.kill(holder.pid, 0);
        throw new DaemonLockHeld(holderPid); // holder alive
      } catch (err) {
        if (err instanceof DaemonLockHeld) throw err;
        rmLock(path); // holder dead or unreadable
      }
    }
  }
}
