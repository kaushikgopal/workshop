/**
 * Behavior tests for "make cli" and the launch-workshop-cli.sh launcher.
 *
 * Every launcher run happens in a throwaway sandbox: the launcher copy sits in
 * a checkout with a space in its path, and a fake bun and a fake fish come
 * first on PATH, so no real install, network, or model call runs here. One
 * test replays the launcher's exact init command with the real fish binary
 * (--no-config as a test wrapper, piped stdin, no TTY); it is skipped with a
 * clear reason when fish is not installed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./helpers.js";

const launcherPath = join(REPO_ROOT, "launch-workshop-cli.sh");
const makefilePath = join(REPO_ROOT, "Makefile");

/** One process call recorded by a fake script. */
interface Call {
  cwd: string;
  env: Record<string, string>;
  args: string[];
}

function parseCallLog(path: string): Call[] {
  if (!existsSync(path)) return [];
  const calls: Call[] = [];
  let call: Call | null = null;
  let inArgs = false;
  const argLines: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "CALL") {
      call = { cwd: "", env: {}, args: [] };
      calls.push(call);
    } else if (line.startsWith("CWD ") && call) {
      call.cwd = line.slice(4);
    } else if (line.startsWith("ENV WORKSHOP_REPO ") && call) {
      call.env.WORKSHOP_REPO = line.slice("ENV WORKSHOP_REPO ".length);
    } else if (line === "ARGS-BEGIN") {
      inArgs = true;
      argLines.length = 0;
    } else if (line === "ARGS-END") {
      inArgs = false;
      if (call) call.args = [...argLines];
    } else if (inArgs && line.startsWith("ARG ")) {
      argLines.push(Buffer.from(line.slice(4), "base64").toString("utf8"));
    }
    // "EXIT" and stray lines are ignored.
  }
  return calls;
}

interface Sandbox {
  root: string;
  /** Checkout copy under a path with a space, where the launcher is run from. */
  repo: string;
  /** Caller cwd with a space, distinct from the checkout. */
  example: string;
  home: string;
  bunLog: string;
  fishLog: string;
  /** Fake bun + fake fish, first on PATH for launcher runs. */
  fakes: string;
  /** Fake bun alone, so the real-fish replay cannot pick up the fake fish. */
  fakeBunOnly: string;
}

const BUN_FAKE = [
  "#!/bin/bash",
  'exec >> "$FAKE_BUN_LOG" || exit 3',
  "printf 'CALL\n'",
  "printf 'CWD %s\n' \"$PWD\"",
  "printf 'ENV WORKSHOP_REPO %s\n' \"$WORKSHOP_REPO\"",
  "printf 'ARGS-BEGIN\n'",
  "for arg in \"$@\"; do printf 'ARG %s\n' \"$(printf '%s' \"$arg\" | base64 | tr -d '\n')\"; done",
  "printf 'ARGS-END\n'",
  "printf 'EXIT\n'",
  "exit $((FAKE_BUN_EXIT))",
].join("\n") + "\n";

const FISH_FAKE = [
  "#!/bin/bash",
  'exec >> "$FAKE_FISH_LOG" || exit 3',
  "printf 'CALL\n'",
  "printf 'CWD %s\n' \"$PWD\"",
  "printf 'ENV WORKSHOP_REPO %s\n' \"$WORKSHOP_REPO\"",
  "printf 'ARGS-BEGIN\n'",
  "for arg in \"$@\"; do printf 'ARG %s\n' \"$(printf '%s' \"$arg\" | base64 | tr -d '\n')\"; done",
  "printf 'ARGS-END\n'",
  "printf 'EXIT\n'",
  "exit $((FAKE_FISH_EXIT))",
].join("\n") + "\n";

function writeFake(dir: string, name: "bun" | "fish"): void {
  const path = join(dir, name);
  writeFileSync(path, name === "bun" ? BUN_FAKE : FISH_FAKE);
  chmodSync(path, 0o755);
}

function makeSandbox(options: { entry?: boolean; bun?: boolean; fish?: boolean } = {}): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workshop-cli-launcher-")));
  const repo = join(root, "checkout repo");
  mkdirSync(join(repo, "src/cli"), { recursive: true });
  if (options.entry !== false) writeFileSync(join(repo, "src/cli/main.ts"), "// fake entry point\n");
  copyFileSync(launcherPath, join(repo, "launch-workshop-cli.sh"));
  chmodSync(join(repo, "launch-workshop-cli.sh"), 0o755);
  copyFileSync(makefilePath, join(repo, "Makefile"));
  const example = join(root, "example cwd");
  mkdirSync(example);
  const home = join(root, "home");
  mkdirSync(home);
  const fakes = join(root, "fakes");
  mkdirSync(fakes);
  const fakeBunOnly = join(root, "fakes-bun-only");
  mkdirSync(fakeBunOnly);
  if (options.bun !== false) {
    writeFake(fakeBunOnly, "bun");
    writeFake(fakes, "bun");
  }
  if (options.fish !== false) writeFake(fakes, "fish");
  return {
    root,
    repo,
    example,
    home,
    bunLog: join(root, "bun.log"),
    fishLog: join(root, "fish.log"),
    fakes,
    fakeBunOnly,
  };
}

function sandboxEnv(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: sandbox.fakes + ":/usr/bin:/bin",
    HOME: sandbox.home,
    FAKE_BUN_LOG: sandbox.bunLog,
    FAKE_FISH_LOG: sandbox.fishLog,
    ...extra,
  };
}

function runLauncher(sandbox: Sandbox, cwd: string, extraEnv: Record<string, string> = {}) {
  // Run the checkout's own launcher copy: the launcher must resolve the
  // checkout from its own path, including paths with spaces.
  return spawnSync(join(sandbox.repo, "launch-workshop-cli.sh"), { cwd, env: sandboxEnv(sandbox, extraEnv), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
}

function runMake(sandbox: Sandbox, cwd: string, args: string[]) {
  return spawnSync("make", args, { cwd, env: sandboxEnv(sandbox), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
}

function withSandbox<T>(options: Parameters<typeof makeSandbox>[0], body: (sandbox: Sandbox) => Promise<T>): Promise<T>;
function withSandbox<T>(options: Parameters<typeof makeSandbox>[0], body: (sandbox: Sandbox) => T): T;
function withSandbox<T>(options: Parameters<typeof makeSandbox>[0], body: (sandbox: Sandbox) => T | Promise<T>): T | Promise<T> {
  const sandbox = makeSandbox(options);
  const cleanup = () => rmSync(sandbox.root, { recursive: true, force: true });
  try {
    const result = body(sandbox);
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe("launch-workshop-cli.sh (fake bun, fake fish)", () => {
  test("installs with --frozen-lockfile in the checkout once, then execs fish with the workshop function", () => {
    withSandbox({}, (sandbox) => {
      const result = runLauncher(sandbox, sandbox.example);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("bun install --frozen-lockfile");

      const bunCalls = parseCallLog(sandbox.bunLog);
      expect(bunCalls).toHaveLength(1);
      expect(bunCalls[0]).toMatchObject({ cwd: sandbox.repo, args: ["install", "--frozen-lockfile"] });
      expect(bunCalls[0]?.env.WORKSHOP_REPO).toBe("");

      const fishCalls = parseCallLog(sandbox.fishLog);
      expect(fishCalls).toHaveLength(1);
      const fishCall = fishCalls[0]!;
      // Exactly fish plus the init command: no --no-config, so the child
      // respects the user's normal fish configs.
      expect(fishCall.args).toHaveLength(2);
      expect(fishCall.args[0]).toBe("--init-command");
      const init = fishCall.args[1] ?? "";
      expect(init).toContain('set -g workshop_repo "$WORKSHOP_REPO"');
      expect(init).toContain("set -e WORKSHOP_REPO");
      expect(init).toContain("function workshop");
      expect(init).toContain('bun "$workshop_repo/src/cli/main.ts" $argv');
      expect(init).not.toContain("funcsave");
      expect(init).not.toContain("set -U");
      expect(init).not.toContain("--no-config");
      // Direct invocation: the fish child inherits the caller's cwd, while the
      // install subshell ran in the checkout.
      expect(fishCall.cwd).toBe(sandbox.example);
      expect(fishCall.env.WORKSHOP_REPO).toBe(sandbox.repo);
    });
  });

  test("install failure fails closed and never starts fish", () => {
    withSandbox({}, (sandbox) => {
      const result = runLauncher(sandbox, sandbox.example, { FAKE_BUN_EXIT: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("bun install --frozen-lockfile failed");
      expect(parseCallLog(sandbox.bunLog)).toHaveLength(1);
      expect(parseCallLog(sandbox.fishLog)).toHaveLength(0);
    });
  });

  test("missing bun fails with a clear error before fish starts", () => {
    withSandbox({ bun: false }, (sandbox) => {
      const result = runLauncher(sandbox, sandbox.example);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("bun is not on PATH");
      expect(parseCallLog(sandbox.fishLog)).toHaveLength(0);
    });
  });

  test("missing fish fails with a clear error and bun is not invoked", () => {
    withSandbox({ fish: false }, (sandbox) => {
      const result = runLauncher(sandbox, sandbox.example);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("fish is not on PATH");
      expect(parseCallLog(sandbox.bunLog)).toHaveLength(0);
    });
  });

  test("checkout without src/cli/main.ts fails with a clear error", () => {
    withSandbox({ entry: false }, (sandbox) => {
      const result = runLauncher(sandbox, sandbox.example);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("src/cli/main.ts");
      expect(parseCallLog(sandbox.bunLog)).toHaveLength(0);
      expect(parseCallLog(sandbox.fishLog)).toHaveLength(0);
    });
  });

  test("launcher and fakes leave the caller's HOME untouched", () => {
    withSandbox({}, (sandbox) => {
      const result = runLauncher(sandbox, sandbox.example);
      expect(result.status).toBe(0);
      expect(readdirSync(sandbox.home)).toEqual([]);
    });
  });

  test("make cli runs the launcher, so the fish child starts in the repo", () => {
    withSandbox({}, (sandbox) => {
      const result = runMake(sandbox, sandbox.repo, ["cli"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("workshop shell ready");
      expect(parseCallLog(sandbox.bunLog)).toEqual([
        { cwd: sandbox.repo, env: { WORKSHOP_REPO: "" }, args: ["install", "--frozen-lockfile"] },
      ]);
      const fishCalls = parseCallLog(sandbox.fishLog);
      expect(fishCalls).toHaveLength(1);
      expect(fishCalls[0]?.cwd).toBe(sandbox.repo);
      expect(fishCalls[0]?.env.WORKSHOP_REPO).toBe(sandbox.repo);
    });
  });

  test("make -C starts the fish child in the repo, not the caller's cwd (by design)", () => {
    withSandbox({}, (sandbox) => {
      // make -C chdirs into the repo before the recipe runs, so the child
      // starts there. Only direct script invocation promises the caller's cwd.
      const result = runMake(sandbox, sandbox.example, ["-C", sandbox.repo, "cli"]);
      expect(result.status).toBe(0);
      const fishCalls = parseCallLog(sandbox.fishLog);
      expect(fishCalls).toHaveLength(1);
      expect(fishCalls[0]?.cwd).toBe(sandbox.repo);
    });
  });

  test("Makefile hands cli to the launcher, which execs fish", () => {
    expect(readFileSync(makefilePath, "utf8")).toMatch(/^cli:/m);
    expect(readFileSync(makefilePath, "utf8")).toContain("launch-workshop-cli.sh");
    expect(readFileSync(launcherPath, "utf8")).toMatch(/exec fish --init-command/);
  });
});

const fishPath = Bun.which("fish");
describe(fishPath ? "workshop function under real fish" : "workshop function under real fish (SKIPPED: fish is not installed on PATH)", () => {
  test.skipIf(!fishPath)(
    "passes zero args, quoted args, and fish list args to bun without leaking env",
    async () => {
      await withSandbox({}, async (sandbox) => {
        // Capture the exact init command the launcher hands to fish.
        const captured = runLauncher(sandbox, sandbox.example);
        expect(captured.status).toBe(0);
        const init = parseCallLog(sandbox.fishLog)[0]?.args[1] ?? "";
        expect(init).toContain("function workshop");

        // Replay with the real fish binary: --no-config is this test's wrapper
        // (the launcher itself respects user configs), stdin is a pipe, so no
        // TTY, profile, or repo auth is involved.
        rmSync(sandbox.bunLog, { force: true });
        const proc = Bun.spawn({
          cmd: [fishPath!, "--no-config", "--init-command", init],
          cwd: sandbox.example,
          env: {
            PATH: sandbox.fakeBunOnly + ":/usr/bin:/bin",
            HOME: sandbox.home,
            FAKE_BUN_LOG: sandbox.bunLog,
            WORKSHOP_REPO: sandbox.repo,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        proc.stdin.write([
          "workshop",
          'workshop "a b" "c d" e',
          'set v "x y"',
          "workshop $v",
          "exit",
        ].join("\n") + "\n");
        proc.stdin.end();
        const timer = setTimeout(() => proc.kill(), 20_000);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        const fishStderr = await new Response(proc.stderr).text();
        if (exitCode !== 0) {
          throw new Error("fish exited " + exitCode + " stderr: " + JSON.stringify(fishStderr) + " fishPath: " + String(fishPath) + " init: " + JSON.stringify(init));
        }
        expect(exitCode).toBe(0);

        const calls = parseCallLog(sandbox.bunLog);
        const script = join(sandbox.repo, "src/cli/main.ts");
        expect(calls).toHaveLength(3);
        expect(calls[0]?.args).toEqual([script]);
        expect(calls[1]?.args).toEqual([script, "a b", "c d", "e"]);
        expect(calls[2]?.args).toEqual([script, "x y"]);
        for (const call of calls) {
          expect(call.cwd).toBe(sandbox.example);
          // The temporary env var is erased by the init command, so nothing
          // leaks to processes started inside the shell.
          expect(call.env.WORKSHOP_REPO).toBe("");
        }
      });
    },
    30_000,
  );
});
