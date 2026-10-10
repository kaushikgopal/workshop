import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalHash, hashSourceText } from "../definition/hash-canonical-json.js";
import { checkDefinitionText } from "../definition/check-definition.js";
import { resolveWorkflowSettings } from "../definition/resolve-workflow-settings.js";
import { machineConfigSchema, type MachineConfig } from "../definition/schema.js";
import { resolvedWorkflowSettingsSchema } from "../definition/schema-resolved.js";
import { runtimeManifestSchema } from "./records.js";
import {
  activationIdSchema,
  evidenceIdSchema,
  occurrenceIdSchema,
} from "./schema.js";
import { utcTimestampSchema } from "../util/schema.js";

const safeRunId = z.string().max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const maxSourceBytes = 1024 * 1024;

const admissionRequestSchema = z.strictObject({
  sourceText: z.string().refine(
    (text) => new TextEncoder().encode(text).byteLength <= maxSourceBytes,
    "workflow source must be at most 1 MiB in UTF-8",
  ),
  sourceLabel: z.string().min(1).max(1024),
  workflowId: z.string().min(1).max(80),
  machineConfig: z.unknown(),
  projectCwd: z.string().min(1).refine((path) => isAbsolute(path) && !path.includes("\u0000")),
  runsDirectory: z.string().min(1).refine((path) => isAbsolute(path) && !path.includes("\u0000")),
  archiveDirectory: z.string().min(1).refine((path) => isAbsolute(path) && !path.includes("\u0000")),
  resolvedSettings: z.unknown(),
  runtimeManifest: z.unknown(),
  runId: safeRunId,
  eventId: evidenceIdSchema,
  activationId: activationIdSchema,
  occurrenceId: occurrenceIdSchema,
  requestId: z.string().min(1).max(256).nullable(),
  admittedAt: utcTimestampSchema,
});

export type PreparedRunAdmission = {
  readonly workflowId: string;
  readonly sourceLabel: string;
  readonly sourceText: string;
  readonly machineConfig: MachineConfig;
  readonly sourceHash: string;
  readonly definition: ReturnType<typeof checkDefinitionText>["def"];
  readonly canonicalHash: string;
  readonly resolvedSettings: z.infer<typeof resolvedWorkflowSettingsSchema>;
  readonly chain: {
    readonly order: readonly string[];
    readonly predecessors: Readonly<Record<string, string | null>>;
  };
  readonly runtimeManifest: z.infer<typeof runtimeManifestSchema>;
  readonly runId: string;
  readonly eventId: string;
  readonly activationId: string;
  readonly occurrenceId: string;
  readonly requestId: string | null;
  readonly admittedAt: string;
  readonly projectCwd: string;
  readonly runsDirectory: string;
  readonly archiveDirectory: string;
  readonly runDirectory: string;
  readonly paths: {
    readonly projectCwd: string;
    readonly runDirectory: string;
    readonly archiveDirectory: string;
  };
  readonly preflightCacheKey: string | null;
};

export type AdmissionPreparationFailure = {
  readonly kind:
    | "admission_input_invalid"
    | "definition_invalid"
    | "machine_settings_invalid"
    | "resolved_settings_invalid"
    | "resolved_settings_mismatch";
  readonly message: string;
  readonly cause?: unknown;
};

export type AdmissionPreparation =
  | { readonly ok: true; readonly value: PreparedRunAdmission }
  | { readonly ok: false; readonly failure: AdmissionPreparationFailure };

/** Parse the frozen admission inputs and independently resolve settings before any storage transaction. */
export function prepareRunAdmission(input: unknown): AdmissionPreparation {
  const request = admissionRequestSchema.safeParse(input);
  if (!request.success) {
    return {
      ok: false,
      failure: { kind: "admission_input_invalid", message: "run admission inputs are invalid", cause: request.error },
    };
  }
  const raw = request.data;
  const machine = machineConfigSchema.safeParse(raw.machineConfig);
  if (!machine.success) {
    return {
      ok: false,
      failure: { kind: "machine_settings_invalid", message: "machine settings are invalid", cause: machine.error },
    };
  }

  let checked: ReturnType<typeof checkDefinitionText>;
  try {
    checked = checkDefinitionText(raw.sourceText, raw.sourceLabel, raw.workflowId);
  } catch (cause) {
    return {
      ok: false,
      failure: {
        kind: "definition_invalid",
        message: cause instanceof Error ? cause.message : "workflow definition is invalid",
        cause,
      },
    };
  }
  if (!raw.runId.startsWith(`${checked.def.id}-`) || raw.runId.length <= checked.def.id.length + 1) {
    return {
      ok: false,
      failure: { kind: "admission_input_invalid", message: "run ID must be path-safe and prefixed by its workflow ID" },
    };
  }

  const settings = resolvedWorkflowSettingsSchema.safeParse(raw.resolvedSettings);
  if (!settings.success) {
    return {
      ok: false,
      failure: { kind: "resolved_settings_invalid", message: "resolved workflow settings are invalid", cause: settings.error },
    };
  }
  let expectedSettings: z.infer<typeof resolvedWorkflowSettingsSchema>;
  try {
    expectedSettings = resolveWorkflowSettings({
      definition: checked.def,
      machine: machine.data,
      projectCwd: raw.projectCwd,
    });
  } catch (cause) {
    return {
      ok: false,
      failure: {
        kind: "machine_settings_invalid",
        message: cause instanceof Error ? cause.message : "workflow settings could not be resolved",
        cause,
      },
    };
  }
  if (canonicalHash(settings.data) !== canonicalHash(expectedSettings)) {
    return {
      ok: false,
      failure: { kind: "resolved_settings_mismatch", message: "resolved settings do not match the checked workflow and machine settings" },
    };
  }

  const runtimeManifest = runtimeManifestSchema.safeParse(raw.runtimeManifest);
  if (!runtimeManifest.success) {
    return {
      ok: false,
      failure: { kind: "admission_input_invalid", message: "runtime manifest is invalid", cause: runtimeManifest.error },
    };
  }

  const projectCwd = resolve(raw.projectCwd);
  const runsDirectory = resolve(raw.runsDirectory);
  const runDirectory = join(runsDirectory, raw.runId);
  const archiveDirectory = resolve(raw.archiveDirectory);
  const sourceHash = hashSourceText(raw.sourceText);
  const canonicalDefinitionHash = canonicalHash(checked.def);
  const predecessors = Object.fromEntries(checked.chain.order.map((nodeId) => [
    nodeId,
    checked.chain.prev.get(nodeId) ?? null,
  ]));
  const preflightCacheKey = settings.data.preflight === null
    ? null
    : canonicalHash({ definition: canonicalDefinitionHash, preflight: settings.data.preflight, projectCwd });

  return {
    ok: true,
    value: {
      workflowId: checked.def.id,
      sourceLabel: raw.sourceLabel,
      sourceText: raw.sourceText,
      machineConfig: machine.data,
      sourceHash,
      definition: checked.def,
      canonicalHash: canonicalDefinitionHash,
      resolvedSettings: settings.data,
      chain: { order: checked.chain.order, predecessors },
      runtimeManifest: runtimeManifest.data,
      runId: raw.runId,
      eventId: raw.eventId,
      activationId: raw.activationId,
      occurrenceId: raw.occurrenceId,
      requestId: raw.requestId,
      admittedAt: raw.admittedAt,
      projectCwd,
      runsDirectory,
      archiveDirectory,
      runDirectory,
      paths: {
        projectCwd,
        runDirectory,
        archiveDirectory: join(archiveDirectory, checked.def.id),
      },
      preflightCacheKey,
    },
  };
}
