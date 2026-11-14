import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BlockedWorkflowStep } from "./types.ts";

export function writeBlockedStep(file: string, input: Omit<BlockedWorkflowStep, "at">): BlockedWorkflowStep {
  const record: BlockedWorkflowStep = { ...input, at: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(record)}\n`, "utf8");
  renameSync(temporaryFile, file);
  return record;
}
