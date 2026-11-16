import { join } from "node:path";
import { ConfigReadError, readConfig } from "../config/read-workshop-config.ts";
import { loadWorkflows } from "../workflow/load-workflows.ts";

function printErrors(label: string, errors: { file: string; reason: string }[]): void {
  for (const error of errors) {
    const file = error.file === "." ? label : join(label, error.file);
    console.error(`${file}: ${error.reason}`);
  }
}

try {
  const config = readConfig();
  const exampleConfig = readConfig("workshop.example.yaml");
  const localProfiles = new Set(Object.keys(config.agent_profiles));
  const exampleProfiles = new Set(Object.keys(exampleConfig.agent_profiles));
  const workflows = loadWorkflows(join(process.cwd(), "workflows"), localProfiles);
  const examples = loadWorkflows(join(process.cwd(), "examples/workflows"), exampleProfiles, { ignoreTopLevelYaml: true });
  printErrors("workflows", workflows.errors);
  printErrors("examples/workflows", examples.errors);
  if (workflows.errors.length > 0 || examples.errors.length > 0) process.exitCode = 1;
} catch (error) {
  if (error instanceof ConfigReadError) {
    for (const issue of error.issues) console.error(`${issue.file}: ${issue.reason}`);
  }
  else console.error(`workflows: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
