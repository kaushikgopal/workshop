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

type CopyStage =
  | "validate destination"
  | "inspect source"
  | "clone destination"
  | "fetch source revision"
  | "check out copy branch"
  | "rename public remote"
  | "update ignore file"
  | "run make setup";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextAvailablePath(path: string): string {
  let candidate = path;
  let suffix = 1;
  while (destinationExists(candidate)) candidate = `${path}-${suffix++}`;
  return candidate;
}

function recoveryCommand(
  stage: CopyStage,
  source: string,
  destination: string,
  createdDestination: boolean,
): string {
  if (stage === "run make setup" && createdDestination) {
    return `cd ${shellQuote(destination)} && make setup`;
  }
  if (!createdDestination) {
    const retryDestination = nextAvailablePath(`${destination}.retry`);
    return `cd ${shellQuote(source)} && make copy to=${shellQuote(retryDestination)}`;
  }
  const partialDestination = nextAvailablePath(`${destination}.partial`);
  return `mv ${shellQuote(destination)} ${shellQuote(partialDestination)} && cd ${shellQuote(source)} && make copy to=${shellQuote(destination)}`;
}

function copy(): void {
  const requestedPath = process.argv[2];
  if (requestedPath === undefined || requestedPath.length === 0) throw new Error("Usage: make copy to=<dir>");

  const source = process.cwd();
  const destination = resolve(requestedPath);
  let stage: CopyStage = "validate destination";
  let createdDestination = false;
  try {
    if (destinationExists(destination)) throw new Error(`Destination already exists: ${destination}`);

    stage = "inspect source";
    const remotes = gitOutput(["remote"], source).split(/\r?\n/).filter(Boolean);
    const origin = remotes.includes("origin") ? gitOutput(["remote", "get-url", "origin"], source) : source;
    const currentBranch = gitOutput(["branch", "--show-current"], source);
    const branch = currentBranch || "workshop-copy";
    const sourceRef = currentBranch || "HEAD";

    stage = "clone destination";
    executeCommand("git", ["clone", origin, destination]);
    createdDestination = true;

    stage = "fetch source revision";
    executeCommand("git", ["fetch", "--no-tags", source, sourceRef], destination);
    stage = "check out copy branch";
    executeCommand("git", ["checkout", "-B", branch, "FETCH_HEAD"], destination);

    stage = "rename public remote";
    executeCommand("git", ["remote", "rename", "origin", "upstream"], destination);

    stage = "update ignore file";
    const ignoreFile = resolve(destination, ".gitignore");
    const ignore = readFileSync(ignoreFile, "utf8");
    const updatedIgnore = ignore.split(/\r?\n/).filter((line) => line !== "/workshop.yaml").join("\n");
    writeFileSync(ignoreFile, updatedIgnore, "utf8");

    stage = "run make setup";
    executeCommand("make", ["setup"], destination);
    console.log(`Created and set up ${destination}. The public repository is named upstream.`);
  } catch (error) {
    const lines = [`Copy stopped at stage: ${stage}.`, errorMessage(error)];
    if (createdDestination) lines.push(`Partial destination retained: ${destination}; no artifacts were removed.`);
    else if (stage === "clone destination") lines.push(`Any partial clone at ${destination} was left untouched.`);
    lines.push(`Recovery command: ${recoveryCommand(stage, source, destination, createdDestination)}`);
    throw new Error(lines.join("\n"), { cause: error });
  }
}

try {
  copy();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
