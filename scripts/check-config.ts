import { checkProfileCommands, ConfigReadError, loadWorkshopConfig } from "../config/load-workshop-config.ts";

try {
  const config = loadWorkshopConfig();
  const issues = checkProfileCommands(config);
  for (const { file, reason } of issues) console.error(`${file}: ${reason}`);
  if (issues.length > 0) process.exitCode = 1;
} catch (error) {
  if (error instanceof ConfigReadError) {
    for (const { file, reason } of error.issues) console.error(`${file}: ${reason}`);
  } else {
    console.error(`workshop.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
