import { readFileSync } from "node:fs";
import { locatePacket } from "../storage/disk/locate-run-files.js";
import { validatePacket } from "./check-packet.js";

/**
 * The live-marker rule. Only lines whose trimmed content is exactly an
 * authorized marker pair count as structure; prose that quotes marker text
 * never does. Packet validation, marker escaping, and the exact marked-block
 * publication renderer all share the rule here, so the merge protocol and
 * receipt reconciliation can never disagree about what is live.
 */

/** The marker a node's attempt is authorized to carry. */
export function authorizedMarker(successorId: string | null): { opening: string; closing: string } {
  if (successorId === null) {
    return { opening: "<workflow-output>", closing: "</workflow-output>" };
  }
  return {
    opening: `<next-node-output id="${successorId}">`,
    closing: "</next-node-output>",
  };
}

/**
 * The live structural marker pair. Only lines whose trimmed content is
 * exactly the authorized marker are structural delimiters — a packet may
 * quote the literal marker text inside ordinary prose (the first real
 * Hemingway packet did), and quoted prose must never count as structure.
 * A live pair is exactly one standalone opening line strictly before
 * exactly one standalone closing line; anything else fails closed.
 */
export function markerPair(
  content: string,
  marker: { opening: string; closing: string },
): { live: true; openingLine: number; closingLine: number } | { live: false; openings: number; closings: number } {
  const openings: number[] = [];
  const closings: number[] = [];
  for (const [line, text] of content.split("\n").entries()) {
    const trimmed = text.trim();
    if (trimmed === marker.opening) openings.push(line);
    else if (trimmed === marker.closing) closings.push(line);
  }
  if (openings.length === 1 && closings.length === 1 && openings[0]! < closings[0]!) {
    return { live: true, openingLine: openings[0]!, closingLine: closings[0]! };
  }
  return { live: false, openings: openings.length, closings: closings.length };
}

/**
 * Escape every reserved marker occurrence except the one live standalone
 * authorized pair, whose lines survive verbatim: prose may quote markers,
 * unauthorized marker lines may exist, but only the structural pair may
 * stay live after a merge.
 */
export function escapeReservedMarkers(content: string, keep: { opening: string; closing: string }): string {
  const pair = markerPair(content, keep);
  const liveLines = pair.live ? new Set([pair.openingLine, pair.closingLine]) : new Set<number>();
  return content
    .split("\n")
    .map((line, i) => (liveLines.has(i) ? line : escapeReservedMarkerLine(line)))
    .join("\n");
}

/** Escape every reserved marker occurrence on one non-structural line. */
function escapeReservedMarkerLine(line: string): string {
  return line
    .replaceAll("<workflow-output>", "\\<workflow-output>")
    .replaceAll("</workflow-output>", "\\</workflow-output>")
    .replace(/<next-node-output id="[^"]*">/g, (m) => `\\${m}`)
    .replaceAll("</next-node-output>", "\\</next-node-output>")
    // Runtime merge and decision markers: packet prose must never mint a live
    // one, or a quoted marker would corrupt the merged log's marker counts.
    .replace(/<!-- workshop:(?:merge|decision) (?:begin|end)/g, (m) => `\\${m}`);
}

/** The merge key the runtime's begin/end markers are deterministic in. */
export interface MergeMarkerKey {
  runId: string;
  nodeId: string;
  attempt: number;
  packetSha256: string;
}

/**
 * The runtime's publication markers: HTML comments (invisible in rendered
 * markdown) keyed by run/node/attempt and the exact packet digest at merge
 * time. Identical inputs always produce identical marker text.
 */
export function mergeMarkers(key: MergeMarkerKey): { begin: string; end: string } {
  const attrs = `run=${key.runId} node=${key.nodeId} attempt=${key.attempt} packet=${key.packetSha256}`;
  return {
    begin: `<!-- workshop:merge begin ${attrs} -->`,
    end: `<!-- workshop:merge end ${attrs} -->`,
  };
}

/** Render the exact immutable marker-to-marker attempt publication block. */
export function renderMarkedPacketBlock(input: {
  runId: string; nodeId: string; attempt: number; attemptFolder: string; successorId: string | null;
}, packetSha: string): string {
  const packetFile = locatePacket(input.attemptFolder);
  validatePacket(packetFile, input.nodeId, input.attempt, input.successorId);
  const packet = readFileSync(packetFile, "utf8");
  const attemptHeading = `#### Attempt ${input.attempt}`;
  const normalized = packet.trimStart().startsWith(attemptHeading)
    ? packet
    : `${attemptHeading}\n\n${packet.trimStart()}`;
  const escaped = escapeReservedMarkers(normalized, authorizedMarker(input.successorId));
  const marker = mergeMarkers({
    runId: input.runId, nodeId: input.nodeId, attempt: input.attempt, packetSha256: packetSha,
  });
  const body = escaped.endsWith("\n") ? escaped : `${escaped}\n`;
  return `${marker.begin}\n${body}${marker.end}`;
}

/** One published marked block located in the worklog text. */
export interface MarkedBlock {
  key: MergeMarkerKey;
  beginIdx: number;
  endIdx: number;
  endLength: number;
  block: string;
}
