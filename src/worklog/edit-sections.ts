import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../storage/disk/write-crash-safe.js";
import { WorklogIntegrityError } from "./detect-tampering.js";

export function worklogTemplate(
  workflowId: string,
  description: string,
  nodeIds: string[],
): string {
  const nodeSections = nodeIds.map((id) => `### Node: ${id}\n`).join("\n");
  return `# Workflow run: ${workflowId}

## Goal

${description}

## Environment

## Global decision log

## Work packets

${nodeSections}## Run outcome
`;
}

/**
 * Append the attempt block under `### Node: <id>`, creating the node section
 * when the first attempt of that node merges.
 */
export function insertAttemptSection(log: string, nodeHeading: string, attemptBlock: string): string {
  if (!log.includes(nodeHeading + "\n")) {
    // Create the node section before "## Run outcome".
    const outcomeHeading = "## Run outcome";
    const idx = log.indexOf(outcomeHeading);
    if (idx === -1) {
      throw new WorklogIntegrityError(`worklog is missing both "${nodeHeading}" and "${outcomeHeading}"`);
    }
    return `${log.slice(0, idx)}${nodeHeading}\n\n${attemptBlock}\n${log.slice(idx)}`;
  }

  // Insert before the next heading that ends the node's section.
  const nodeIdx = log.indexOf(nodeHeading + "\n") + nodeHeading.length + 1;
  const rest = log.slice(nodeIdx);
  const nextHeading = /^#{2,3} /m.exec(rest);
  const insertAt = nextHeading ? nodeIdx + (nextHeading.index ?? 0) : log.length;
  return `${log.slice(0, insertAt)}\n${attemptBlock}${log.slice(insertAt)}`;
}

/** The heading-delimited section of one node, or "" when absent. */
export function sectionFor(log: string, nodeHeading: string): string {
  const nodeIdx = log.indexOf(nodeHeading + "\n");
  if (nodeIdx === -1) return "";
  const rest = log.slice(nodeIdx);
  const nextHeading = /^#{2,3} /m.exec(rest.slice(nodeHeading.length + 1));
  // next.index is relative to the text after the heading line: make the
  // section end absolute before slicing, or early headings yield "".
  const end = nextHeading
    ? nodeIdx + nodeHeading.length + 1 + (nextHeading.index ?? 0)
    : log.length;
  return log.slice(nodeIdx, end);
}

/**
 * Prepend a timestamped runtime note under one of the sections the runtime
 * owns ("Environment", "Run outcome"). Best-effort: SQLite stays authoritative,
 * so a missing log or heading is not an error.
 */
export function appendRuntimeNote(worklogFile: string, section: "Environment" | "Run outcome", text: string): void {
  try {
    const content = readFileSync(worklogFile, "utf8");
    const heading = `## ${section}\n`;
    const idx = content.indexOf(heading);
    if (idx === -1) return;
    const at = idx + heading.length;
    const updated = `${content.slice(0, at)}\n- ${new Date().toISOString()} — ${text}\n${content.slice(at)}`;
    atomicWriteFileSync(worklogFile, updated);
  } catch {
    /* notes are best-effort; SQLite stays authoritative */
  }
}
