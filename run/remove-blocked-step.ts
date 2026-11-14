import { rmSync } from "node:fs";

export function removeBlockedStep(file: string): void {
  rmSync(file, { force: true });
}
