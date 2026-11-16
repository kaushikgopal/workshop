export type WorkflowPauseState = "paused" | "unpaused";
export type WorkflowPauseEvent = "pause" | "resume";

export type WorkflowPauseTransition =
  | { kind: "changed"; state: WorkflowPauseState }
  | { kind: "already-paused"; state: "paused" }
  | { kind: "already-unpaused"; state: "unpaused" };

export function transitionWorkflowPause(
  state: WorkflowPauseState,
  event: WorkflowPauseEvent,
): WorkflowPauseTransition {
  if (event === "pause") {
    return state === "paused"
      ? { kind: "already-paused", state }
      : { kind: "changed", state: "paused" };
  }
  return state === "unpaused"
    ? { kind: "already-unpaused", state }
    : { kind: "changed", state: "unpaused" };
}
