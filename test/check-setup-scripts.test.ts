import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function executeMake(args: string[], options: { directoryName?: string; config?: boolean; commandStatus?: number } = {}) {
  const fixture = createDirectory("workshop-make-arguments-test-");
  const project = join(fixture, options.directoryName ?? "project");
  const bin = join(fixture, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  copyFileSync(join(root, "Makefile"), join(project, "Makefile"));
  if (options.config !== false) writeFileSync(join(project, "workshop.yaml"), "");
  const recorder = 'console.log(JSON.stringify(process.argv.slice(1))); process.exit(Number(process.env.MAKE_RECIPE_STATUS ?? 0));';
  for (const command of ["node", "npm"]) {
    writeExecutable(join(bin, command), `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(recorder)} ${command} "$@"\n`);
  }
  try {
    const result = spawnSync("make", ["--no-print-directory", ...args], {
      cwd: project,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: [bin, process.env.PATH ?? ""].join(delimiter),
        MAKEFLAGS: "",
        MFLAGS: "",
        MAKEOVERRIDES: "",
        WORKSHOP_MAKE_PROBE: "expanded-dollar",
        MAKE_RECIPE_STATUS: String(options.commandStatus ?? 0),
      },
    });
    assert.equal(result.error, undefined);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      project: realpathSync(project),
      calls: result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const makeChecks = [
  ["node", "scripts/check-config.ts"],
  ["node", "scripts/check-workflows.ts"],
  ["npm", "run", "typecheck"],
  ["npm", "test"],
];

test("make recipes preserve ordinary arguments and control flow", () => {
  const cases = [
    { args: ["chat"], calls: [["node", "scripts/chat-workshop.ts"]] },
    { args: ["chat", "print="], calls: [["node", "scripts/chat-workshop.ts"]] },
    { args: ["chat", "print= \t "], calls: [["node", "scripts/chat-workshop.ts"]] },
    { args: ["chat", "print=  What is running?  "], calls: [["node", "scripts/chat-workshop.ts", "--print", "What is running?  "]] },
    { args: ["chat", "print=Using $(LABEL)", "LABEL=custom.label"], calls: [["node", "scripts/chat-workshop.ts", "--print", "Using custom.label"]] },
    { args: ["copy"], calls: [["node", "scripts/copy-workshop.ts", ""]] },
    { args: ["copy", "to="], calls: [["node", "scripts/copy-workshop.ts", ""]] },
    { args: ["copy", "to=private copy"], calls: [["node", "scripts/copy-workshop.ts", "private copy"]] },
    { args: ["service-uninstall"], calls: [["node", "scripts/uninstall-launch-agent.ts", "dev.workshop.service"]] },
    { args: ["service-uninstall", "LABEL=custom.label"], calls: [["node", "scripts/uninstall-launch-agent.ts", "custom.label"]] },
  ];
  for (const { args, calls } of cases) {
    const result = executeMake(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.calls, calls, JSON.stringify(args));
  }
  for (const label of [undefined, "", "custom.label"]) {
    const result = executeMake(["service-install", ...(label !== undefined ? [`LABEL=${label}`] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.calls, [...makeChecks, ["node", "scripts/install-launch-agent.ts", label ?? "dev.workshop.service", result.project]]);
  }
  const missing = executeMake(["service-install"], { config: false });
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /^workshop.yaml is required; run make setup and edit the config first\.\n/);
  const failedCheck = executeMake(["service-install"], { commandStatus: 7 });
  assert.equal(failedCheck.status, 2);
  assert.deepEqual(failedCheck.calls, [["node", "scripts/check-config.ts"]]);
  const failedChat = executeMake(["chat", "print=Hello"], { commandStatus: 7 });
  assert.equal(failedChat.status, 2);
  assert.deepEqual(failedChat.calls, [["node", "scripts/chat-workshop.ts", "--print", "Hello"]]);
});

test("make recipes pass shell characters literally in operator arguments", () => {
  const input = '  Explain "two words", \'single\'; \\path $$WORKSHOP_MAKE_PROBE $${WORKSHOP_MAKE_PROBE} $$(printf dollar-probe) `printf boundary-probe`  ';
  const literal = 'Explain "two words", \'single\'; \\path $WORKSHOP_MAKE_PROBE ${WORKSHOP_MAKE_PROBE} $(printf dollar-probe) `printf boundary-probe`  ';
  const cases = [
    { target: "chat", variable: "print", script: "scripts/chat-workshop.ts", before: ["--print"] },
    { target: "copy", variable: "to", script: "scripts/copy-workshop.ts", before: [] },
    { target: "service-uninstall", variable: "LABEL", script: "scripts/uninstall-launch-agent.ts", before: [] },
    { target: "service-install", variable: "LABEL", script: "scripts/install-launch-agent.ts", before: [] },
  ];
  for (const { target, variable, script, before } of cases) {
    const result = executeMake([target, `${variable}=${input}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.calls, [
      ...(target === "service-install" ? makeChecks : []),
      ["node", script, ...before, literal, ...(target === "service-install" ? [result.project] : [])],
    ], target);
  }
  const multiline = executeMake(["chat", "print=first\nsecond"]);
  assert.equal(multiline.status, 0, multiline.stderr);
  assert.equal(multiline.stderr, "");
  assert.deepEqual(multiline.calls, [["node", "scripts/chat-workshop.ts", "--print", "first\nsecond"]]);
  const directory = executeMake(["service-install"], { directoryName: "project`printf path-probe`" });
  assert.equal(directory.status, 0, directory.stderr);
  assert.equal(directory.stderr, "");
  assert.deepEqual(directory.calls, [...makeChecks, ["node", "scripts/install-launch-agent.ts", "dev.workshop.service", directory.project]]);
});
