import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { canonicalHash } from "../src/definition/hash-canonical-json.js";
import { openDurableStorage } from "../src/storage/durable/open-durable-storage.js";
import {
  admitRecoveryIntent,
  clearActiveRecoveryRequest,
  handleRecoveryRestart,
  initializeRecoveryIndex,
  markRecoveryActionDispatching,
  markRecoveryGlobalDispatching,
  recordRecoveryActionReceipt,
  recordRecoveryContinuationConsent,
  recordRecoveryDeathEvidence,
  refuseRecoveryAction,
  recordRecoveryGlobalDispatchReceipt,
  settleRecoveryAction,
} from "../src/storage/durable/commit-recovery-intent.js";
import {
  recoveryActionIntentV1Schema,
  type RecoveryActionIntentV1,
} from "../src/storage/durable/schema-recovery.js";

const HASH = `sha256:${"a".repeat(64)}`;
const TIME = "2026-11-06T12:00:00.000Z";
const INSTALLATION_ID = "cdd6937f-09a6-4809-a75f-1ca6e75c2400";
const REQUEST_ID = "2b92e773-9e80-4b4a-8cff-97795cda5c78";
const NEXT_REQUEST_ID = "75f51114-8870-412f-9a85-331315f065c6";
const OTHER_REQUEST_ID = "e194ff07-2005-4d04-96da-8c7525cb9a10";
const OWNER = {
  conversationId: 2,
  taskOwnerId: null,
  conversationOwner: null,
  ownershipHash: HASH,
} as const;

async function withRecoveryHarness<T>(work: (harness: Harness) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "workshop-recovery-intent-"));
  let harness: Harness | undefined;
  try {
    const opened = await openDurableStorage(join(directory, "durable.sqlite"));
    if (!opened.ok) throw new Error(`${opened.failure.message}: ${String(opened.failure.cause)}`);
    harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    return await work(harness);
  } finally {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
}

function recoveryAction(taskId: number, action: "abort" | "retry" = "abort"): RecoveryActionIntentV1 {
  return {
    taskId,
    taskKind: "workshop.test.recovery-probe",
    taskVersion: 1,
    action,
    owner: OWNER,
    inputHash: HASH,
    checkpointHash: HASH,
    process: null,
    replaySafety: action === "retry" ? "safe" : "unknown",
  };
}

function admission(
  harness: Harness,
  requestId: string,
  actions: readonly RecoveryActionIntentV1[],
  options: { reason?: string; supersedesRequestId?: string | null; resumeInstallation?: boolean } = {},
) {
  return {
    harness,
    context: BACKGROUND_CONTEXT,
    requestId,
    manifestDigest: HASH,
    reason: options.reason ?? "Retire interrupted tasks after review",
    confirmedAt: TIME,
    resumeInstallation: options.resumeInstallation ?? true,
    supersedesRequestId: options.supersedesRequestId ?? null,
    actions,
    committedAt: TIME,
  };
}

describe("Durable recovery intent journal", () => {
  test("validates retry policy and completes an attested recovery without replay", async () => {
    const identityFreeProcess = {
      executionId: "execution-11",
      incarnationId: "incarnation-11",
      launchServiceBootId: null,
      identity: null,
    } as const;
    const unsafeRetry = recoveryActionIntentV1Schema.safeParse({
      ...recoveryAction(11, "retry"),
      process: identityFreeProcess,
      processEntryHash: HASH,
    });
    expect(unsafeRetry.success).toBe(false);

    await withRecoveryHarness(async (harness) => {
      const initialized = await initializeRecoveryIndex({ harness, context: BACKGROUND_CONTEXT, installationId: INSTALLATION_ID });
      expect(initialized).toEqual({ kind: "initialized", installationId: INSTALLATION_ID });
      expect(await initializeRecoveryIndex({ harness, context: BACKGROUND_CONTEXT, installationId: INSTALLATION_ID }))
        .toEqual({ kind: "already_initialized", installationId: INSTALLATION_ID });

      const attestedAction: RecoveryActionIntentV1 = {
        ...recoveryAction(11),
        process: identityFreeProcess,
        processEntryHash: HASH,
      };
      const retryAction = recoveryAction(12, "retry");
      const first = await admitRecoveryIntent(admission(harness, REQUEST_ID, [attestedAction, retryAction]));
      expect(first.kind).toBe("admitted");
      if (first.kind !== "admitted") throw new Error("expected recovery admission");
      expect(first.request.actions.map(({ occurrence, actionId }) => ({ occurrence, actionId }))).toEqual([
        { occurrence: 1, actionId: "task-11-occurrence-1" },
        { occurrence: 1, actionId: "task-12-occurrence-1" },
      ]);
      expect((await admitRecoveryIntent(admission(harness, REQUEST_ID, [attestedAction, retryAction]))).kind).toBe("replayed");
      expect(await admitRecoveryIntent(admission(harness, REQUEST_ID, [attestedAction, retryAction], { reason: "Changed review" })))
        .toMatchObject({ kind: "conflict", code: "idempotency_conflict" });

      const evidence = {
        kind: "operator_attested_absent" as const,
        method: "typed_terminal_confirmation" as const,
        attestingRequestId: REQUEST_ID,
        attestedAt: TIME,
        manifestDigest: HASH,
        processEntryHash: HASH,
        evidenceHash: canonicalHash({ statement: "no process exists" }),
      };
      expect(await recordRecoveryDeathEvidence({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11,
        evidence: { ...evidence, attestingRequestId: OTHER_REQUEST_ID },
      })).toMatchObject({ kind: "conflict", code: "death_proof_mismatch" });
      expect(await markRecoveryActionDispatching({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11, markedAt: TIME,
      })).toMatchObject({ kind: "conflict", code: "death_proof_required" });
      expect((await recordRecoveryDeathEvidence({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11, evidence,
      })).kind).toBe("updated");
      expect((await recordRecoveryDeathEvidence({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11, evidence,
      })).kind).toBe("already_recorded");

      expect((await markRecoveryActionDispatching({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11, markedAt: TIME,
      })).kind).toBe("updated");
      const abortReceipt = {
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11,
        method: "abortTask" as const, returnedAt: "2026-11-06T12:00:01.000Z", taskSnapshotHash: HASH,
      };
      expect((await recordRecoveryActionReceipt(abortReceipt)).kind).toBe("updated");
      expect((await recordRecoveryActionReceipt(abortReceipt)).kind).toBe("already_recorded");
      const settlement = {
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 11,
        settledAt: "2026-11-06T12:00:02.000Z",
        taskOutcome: { status: "blocked", reason: "unknown_external_effect" },
        processEvidenceHash: canonicalHash(evidence),
      };
      expect((await settleRecoveryAction(settlement)).kind).toBe("updated");
      expect((await settleRecoveryAction(settlement)).kind).toBe("already_recorded");

      expect((await recordRecoveryContinuationConsent({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, manifestDigest: HASH,
        confirmedAt: "2026-11-06T12:01:00.000Z", resumeInstallation: true,
        reason: "Resume installation after all abort marks",
      })).kind).toBe("updated");
      expect((await markRecoveryGlobalDispatching({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, firstRetryTaskId: 12,
        markedAt: "2026-11-06T12:01:01.000Z",
      })).kind).toBe("updated");
      const globalReceipt = {
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID,
        method: "retryTask" as const, taskId: 12,
        returnedAt: "2026-11-06T12:01:02.000Z", taskSnapshotHash: HASH,
      };
      expect((await recordRecoveryGlobalDispatchReceipt(globalReceipt)).kind).toBe("updated");
      expect((await recordRecoveryGlobalDispatchReceipt(globalReceipt)).kind).toBe("already_recorded");
      const cleared = await clearActiveRecoveryRequest({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID,
        mode: "readiness_verified", manifestDigest: HASH, checkedAt: "2026-11-06T12:02:00.000Z",
      });
      expect(cleared).toMatchObject({ kind: "updated", request: { state: "complete" } });

      const next = await admitRecoveryIntent(admission(harness, NEXT_REQUEST_ID, [attestedAction]));
      expect(next).toMatchObject({
        kind: "admitted",
        request: { actions: [{ occurrence: 2, actionId: "task-11-occurrence-2" }] },
      });
    });
  });

  test("binds host death proof to its exact incarnation and records action refusal", async () => {
    await withRecoveryHarness(async (harness) => {
      await initializeRecoveryIndex({ harness, context: BACKGROUND_CONTEXT, installationId: INSTALLATION_ID });
      const identity = {
        pid: 321,
        pgid: 321,
        startIdentity: "start-identity-31",
        serviceBootId: "6af76db8-103c-477d-9e61-2bfb6a87df00",
      } as const;
      const process = {
        executionId: "execution-31",
        incarnationId: "incarnation-31",
        launchServiceBootId: identity.serviceBootId,
        identity,
      } as const;
      const processAction: RecoveryActionIntentV1 = { ...recoveryAction(31), process, processEntryHash: HASH };
      const refusalAction = recoveryAction(32);
      expect((await admitRecoveryIntent(admission(harness, REQUEST_ID, [processAction, refusalAction]))).kind).toBe("admitted");

      const evidence = {
        kind: "confirmed_dead" as const,
        method: "process_group_absent" as const,
        hostBootId: "2df34fe9-3b34-4bde-aa48-2d585c04a024",
        observedAt: "2026-11-06T12:05:00.000Z",
        identity,
        executionId: process.executionId,
        incarnationId: process.incarnationId,
        launchServiceBootId: process.launchServiceBootId,
        inputHash: HASH,
        checkpointHash: HASH,
        processEntryHash: HASH,
      };
      expect(await recordRecoveryDeathEvidence({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 31,
        evidence: { ...evidence, incarnationId: "wrong-incarnation" },
      })).toMatchObject({ kind: "conflict", code: "death_proof_mismatch" });
      expect((await recordRecoveryDeathEvidence({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 31, evidence,
      })).kind).toBe("updated");
      const refusal = {
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID, taskId: 32,
        code: "operator_refused", refusedAt: "2026-11-06T12:05:01.000Z",
      };
      expect((await refuseRecoveryAction(refusal)).kind).toBe("updated");
      expect((await refuseRecoveryAction(refusal)).kind).toBe("already_recorded");
      expect(await clearActiveRecoveryRequest({
        harness, context: BACKGROUND_CONTEXT, requestId: REQUEST_ID,
        mode: "refused", manifestDigest: HASH, refusedAt: "2026-11-06T12:06:00.000Z", reasonCode: "operator_refused",
      })).toMatchObject({
        kind: "updated",
        request: { state: "refused", actions: [{ state: "refused" }, { state: "refused" }] },
      });
    });
  });


  test("serializes concurrent admission and marks an interrupted dispatch indeterminate", async () => {
    await withRecoveryHarness(async (harness) => {
      await initializeRecoveryIndex({ harness, context: BACKGROUND_CONTEXT, installationId: INSTALLATION_ID });
      const contenders = await Promise.all([
        admitRecoveryIntent(admission(harness, REQUEST_ID, [recoveryAction(21)])),
        admitRecoveryIntent(admission(harness, NEXT_REQUEST_ID, [recoveryAction(22)])),
      ]);
      expect(contenders.filter((result) => result.kind === "admitted")).toHaveLength(1);
      expect(contenders.filter((result) => result.kind === "conflict" && result.code === "recovery_in_progress")).toHaveLength(1);
      const active = contenders.find((result) => result.kind === "admitted");
      if (active?.kind !== "admitted") throw new Error("expected one admitted request");
      const requestId = active.request.intent?.requestId;
      if (requestId === undefined) throw new Error("expected admitted request identity");
      const taskId = active.request.actions[0]!.taskId;

      expect((await markRecoveryActionDispatching({
        harness, context: BACKGROUND_CONTEXT, requestId, taskId, markedAt: TIME,
      })).kind).toBe("updated");
      const restarted = await handleRecoveryRestart({
        harness, context: BACKGROUND_CONTEXT, requestId,
        observedBootId: "5f8f8ac0-30c6-4b6d-b72a-06d1378d3adf", observedAt: "2026-11-06T12:03:00.000Z",
      });
      expect(restarted).toMatchObject({ kind: "updated", request: { actions: [{ state: "indeterminate" }] } });
      expect(await recordRecoveryActionReceipt({
        harness, context: BACKGROUND_CONTEXT, requestId, taskId,
        method: "abortTask", returnedAt: "2026-11-06T12:03:01.000Z",
      })).toMatchObject({ kind: "conflict", code: "dispatch_uncertain" });
      expect((await handleRecoveryRestart({
        harness, context: BACKGROUND_CONTEXT, requestId,
        observedBootId: "5f8f8ac0-30c6-4b6d-b72a-06d1378d3adf", observedAt: "2026-11-06T12:03:02.000Z",
      })).kind).toBe("already_recorded");
      expect(await clearActiveRecoveryRequest({
        harness, context: BACKGROUND_CONTEXT, requestId,
        mode: "refused", manifestDigest: HASH, refusedAt: "2026-11-06T12:04:00.000Z", reasonCode: "fresh_review_required",
      })).toMatchObject({ kind: "updated", request: { state: "refused", actions: [{ state: "indeterminate" }] } });
    });
  });
});
