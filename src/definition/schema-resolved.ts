import { isAbsolute } from "node:path";
import { z } from "zod";
import { keepFilesValue, nodeIdSchema, resultModeValue, retriesValue } from "./schema.js";
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
    model: z.string().min(1),
    instructions: z.string(),
    shell: absolutePath,
    cwd: absolutePath,
    timeoutMs: positiveSafeInteger.nullable(),
    streamCapBytes: finiteOrUnlimited,
    replay: replayPolicySchema,
  }),
]);

/** Format 3 runs counted total attempts; they stay readable after an upgrade but never execute. */
const legacyResolvedNodeSettingsSchema = z.strictObject({
  run: resolvedExecutionSiteSchema,
  validator: resolvedExecutionSiteSchema.nullable(),
  maxAttempts: positiveSafeInteger,
});

const currentResolvedNodeSettingsSchema = z.strictObject({
  run: resolvedExecutionSiteSchema,
  validator: resolvedExecutionSiteSchema.nullable(),
  retries: retriesValue,
  result: resultModeValue,
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
export const currentResolvedWorkflowSettingsSchema = z.strictObject({
  formatVersion: z.literal(4),
  instructions: z.string().nullable(),
  keepFiles: keepFilesValue,
  nodes: z.record(nodeIdSchema, currentResolvedNodeSettingsSchema),
  preflight: resolvedPreflightSettingsSchema.nullable(),
  orchestrator: resolvedOrchestratorSettingsSchema,
});

const legacyResolvedWorkflowSettingsSchema = z.strictObject({
  keepFiles: keepFilesValue,
  nodes: z.record(nodeIdSchema, legacyResolvedNodeSettingsSchema),
  preflight: resolvedPreflightSettingsSchema.nullable(),
  orchestrator: resolvedOrchestratorSettingsSchema,
});

/** Either node shape; readers that only display settings accept both formats. */
export const resolvedNodeSettingsSchema = z.union([currentResolvedNodeSettingsSchema, legacyResolvedNodeSettingsSchema]);

export const resolvedWorkflowSettingsSchema = z.union([
  currentResolvedWorkflowSettingsSchema,
  legacyResolvedWorkflowSettingsSchema,
]);

export type ResolvedExecutionSite = z.infer<typeof resolvedExecutionSiteSchema>;
export type ResolvedNodeSettings =
  | z.infer<typeof currentResolvedNodeSettingsSchema>
  | z.infer<typeof legacyResolvedNodeSettingsSchema>;
export type ResolvedPreflightSettings = z.infer<typeof resolvedPreflightSettingsSchema>;

