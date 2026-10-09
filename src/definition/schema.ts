import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseByteSize, parseDuration } from "../util/parse-units.js";
import { replayPolicySchema } from "../util/schema.js";
import { parseModel } from "./parse-model.js";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer");

const modelString = z.string().superRefine((value, context) => {
  try {
    parseModel(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid model string",
    });
  }
});

export const durationString = z
  .string()
  .regex(/^[1-9][0-9]*(ms|[smhdw])$/, "expected a positive integer duration with unit ms|s|m|h|d|w, e.g. 10ms")
  .refine((value) => {
    try {
      parseDuration(value);
      return true;
    } catch {
      return false;
    }
  }, "duration must fit a finite safe-integer millisecond value");

export const timeoutValue = z.union([durationString, z.literal("unlimited")]);

export const byteSizeValue = z.union([
  z.string()
    .regex(/^[1-9][0-9]*(kb|mb)?$/, "expected a positive byte size with optional kb|mb, e.g. 256kb")
    .refine((value) => {
      try {
        parseByteSize(value);
        return true;
      } catch {
        return false;
      }
    }, "byte cap must fit a finite safe-integer byte value"),
  z.literal("unlimited"),
]);

export const replayValue = replayPolicySchema;

export const workflowIdSchema = z
  .string()
  .max(80, "workflow ids must be at most 80 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "workflow ids must be lowercase slugs separated by single hyphens");

export const nodeIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "node ids must be lowercase slugs separated by single hyphens");

const nonemptyCommand = z.string().refine((value) => value.trim().length > 0, "command must be nonempty");

export const harnessSchema = z.strictObject({
  command: nonemptyCommand,
});

export const agentDefaultsSchema = z.strictObject({
  harness: harnessSchema.optional(),
  model: modelString.optional(),
});

export const agentSettingsSchema = z.strictObject({
  harness: harnessSchema.optional(),
  model: modelString.optional(),
  instructions: z.string(),
});

const runSchema = z.union([
  z.strictObject({ agent: agentSettingsSchema }),
  z.strictObject({ command: nonemptyCommand }),
]);

const validatorSchema = z.union([
  z.strictObject({
    agent: agentSettingsSchema,
    timeout: timeoutValue.optional(),
    replay: replayValue.optional(),
  }),
  z.strictObject({
    command: nonemptyCommand,
    timeout: timeoutValue.optional(),
    replay: replayValue.optional(),
  }),
]);

const nodeSchema = z.strictObject({
  run: runSchema,
  validator: validatorSchema.optional(),
  next: z.union([nodeIdSchema, z.null()]),
  max_attempts: positiveSafeInteger.optional(),
  timeout: timeoutValue.optional(),
  stream_cap: byteSizeValue.optional(),
  replay: replayValue.optional(),
});

const scheduleSchema = z.strictObject({
  every: durationString,
  max_runs: z.union([positiveSafeInteger, z.literal("unlimited")]),
});

const preflightSchema = z.strictObject({
  command: nonemptyCommand,
  timeout: timeoutValue.optional(),
});

const orchestratorSchema = z.strictObject({
  model: modelString.optional(),
  timeout: timeoutValue.optional(),
});

export const workflowSchema = z.strictObject({
  version: z.literal(2),
  id: workflowIdSchema,
  description: z.string().refine(
    (value) => new TextEncoder().encode(value).byteLength <= 4 * 1024,
    "description must be at most 4 KiB in UTF-8",
  ).optional(),
  schedule: scheduleSchema.optional(),
  defaults: z.strictObject({
    max_attempts: positiveSafeInteger.optional(),
    timeout: timeoutValue.optional(),
    stream_cap: byteSizeValue.optional(),
    replay: replayValue.optional(),
    agent: agentDefaultsSchema.optional(),
  }).optional(),
  environment: z.strictObject({
    preflight: preflightSchema,
  }).optional(),
  orchestrator: orchestratorSchema.optional(),
  nodes: z.record(nodeIdSchema, nodeSchema).refine(
    (nodes) => Object.keys(nodes).length > 0,
    "workflow must contain at least one node",
  ),
});

const absoluteShell = z.string().refine(
  (value) => isAbsolute(value),
  "shell must be an absolute executable path",
);

export const machineConfigSchema = z.strictObject({
  version: z.literal(2),
  project_dir: z.string().optional(),
  shell: absoluteShell.optional(),
  max_concurrent_runs: positiveSafeInteger.optional(),
  default_timeout: timeoutValue.optional(),
  stream_cap: byteSizeValue.optional(),
  agent: agentDefaultsSchema.optional(),
  orchestrator: orchestratorSchema.optional(),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type NodeDefinition = z.infer<typeof nodeSchema>;
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export type MachineConfig = z.infer<typeof machineConfigSchema>;
