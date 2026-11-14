import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function validateLabel(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error("LABEL must contain only letters, digits, dots, and hyphens");
  }
  return value;
}

function executeLaunchctl(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function uninstall(): void {
  if (process.platform !== "darwin") throw new Error("The Workshop launch agent can only be removed on macOS");
  const label = validateLabel(process.argv[2]);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID");

  const domain = `gui/${uid}`;
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const loaded = executeLaunchctl(["print", `${domain}/${label}`]);
  if (loaded.status === 0) {
    const target = existsSync(plistPath) ? plistPath : `${domain}/${label}`;
    const removed = executeLaunchctl(["bootout", domain, target]);
    if (removed.status !== 0) {
      throw new Error(`launchctl bootout failed: ${removed.output.trim() || removed.status}`);
    }
  }

  if (existsSync(plistPath)) rmSync(plistPath);
  console.log(`Removed launch agent ${label}.`);
}

try {
  uninstall();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
