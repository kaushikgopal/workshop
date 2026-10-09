import { isAbsolute } from "node:path";
import { z } from "zod";
import { nodeIdV2 } from "./schema-v2.js";
import { replayPolicyV2Schema } from "../util/schema-v2.js";

const positiveSafeIntegerV2 = z.number().int().positive().refine(Number.isSafeInteger);
const absolutePathV2 = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes("\u0000"),
  "path must be absolute and contain no NUL",
);
const finiteOrUnlimitedV2 = z.union([positiveSafeIntegerV2, z.literal("unlimited")]);

/** Fully resolved worker or validator settings frozen into an admitted run. */
export const resolvedExecutionSiteV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    command: z.string().min(1),
    shell: absolutePathV2,
    cwd: absolutePathV2,
    timeoutMs: positiveSafeIntegerV2.nullable(),
    streamCapBytes: finiteOrUnlimitedV2,
    replay: replayPolicyV2Schema,
  }),
  z.strictObject({
    kind: z.literal("agent"),
    harnessCommand: z.string().min(1),
    model: z.string().min(1),
    instructions: z.string(),
    shell: absolutePathV2,
    cwd: absolutePathV2,
    timeoutMs: positiveSafeIntegerV2.nullable(),
    streamCapBytes: finiteOrUnlimitedV2,
    replay: replayPolicyV2Schema,
  }),
]);

export const resolvedNodeSettingsV2Schema = z.strictObject({
  run: resolvedExecutionSiteV2Schema,
  validator: resolvedExecutionSiteV2Schema.nullable(),
  maxAttempts: positiveSafeIntegerV2,
});

export const resolvedPreflightSettingsV2Schema = z.strictObject({
  command: z.string().min(1),
  shell: absolutePathV2,
  cwd: absolutePathV2,
  timeoutMs: positiveSafeIntegerV2.nullable(),
});

/** Internal judging runs in a restricted Durable conversation, not a shell process. */
export const resolvedOrchestratorSettingsV2Schema = z.strictObject({
  model: z.string().min(1).nullable(),
  timeoutMs: positiveSafeIntegerV2.nullable(),
});

/** Frozen policy for every node, preflight, and the optional internal judge. */
export const resolvedWorkflowSettingsV2Schema = z.strictObject({
  nodes: z.record(nodeIdV2, resolvedNodeSettingsV2Schema),
  preflight: resolvedPreflightSettingsV2Schema.nullable(),
  orchestrator: resolvedOrchestratorSettingsV2Schema,
});

export type ResolvedExecutionSiteV2 = z.infer<typeof resolvedExecutionSiteV2Schema>;
export type ResolvedNodeSettingsV2 = z.infer<typeof resolvedNodeSettingsV2Schema>;
export type ResolvedPreflightSettingsV2 = z.infer<typeof resolvedPreflightSettingsV2Schema>;
export type ResolvedOrchestratorSettingsV2 = z.infer<typeof resolvedOrchestratorSettingsV2Schema>;
export type ResolvedWorkflowSettingsV2 = z.infer<typeof resolvedWorkflowSettingsV2Schema>;

