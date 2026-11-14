import { resumeHook } from "eve/workflow/api";
import { resolve } from "node:path";
import { recordActionLog, type RecordActionLogInput, type ActionLogEntry } from "../../run/record-action-log.ts";
import { locateBlockedStep } from "../../run/locate-blocked-step.ts";
import { readBlockedStep } from "../../run/read-blocked-step.ts";
import { parseWorkflowDecision } from "../../workflow/parse-workflow-decision.ts";
import type { WorkflowDecision } from "../../workflow/types.ts";

type DecisionSenderOptions = {
  stateRoot?: string;
  resume?: (token: string, decision: WorkflowDecision) => Promise<void>;
  appendAction?: (entry: RecordActionLogInput) => void | Promise<void>;
};

function decisionNote(decision: WorkflowDecision): string {
  if (decision.action === "retry") {
    return [decision.hint, decision.after === undefined ? undefined : `retry after ${decision.after}`].filter(Boolean).join("; ");
  }
  if (decision.action === "skip") return "Step skipped by chat decision.";
  if (decision.action === "accept") return "Last output accepted by chat decision.";
  return "Run failed by chat decision.";
}

export async function sendWorkflowDecision(runId: string, decision: WorkflowDecision, options: DecisionSenderOptions = {}): Promise<void> {
  const checkedDecision = parseWorkflowDecision(decision);
  const stateRoot = options.stateRoot ?? resolve(process.cwd(), "state");
  const blocked = readBlockedStep(locateBlockedStep(stateRoot, runId));
  if (!blocked) throw new Error(`Workflow run ${runId} is not waiting on a decision`);
  if (checkedDecision.action === "retry" && checkedDecision.profile !== undefined && !blocked.retry_profiles.includes(checkedDecision.profile)) {
    throw new Error(`Profile "${checkedDecision.profile}" cannot retry ${blocked.step_kind} step ${blocked.step}`);
  }
  const resume = options.resume ?? ((token, payload) => resumeHook(token, payload));
  await resume(blocked.token, checkedDecision);
  const action: Omit<ActionLogEntry, "at"> = {
    workflow: blocked.workflow,
    run_id: blocked.run_id,
    step: blocked.step,
    source: "chat",
    decision: checkedDecision,
    note: decisionNote(checkedDecision),
  };
  if (options.appendAction) await options.appendAction(action);
  else recordActionLog(resolve(stateRoot, "actions.jsonl"), action);
}
