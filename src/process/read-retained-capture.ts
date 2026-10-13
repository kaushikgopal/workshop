import type { ProcessCapture } from "./schema.js";

/** Preserve invalid UTF-8 as inspectable base64 instead of replacement characters. */
export function readRetainedCapture(capture: ProcessCapture): string | null {
  if (capture.retained === undefined) return null;
  return readCaptureBytes(Buffer.from(capture.retained.bytes, "base64"));
}

export function readCaptureBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "[invalid UTF-8; base64 bytes]\n" + Buffer.from(bytes).toString("base64");
  }
}
