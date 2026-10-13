import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { installationDocumentV1Schema } from "../installation/schema.js";
import { WorkshopInstallationDoc, WorkshopRunDoc } from "../storage/durable/define-workshop-records.js";

export interface OpenRunSettings {
  readonly workflowId: string;
  readonly runId: string;
  readonly resolvedSettings: unknown;
}

/**
 * Format 4 changed retry and verifier semantics, so a format 3 run must finish
 * under the build that admitted it. Upgrades drain; they never reinterpret.
 */
export function checkNoOpenLegacyRuns(openRuns: readonly OpenRunSettings[]): void {
  const legacy = openRuns.filter((run) => !isCurrentFormat(run.resolvedSettings));
  if (legacy.length === 0) return;
  const names = legacy.map((run) => `${run.workflowId}/${run.runId}`).join(", ");
  throw new Error(
    `open runs use workflow format 3 and cannot continue under format 4: ${names}.`
      + " Stop or finish them with the previous Workshop build (workshop stop <workflow>), then start the service again.",
  );
}

/** Read each workflow's open run before any task resumes. */
export async function checkInstallationHasNoOpenLegacyRuns(harness: Harness, context: Context): Promise<void> {
  const installation = installationDocumentV1Schema.parse(await harness.snapshot(WorkshopInstallationDoc, context));
  if (installation.state !== "ready") return;
  const openRuns: OpenRunSettings[] = [];
  for (const [workflowId, workflow] of Object.entries(installation.workflows)) {
    if (workflow.openRunId === null) continue;
    const reference = workflow.runs.find((run) => run.runId === workflow.openRunId);
    if (reference === undefined) throw new Error(`open run ${workflow.openRunId} is missing from the installation index`);
    const run: unknown = await harness.snapshot(WorkshopRunDoc, reference.conversationId as ConversationId, context);
    const resolvedSettings = typeof run === "object" && run !== null && "resolvedSettings" in run ? run.resolvedSettings : undefined;
    // An open run that never reached admission has no frozen settings and no legacy semantics to protect.
    if (resolvedSettings === undefined) continue;
    openRuns.push({ workflowId, runId: reference.runId, resolvedSettings });
  }
  checkNoOpenLegacyRuns(openRuns);
}

function isCurrentFormat(settings: unknown): boolean {
  return typeof settings === "object" && settings !== null && "formatVersion" in settings && settings.formatVersion === 4;
}
