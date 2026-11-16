import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const copyScript = join(root, "scripts", "copy-workshop.ts");
const installScript = join(root, "scripts", "install-launch-agent.ts");

function createDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function createCommandShims(directory: string): { bin: string; gitLog: string; makeLog: string } {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const gitLog = join(directory, "git.log");
  const makeLog = join(directory, "make.log");
  writeExecutable(join(bin, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  remote)
    if [ "\${2-}" = "get-url" ]; then printf '%s\\n' "$FAKE_ORIGIN"; fi
    ;;
  clone)
    mkdir -p "$3/.git" || exit 1
    printf '/workshop.yaml\\n' > "$3/.gitignore"
    printf 'copied\\n' > "$3/copied"
    ;;
  branch)
    printf '%s\\n' "\${FAKE_BRANCH-}"
    ;;
  fetch)
    if [ "\${FAIL_GIT_STEP-}" = "fetch" ]; then echo 'fake fetch failure' >&2; exit 23; fi
    ;;
  checkout)
    printf '%s\\n' "$3" > "$PWD/copied-branch"
    ;;
esac
`);
  writeExecutable(join(bin, "make"), `#!/bin/sh
printf '%s\\n' "$*" >> "$MAKE_LOG"
if [ "\${FAIL_MAKE_STEP-}" = "$1" ]; then echo 'fake make failure' >&2; exit 24; fi
`);
  return { bin, gitLog, makeLog };
}

function runCopy(source: string, destination: string, options: {
  bin: string;
  gitLog: string;
  makeLog: string;
  failGitStep?: string;
  failMakeStep?: string;
}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [copyScript, destination], {
    cwd: source,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [options.bin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      GIT_LOG: options.gitLog,
      MAKE_LOG: options.makeLog,
      FAIL_GIT_STEP: options.failGitStep ?? "",
      FAIL_MAKE_STEP: options.failMakeStep ?? "",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test("copy uses HEAD when the source checkout is detached", () => {
  const fixture = createDirectory("workshop-copy-detached-test-");
  const source = join(fixture, "source");
  const destination = join(fixture, "private-copy");
  mkdirSync(source);
  const shims = createCommandShims(fixture);
  try {
    const result = runCopy(source, destination, shims);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const gitCalls = readFileSync(shims.gitLog, "utf8");
    assert.ok(gitCalls.includes(`fetch --no-tags ${realpathSync(source)} HEAD\n`), gitCalls);
    assert.ok(gitCalls.includes("checkout -B workshop-copy FETCH_HEAD\n"), gitCalls);
    assert.equal(readFileSync(join(destination, "copied-branch"), "utf8"), "workshop-copy\n");
    assert.equal(readFileSync(join(destination, ".gitignore"), "utf8"), "");
    assert.equal(readFileSync(shims.makeLog, "utf8"), "setup\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("copy reports its failed stage and a recovery command without removing its partial destination", () => {
  const fixture = createDirectory("workshop-copy-failure-test-");
  const source = join(fixture, "source");
  const destination = join(fixture, "private-copy");
  const partial = `${destination}.partial`;
  mkdirSync(source);
  const shims = createCommandShims(fixture);
  try {
    const result = runCopy(source, destination, { ...shims, failGitStep: "fetch" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Copy stopped at stage: fetch source revision/);
    assert.ok(result.stderr.includes(`Partial destination retained: ${destination};`), result.stderr);
    assert.ok(result.stderr.includes(`Recovery command: mv ${quoteShellArgument(destination)} ${quoteShellArgument(partial)} && cd ${quoteShellArgument(realpathSync(source))} && make copy to=${quoteShellArgument(destination)}`), result.stderr);
    assert.equal(readFileSync(join(destination, "copied"), "utf8"), "copied\n");
    assert.equal(existsSync(partial), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("copy setup failure reports how to finish setup and keeps the copy", () => {
  const fixture = createDirectory("workshop-copy-setup-failure-test-");
  const source = join(fixture, "source");
  const destination = join(fixture, "private-copy");
  mkdirSync(source);
  const shims = createCommandShims(fixture);
  try {
    const result = runCopy(source, destination, { ...shims, failMakeStep: "setup" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Copy stopped at stage: run make setup/);
    assert.ok(result.stderr.includes(`Recovery command: cd ${quoteShellArgument(destination)} && make setup`), result.stderr);
    assert.ok(result.stderr.includes(`Partial destination retained: ${destination}; no artifacts were removed.`), result.stderr);
    assert.equal(readFileSync(join(destination, "copied"), "utf8"), "copied\n");
    assert.equal(existsSync(`${destination}.partial`), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("launch-agent bootstrap failure reports the exact recovery command and keeps the plist", () => {
  const fixture = createDirectory("workshop-launch-agent-failure-test-");
  const repository = join(fixture, "project");
  const home = join(fixture, "home");
  const shim = join(fixture, "fake-launchctl.mjs");
  const launchctlLog = join(fixture, "launchctl.log");
  const label = "com.example.workshop-test";
  const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(join(repository, "service"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repository, "workshop.yaml"), "agent_profiles: {}\norchestrator: {}\n");
  writeFileSync(join(repository, "service", "launch-service.plist.template"), "<plist>{{LABEL}} {{NODE_PATH}} {{REPO_PATH}} {{PATH}} {{LOG_PATH}}</plist>\n");
  writeFileSync(shim, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
Object.defineProperty(process, "platform", { value: "darwin" });
childProcess.spawnSync = (command, args) => {
  appendFileSync(process.env.LAUNCHCTL_LOG, JSON.stringify({ command, args }) + "\\n");
  return { status: args[0] === "print" ? 113 : 42, stdout: "", stderr: args[0] === "bootstrap" ? "fake bootstrap failure" : "not loaded" };
};
syncBuiltinESMExports();
`);
  try {
    const result = spawnSync(process.execPath, ["--import", shim, installScript, label, repository], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, HOME: home, LAUNCHCTL_LOG: launchctlLog },
    });
    const uid = process.getuid?.();
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Install stopped at stage: bootstrap LaunchAgent/);
    assert.ok(result.stderr.includes(`Recovery command: /bin/launchctl bootstrap gui/${uid} ${quoteShellArgument(plistPath)}`), result.stderr);
    assert.match(result.stderr, /No files were removed|plist was kept/i);
    assert.equal(existsSync(plistPath), true);
    const calls = readFileSync(launchctlLog, "utf8");
    assert.ok(calls.includes('{"command":"/bin/launchctl","args":["print"'), calls);
    assert.ok(calls.includes('{"command":"/bin/launchctl","args":["bootstrap"'), calls);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
