import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "./config.js";
import { canonicalHash } from "./definition/hash.js";
import { parseStrictYaml } from "./definition/parse.js";
import { workflowSchema, type WorkflowDefinition } from "./definition/schema.js";
import { validateChain, type ChainInfo } from "./definition/validate.js";
import { GuardRejected, type RunRow, type Store } from "./store/store.js";
import { parseDuration } from "./util/duration.js";
import { ensurePristineFile, WorklogIntegrityError, worklogTemplate } from "./worklog/worklog.js";

export interface AdmissionDefinition {
  def: WorkflowDefinition;
  chain: ChainInfo;
  canonicalHash: string;
  sourcePath: string;
  sourceText: string;
}

export interface AdmissionResult {
  runId: string;
  created: boolean;
}

/** Manual start activation and reservation share one serialized owner. */
export function admitManualRun(input: {
  store: Store;
  inst: Installation;
  loaded: AdmissionDefinition;
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
  let loaded: AdmissionDefinition;
  try {
    loaded = loadAdmissionDefinition(wf.definition_path);
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
    const expectedWorklog = join(expectedRunDir, "WORKSHOP_LOG.md");
    if (run.run_dir !== expectedRunDir || run.definition_snapshot_path !== expectedSnapshot || run.worklog_path !== expectedWorklog) {
      throw new WorklogIntegrityError(`run ${run.run_id} has artifact paths outside its reserved run directory`);
    }
    if (!run.admission_definition_yaml) {
      throw new WorklogIntegrityError(`run ${run.run_id} has no replayable admission definition`);
    }

    const raw = parseStrictYaml(run.admission_definition_yaml, `admission:${run.run_id}`);
    const def = workflowSchema.parse(raw);
    const chain = validateChain(def);
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

function loadAdmissionDefinition(sourcePath: string): AdmissionDefinition {
  let sourceText: string;
  try {
    sourceText = readFileSync(sourcePath, "utf8");
  } catch (e) {
    throw new Error(`cannot read workflow definition at ${sourcePath}: ${(e as Error).message}`);
  }
  const raw = parseStrictYaml(sourceText, sourcePath);
  const def = workflowSchema.parse(raw);
  return { def, chain: validateChain(def), canonicalHash: canonicalHash(def), sourcePath, sourceText };
}
