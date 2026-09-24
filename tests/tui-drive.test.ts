import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.js";

/**
 * The viewer, driven for real.
 *
 * Every defect reported from actually using `watch` lived in the wiring rather
 * than in a pane: the feed was bound to a workflow before one was chosen, and
 * `q` destroyed the renderer while the poll timer kept the process alive. Both
 * pass every unit test, because the panes were right and the process was wrong.
 *
 * So this drives the real command with keys on stdin and reads the frames back.
 * It waits for each frame instead of sleeping, and strips escape sequences so
 * the assertions read the text a person would see.
 */

const stripAnsi = (raw: string): string =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[>=][0-9;]*[a-zA-Z]?/g, "");

interface Driven {
  output: string;
  /** Resolve once the accumulated, escape-stripped output matches. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  send(keys: string): void;
  exited: Promise<number | null>;
  kill(): void;
}

function drive(...args: string[]): Driven {
  const child = spawn("bun", [join(REPO_ROOT, "src/cli.ts"), "watch", ...args], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const state = { output: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    state.output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

  return {
    get output() {
      return state.output;
    },
    async waitFor(pattern, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const clean = stripAnsi(state.output);
        if (pattern.test(clean)) return clean;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${pattern}\n--- last frame ---\n${clean.slice(-1200)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    send: (keys) => child.stdin.write(keys),
    exited,
    kill: () => child.kill("SIGKILL"),
  };
}

describe("watch, driven for real", () => {
  test("picking a workflow shows that workflow, not an empty view", async () => {
    const app = drive();
    try {
      await app.waitFor(/pick a workflow/);
      // A real workflow exists in this repo's installation, so the picker has
      // something to offer; Enter takes the highlighted one.
      app.send("\r");

      // Evidence that a chain rendered: node rows exist and the empty-state
      // text does not. Asserting on a contiguous title would be flaky, because
      // stripping escapes concatenates writes in order, not on screen.
      const frame = await app.waitFor(/node-[a-z][a-z-]+/);
      expect(frame).not.toContain("(no runs yet)");
      expect(frame).not.toContain("(no unresolved run)");

      // And quitting takes the process with it: the poll timer is cleared, so
      // no second interrupt is needed.
      app.send("q");
      expect(await app.exited).toBe(0);
    } finally {
      app.kill();
    }
  }, 30_000);

  test("an explicit workflow skips the picker and quits on q", async () => {
    const app = drive("hemingway-clock");
    try {
      const frame = await app.waitFor(/node-[a-z][a-z-]+/);
      expect(frame).not.toContain("pick a workflow");
      expect(frame).toContain("hemingway-clock");
      app.send("q");
      expect(await app.exited).toBe(0);
    } finally {
      app.kill();
    }
  }, 30_000);
});
