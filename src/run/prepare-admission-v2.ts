import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalHash, hashSourceText } from "../definition/hash-canonical-json.js";
import { checkV2DefinitionText } from "../definition/check-v2-definition.js";
import { resolveV2WorkflowSettings } from "../definition/resolve-v2-workflow-settings.js";
import { machineConfigSchemaV2, type MachineConfigV2 } from "../definition/schema-v2.js";
import { resolvedWorkflowSettingsV2Schema } from "../definition/schema-resolved-v2.js";
import { runtimeManifestV2Schema } from "./records-v2.js";
import {
  activationIdV2Schema,
  evidenceIdV2Schema,
  occurrenceIdV2Schema,
} from "./schema-v2.js";
import { utcTimestampV2Schema } from "../util/schema-v2.js";

const safeRunIdV2 = z.string().max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const maxSourceBytes = 1024 * 1024;

const admissionRequestV2Schema = z.strictObject({
  sourceText: z.string().refine(
    (text) => new TextEncoder().encode(text).byteLength <= maxSourceBytes,
    "workflow source must be at most 1 MiB in UTF-8",
  ),
  sourceLabel: z.string().min(1).max(1024),
  machineConfig: z.unknown(),
  projectCwd: z.string().min(1).refine((path) => isAbsolute(path) && !path.includes("\u0000")),
  runsDirectory: z.string().min(1).refine((path) => isAbsolute(path) && !path.includes("\u0000")),
  resolvedSettings: z.unknown(),
  runtimeManifest: z.unknown(),
  runId: safeRunIdV2,
  eventId: evidenceIdV2Schema,
  activationId: activationIdV2Schema,
  occurrenceId: occurrenceIdV2Schema,
  requestId: z.string().min(1).max(256).nullable(),
  admittedAt: utcTimestampV2Schema,
});

export type PreparedRunAdmissionV2 = {
  readonly workflowId: string;
  readonly sourceLabel: string;
  readonly sourceText: string;
  readonly machineConfig: MachineConfigV2;
  readonly sourceHash: string;
  readonly definition: ReturnType<typeof checkV2DefinitionText>["def"];
  readonly canonicalHash: string;
  readonly resolvedSettings: z.infer<typeof resolvedWorkflowSettingsV2Schema>;
  readonly chain: {
    readonly order: readonly string[];
    readonly predecessors: Readonly<Record<string, string | null>>;
  };
  readonly runtimeManifest: z.infer<typeof runtimeManifestV2Schema>;
  readonly runId: string;
  readonly eventId: string;
  readonly activationId: string;
  readonly occurrenceId: string;
  readonly requestId: string | null;
  readonly admittedAt: string;
  readonly projectCwd: string;
  readonly runsDirectory: string;
  readonly runDirectory: string;
  readonly paths: {
    readonly projectCwd: string;
    readonly runDirectory: string;
    readonly definitionSnapshot: string;
    readonly worklog: string;
    readonly inputDirectory: string;
    readonly outputDirectory: string;
    readonly captureDirectory: string;
  };
  readonly preflightCacheKey: string | null;
};

export type AdmissionPreparationFailureV2 = {
  readonly kind:
    | "admission_input_invalid"
    | "definition_invalid"
    | "machine_settings_invalid"
    | "resolved_settings_invalid"
    | "resolved_settings_mismatch";
  readonly message: string;
  readonly cause?: unknown;
};

export type AdmissionPreparationV2 =
  | { readonly ok: true; readonly value: PreparedRunAdmissionV2 }
  | { readonly ok: false; readonly failure: AdmissionPreparationFailureV2 };

/** Parse the frozen admission inputs and independently resolve settings before any storage transaction. */
export function prepareRunAdmissionV2(input: unknown): AdmissionPreparationV2 {
  const request = admissionRequestV2Schema.safeParse(input);
  if (!request.success) {
    return {
      ok: false,
      failure: { kind: "admission_input_invalid", message: "run admission inputs are invalid", cause: request.error },
    };
  }
  const raw = request.data;
  const machine = machineConfigSchemaV2.safeParse(raw.machineConfig);
  if (!machine.success) {
    return {
      ok: false,
      failure: { kind: "machine_settings_invalid", message: "machine settings are invalid", cause: machine.error },
    };
  }

  let checked: ReturnType<typeof checkV2DefinitionText>;
  try {
    checked = checkV2DefinitionText(raw.sourceText, raw.sourceLabel);
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

  const settings = resolvedWorkflowSettingsV2Schema.safeParse(raw.resolvedSettings);
  if (!settings.success) {
    return {
      ok: false,
      failure: { kind: "resolved_settings_invalid", message: "resolved workflow settings are invalid", cause: settings.error },
    };
  }
  let expectedSettings: z.infer<typeof resolvedWorkflowSettingsV2Schema>;
  try {
    expectedSettings = resolveV2WorkflowSettings({
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

  const runtimeManifest = runtimeManifestV2Schema.safeParse(raw.runtimeManifest);
  if (!runtimeManifest.success) {
    return {
      ok: false,
      failure: { kind: "admission_input_invalid", message: "runtime manifest is invalid", cause: runtimeManifest.error },
    };
  }

  const projectCwd = resolve(raw.projectCwd);
  const runsDirectory = resolve(raw.runsDirectory);
  const runDirectory = join(runsDirectory, raw.runId);
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
      runDirectory,
      paths: {
        projectCwd,
        runDirectory,
        definitionSnapshot: join(runDirectory, "definition.yaml"),
        worklog: join(runDirectory, "WORKLOG.md"),
        inputDirectory: join(runDirectory, "input"),
        outputDirectory: join(runDirectory, "output"),
        captureDirectory: join(runDirectory, "captures"),
      },
      preflightCacheKey,
    },
  };
}
