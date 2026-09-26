import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.js";

/**
 * The TUI boundary, enforced.
 *
 * `src/tui/` holds the files that exist only to serve the terminal viewer. Two
 * things follow, and both are cheap to break by accident and expensive to
 * notice:
 *
 *   1. the runtime must not depend on the viewer. Only lazily-loaded entry
 *      points may import it, so a terminal library never enters the runtime's
 *      import graph.
 *   2. the viewer must not reach around the CLI contract. It reads the
 *      projections, never SQLite, a run directory, or the filesystem.
 *
 * This test reads import statements rather than running anything: a rule about
 * what may import what belongs in the source, not in a runtime assertion.
 */
const TUI_DIR = "src/tui/";
const isTuiSpec = (spec: string): boolean => /(^|\/)tui\//.test(spec);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

const relative = (path: string): string => path.slice(REPO_ROOT.length + 1);

/** Import specifiers in one file, split by whether they survive compilation. */
function importsOf(source: string): { typeOnly: string[]; value: string[]; dynamic: string[] } {
  const collect = (pattern: RegExp, into: string[]): void => {
    for (const match of source.matchAll(pattern)) into.push(match[1]!);
  };
  const typeOnly: string[] = [];
  const value: string[] = [];
  const dynamic: string[] = [];
  collect(/^import\s+type\s[^;]*?from\s+"([^"]+)"/gm, typeOnly);
  // A value import is any static import that is not type-only.
  for (const match of source.matchAll(/^import\s+([^;]*?)from\s+"([^"]+)"/gm)) {
    if (match[1]!.startsWith("type ")) continue;
    value.push(match[2]!);
  }
  collect(/await import\("([^"]+)"\)/g, dynamic);
  collect(/^\s*import\("([^"]+)"\)/gm, dynamic);
  return { typeOnly, value, dynamic };
}

const allImports = (source: string): string[] => {
  const { typeOnly, value, dynamic } = importsOf(source);
  return [...typeOnly, ...value, ...dynamic];
};

describe("TUI boundary — the folder says what a file is for", () => {
  const all = sourceFiles(join(REPO_ROOT, "src"));
  const tui = all.filter((p) => relative(p).startsWith(TUI_DIR));
  const rest = all.filter((p) => !relative(p).startsWith(TUI_DIR));

  test("the TUI files are exactly the ones meant to be there", () => {
    // If this list changes, the boundary changed: say so deliberately.
    expect(tui.map(relative).sort()).toEqual(["src/tui/build-panes.ts", "src/tui/data-source.ts", "src/tui/mount-viewer.ts"]);
  });

  test("the runtime does not import the viewer, except its lazy entry point", () => {
    const importers = rest.filter((file) =>
      allImports(readFileSync(file, "utf8")).some(isTuiSpec),
    );
    // `watch` loads the viewer on demand; nothing else may reach for it at all.
    expect(importers.map(relative)).toEqual(["src/cli/watch.ts"]);

    const cli = readFileSync(join(REPO_ROOT, "src/cli/watch.ts"), "utf8");
    const { typeOnly, value, dynamic } = importsOf(cli);
    // Nothing the runtime executes may be a TUI module: only the lazily-loaded
    // entry point, plus type-only imports that vanish at compile time.
    expect(value.filter(isTuiSpec)).toEqual([]);
    expect(dynamic.filter(isTuiSpec)).toEqual(["../tui/mount-viewer.js"]);
    expect(typeOnly.filter(isTuiSpec)).toEqual(["../tui/data-source.js"]);
    // A static value import would pull OpenTUI into every invocation, including
    // `validate` and `status`.
    expect(cli).toContain('await import("../tui/mount-viewer.js")');
  });

  test("the viewer never reaches past the CLI contract, transitively", () => {
    // The spec's rule: the viewer consumes projections, so it must not touch the
    // store, the database, run evidence, or the filesystem.
    //
    // Checking only direct specifiers let a real violation hide: the panes
    // imported a formatting helper from the status tree renderer, which imports
    // the store, the recovery module, and `node:fs` — so loading the viewer
    // loaded SQLite. Type-only imports are erased and load nothing, so only value
    // imports are followed.
    const forbiddenSpec = /^node:(fs|child_process|sqlite)$/;
    const forbiddenPath = /\/src\/(storage|worklog|run|daemon|attempt|process)\//;

    /** Resolve a relative specifier to a source file, or null when external. */
    const resolve = (from: string, spec: string): string | null => {
      if (!spec.startsWith(".")) return null;
      const base = join(from, "..", spec.replace(/\.js$/, ".ts"));
      return existsSync(base) ? base : null;
    };

    const violations: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [...tui];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of importsOf(readFileSync(file, "utf8")).value) {
        const via = `${relative(file)} imports ${spec}`;
        const target = resolve(file, spec);
        if (forbiddenSpec.test(spec) || (target && forbiddenPath.test(target))) violations.push(via);
        if (target) queue.push(target);
      }
    }
    // A walk that resolved nothing would pass vacuously.
    expect(visited.size).toBeGreaterThan(1);
    expect(violations).toEqual([]);
  });

  test("the viewer's reachable graph is exactly the pure projections", () => {
    // A guard on the guard: if the walk silently stopped resolving anything,
    // the assertion above would pass vacuously.
    const reachable = relative(join(REPO_ROOT, "src/tui/build-panes.ts"));
    expect(reachable).toContain("build-panes.ts");
    // The panes load the formatter and nothing that reads: prove the formatter
    // itself has no imports, which is the property that makes the graph clean.
    const format = readFileSync(join(REPO_ROOT, "src/views/format-for-terminal.ts"), "utf8");
    expect(importsOf(format).value).toEqual([]);
    expect(importsOf(format).typeOnly).toEqual([]);
  });

  test("the viewer's data arrives through the source interface, not a store handle", () => {
    const panes = readFileSync(join(REPO_ROOT, "src/tui/build-panes.ts"), "utf8");
    // Panes are pure: types in, data out. A store parameter here would mean the
    // layout had learned to query.
    expect(panes).toContain("export interface ViewerPane");
    expect(panes).not.toContain("Store");
    expect(panes).not.toContain("readFileSync");
  });
});
