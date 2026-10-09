import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import { checkDefinitionText } from "../definition/check-definition.js";
import { resolveWorkflowSettings } from "../definition/resolve-workflow-settings.js";
import { machineConfigSchema, workflowIdSchema, type MachineConfig } from "../definition/schema.js";
import { parseStrictYaml } from "../definition/parse-yaml.js";

export interface Installation {
  readonly root: string;
  readonly workshopDirectory: string;
  readonly configDirectory: string;
  readonly workflowsDirectory: string;
  readonly stateDirectory: string;
  readonly runsDirectory: string;
  readonly databasePath: string;
  readonly machine: MachineConfig;
  readonly projectCwd: string;
}

export interface CheckedWorkflow {
  readonly workflowId: string;
  readonly sourceText: string;
  readonly sourcePath: string;
  readonly definition: ReturnType<typeof checkDefinitionText>["def"];
  readonly chain: ReturnType<typeof checkDefinitionText>["chain"];
  readonly canonicalHash: string;
  readonly resolvedSettings: ReturnType<typeof resolveWorkflowSettings>;
}

/** Locate the nearest installation without creating any state. */
export function findInstallation(from: string = process.cwd()): Installation {
  let directory = resolve(from);
  for (;;) {
    const workshopDirectory = join(directory, ".workshop");
    if (existsSync(workshopDirectory)) return loadInstallation(directory);
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`no Workshop installation found — expected .workshop/ in "${resolve(from)}" or an ancestor`);
    }
    directory = parent;
  }
}

/** Load machine settings without creating installation state. */
export function loadInstallation(root: string): Installation {
  const absoluteRoot = resolve(root);
  const workshopDirectory = join(absoluteRoot, ".workshop");
  const stat = lstatSync(workshopDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`installation path must be a real .workshop directory: ${workshopDirectory}`);
  }

  const configDirectory = join(workshopDirectory, "config");
  const workflowsDirectory = join(configDirectory, "workflows");
  const stateDirectory = join(workshopDirectory, "state");
  const configPath = join(configDirectory, "workshop.yaml");
  const machine = loadMachineConfig(configPath);
  const projectCwd = machine.project_dir === undefined ? absoluteRoot : resolve(configDirectory, machine.project_dir);

  return {
    root: absoluteRoot,
    workshopDirectory,
    configDirectory,
    workflowsDirectory,
    stateDirectory,
    runsDirectory: join(stateDirectory, "runs"),
    databasePath: join(stateDirectory, "durable.db"),
    machine,
    projectCwd,
  };
}

/**
 * A missing machine config means built-in defaults. A present one must declare
 * `version: 2`, so an unversioned file fails with a schema error that names the
 * fix instead of a list of unrecognized keys.
 */
function loadMachineConfig(configPath: string): MachineConfig {
  if (!existsSync(configPath)) return machineConfigSchema.parse({ version: 2 });
  const raw = parseStrictYaml(readFileSync(configPath, "utf8"), configPath);
  const version = typeof raw === "object" && raw !== null && !Array.isArray(raw) && "version" in raw ? raw.version : undefined;
  if (version !== 2) {
    throw new Error(version === undefined
      ? `${configPath}: machine config does not declare a version; add version: 2`
      : `${configPath}: unsupported machine config version ${JSON.stringify(version)}; expected version: 2`);
  }
  return machineConfigSchema.parse(raw);
}

/** Read, check, and resolve one workflow; this function has no execution or storage effects. */
export function loadCheckedWorkflow(installation: Installation, workflowId: string): CheckedWorkflow {
  const checkedId = workflowIdSchema.parse(workflowId);
  const sourcePath = join(installation.workflowsDirectory, `${checkedId}.yaml`);
  const sourceText = readFileSync(sourcePath, "utf8");
  const checked = checkDefinitionText(sourceText, sourcePath);
  if (checked.def.id !== checkedId) {
    throw new Error(`workflow id in ${sourcePath} is ${JSON.stringify(checked.def.id)}, expected ${JSON.stringify(checkedId)}`);
  }
  const resolvedSettings = resolveWorkflowSettings({
    definition: checked.def,
    machine: installation.machine,
    projectCwd: installation.projectCwd,
  });
  return {
    workflowId: checkedId,
    sourceText,
    sourcePath,
    definition: checked.def,
    chain: checked.chain,
    canonicalHash: canonicalHash(checked.def),
    resolvedSettings,
  };
}
