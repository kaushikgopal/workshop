import type { Database } from "bun:sqlite";
import type {
  ActivationState,
  AttemptRow,
  BlockKind,
  DesiredState,
  FailureKind,
  RunRow,
  RunStatus,
  WorkflowRow,
} from "./types.js";
import * as attempts from "./attempts.js";
import * as rows from "./rows.js";
import * as runs from "./runs.js";
import * as workflows from "./workflows.js";

export type {
  ActivationState,
  AttemptRow,
  AttemptStatus,
  BlockKind,
  DesiredState,
  FailureKind,
  OrchestratorPhase,
  RunRow,
  RunStatus,
  WorkflowRow,
} from "./types.js";
export { CapacityRejected, GuardRejected } from "./types.js";
export { isTerminal } from "./rows.js";

/**
 * Store operations. Every transition that could race uses a guarded
 * compare-and-set inside a transaction that re-checks run status, desired
 * state, and orchestrator phase. "CAS" here means: UPDATE ... WHERE guard
 * conditions, then require changes() === 1.
 *
 * The SQL lives in ./rows.ts, ./workflows.ts, ./runs.ts, and ./attempts.ts;
 * this class composes it, passing itself as each module's context so the
 * re-entrant tx() below stays the one transaction helper.
 */
export class Store {
  private inTx = false;
  constructor(readonly db: Database) {}

  /** Immediate transactions; re-entrant for composed operations. */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  getWorkflow(workflowId: string): WorkflowRow | null {
    return workflows.getWorkflow(this, workflowId);
  }

  listWorkflows(): WorkflowRow[] {
    return workflows.listWorkflows(this);
  }

  upsertWorkflowActivation(input: {
    workflowId: string;
    definitionPath: string;
    definitionHash: string;
    every: string | null;
    maxRuns: number | null;
    now: Date;
  }): { created: boolean } {
    return workflows.upsertWorkflowActivation(this, input);
  }

  setActivationState(workflowId: string, state: ActivationState): void {
    workflows.setActivationState(this, workflowId, state);
  }

  getRun(runId: string): RunRow | null {
    return rows.getRun(this, runId);
  }

  getUnresolvedRun(workflowId: string): RunRow | null {
    return rows.getUnresolvedRun(this, workflowId);
  }

  getMostRecentRun(workflowId: string): RunRow | null {
    return rows.getMostRecentRun(this, workflowId);
  }

  listRuns(workflowId?: string): RunRow[] {
    return rows.listRuns(this, workflowId);
  }

  listUnresolvedRuns(): RunRow[] {
    return rows.listUnresolvedRuns(this);
  }

  listPendingAdmissions(): RunRow[] {
    return rows.listPendingAdmissions(this);
  }

  createRun(input: {
    workflowId: string;
    definitionHash: string;
    definitionYaml: string;
    runsDir: string;
    now: Date;
    mode: "manual" | "scheduled";
    isRecurring: boolean;
    everyMs: number | null;
  }): { runId: string; created: boolean } {
    return runs.createRun(this, input);
  }

  consumeScheduledOverlap(workflowId: string, now: Date, everyMs: number): string | null {
    return runs.consumeScheduledOverlap(this, workflowId, now, everyMs);
  }

  markAdmissionReady(runId: string, now: Date): boolean {
    return runs.markAdmissionReady(this, runId, now);
  }

  failAdmission(runId: string, error: string, now: Date): void {
    runs.failAdmission(this, runId, error, now);
  }

  failRunIntegrity(runId: string, error: string, now: Date): void {
    runs.failRunIntegrity(this, runId, error, now);
  }

  failPendingPacketIntegrity(input: { runId: string; nodeId: string; attempt: number; error: string; now: Date }): boolean {
    return runs.failPendingPacketIntegrity(this, input);
  }

  setDesiredState(runId: string, desired: DesiredState, now: Date): void {
    runs.setDesiredState(this, runId, desired, now);
  }

  setRunStatus(runId: string, status: RunStatus, now: Date, blockKind: BlockKind | null): void {
    runs.setRunStatus(this, runId, status, now, blockKind);
  }

  getAttempt(runId: string, nodeId: string, attempt: number): AttemptRow | null {
    return attempts.getAttempt(this, runId, nodeId, attempt);
  }

  getLiveAttempt(runId: string): AttemptRow | null {
    return attempts.getLiveAttempt(this, runId);
  }

  listAttempts(runId: string): AttemptRow[] {
    return attempts.listAttempts(this, runId);
  }

  createSuccessorAttempt(input: {
    runId: string;
    nodeId: string;
    resolvedMaxAttempts: number;
    resolvedTimeoutMs: number | null;
    chainPosition: number;
    now: Date;
  }): AttemptRow {
    return attempts.createSuccessorAttempt(this, input);
  }

  createRetryAttempt(input: {
    runId: string;
    nodeId: string;
    previousAttempt: number;
    resolvedMaxAttempts: number;
    resolvedTimeoutMs: number | null;
    chainPosition: number;
    now: Date;
  }): AttemptRow | null {
    return attempts.createRetryAttempt(this, input);
  }

  resumeBlockedRun(input: { runId: string; now: Date }): AttemptRow | null {
    return attempts.resumeBlockedRun(this, input);
  }

  claimAttempt(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    now: Date;
    maxConcurrentRuns: number;
  }): { ownerToken: string; pgid: number; startId: string } {
    return attempts.claimAttempt(this, input);
  }

  recordChildIdentity(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return attempts.recordChildIdentity(this, input);
  }

  recordValidatorIdentity(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return attempts.recordValidatorIdentity(this, input);
  }

  clearAttemptProcessIdentity(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    role: "worker" | "validator"; pid: number; startId: string; pgid: number; now: Date;
  }): boolean {
    return attempts.clearAttemptProcessIdentity(this, input);
  }

  confirmAttemptProcessStopped(input: {
    runId: string; nodeId: string; attempt: number; role: "worker" | "validator";
    pid: number; startId: string; pgid: number; now: Date;
  }): boolean {
    return attempts.confirmAttemptProcessStopped(this, input);
  }

  recordResolvedExecution(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    harnessTemplate: string; harnessCommand: string; model: string | null; now: Date;
  }): boolean {
    return attempts.recordResolvedExecution(this, input);
  }

  heartbeat(input: { runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date }): boolean {
    return attempts.heartbeat(this, input);
  }

  setProgress(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string; progress: string; now: Date;
  }): boolean {
    return attempts.setProgress(this, input);
  }

  claimFinishing(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string; now: Date;
    nodeOutputPath: string; validatorStatus: "passed" | "failed" | null; validatorReason: string | null;
  }): void {
    attempts.claimFinishing(this, input);
  }

  completeAttempt(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    now: Date;
    successor: { nodeId: string; resolvedMaxAttempts: number; resolvedTimeoutMs: number | null; chainPosition: number } | null;
  }): { completed: boolean; successorCreated: boolean } {
    return attempts.completeAttempt(this, input);
  }

  blockAttempt(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string;
    blockKind: BlockKind; reason: string; now: Date;
  }): boolean {
    return attempts.blockAttempt(this, input);
  }

  failAttempt(input: {
    runId: string; nodeId: string; attempt: number; ownerToken: string | null;
    failureKind: FailureKind; validatorReason?: string | null; protectForOrchestration?: boolean; now: Date;
  }): { failed: boolean; orchestratorPending: boolean } {
    return attempts.failAttempt(this, input);
  }

  stopRun(input: { runId: string; now: Date }): void {
    runs.stopRun(this, input);
  }

  finalizeStoppedRun(input: { runId: string; now: Date }): boolean {
    return runs.finalizeStoppedRun(this, input);
  }

  transferFinishingOwner(input: {
    runId: string; nodeId: string; attempt: number; priorOwnerToken: string; now: Date;
  }): string | null {
    return attempts.transferFinishingOwner(this, input);
  }

  claimOrchestrator(runId: string, now: Date, maxConcurrentRuns: number): { ownerToken: string } | null {
    return runs.claimOrchestrator(this, runId, now, maxConcurrentRuns);
  }

  recordOrchestratorIdentity(input: {
    runId: string; ownerToken: string; childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return runs.recordOrchestratorIdentity(this, input);
  }

  heartbeatOrchestrator(input: { runId: string; ownerToken: string; now: Date }): boolean {
    return runs.heartbeatOrchestrator(this, input);
  }

  clearOrchestratorIdentity(input: {
    runId: string; ownerToken: string; childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return runs.clearOrchestratorIdentity(this, input);
  }

  confirmOrchestratorProcessStopped(input: {
    runId: string; childPid: number; childStartId: string; childPgid: number; now: Date;
  }): boolean {
    return runs.confirmOrchestratorProcessStopped(this, input);
  }

  claimApplying(input: { runId: string; ownerToken: string; resultPath: string; now: Date }): boolean {
    return runs.claimApplying(this, input);
  }

  applyOrchestratorDecision(input: {
    runId: string; ownerToken: string; decision: "retry" | "block" | "fail"; now: Date;
  }): { effectNodeId: string | null; effectAttempt: number | null } {
    return runs.applyOrchestratorDecision(this, input);
  }

  releaseOrchestratorToPending(runId: string, ownerToken: string, now: Date): boolean {
    return runs.releaseOrchestratorToPending(this, runId, ownerToken, now);
  }

  operatorResetOrchestrator(runId: string, now: Date): boolean {
    return runs.operatorResetOrchestrator(this, runId, now);
  }

  hasExecutionCapacity(maxConcurrentRuns: number): boolean {
    return workflows.hasExecutionCapacity(this, maxConcurrentRuns);
  }

  assertRunnableForClaim(runId: string): void {
    attempts.assertRunnableForClaim(this, runId);
  }

  assertRunnable(runId: string): void {
    attempts.assertRunnable(this, runId);
  }
}
