import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
const mode = process.argv[2];

if (mode === "echo") {
  process.stdout.write(input);
} else if (mode === "line") {
  process.stdout.write("A quiet road crossed the field.\n");
} else if (mode === "accept") {
  process.stdout.write("ACCEPT - the line is original\n");
} else if (mode === "reject") {
  process.stdout.write("REJECT - the line repeats an earlier sentence\n");
} else if (mode === "fail") {
  process.stderr.write("fixture profile failure\n");
  process.exitCode = 7;
} else if (mode === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
} else if (mode === "spawn-grandchild") {
  const pidFile = process.argv[3];
  if (!pidFile) throw new Error("grandchild PID file is required");
  const grandchild = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
  ], { stdio: "ignore" });
  if (grandchild.pid === undefined) throw new Error("grandchild did not start");
  writeFileSync(pidFile, String(grandchild.pid));
  await new Promise(() => {});
} else if (mode === "environment") {
  process.stdout.write(JSON.stringify({
    input,
    workflow: process.env.WORKSHOP_WORKFLOW,
    runId: process.env.WORKSHOP_RUN_ID,
    step: process.env.WORKSHOP_STEP,
    dataDirectory: process.env.WORKSHOP_DATA_DIR,
    stateDirectory: process.env.WORKSHOP_STATE_DIR,
    feedback: process.env.WORKSHOP_FEEDBACK,
  }));
}
