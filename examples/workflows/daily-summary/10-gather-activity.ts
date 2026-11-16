import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = process.env.WORKSHOP_PROJECT_ROOT;
if (!projectRoot) {
  console.error("WORKSHOP_PROJECT_ROOT is required");
  process.exitCode = 1;
} else {
  const reader = resolve(projectRoot, "scripts/read-workshop-activity.ts");
  const result = spawnSync(process.execPath, [reader], { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not start Workshop activity reader: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.status === null) {
    console.error(`Workshop activity reader stopped${result.signal ? ` by ${result.signal}` : ""}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}
