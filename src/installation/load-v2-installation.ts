import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import { checkV2DefinitionText } from "../definition/check-v2-definition.js";
import { resolveV2WorkflowSettings } from "../definition/resolve-v2-workflow-settings.js";
import { machineConfigSchemaV2, workflowIdV2, type MachineConfigV2 } from "../definition/schema-v2.js";
import { parseStrictYaml } from "../definition/parse-yaml.js";
import { renderV3MigrationGuidance } from "../definition/render-v3-migration-guidance.js";

export interface V2Installation {
  readonly root: string;
  readonly workshopDirectory: string;
  readonly configDirectory: string;
  readonly workflowsDirectory: string;
  readonly stateDirectory: string;
  readonly runsDirectory: string;
  readonly databasePath: string;
  readonly machine: MachineConfigV2;
  readonly projectCwd: string;
}

export interface CheckedV2Workflow {
  readonly workflowId: string;
  readonly sourceText: string;
  readonly sourcePath: string;
  readonly definition: ReturnType<typeof checkV2DefinitionText>["def"];
  readonly chain: ReturnType<typeof checkV2DefinitionText>["chain"];
  readonly canonicalHash: string;
  readonly resolvedSettings: ReturnType<typeof resolveV2WorkflowSettings>;
}

/** Locate v4 installation paths without parsing or creating v3 state. */
export function findV2Installation(from: string = process.cwd()): V2Installation {
  let directory = resolve(from);
  for (;;) {
    const workshopDirectory = join(directory, ".workshop");
    if (existsSync(workshopDirectory)) return loadV2Installation(directory);
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`no Workshop installation found — expected .workshop/ in "${resolve(from)}" or an ancestor`);
    }
    directory = parent;
  }
}

/** Load v2 machine settings without creating installation state. */
export function loadV2Installation(root: string): V2Installation {
  const absoluteRoot = resolve(root);
  const workshopDirectory = join(absoluteRoot, ".workshop");
  const stat = lstatSync(workshopDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`v4 installation path must be a real .workshop directory: ${workshopDirectory}`);
  }

  const configDirectory = join(workshopDirectory, "config");
  const workflowsDirectory = join(configDirectory, "workflows");
  const stateDirectory = join(workshopDirectory, "state");
  const configPath = join(configDirectory, "workshop.yaml");
  const machine = loadV2MachineConfig(configPath, stateDirectory, workflowsDirectory);
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
 * A v3 installation has either a machine config without `version: 2`, or no
 * config beside v3's SQLite state or version 1 workflows. Refuse all three
 * before any v4 code can create service files in that state directory; a
 * fresh installation without v3 files may still rely on v2 defaults.
 */
function loadV2MachineConfig(configPath: string, stateDirectory: string, workflowsDirectory: string): MachineConfigV2 {
  if (!existsSync(configPath)) {
    const legacyDatabase = join(stateDirectory, "workshop.db");
    if (existsSync(legacyDatabase)) {
      throw new Error(renderV3MigrationGuidance(
        `this installation has v3 state (${legacyDatabase}) and no version 2 machine config at ${configPath}; v4 will not start beside it implicitly.`,
      ));
    }
    const legacyWorkflow = findVersion1Workflow(workflowsDirectory);
    if (legacyWorkflow !== null) {
      throw new Error(renderV3MigrationGuidance(
        `this installation has a version 1 workflow (${legacyWorkflow}) and no version 2 machine config at ${configPath}; v4 will not start beside it implicitly.`,
      ));
    }
    return machineConfigSchemaV2.parse({ version: 2 });
  }
  const raw = parseStrictYaml(readFileSync(configPath, "utf8"), configPath);
  const version = declaredVersion(raw);
  if (version === undefined || version === 1) {
    throw new Error(renderV3MigrationGuidance(
      `${configPath} is a v3 machine config (it does not declare \`version: 2\`), which the default v4 engine cannot read.`,
    ));
  }
  return machineConfigSchemaV2.parse(raw);
}

function findVersion1Workflow(workflowsDirectory: string): string | null {
  let names: string[];
  try {
    names = readdirSync(workflowsDirectory).filter((name) => name.endsWith(".yaml")).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const path = join(workflowsDirectory, name);
    try {
      if (declaredVersion(parseStrictYaml(readFileSync(path, "utf8"), path)) === 1) return path;
    } catch {
      // Unreadable or malformed files surface through the normal workflow check.
    }
  }
  return null;
}

function declaredVersion(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "version" in value ? value.version : undefined;
}

/** Read, check, and resolve one v2 workflow; this function has no execution or storage effects. */
export function loadCheckedV2Workflow(installation: V2Installation, workflowId: string): CheckedV2Workflow {
  const checkedId = workflowIdV2.parse(workflowId);
  const sourcePath = join(installation.workflowsDirectory, `${checkedId}.yaml`);
  const sourceText = readFileSync(sourcePath, "utf8");
  const checked = checkV2DefinitionText(sourceText, sourcePath);
  if (checked.def.id !== checkedId) {
    throw new Error(`workflow id in ${sourcePath} is ${JSON.stringify(checked.def.id)}, expected ${JSON.stringify(checkedId)}`);
  }
  const resolvedSettings = resolveV2WorkflowSettings({
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
