import { z } from "zod";

/**
 * Strict schemas for workflow definitions and machine configuration.
 * Every object is strict: unknown keys are rejected, execution sites are
 * tagged unions with exactly one member.
 */

export const durationString = z
  .string()
  .regex(/^[1-9][0-9]*[smhdw]$/, "expected a positive integer duration with unit s|m|h|d|w, e.g. 10m");

export const timeoutValue = z.union([durationString, z.literal("unlimited")]);

export const byteSizeValue = z.union([
  z.string().regex(/^[1-9][0-9]*(kb|mb)?$/, "expected a positive byte size with optional kb|mb, e.g. 256kb"),
  z.literal("unlimited"),
]);

export const modelString = z
  .string()
  .regex(
    /^[^/\s]+\/[^:\s]+:[^:\s]+$/,
    'expected "<provider>/<model-id>:<thinking-level>", e.g. "openai-codex/gpt-5.3-codex:medium"',
  );

export const nodeSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "node ids must be readable slugs: lowercase letters, digits, hyphens");

export const harnessBlock = z.strictObject({
  command: z.string().min(1),
});

export const agentBlock = z.strictObject({
  harness: harnessBlock.optional(),
  model: modelString.optional(),
  instructions: z.string().min(1),
});

export const runUnion = z.union([
  z.strictObject({ agent: agentBlock }).strict(),
  z.strictObject({ command: z.string().min(1) }).strict(),
]);

export const validatorUnion = z.union([
  z.strictObject({
    agent: agentBlock,
    timeout: timeoutValue.optional(),
  }).strict(),
  z.strictObject({
    command: z.string().min(1),
    timeout: timeoutValue.optional(),
  }).strict(),
]);

export const nodeSchema = z.strictObject({
  run: runUnion,
  validator: validatorUnion.optional(),
  timeout: timeoutValue.optional(),
  stream_cap: byteSizeValue.optional(),
  max_attempts: z.number().int().min(1).optional(),
  next: z.union([nodeSlug, z.null()]).optional(),
});

export const workflowSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "workflow ids must be readable slugs"),
  description: z.string().min(1),
  schedule: z.strictObject({
    every: durationString,
    max_runs: z.number().int(),
  }).optional(),
  defaults: z
    .strictObject({
      max_attempts: z.number().int().min(1).optional(),
      timeout: timeoutValue.optional(),
      agent: z
        .strictObject({
          harness: harnessBlock.optional(),
          model: modelString.optional(),
        })
        .optional(),
    })
    .optional(),
  environment: z
    .strictObject({
      preflight: z.strictObject({
        command: z.string().min(1),
        timeout: timeoutValue.optional(),
      }).optional(),
    })
    .optional(),
  orchestrator: z
    .strictObject({
      agent: z
        .strictObject({
          harness: harnessBlock.optional(),
          model: modelString.optional(),
        })
        .optional(),
      timeout: timeoutValue.optional(),
    })
    .optional(),
  nodes: z.record(nodeSlug, nodeSchema),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type NodeDefinition = z.infer<typeof nodeSchema>;

export const machineConfigSchema = z.strictObject({
  project_dir: z.string().optional(),
  shell: z.string().min(1).optional(),
  max_concurrent_runs: z.number().int().min(1).optional(),
  default_timeout: durationString.optional(),
  stream_cap: byteSizeValue.optional(),
  agent: z
    .strictObject({
      harness: harnessBlock.optional(),
      model: modelString.optional(),
    })
    .optional(),
});

export type MachineConfig = Required<Pick<z.infer<typeof machineConfigSchema>, never>> &
  z.infer<typeof machineConfigSchema>;
