import { join } from "node:path";
import type { Installation } from "../load-installation.js";
import { canonicalHash } from "../definition/hash-canonical-json.js";
import { checkDefinitionText, loadAndValidateDefinition, type LoadedDefinition } from "../definition/load-definition.js";
import { GuardRejected, type RunRow, type Store } from "../storage/db/store.js";
import { parseDuration } from "../util/parse-units.js";
import { worklogTemplate } from "../worklog/edit-sections.js";
import { WorklogIntegrityError } from "../worklog/detect-tampering.js";
import { locateWorklog } from "../storage/disk/locate-run-files.js";
import { ensurePristineFile } from "../storage/disk/write-crash-safe.js";

export interface AdmissionResult {
  runId: string;
  created: boolean;
}

/** Manual start activation and reservation share one serialized owner. */
export function admitManualRun(input: {
  store: Store;
  inst: Installation;
  loaded: LoadedDefinition;
  now: Date;
}): AdmissionResult {
  const { store, inst, loaded, now } = input;
  const reserved = store.tx(() => {
    const unresolved = store.getUnresolvedRun(loaded.def.id);
    if (unresolved) return { runId: unresolved.run_id, created: false };

    store.upsertWorkflowActivation({
      workflowId: loaded.def.id,
      definitionPath: loaded.sourcePath,
      definitionHash: loaded.canonicalHash,
      every: loaded.def.schedule?.every ?? null,
      maxRuns: loaded.def.schedule?.max_runs ?? 1,
      now,
    });
    const activation = store.getWorkflow(loaded.def.id)!;
    const everyMs = activation.schedule_every ? parseDuration(activation.schedule_every) : null;
    return store.createRun({
      workflowId: loaded.def.id,
      definitionHash: loaded.canonicalHash,
      definitionYaml: loaded.sourceText,
      runsDir: inst.runsDir,
      now,
      mode: "manual",
      isRecurring: everyMs !== null,
      everyMs,
    });
  });
  prepareAdmission({ store, inst, runId: reserved.runId, now });
  return reserved;
}

/** Reserve one due occurrence from the activation's persisted cadence. */
export function admitScheduledRun(input: {
  store: Store;
  inst: Installation;
  workflowId: string;
  now: Date;
}): AdmissionResult {
  const { store, inst, workflowId, now } = input;
  const wf = store.getWorkflow(workflowId);
  if (!wf) throw new GuardRejected(`no workflow "${workflowId}"`);
  if (!wf.schedule_every) throw new GuardRejected("workflow is not scheduled");
  const everyMs = parseDuration(wf.schedule_every);
  const overlappingRun = store.consumeScheduledOverlap(workflowId, now, everyMs);
  if (overlappingRun) {
    prepareAdmission({ store, inst, runId: overlappingRun, now });
    return { runId: overlappingRun, created: false };
  }

  // The source is read and validated once. The exact bytes are committed with
  // the reservation, so replay never consults a later version of this file.
  let loaded: LoadedDefinition;
  try {
    loaded = loadAndValidateDefinition(wf.definition_path);
  } catch (e) {
    throw new GuardRejected(`cannot admit scheduled workflow "${workflowId}": ${(e as Error).message}`);
  }
  if (loaded.def.id !== workflowId) {
    throw new GuardRejected(`definition at ${wf.definition_path} identifies "${loaded.def.id}", expected "${workflowId}"`);
  }
  const reserved = store.createRun({
    workflowId,
    definitionHash: loaded.canonicalHash,
    definitionYaml: loaded.sourceText,
    runsDir: inst.runsDir,
    now,
    mode: "scheduled",
    isRecurring: true,
    everyMs,
  });
  prepareAdmission({ store, inst, runId: reserved.runId, now });
  return reserved;
}

/** Finish a DB-first reservation idempotently from its persisted payload. */
export function prepareAdmission(input: {
  store: Store;
  inst: Installation;
  runId: string;
  now: Date;
}): RunRow {
  const { store, inst, runId, now } = input;
  let run = store.getRun(runId);
  if (!run) throw new GuardRejected(`no run "${runId}"`);
  if (run.admission_state === "ready") return run;
  if (run.admission_state === "blocked") throw new WorklogIntegrityError(run.admission_error ?? "admission is blocked");

  try {
    const expectedRunDir = join(inst.runsDir, run.run_id);
    const expectedSnapshot = join(expectedRunDir, "definition.yaml");
    // Runs reserved before the WORKLOG.md rename keep their original filename.
    const allowedWorklogs = [locateWorklog(expectedRunDir), join(expectedRunDir, "WORKSHOP_LOG.md")];
    if (run.run_dir !== expectedRunDir || run.definition_snapshot_path !== expectedSnapshot || !allowedWorklogs.includes(run.worklog_path)) {
      throw new WorklogIntegrityError(`run ${run.run_id} has artifact paths outside its reserved run directory`);
    }
    if (!run.admission_definition_yaml) {
      throw new WorklogIntegrityError(`run ${run.run_id} has no replayable admission definition`);
    }

    const { def, chain } = checkDefinitionText(run.admission_definition_yaml, `admission:${run.run_id}`);
    if (def.id !== run.workflow_id) throw new WorklogIntegrityError(`admission definition identifies "${def.id}", expected "${run.workflow_id}"`);
    if (canonicalHash(def) !== run.definition_hash) throw new WorklogIntegrityError(`admission definition hash does not match run ${run.run_id}`);

    ensurePristineFile(run.definition_snapshot_path, run.admission_definition_yaml);
    ensurePristineFile(run.worklog_path, worklogTemplate(def.id, def.description, chain.order));
    store.markAdmissionReady(run.run_id, now);
    run = store.getRun(run.run_id)!;
    return run;
  } catch (e) {
    // A concurrent preparer may have won and execution may already have
    // changed the worklog. Ready is authoritative; never reclassify it.
    const fresh = store.getRun(run.run_id)!;
    if (fresh.admission_state === "ready") return fresh;
    const message = e instanceof Error ? e.message : String(e);
    store.failAdmission(run.run_id, message, now);
    throw e;
  }
}

/** Recovery phase zero: no snapshot or attempt may load before this finishes. */
export function recoverAdmissions(input: { store: Store; inst: Installation; now: Date }): void {
  for (const run of input.store.listPendingAdmissions()) {
    try {
      prepareAdmission({ ...input, runId: run.run_id });
    } catch {
      // prepareAdmission records a durable fail-closed admission result.
    }
  }
}
