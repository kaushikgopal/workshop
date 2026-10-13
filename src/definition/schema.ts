import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseByteSize, parseDuration } from "../util/parse-units.js";
import { replayPolicySchema } from "../util/schema.js";
import { parseModel } from "./parse-model.js";

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer");
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");

function maxUtf8Bytes(limit: number, label: string) {
  return z.string().refine((value) => new TextEncoder().encode(value).byteLength <= limit, `${label} must be at most ${limit / 1024} KiB in UTF-8`);
}

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
/** Retries after the first attempt; `unlimited` never stops on count alone. */
export const retriesValue = z.union([nonnegativeSafeInteger, z.literal("unlimited")]);
export const resultModeValue = z.enum(["text", "tagged"]);
const workflowInstructionsValue = maxUtf8Bytes(64 * 1024, "instructions");
export const keepFilesValue = z.enum(["failed", "always"]);

export const workflowIdSchema = z
  .string()
  .max(80, "workflow ids must be at most 80 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "workflow ids must be lowercase slugs separated by single hyphens");

export const nodeIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "step ids must be lowercase slugs separated by single hyphens");

const nonemptyCommand = z.string().refine((value) => value.trim().length > 0, "command must be nonempty");

/** `pi` names the built-in Pi preset; an object supplies a custom command. */
export const harnessSchema = z.union([
  z.literal("pi"),
  z.strictObject({ command: nonemptyCommand }),
]);

export const agentDefaultsSchema = z.strictObject({
  harness: harnessSchema.optional(),
  model: modelString.optional(),
});

export const agentSettingsSchema = z.strictObject({
  harness: harnessSchema.optional(),
  model: modelString.optional(),
  instructions: z.string(),
});

// The frozen, normalized chain stored with every run. Authors write `workflowFileSchema` below.
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

// Frozen definitions keep legacy keys readable; authoring rules live in `workflowFileSchema`.
const nodeSchema = z.strictObject({
  run: runSchema,
  validator: validatorSchema.optional(),
  next: z.union([nodeIdSchema, z.null()]),
  max_attempts: positiveSafeInteger.optional(),
  retries: retriesValue.optional(),
  result: resultModeValue.optional(),
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

const workflowSettings = {
  description: z.string().refine(
    (value) => new TextEncoder().encode(value).byteLength <= 4 * 1024,
    "description must be at most 4 KiB in UTF-8",
  ).optional(),
  schedule: scheduleSchema.optional(),
  instructions: workflowInstructionsValue.optional(),
  defaults: z.strictObject({
    max_attempts: positiveSafeInteger.optional(),
    retries: retriesValue.optional(),
    timeout: timeoutValue.optional(),
    stream_cap: byteSizeValue.optional(),
    replay: replayValue.optional(),
    keep_files: keepFilesValue.optional(),
    agent: agentDefaultsSchema.optional(),
  }).optional(),
  environment: z.strictObject({
    preflight: preflightSchema,
  }).optional(),
  orchestrator: orchestratorSchema.optional(),
};

export const workflowSchema = z.strictObject({
  id: workflowIdSchema,
  ...workflowSettings,
  nodes: z.record(nodeIdSchema, nodeSchema).refine(
    (nodes) => Object.keys(nodes).length > 0,
    "workflow must contain at least one step",
  ),
});

/** The workflow file format; every workflow file must declare it. */
export const CURRENT_FORMAT_VERSION = 4;
/** The machine config format; unchanged by workflow format 4 and still optional. */
export const MACHINE_FORMAT_VERSION = 3;

const authoredAgentSchema = z.union([
  z.string(),
  agentSettingsSchema,
]);

/** A verifier has the same shapes as a step body and no other fields. */
const authoredVerifySchema = z.union([
  nonemptyCommand,
  z.strictObject({ run: nonemptyCommand }),
  z.strictObject({ agent: authoredAgentSchema }),
]);

const authoredStepOptions = {
  retries: retriesValue.optional(),
  replay: replayValue.optional(),
  verify: authoredVerifySchema.optional(),
  result: resultModeValue.optional(),
  timeout: timeoutValue.optional(),
  stream_cap: byteSizeValue.optional(),
};

export const authoredStepSchema = z.union([
  nonemptyCommand,
  z.strictObject({ run: nonemptyCommand, ...authoredStepOptions }),
  z.strictObject({ agent: authoredAgentSchema, ...authoredStepOptions }),
]);

export const workflowFileSchema = z.strictObject({
  version: z.literal(CURRENT_FORMAT_VERSION),
  description: workflowSettings.description,
  instructions: workflowInstructionsValue.optional(),
  schedule: scheduleSchema.optional(),
  defaults: z.strictObject({
    retries: retriesValue.optional(),
    replay: replayValue.optional(),
    timeout: timeoutValue.optional(),
    stream_cap: byteSizeValue.optional(),
    agent: agentDefaultsSchema.optional(),
  }).optional(),
  environment: workflowSettings.environment,
  steps: z.array(
    z.record(nodeIdSchema, authoredStepSchema).refine(
      (entry) => Object.keys(entry).length === 1,
      "each step is one `- <step-id>: ...` entry",
    ),
  ).min(1, "workflow must contain at least one step"),
});

const absoluteShell = z.string().refine(
  (value) => isAbsolute(value),
  "shell must be an absolute executable path",
);

export const machineConfigSchema = z.strictObject({
  version: z.literal(MACHINE_FORMAT_VERSION).optional(),
  project_dir: z.string().optional(),
  shell: absoluteShell.optional(),
  max_concurrent_runs: positiveSafeInteger.optional(),
  default_timeout: timeoutValue.optional(),
  stream_cap: byteSizeValue.optional(),
  keep_files: keepFilesValue.optional(),
  agent: agentDefaultsSchema.optional(),
  orchestrator: orchestratorSchema.optional(),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowFile = z.infer<typeof workflowFileSchema>;
export type AuthoredStep = z.infer<typeof authoredStepSchema>;
export type AuthoredVerify = z.infer<typeof authoredVerifySchema>;
export type Retries = z.infer<typeof retriesValue>;
export type ResultMode = z.infer<typeof resultModeValue>;
export type NodeDefinition = z.infer<typeof nodeSchema>;
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export type MachineConfig = z.infer<typeof machineConfigSchema>;
