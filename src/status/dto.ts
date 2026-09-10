import type { Store, WorkflowRow, RunRow, AttemptRow } from "../store/store.js";

/**
 * Stable versioned status DTO — the viewer contract (POC-C). Shape is version
 * at five levels: workflow, activation, current run, node, attempt.
 * Timestamps are ISO strings; nullable fields are explicit.
 */

export const STATUS_DTO_VERSION = 1;

export interface AttemptStatusDto {
  number: number;
  status: string;
  progress: string | null;
  validator: "passed" | "failed" | null;
  failure: string | null;
  blocker: string | null;
}

export interface NodeStatusDto {
  id: string;
  status: string;
  attempts: AttemptStatusDto[];
}

export interface RunStatusDto {
  id: string;
  status: string;
  desiredState: string;
  orchestratorPhase: string;
  startedAt: string;
  blocker: string | null;
  nodes: NodeStatusDto[];
}

export interface ActivationDto {
  state: string;
  startedAt: string;
  startedRuns: number;
  maxRuns: number | null;
  nextRunAt: string | null;
}

export interface WorkflowStatusDto {
  id: string;
  definitionHash: string;
  activation: ActivationDto | null;
  currentRun: RunStatusDto | null;
}

export interface StatusDto {
  version: number;
  workflows: WorkflowStatusDto[];
}

export function buildStatusDto(store: Store, now: Date): StatusDto {
  const workflows = store.listWorkflows().map((wf) => buildWorkflowDto(store, wf, now));
  return { version: STATUS_DTO_VERSION, workflows };
}

export function buildWorkflowDto(store: Store, wf: WorkflowRow, _now: Date): WorkflowStatusDto {
  const currentRun = store.getUnresolvedRun(wf.workflow_id);
  return {
    id: wf.workflow_id,
    definitionHash: wf.canonical_definition_hash,
    activation:
      wf.schedule_every === null && wf.schedule_max_runs === null
        ? null
        : {
            state: wf.activation_state,
            startedAt: wf.activation_started_at,
            startedRuns: wf.schedule_started_runs,
            maxRuns: wf.schedule_max_runs,
            nextRunAt: wf.next_run_at,
          },
    currentRun: currentRun ? buildRunDto(store, currentRun) : null,
  };
}

export function buildRunDto(store: Store, run: RunRow): RunStatusDto {
  const attempts = store.listAttempts(run.run_id);
  // Arrays are ordered by chain position, then attempt number.
  const nodeIds: string[] = [];
  for (const a of attempts.slice().sort((x, y) => x.chain_position - y.chain_position || x.attempt - y.attempt)) {
    if (!nodeIds.includes(a.node_id)) nodeIds.push(a.node_id);
  }
  return {
    id: run.run_id,
    status: run.status,
    desiredState: run.desired_state,
    orchestratorPhase: run.orchestrator_phase,
    startedAt: run.started_at,
    blocker: run.block_kind,
    nodes: nodeIds.map((id) => buildNodeDto(attempts.filter((a) => a.node_id === id), id)),
  };
}

function buildNodeDto(attempts: AttemptRow[], id: string): NodeStatusDto {
  const status = nodeStatusFromAttempts(attempts);
  return {
    id,
    status,
    attempts: attempts
      .slice()
      .sort((a, b) => a.attempt - b.attempt)
      .map((a) => ({
        number: a.attempt,
        status: a.status,
        progress: a.current_progress,
        validator: a.validator_status,
        failure: a.failure_kind,
        blocker: a.block_kind,
      })),
  };
}

/** Node status derived from its attempts; live attempt dominates. */
function nodeStatusFromAttempts(attempts: AttemptRow[]): string {
  const live = attempts.find((a) => ["pending", "running", "finishing"].includes(a.status));
  if (live) return live.status === "pending" ? "pending" : "running";
  if (attempts.some((a) => a.status === "blocked")) return "blocked";
  if (attempts.some((a) => a.status === "completed")) return "completed";
  if (attempts.some((a) => a.status === "failed")) return "failed";
  if (attempts.some((a) => a.status === "cancelled")) return "cancelled";
  return "pending";
}

/** Human text rendering of the same DTO data. */
export function renderStatusText(dto: StatusDto): string {
  const lines: string[] = [];
  for (const wf of dto.workflows) {
    lines.push(`Workflow  ${wf.id}`);
    if (wf.activation) {
      lines.push(
        `Activation ${wf.activation.state} (runs ${wf.activation.startedRuns}${wf.activation.maxRuns != null ? `/${wf.activation.maxRuns}` : ""})` +
          (wf.activation.nextRunAt ? ` next ${wf.activation.nextRunAt}` : ""),
      );
    }
    const run = wf.currentRun;
    if (!run) {
      lines.push("Run      (none unresolved)");
      lines.push("");
      continue;
    }
    lines.push(`Run       ${run.id} — ${run.status}${run.blocker ? ` (blocked: ${run.blocker})` : ""}`);
    for (const node of run.nodes) {
      lines.push(`  Node    ${node.id} — ${node.status}`);
      for (const attempt of node.attempts) {
        const bits: string[] = [`${attempt.number}`, attempt.status];
        if (attempt.progress) bits.push(`progress: ${attempt.progress}`);
        if (attempt.validator) bits.push(`validator: ${attempt.validator}`);
        if (attempt.failure) bits.push(`failure: ${attempt.failure}`);
        if (attempt.blocker) bits.push(`blocker: ${attempt.blocker}`);
        lines.push(`    Attempt ${bits.join(" · ")}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
