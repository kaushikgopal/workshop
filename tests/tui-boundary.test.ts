import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.js";

/**
 * The TUI boundary, enforced.
 *
 * `src/tui-*.ts` is the naming convention for files that exist only to serve
 * the terminal viewer. Two things follow, and both are cheap to break by
 * accident and expensive to notice:
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

const TUI_PREFIX = "tui-";

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

describe("TUI boundary — naming says what a file is for", () => {
  const all = sourceFiles(join(REPO_ROOT, "src"));
  const tui = all.filter((p) => relative(p).includes(TUI_PREFIX));
  const rest = all.filter((p) => !relative(p).includes(TUI_PREFIX));

  test("the TUI files are exactly the ones meant to be there", () => {
    // If this list changes, the boundary changed: say so deliberately.
    expect(tui.map(relative).sort()).toEqual(["src/tui-app.ts", "src/tui-panes.ts", "src/tui-source.ts"]);
  });

  test("the runtime does not import the viewer, except its lazy entry point", () => {
    const importers = rest.filter((file) =>
      allImports(readFileSync(file, "utf8")).some((spec) => spec.includes(`${TUI_PREFIX}`)),
    );
    // `watch` loads the viewer on demand; nothing else may reach for it at all.
    expect(importers.map(relative)).toEqual(["src/cli.ts"]);

    const cli = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
    const { typeOnly, value, dynamic } = importsOf(cli);
    // Nothing the runtime executes may be a TUI module: only the lazily-loaded
    // entry point, plus type-only imports that vanish at compile time.
    expect(value.filter((spec) => spec.includes(TUI_PREFIX))).toEqual([]);
    expect(dynamic.filter((spec) => spec.includes(TUI_PREFIX))).toEqual(["./tui-app.js"]);
    expect(typeOnly.filter((spec) => spec.includes(TUI_PREFIX))).toEqual(["./tui-source.js"]);
    // A static value import would pull OpenTUI into every invocation, including
    // `validate` and `status`.
    expect(cli).toContain('await import("./tui-app.js")');
  });

  test("the viewer never reaches past the CLI contract", () => {
    // The spec's rule, made checkable: the viewer consumes projections, so it
    // must not touch the store, the database, run evidence, or the filesystem.
    const forbidden = [/node:fs/, /\/store\//, /store\.js/, /db\.js/, /worklog\//, /execute\.js/, /recovery\.js/, /daemon\.js/];
    for (const file of tui) {
      for (const spec of allImports(readFileSync(file, "utf8"))) {
        for (const pattern of forbidden) {
          expect(`${relative(file)} imports ${spec}`).not.toMatch(
            new RegExp(`imports .*${pattern.source.replace(/\\\//g, "/")}`),
          );
        }
      }
    }
  });

  test("the viewer's data arrives through the source interface, not a store handle", () => {
    const panes = readFileSync(join(REPO_ROOT, "src/tui-panes.ts"), "utf8");
    // Panes are pure: types in, data out. A store parameter here would mean the
    // layout had learned to query.
    expect(panes).toContain("export interface ViewerPane");
    expect(panes).not.toContain("Store");
    expect(panes).not.toContain("readFileSync");
  });
});
