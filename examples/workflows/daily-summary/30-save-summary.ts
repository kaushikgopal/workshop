import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readStandardInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string | Buffer) => { input += chunk; });
    process.stdin.once("end", () => resolve(input));
    process.stdin.once("error", reject);
  });
}

const dataDirectory = process.env.WORKSHOP_DATA_DIR;
if (!dataDirectory) throw new Error("WORKSHOP_DATA_DIR is required");
const summary = (await readStandardInput()).trim();
if (!summary) throw new Error("The summary step returned no text");

const date = new Date().toISOString().slice(0, 10);
const fileName = `summary-${date}.md`;
mkdirSync(dataDirectory, { recursive: true });
writeFileSync(join(dataDirectory, fileName), `${summary}\n`, "utf8");
process.stdout.write(`Saved ${fileName}. To notify users, add a command step after 30-save-summary.ts.\n`);
