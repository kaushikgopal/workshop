import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function executeCommand(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

function gitOutput(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
  return result.stdout.trim();
}

function destinationExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function copy(): void {
  const requestedPath = process.argv[2];
  if (requestedPath === undefined || requestedPath.length === 0) throw new Error("Usage: make copy to=<dir>");

  const source = process.cwd();
  const destination = resolve(requestedPath);
  if (destinationExists(destination)) throw new Error(`Destination already exists: ${destination}`);

  const originResult = spawnSync("git", ["remote", "get-url", "origin"], { cwd: source, encoding: "utf8" });
  if (originResult.error) throw originResult.error;
  const origin = originResult.status === 0 ? originResult.stdout.trim() : source;
  executeCommand("git", ["clone", origin, destination]);

  const branch = gitOutput(["branch", "--show-current"], source) || "workshop-copy";
  executeCommand("git", ["fetch", "--no-tags", source, branch], destination);
  executeCommand("git", ["checkout", "-B", branch, "FETCH_HEAD"], destination);
  executeCommand("git", ["remote", "rename", "origin", "upstream"], destination);

  const ignoreFile = resolve(destination, ".gitignore");
  const ignore = readFileSync(ignoreFile, "utf8");
  const updatedIgnore = ignore.split(/\r?\n/).filter((line) => line !== "/workshop.yaml").join("\n");
  writeFileSync(ignoreFile, updatedIgnore, "utf8");

  executeCommand("make", ["setup"], destination);
  console.log(`Created and set up ${destination}. The public repository is named upstream.`);
}

try {
  copy();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
