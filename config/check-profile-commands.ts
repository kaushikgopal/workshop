import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import type { ConfigIssue, WorkshopConfig } from "./load-workshop-config.ts";

export function checkProfileCommands(
  config: WorkshopConfig,
  pathValue: string | undefined = process.env.PATH,
  configFile = process.env.WORKSHOP_CONFIG ?? "workshop.yaml",
): ConfigIssue[] {
  const searchPath = pathValue?.split(delimiter) ?? [];
  const issues: ConfigIssue[] = [];
  const configDirectory = dirname(resolve(configFile));
  for (const [name, profile] of Object.entries(config.agent_profiles)) {
    const executable = profile.command[0];
    if (executable === undefined || !isExecutableOnPath(executable, searchPath, configDirectory)) {
      issues.push({
        file: configFile,
        reason: `agent_profiles.${name}.command[0] ${JSON.stringify(executable ?? "")} must resolve to an executable file on PATH`,
      });
    }
  }
  return issues;
}

function isExecutableOnPath(executable: string, searchPath: string[], configDirectory: string): boolean {
  const candidates = executable.includes("/")
    ? [isAbsolute(executable) ? executable : resolve(configDirectory, executable)]
    : searchPath.map((directory) => resolve(directory || process.cwd(), executable));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
