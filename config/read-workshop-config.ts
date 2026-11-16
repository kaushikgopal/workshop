import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export type ConfigIssue = { file: string; reason: string };

export type AgentProfile = {
  command: string[];
  context_window?: number;
};

export type WorkshopConfig = {
  agent_profiles: Record<string, AgentProfile>;
  orchestrator: {
    model?: string;
    escalation_model?: string;
  };
};

export class ConfigReadError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(issues.map(({ file, reason }) => `${file}: ${reason}`).join("\n"));
    this.name = "ConfigReadError";
    this.issues = issues;
  }
}

const profileName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must use lowercase letters, digits, and hyphens");

const agentProfileSchema = z.object({
  command: z.array(z.string()).min(1, "must contain at least one argument").refine((command) => Boolean(command[0]?.trim()), "must not be empty"),
  context_window: z.number().int().positive().optional(),
}).strict();

const agentProfilesSchema = z.record(z.string(), agentProfileSchema)
  .refine((profiles) => Object.keys(profiles).length > 0, "must contain at least one profile")
  .superRefine((profiles, context) => {
    for (const name of Object.keys(profiles)) {
      if (!profileName.safeParse(name).success) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "name must use lowercase letters, digits, and hyphens",
        });
      }
    }
  });

const configSchema = z.object({
  agent_profiles: agentProfilesSchema,
  orchestrator: z.object({
    model: z.string().min(1).optional(),
    escalation_model: z.string().min(1).optional(),
  }).strict(),
}).strict();

function makeIssue(file: string, reason: string): ConfigReadError {
  return new ConfigReadError([{ file, reason }]);
}

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === "'" || quote === '"' || quote === "`") {
    if (!value.endsWith(quote)) throw new Error("unterminated quoted value");
    const inner = value.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\").replace(/\\\"/g, '"')
      : inner;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function loadEnvLocal(configDirectory: string): void {
  const envFile = resolve(configDirectory, ".env.local");
  let contents: string;
  try {
    contents = readFileSync(envFile, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw makeIssue(".env.local", `could not read file: ${errorMessage(error)}`);
  }

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const source = line.trim();
    if (source.length === 0 || source.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(source);
    if (!match) throw makeIssue(".env.local", `line ${index + 1} must use KEY=value syntax`);
    const key = match[1];
    if (key === undefined) throw makeIssue(".env.local", `line ${index + 1} has no variable name`);
    if (process.env[key] !== undefined) continue;
    try {
      process.env[key] = parseEnvValue(match[2] ?? "");
    } catch (error) {
      throw makeIssue(".env.local", `line ${index + 1}: ${errorMessage(error)}`);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interpolateEnvironment(value: unknown, file: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = process.env[name];
      if (replacement === undefined) throw makeIssue(file, `environment variable ${name} is not set`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnvironment(item, file));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnvironment(item, file)]));
  }
  return value;
}

function describeSchemaIssues(file: string, issues: z.ZodIssue[]): ConfigIssue[] {
  return issues.map((entry) => ({
    file,
    reason: `${entry.path.length ? `${entry.path.join(".")}: ` : ""}${entry.message}`,
  }));
}

export function readConfig(configFile?: string): WorkshopConfig {
  const configuredFile = configFile ?? process.env.WORKSHOP_CONFIG ?? "workshop.yaml";
  const absoluteFile = isAbsolute(configuredFile) ? configuredFile : resolve(process.cwd(), configuredFile);
  loadEnvLocal(dirname(absoluteFile));

  let source: string;
  try {
    source = readFileSync(absoluteFile, "utf8");
  } catch (error) {
    throw makeIssue(configuredFile, `could not read config: ${errorMessage(error)}`);
  }

  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) {
    throw new ConfigReadError(document.errors.map((error) => ({ file: configuredFile, reason: `invalid YAML: ${error.message}` })));
  }

  let parsed: unknown;
  try {
    parsed = document.toJS();
  } catch (error) {
    throw makeIssue(configuredFile, `invalid YAML: ${errorMessage(error)}`);
  }
  const expanded = interpolateEnvironment(parsed, configuredFile);
  const result = configSchema.safeParse(expanded);
  if (!result.success) throw new ConfigReadError(describeSchemaIssues(configuredFile, result.error.issues));
  const configDirectory = dirname(absoluteFile);
  const agent_profiles = Object.fromEntries(
    Object.entries(result.data.agent_profiles).map(([name, profile]) => {
      const [executable, ...args] = profile.command;
      const command = executable !== undefined && executable.includes("/") && !isAbsolute(executable)
        ? [resolve(configDirectory, executable), ...args]
        : profile.command;
      return [name, { ...profile, command }];
    }),
  );
  return { ...result.data, agent_profiles };
}

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
