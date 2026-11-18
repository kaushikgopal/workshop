import type { WorkflowTaskCheckpoint } from "../workflow/advance-workflow-state.ts";

export type WorkflowStatusRuntimeRecord = {
  abortRequested: boolean;
  state: { status: string; checkpoint?: unknown; outcome?: unknown };
};

export type WorkflowSchedulerAvailability =
  | { kind: "running" }
  | { kind: "pending"; migrates: boolean }
  | { kind: "waiting"; on: readonly unknown[] }
  | { kind: "sleeping"; until: number }
  | { kind: "completing" }
  | { kind: "blocked"; reason: "missing_task" | "task_too_old" | "migration_failed"; error?: unknown };

export type WorkflowRunStatusProjection = {
  status: string;
  phase: string;
  status_message: string;
  allowed_actions: string[];
  error?: string;
  blocked_step?: { allowed_actions: string[]; retry_profiles: string[] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function outcomeOf(record: WorkflowStatusRuntimeRecord): { status: string; message: string; error?: string } | undefined {
  if (record.state.status !== "completing" && record.state.status !== "terminal") return undefined;
  const outcome = record.state.outcome;
  if (!isRecord(outcome) || typeof outcome.status !== "string") return undefined;
  switch (outcome.status) {
    case "completed": {
      const result = outcome.result;
      const status = isRecord(result) && result.status === "nothing-to-do" ? "nothing-to-do" : "completed";
      return { status, message: status === "nothing-to-do" ? "Workflow found nothing to do." : "Workflow completed." };
    }
    case "aborted": {
      const reason = typeof outcome.reason === "string" ? outcome.reason : "cancelled";
      return { status: "cancelled", message: `Workflow cancelled: ${oneLine(reason)}`, error: reason };
    }
    case "failed":
    case "faulted": {
      const error = isRecord(outcome.error) && typeof outcome.error.message === "string" ? outcome.error.message : "No error detail was recorded";
      return { status: outcome.status, message: `${outcome.status === "failed" ? "Workflow failed" : "Workflow task faulted"}: ${oneLine(error)}`, error };
    }
    case "orphaned": {
      const reason = typeof outcome.reason === "string" ? outcome.reason : "The task definition is unavailable";
      return { status: "orphaned", message: `Workflow task orphaned: ${oneLine(reason)}`, error: reason };
    }
    default:
      return undefined;
  }
}

function legacyStatus(record: WorkflowStatusRuntimeRecord, checkpoint: WorkflowTaskCheckpoint | undefined): string {
  const state = record.state;
  if (["pending", "running", "waiting", "sleeping"].includes(state.status)) {
    return checkpoint?.phase === "blocked" || checkpoint?.phase === "decision" ? "blocked" : state.status;
  }
  return outcomeOf(record)?.status ?? "unavailable";
}

function blockedActions(
  checkpoint: WorkflowTaskCheckpoint | undefined,
  mailboxOccupied: boolean,
  abortRequested: boolean,
  definitionBlocked: boolean,
): WorkflowRunStatusProjection["blocked_step"] {
  if (!checkpoint || (checkpoint.phase !== "blocked" && checkpoint.phase !== "decision")) return undefined;
  const activeChoice = checkpoint.phase === "blocked" && !mailboxOccupied && !abortRequested && !definitionBlocked;
  return {
    allowed_actions: activeChoice
      ? ["retry", "skip", ...(checkpoint.failure.lastOutput.trim().length > 0 ? ["accept"] : []), "fail"]
      : [],
    retry_profiles: [...checkpoint.failure.retryProfiles],
  };
}

function phaseMessage(
  record: WorkflowStatusRuntimeRecord,
  checkpoint: WorkflowTaskCheckpoint | undefined,
  status: string,
  availability: WorkflowSchedulerAvailability | undefined,
  mailboxOccupied: boolean,
): { phase: string; message: string } {
  if (availability?.kind === "blocked") {
    return { phase: "definition-unavailable", message: `Cannot resume: task definition is unavailable (${availability.reason}).` };
  }
  if (record.state.status === "completing") {
    return { phase: "completing", message: `Outcome decided (${status}); finishing owned work.` };
  }
  if (record.state.status === "terminal") {
    const outcome = outcomeOf(record);
    return { phase: status, message: outcome?.message ?? `Workflow status is ${status}.` };
  }
  if (record.abortRequested) {
    return { phase: "cancellation-requested", message: "Cancellation requested; stopping or draining owned work." };
  }
  if (checkpoint?.phase === "blocked" || checkpoint?.phase === "decision") {
    if (checkpoint.phase === "decision" || mailboxOccupied) {
      return { phase: "decision-recorded", message: "Decision recorded; waiting for the workflow to apply it." };
    }
    if (checkpoint.roundStatus === "pending") {
      return { phase: "waiting-for-round", message: "Waiting for the orchestrator's automatic failure round." };
    }
    return { phase: "awaiting-decision", message: `Run blocked at ${checkpoint.failure.step}: ${oneLine(checkpoint.failure.lastError)}. Choose a blocked-step action.` };
  }
  if (record.state.status === "sleeping") {
    const until = checkpoint?.phase === "step" || checkpoint?.phase === "attempt" ? checkpoint.waitUntil : undefined;
    return { phase: "retry-scheduled", message: until === undefined ? "Retry scheduled; no process is running." : `Retry scheduled for ${new Date(until).toISOString()}; no process is running.` };
  }
  if (record.state.status === "waiting") {
    return checkpoint?.phase === "attempt"
      ? { phase: "waiting-for-attempt", message: "Waiting for the active step attempt to finish." }
      : { phase: "waiting", message: "Waiting for owned workflow work to finish." };
  }
  if (record.state.status === "pending") return { phase: "queued", message: "Queued to start workflow work." };
  if (record.state.status === "running") {
    return { phase: "executing", message: checkpoint?.phase === "attempt" ? "Executing a workflow step attempt." : "Executing workflow work." };
  }
  return { phase: "unavailable", message: `Workflow status is ${status}.` };
}

export function projectWorkflowRunStatus(input: {
  record: WorkflowStatusRuntimeRecord;
  availability?: WorkflowSchedulerAvailability;
  checkpoint?: WorkflowTaskCheckpoint;
  mailboxOccupied: boolean;
}): WorkflowRunStatusProjection {
  const { record, availability, checkpoint, mailboxOccupied } = input;
  const status = legacyStatus(record, checkpoint);
  const projection = phaseMessage(record, checkpoint, status, availability, mailboxOccupied);
  const definitionBlocked = availability?.kind === "blocked";
  const canCancel = !record.abortRequested && !definitionBlocked
    && ["pending", "running", "waiting", "sleeping"].includes(record.state.status);
  const blocked = blockedActions(checkpoint, mailboxOccupied, record.abortRequested, definitionBlocked);
  const awaitingChoice = checkpoint?.phase === "blocked" && !mailboxOccupied && !record.abortRequested && !definitionBlocked;
  const outcome = outcomeOf(record);
  return {
    status,
    phase: projection.phase,
    status_message: oneLine(projection.message),
    allowed_actions: [ ...(canCancel ? ["cancel_run"] : []), ...(awaitingChoice ? ["decide_blocked_run"] : []) ],
    ...(outcome?.error === undefined ? {} : { error: outcome.error }),
    ...(blocked === undefined ? {} : { blocked_step: blocked }),
  };
}
