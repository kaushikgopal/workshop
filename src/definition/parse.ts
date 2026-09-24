import { parseDocument, visit, isAlias, Lexer, type Document } from "yaml";

/** Definition files that fail strict parsing carry this error type. */
export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionError";
  }
}

/**
 * Strict YAML load: fails closed on parse errors, duplicate keys, aliases,
 * merge keys, and anchor definitions. A definition that parses loosely is a
 * definition that drifts silently.
 */
export function parseStrictYaml(src: string, label: string): unknown {
  let doc: Document;
  try {
    doc = parseDocument(src, { merge: false, uniqueKeys: true, strict: true });
  } catch (e) {
    throw new DefinitionError(`${label}: YAML parse failed: ${(e as Error).message}`);
  }
  if (doc.errors.length > 0) {
    const detail = doc.errors.map((e) => `  - ${e.message}`).join("\n");
    throw new DefinitionError(`${label}: invalid YAML:\n${detail}`);
  }
  if (doc.warnings.length > 0) {
    const detail = doc.warnings.map((e) => `  - ${e.message}`).join("\n");
    throw new DefinitionError(`${label}: YAML warnings (strict):\n${detail}`);
  }

  // Aliases (and therefore merge keys, which require an alias) are rejected.
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      throw new DefinitionError(
        `${label}: YAML aliases are rejected — write the value out explicitly (alias *${node.source})`,
      );
    }
    return undefined;
  });

  const value = doc.toJS();
  rejectMergeKeys(value, label);

  // Bare anchor definitions are inert but still rejected: the lexer emits
  // them as standalone chunks, while "&" inside scalars never is.
  const anchorMatch = findAnchorToken(src);
  if (anchorMatch) {
    throw new DefinitionError(
      `${label}: YAML anchors are rejected — write the value out explicitly (found "${anchorMatch}")`,
    );
  }

  return value;
}

function findAnchorToken(src: string): string | null {
  for (const chunk of new Lexer().lex(src)) {
    if (typeof chunk !== "string") continue;
    if (/^&[A-Za-z0-9_-]+$/.test(chunk)) return chunk;
    if (/^\*[A-Za-z0-9_-]+$/.test(chunk)) return chunk;
  }
  return null;
}
function rejectMergeKeys(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectMergeKeys(item, label);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "<<") {
        throw new DefinitionError(
          `${label}: YAML merge keys ("<<") are rejected — write the keys out explicitly`,
        );
      }
      rejectMergeKeys(v, label);
    }
  }
}
