import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    if (match[1] !== undefined) specifiers.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*(?:\(\s*)?["']([^"']+)["']/g)) {
    if (match[1] !== undefined) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveSourceImport(from: string, specifier: string, knownFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(from), specifier);
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target,
    resolve(target, "index.ts"),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

const sourceDirectories = ["config", "examples", "run", "schedule", "scripts", "service", "workflow"];

function createSourceTree(): string {
  const root = mkdtempSync(join(tmpdir(), "workshop-architecture-test-"));
  for (const directory of sourceDirectories) mkdirSync(resolve(root, directory), { recursive: true });
  writeFileSync(resolve(root, "service/types.ts"), "export type Service = string;\n");
  return root;
}

function serviceDependencyChains(root = projectRoot): string[] {
  const files = sourceDirectories.flatMap((directory) => sourceFiles(resolve(root, directory)));
  const knownFiles = new Set(files);
  const workflowFiles = files.filter((file) => relative(root, file).startsWith(`workflow${sep}`));
  const serviceFiles = new Set(files.filter((file) => relative(root, file).startsWith(`service${sep}`)));
  const violations: string[] = [];

  for (const start of workflowFiles) {
    const pending: Array<{ file: string; chain: string[] }> = [{ file: start, chain: [relative(root, start)] }];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || visited.has(current.file)) continue;
      visited.add(current.file);
      if (serviceFiles.has(current.file)) {
        violations.push(current.chain.join(" -> "));
        continue;
      }
      const source = readFileSync(current.file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const dependency = resolveSourceImport(current.file, specifier, knownFiles);
        if (dependency) pending.push({
          file: dependency,
          chain: [...current.chain, relative(root, dependency)],
        });
      }
    }
  }
  return violations;
}

test("workflow modules do not depend on the service API", () => {
  assert.deepEqual(serviceDependencyChains(), []);
});

test("reports a transitive workflow dependency on the service API", () => {
  const root = createSourceTree();
  try {
    writeFileSync(resolve(root, "workflow/entry.ts"), 'import "../run/entry.ts";\n');
    writeFileSync(resolve(root, "run/entry.ts"), 'export * from "../service/types.ts";\n');
    assert.deepEqual(serviceDependencyChains(root), [
      "workflow/entry.ts -> run/entry.ts -> service/types.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
