import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseV2ByteSize, parseV2Duration } from "../util/parse-units.js";
import { replayPolicyV2Schema } from "../util/schema-v2.js";
import { parseV2Model } from "./parse-v2-model.js";

const positiveSafeIntegerV2 = z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer");

const modelStringV2 = z.string().superRefine((value, context) => {
  try {
    parseV2Model(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid v2 model string",
    });
  }
});

export const durationStringV2 = z
  .string()
  .regex(/^[1-9][0-9]*(ms|[smhdw])$/, "expected a positive integer duration with unit ms|s|m|h|d|w, e.g. 10ms")
  .refine((value) => {
    try {
      parseV2Duration(value);
      return true;
    } catch {
      return false;
    }
  }, "duration must fit a finite safe-integer millisecond value");

export const timeoutValueV2 = z.union([durationStringV2, z.literal("unlimited")]);

export const byteSizeValueV2 = z.union([
  z.string()
    .regex(/^[1-9][0-9]*(kb|mb)?$/, "expected a positive byte size with optional kb|mb, e.g. 256kb")
    .refine((value) => {
      try {
        parseV2ByteSize(value);
        return true;
      } catch {
        return false;
      }
    }, "byte cap must fit a finite safe-integer byte value"),
  z.literal("unlimited"),
]);

export const replayValueV2 = replayPolicyV2Schema;

export const workflowIdV2 = z
  .string()
  .max(80, "workflow ids must be at most 80 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "workflow ids must be lowercase slugs separated by single hyphens");

export const nodeIdV2 = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "node ids must be lowercase slugs separated by single hyphens");

const nonemptyCommandV2 = z.string().refine((value) => value.trim().length > 0, "command must be nonempty");

export const harnessV2Schema = z.strictObject({
  command: nonemptyCommandV2,
});

export const agentDefaultsV2Schema = z.strictObject({
  harness: harnessV2Schema.optional(),
  model: modelStringV2.optional(),
});

export const agentSettingsV2Schema = z.strictObject({
  harness: harnessV2Schema.optional(),
  model: modelStringV2.optional(),
  instructions: z.string(),
});

const runV2Schema = z.union([
  z.strictObject({ agent: agentSettingsV2Schema }),
  z.strictObject({ command: nonemptyCommandV2 }),
]);

const validatorV2Schema = z.union([
  z.strictObject({
    agent: agentSettingsV2Schema,
    timeout: timeoutValueV2.optional(),
    replay: replayValueV2.optional(),
  }),
  z.strictObject({
    command: nonemptyCommandV2,
    timeout: timeoutValueV2.optional(),
    replay: replayValueV2.optional(),
  }),
]);

const nodeV2Schema = z.strictObject({
  run: runV2Schema,
  validator: validatorV2Schema.optional(),
  next: z.union([nodeIdV2, z.null()]),
  max_attempts: positiveSafeIntegerV2.optional(),
  timeout: timeoutValueV2.optional(),
  stream_cap: byteSizeValueV2.optional(),
  replay: replayValueV2.optional(),
});

const scheduleV2Schema = z.strictObject({
  every: durationStringV2,
  max_runs: z.union([positiveSafeIntegerV2, z.literal("unlimited")]),
});

const preflightV2Schema = z.strictObject({
  command: nonemptyCommandV2,
  timeout: timeoutValueV2.optional(),
});

const orchestratorV2Schema = z.strictObject({
  model: modelStringV2.optional(),
  timeout: timeoutValueV2.optional(),
});

export const workflowSchemaV2 = z.strictObject({
  version: z.literal(2),
  id: workflowIdV2,
  description: z.string().refine(
    (value) => new TextEncoder().encode(value).byteLength <= 4 * 1024,
    "description must be at most 4 KiB in UTF-8",
  ).optional(),
  schedule: scheduleV2Schema.optional(),
  defaults: z.strictObject({
    max_attempts: positiveSafeIntegerV2.optional(),
    timeout: timeoutValueV2.optional(),
    stream_cap: byteSizeValueV2.optional(),
    replay: replayValueV2.optional(),
    agent: agentDefaultsV2Schema.optional(),
  }).optional(),
  environment: z.strictObject({
    preflight: preflightV2Schema,
  }).optional(),
  orchestrator: orchestratorV2Schema.optional(),
  nodes: z.record(nodeIdV2, nodeV2Schema).refine(
    (nodes) => Object.keys(nodes).length > 0,
    "workflow must contain at least one node",
  ),
});

const absoluteShellV2 = z.string().refine(
  (value) => isAbsolute(value),
  "shell must be an absolute executable path",
);

export const machineConfigSchemaV2 = z.strictObject({
  version: z.literal(2),
  project_dir: z.string().optional(),
  shell: absoluteShellV2.optional(),
  max_concurrent_runs: positiveSafeIntegerV2.optional(),
  default_timeout: timeoutValueV2.optional(),
  stream_cap: byteSizeValueV2.optional(),
  agent: agentDefaultsV2Schema.optional(),
  orchestrator: orchestratorV2Schema.optional(),
});

export type WorkflowDefinitionV2 = z.infer<typeof workflowSchemaV2>;
export type NodeDefinitionV2 = z.infer<typeof nodeV2Schema>;
export type AgentDefaultsV2 = z.infer<typeof agentDefaultsV2Schema>;
export type AgentSettingsV2 = z.infer<typeof agentSettingsV2Schema>;
export type MachineConfigV2 = z.infer<typeof machineConfigSchemaV2>;
