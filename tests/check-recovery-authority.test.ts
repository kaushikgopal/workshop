import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseServiceRequestLine } from "../src/service/parse-service-protocol.js";
import { serviceRequestV1Schema } from "../src/service/schema.js";
import { REPO_ROOT } from "./helpers.js";

describe("recovery authority boundaries", () => {
  test("bot modules do not import recovery modules, directly or transitively", () => {
    const botFiles = sourceFiles(join(REPO_ROOT, "src/bot"));
    const reachable = importClosure(botFiles);
    const recoveryModules = reachable.filter((path) => /(?:recover|recovery|verify-process-death)/i.test(path));

    expect(recoveryModules).toEqual([]);
  });

  test("the normal service protocol has no recovery mutation method", () => {
    const methods = serviceRequestV1Schema.options.map((option) => option.shape.method.value);
    const recoveryMethods = methods.filter((method) => /recover/i.test(method));

    // A read-only receipt lookup may use the protocol. Recovery controls must stay outside it.
    expect(recoveryMethods.filter((method) => String(method) !== "recovery.receipt")).toEqual([]);

    const mutationMethods = ["recovery.apply", "recovery.continue", "recovery.abort", "recovery.retry"];
    for (const method of mutationMethods) {
      expect(serviceRequestV1Schema.safeParse({
        version: 1,
        method,
        requestId: "recovery-authority-test",
        request: { diagnosticDigest: `sha256:${"a".repeat(64)}`, actions: ["abort"] },
      }).success).toBe(false);
      expect(parseServiceRequestLine(JSON.stringify({ version: 1, method, requestId: "recovery-authority-test" })))
        .toMatchObject({ ok: false, failure: { error: { code: "unknown_method" } } });
    }

    expect(serviceRequestV1Schema.safeParse({
      version: 1,
      method: "status",
      recovery: { action: "resume", taskId: 17 },
    }).success).toBe(false);
  });

  test("piped input is refused even when JSON is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "workshop-recovery-authority-"));
    try {
      mkdirSync(join(root, ".workshop"));
      for (const json of [false, true]) {
        const child = Bun.spawn([process.execPath, join(REPO_ROOT, "src/cli/main.ts"), "service", "recover", "apply",
          "--request-id", "11111111-1111-4111-8111-111111111111",
          "--diagnostic", `sha256:${"a".repeat(64)}`,
          "--resume-installation", "--reason", "reviewed", ...(json ? ["--json"] : []),
        ], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        child.stdin.end();
        const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(status).toBe(64);
        expect(error).toContain("terminal stdin and stderr");
        expect(existsSync(join(root, ".workshop", ".state"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function importClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...relativeImports(file));
  }
  return [...seen].map((file) => relative(REPO_ROOT, file)).sort();
}

function relativeImports(file: string): string[] {
  const source = withoutComments(readFileSync(file, "utf8"));
  const targets: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = resolve(dirname(file), match[1]!).replace(/\.js$/, ".ts");
    if (!existsSync(target)) throw new Error(`${relative(REPO_ROOT, file)} imports unresolved ${match[1]}`);
    targets.push(target);
  }
  return targets;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}
