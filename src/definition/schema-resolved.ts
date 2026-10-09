import { isAbsolute } from "node:path";
import { z } from "zod";
import { nodeIdSchema } from "./schema.js";
import { replayPolicySchema } from "../util/schema.js";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const absolutePath = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes("\u0000"),
  "path must be absolute and contain no NUL",
);
const finiteOrUnlimited = z.union([positiveSafeInteger, z.literal("unlimited")]);

/** Fully resolved worker or validator settings frozen into an admitted run. */
export const resolvedExecutionSiteSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    command: z.string().min(1),
    shell: absolutePath,
    cwd: absolutePath,
    timeoutMs: positiveSafeInteger.nullable(),
    streamCapBytes: finiteOrUnlimited,
    replay: replayPolicySchema,
  }),
  z.strictObject({
    kind: z.literal("agent"),
    harnessCommand: z.string().min(1),
    model: z.string().min(1),
    instructions: z.string(),
    shell: absolutePath,
    cwd: absolutePath,
    timeoutMs: positiveSafeInteger.nullable(),
    streamCapBytes: finiteOrUnlimited,
    replay: replayPolicySchema,
  }),
]);

export const resolvedNodeSettingsSchema = z.strictObject({
  run: resolvedExecutionSiteSchema,
  validator: resolvedExecutionSiteSchema.nullable(),
  maxAttempts: positiveSafeInteger,
});

export const resolvedPreflightSettingsSchema = z.strictObject({
  command: z.string().min(1),
  shell: absolutePath,
  cwd: absolutePath,
  timeoutMs: positiveSafeInteger.nullable(),
});

/** Internal judging runs in a restricted Durable conversation, not a shell process. */
export const resolvedOrchestratorSettingsSchema = z.strictObject({
  model: z.string().min(1).nullable(),
  timeoutMs: positiveSafeInteger.nullable(),
});

/** Frozen policy for every node, preflight, and the optional internal judge. */
export const resolvedWorkflowSettingsSchema = z.strictObject({
  nodes: z.record(nodeIdSchema, resolvedNodeSettingsSchema),
  preflight: resolvedPreflightSettingsSchema.nullable(),
  orchestrator: resolvedOrchestratorSettingsSchema,
});

export type ResolvedExecutionSite = z.infer<typeof resolvedExecutionSiteSchema>;
export type ResolvedNodeSettings = z.infer<typeof resolvedNodeSettingsSchema>;
export type ResolvedPreflightSettings = z.infer<typeof resolvedPreflightSettingsSchema>;
export type ResolvedOrchestratorSettings = z.infer<typeof resolvedOrchestratorSettingsSchema>;
export type ResolvedWorkflowSettings = z.infer<typeof resolvedWorkflowSettingsSchema>;

