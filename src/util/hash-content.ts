import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
/** Content digest of an in-memory string, same format as sha256File. */
export function sha256String(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
