import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const unresolvedDynamicImport = "<unresolved dynamic import>";

// These tokens can begin an expression where `/` starts a regular expression.
const regularExpressionPrefixTokens = new Set<SyntaxKind>([
  SyntaxKind.OpenParenToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.CommaToken,
  SyntaxKind.ColonToken,
  SyntaxKind.SemicolonToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.ExclamationToken,
  SyntaxKind.TildeToken,
  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.OfKeyword,
  SyntaxKind.YieldKeyword,
  SyntaxKind.AwaitKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.DoKeyword,
]);

function importSpecifiers(source: string): string[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: Array<{ kind: SyntaxKind; value: string }> = [];
  // Track template nesting so the scanner can resume text after each interpolation.
  const templateBraceDepths: number[] = [];
  let previousToken: SyntaxKind | undefined;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (templateBraceDepths.length > 0 && kind === SyntaxKind.CloseBraceToken) {
      const expression = templateBraceDepths.length - 1;
      const depth = templateBraceDepths[expression];
      if (depth === undefined) throw new Error("Template brace tracking lost its expression");
      if (depth === 0) kind = scanner.reScanTemplateToken(false);
      else templateBraceDepths[expression] = depth - 1;
    } else if (templateBraceDepths.length > 0 && kind === SyntaxKind.OpenBraceToken) {
      const expression = templateBraceDepths.length - 1;
      templateBraceDepths[expression] = (templateBraceDepths[expression] ?? 0) + 1;
    }

    if (kind === SyntaxKind.TemplateHead) templateBraceDepths.push(0);
    else if (kind === SyntaxKind.TemplateTail) templateBraceDepths.pop();
    if (kind === SyntaxKind.SlashToken && (!previousToken || regularExpressionPrefixTokens.has(previousToken))) {
      kind = scanner.reScanSlashToken();
    }
    if (scanner.getTokenStart() === scanner.getTokenEnd()) {
      throw new Error(`Unable to scan token at ${scanner.getTokenStart()}`);
    }
    tokens.push({ kind, value: scanner.getTokenValue() });
    previousToken = kind;
  }

  const specifiers = new Set<string>();
  const valueOf = (token: (typeof tokens)[number] | undefined): string | undefined =>
    token?.kind === SyntaxKind.StringLiteral || token?.kind === SyntaxKind.NoSubstitutionTemplateLiteral
      ? token.value
      : undefined;
  const addFromClause = (start: number): void => {
    for (let index = start + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (
        !token ||
        token.kind === SyntaxKind.SemicolonToken ||
        token.kind === SyntaxKind.ImportKeyword ||
        token.kind === SyntaxKind.ExportKeyword
      ) break;
      if (token.kind !== SyntaxKind.FromKeyword) continue;
      const specifier = valueOf(tokens[index + 1]);
      if (specifier !== undefined) specifiers.add(specifier);
      break;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const next = tokens[index + 1];
    if (token.kind === SyntaxKind.ImportKeyword) {
      if (next?.kind === SyntaxKind.OpenParenToken) {
        const argument = tokens[index + 2];
        const specifier = valueOf(argument);
        const callEnd = tokens[index + 3]?.kind;
        if (
          specifier !== undefined &&
          (callEnd === SyntaxKind.CloseParenToken || callEnd === SyntaxKind.CommaToken)
        ) {
          specifiers.add(specifier);
        } else {
          specifiers.add(unresolvedDynamicImport);
        }
      } else {
        const specifier = valueOf(next);
        if (specifier !== undefined) specifiers.add(specifier);
        else addFromClause(index);
      }
    } else if (token.kind === SyntaxKind.ExportKeyword) {
      const bindings = next?.kind === SyntaxKind.TypeKeyword ? tokens[index + 2] : next;
      if (bindings?.kind === SyntaxKind.AsteriskToken || bindings?.kind === SyntaxKind.OpenBraceToken) addFromClause(index);
    } else if (
      (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.RequireKeyword) &&
      token.value === "require" &&
      next?.kind === SyntaxKind.OpenParenToken
    ) {
      const specifier = valueOf(tokens[index + 2]);
      if (specifier !== undefined && tokens[index + 3]?.kind === SyntaxKind.CloseParenToken) {
        specifiers.add(specifier);
      } else {
        specifiers.add(unresolvedDynamicImport);
      }
    }
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

const sourceDirectories = ["agent", "config", "examples", "run", "schedule", "scripts", "service", "workflow"];

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
        if (specifier === unresolvedDynamicImport) {
          violations.push([...current.chain, unresolvedDynamicImport].join(" -> "));
          continue;
        }
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

test("reports transitive module references into the service API", () => {
  const root = createSourceTree();
  try {
    writeFileSync(resolve(root, "workflow/entry.ts"), 'import "../run/entry.ts";\n');
    writeFileSync(resolve(root, "run/entry.ts"), 'export * from "../run/required.ts";\n');
    writeFileSync(resolve(root, "run/required.ts"), 'require("../service/types.ts");\n');
    assert.deepEqual(serviceDependencyChains(root), [
      "workflow/entry.ts -> run/entry.ts -> run/required.ts -> service/types.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import-shaped comments and strings do not create dependency edges", () => {
  const root = createSourceTree();
  try {
    writeFileSync(resolve(root, "workflow/comments.ts"), [
      '// import "../service/types.ts";',
      'const note = \'from "../service/types.ts"\';',
      "export {};",
    ].join("\n"));
    assert.deepEqual(serviceDependencyChains(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic imports can use static template literals", () => {
  const root = createSourceTree();
  try {
    writeFileSync(resolve(root, "workflow/template.ts"), "void import(`../service/types.ts`);\n");
    assert.deepEqual(serviceDependencyChains(root), ["workflow/template.ts -> service/types.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unresolved dynamic imports remain visible as boundary risks", () => {
  const root = createSourceTree();
  try {
    writeFileSync(resolve(root, "workflow/template.ts"), 'void import(`../service/${name}.ts`);\n');
    assert.deepEqual(serviceDependencyChains(root), [
      "workflow/template.ts -> <unresolved dynamic import>",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
