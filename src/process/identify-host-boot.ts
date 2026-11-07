import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Identify the current host boot, or return null when the host cannot prove it. */
export function identifyHostBoot(): string | null {
  try {
    let value: string;
    if (process.platform === "darwin") {
      const result = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
      if (result.error !== undefined || result.status !== 0) return null;
      value = result.stdout.trim();
    } else if (process.platform === "linux") {
      value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else {
      return null;
    }
    const parsed = z.string().uuid().safeParse(value);
    return parsed.success ? parsed.data.toLowerCase() : null;
  } catch {
    return null;
  }
}
