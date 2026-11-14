import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const mode = process.argv[2];

if (mode === "fail") {
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else if (mode === "tool") {
  process.stdout.write(JSON.stringify({ tool_calls: [{ name: "list_runs", input: { limit: 3 } }] }));
} else if (mode === "repair" && !prompt.includes("Your previous output was invalid")) {
  process.stdout.write("not JSON");
} else if (mode === "always-invalid") {
  process.stdout.write("not JSON");
} else {
  process.stdout.write(JSON.stringify({ text: prompt.includes("Say hello") ? (mode === "repair" ? "repaired reply" : "fixture reply") : "prompt missing" }));
}
