import { readFileSync } from "node:fs";
import { authorizedMarker, markerPair } from "./apply-marker-rules.js";
import { WorklogIntegrityError } from "./detect-tampering.js";

export interface PacketCheck {
  ok: true;
}
/**
 * Validate a finished packet before merge. Ownership is the gate:
 * - exactly one standalone authorized opening line whose closing line
 *   follows it (spec §8); marker text quoted in prose never counts;
 * - no headings that own runtime sections (#, ##, ###).
 * Formatting drift inside the attempt block — dropped or extra ####/#####
 * headings — is tolerated; the merge normalizes the attempt heading.
 */
export function validatePacket(packetFile: string, nodeId: string, attempt: number, successorId: string | null): void {
  const content = readFileSync(packetFile, "utf8");
  const marker = authorizedMarker(successorId);

  for (const line of content.split("\n")) {
    if (/^#{1,3} /.test(line.trim())) {
      throw new WorklogIntegrityError(
        `packet for ${nodeId} #${attempt} contains a heading it does not own: "${line.trim()}" — "#", "##", and "###" sections belong to the runtime`
      );
    }
  }

  const pair = markerPair(content, marker);
  if (!pair.live) {
    throw new WorklogIntegrityError(
      `packet for ${nodeId} #${attempt} must contain exactly one standalone ${marker.opening} marker ` +
      `followed by its ${marker.closing} closing line ` +
      `(found ${pair.openings} standalone openings, ${pair.closings} standalone closings)`
    );
  }
}
/** Pull the text between the live standalone marker pair, trimmed. */
export function extractMarker(content: string, opening: string, closing: string): string {
  const pair = markerPair(content, { opening, closing });
  if (!pair.live) return "";
  const lines = content.split("\n");
  return lines.slice(pair.openingLine + 1, pair.closingLine).join("\n").trim();
}
/**
 * Node output for handoff and validation: command stdout, or the agent's
 * marker content; an empty agent marker falls back to the complete packet.
 */
export function extractNodeOutput(
  kind: "command" | "agent",
  packetFile: string,
  stdoutFile: string
): string | null {
  const packet = readFileSync(packetFile, "utf8");
  if (kind === "command") {
    return readFileSync(stdoutFile, "utf8");
  }
  const usesWorkflowOutput = packet.includes("<workflow-output>");
  const marker = usesWorkflowOutput
    ? { opening: "<workflow-output>", closing: "</workflow-output>" }
    : /<next-node-output id="[^"]*">/.exec(packet)?.[0]
      ? { opening: /<next-node-output id="[^"]*">/.exec(packet)![0], closing: "</next-node-output>" }
      : null;
  if (marker === null) return null;
  const content = extractMarker(packet, marker.opening, marker.closing);
  return content.trim() === "" ? packet : content;
}
