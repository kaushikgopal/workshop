
/** The scaffold content for one attempt's packet file. */

import { existsSync, readFileSync } from "node:fs";
import { locatePacket } from "../storage/disk/locate-run-files.js";
import { atomicWriteFileSync, ensurePristineFile } from "../storage/disk/write-crash-safe.js";
import { authorizedMarker } from "./apply-marker-rules.js";

export function packetTemplate(attempt: number, marker: { opening: string; closing: string; }): string {
  return `#### Attempt ${attempt}

##### Progress

##### Decisions

##### Validation

##### Blockers

${marker.opening}
${marker.closing}
`;
}
/** Scaffold one attempt, creating missing pristine evidence without overwrite. */
export function scaffoldPacket(
  attemptFolder: string,
  attempt: number,
  successorId: string | null
): string {
  const marker = authorizedMarker(successorId);
  const path = locatePacket(attemptFolder);
  const content = packetTemplate(attempt, marker);
  ensurePristineFile(path, content);
  return content;
}
/** Fill a command node's packet deterministically — the runtime writes it. */
export function fillCommandPacket(input: {
  packetFile: string;
  attempt: number;
  exitCode: number | null;
  stdoutFile: string;
  validatorLine: string;
  marker: { opening: string; closing: string; };
}): void {
  const stdout = existsSync(input.stdoutFile) ? readFileSync(input.stdoutFile, "utf8") : "";
  const content = `#### Attempt ${input.attempt}

##### Progress

Command completed with exit code ${input.exitCode ?? "null"}.

##### Decisions

Deterministic command node; no model decisions.

##### Validation

${input.validatorLine}

##### Blockers

None.

${input.marker.opening}
${stdout.trimEnd()}
${input.marker.closing}
`;
  atomicWriteFileSync(input.packetFile, content);
}
