import { createHash } from "node:crypto";
import {
  renderVerifierPromptV4,
  renderWorkerPromptV4,
  type VerifierPromptV4Input,
  type WorkerPromptV4Input,
} from "./render-agent-prompt.js";

export type ProcessStdinInput =
  | { role: "worker"; kind: "command"; previousOutput: string | null }
  | { role: "worker"; kind: "agent"; prompt: WorkerPromptV4Input }
  | { role: "verifier"; kind: "command"; candidateOutput: string }
  | { role: "verifier"; kind: "agent"; prompt: VerifierPromptV4Input };

export interface ProcessStdin {
  bytes: Uint8Array;
  sha256: string;
  byteCount: number;
}

/** Build exact process stdin bytes and their identity without reading or writing state. */
export function buildProcessStdin(input: ProcessStdinInput): ProcessStdin {
  const text = input.kind === "command"
    ? input.role === "worker" ? input.previousOutput ?? "" : input.candidateOutput
    : input.role === "worker" ? renderWorkerPromptV4(input.prompt) : renderVerifierPromptV4(input.prompt);
  const bytes = new TextEncoder().encode(text);
  const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, byteCount: bytes.byteLength };
}
