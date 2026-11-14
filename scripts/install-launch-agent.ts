import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function validateLabel(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error("LABEL must contain only letters, digits, dots, and hyphens");
  }
  return value;
}

function executeLaunchctl(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function install(): void {
  if (process.platform !== "darwin") throw new Error("The Workshop launch agent can only be installed on macOS");

  const label = validateLabel(requireValue(process.argv[2], "LABEL"));
  const repository = resolve(requireValue(process.argv[3], "repository path"));
  const npxPath = requireValue(process.argv[4], "npx path");
  const portText = requireValue(process.argv[5], "PORT");
  if (!isAbsolute(npxPath)) throw new Error("npx path must be absolute");
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  if (!existsSync(join(repository, "workshop.yaml"))) throw new Error("workshop.yaml is required; run make setup first");

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID");
  const domain = `gui/${uid}`;
  const loaded = executeLaunchctl(["print", `${domain}/${label}`]);
  if (loaded.status === 0) throw new Error(`Launch agent ${label} is already loaded; run make service-uninstall first`);

  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgents, `${label}.plist`);
  if (existsSync(plistPath)) throw new Error(`${plistPath} already exists; remove it or choose another LABEL`);

  const nodePath = process.execPath;
  const servicePath = [...new Set([
    dirname(nodePath),
    dirname(npxPath),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  ])].join(delimiter);
  const logPath = join(repository, "state", "service.log");
  const template = readFileSync(resolve(repository, "service/launch-service.plist.template"), "utf8");
  const values: Record<string, string> = {
    LABEL: label,
    NODE_PATH: nodePath,
    NPX_PATH: npxPath,
    PORT: portText,
    REPO_PATH: repository,
    PATH: servicePath,
    LOG_PATH: logPath,
  };
  const plist = template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown launch agent placeholder ${placeholder}`);
    return xmlEscape(value);
  });
  if (/\{\{[A-Z_]+\}\}/.test(plist)) throw new Error("Launch agent template contains an unresolved placeholder");

  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plistPath, plist, { encoding: "utf8", flag: "wx", mode: 0o644 });

  const bootstrapped = executeLaunchctl(["bootstrap", domain, plistPath]);
  if (bootstrapped.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrapped.output.trim() || bootstrapped.status}`);
  }
  console.log(`Installed launch agent ${label}. Logs: state/service.log`);
}

try {
  install();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
