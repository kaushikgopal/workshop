import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
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

function serviceDependencyChains(): string[] {
  const directories = ["config", "examples", "run", "schedule", "scripts", "service", "workflow"];
  const files = directories.flatMap((directory) => sourceFiles(resolve(projectRoot, directory)));
  const knownFiles = new Set(files);
  const workflowFiles = files.filter((file) => relative(projectRoot, file).startsWith(`workflow${sep}`));
  const serviceFiles = new Set(files.filter((file) => relative(projectRoot, file).startsWith(`service${sep}`)));
  const violations: string[] = [];

  for (const start of workflowFiles) {
    const pending: Array<{ file: string; chain: string[] }> = [{ file: start, chain: [relative(projectRoot, start)] }];
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
          chain: [...current.chain, relative(projectRoot, dependency)],
        });
      }
    }
  }
  return violations;
}

test("workflow modules do not depend on the service API", () => {
  assert.deepEqual(serviceDependencyChains(), []);
});
