import { readFileSync } from "node:fs";
import type { OwnerModelsCatalog } from "./parse-owner-models.js";
import { parseOwnerModels } from "./parse-owner-models.js";

export type LoadedOwnerModels = OwnerModelsCatalog | { readonly kind: "missing" };

/** Load the supported public model catalog without retaining its credentials. */
export function loadOwnerModels(modelsFile: string): LoadedOwnerModels {
  let text: string;
  try {
    text = readFileSync(modelsFile, "utf8");
  } catch (error) {
    return isMissingFile(error) ? { kind: "missing" } : { kind: "invalid" };
  }
  return parseOwnerModels(text);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
