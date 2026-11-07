import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { RecoveryIndexV1, RecoveryRequestV1 } from "./schema-recovery.js";

/** Session-scoped recovery installation identity, active reservation, and permanent occurrence index. */
export const WorkshopRecoveryIndexDoc = defineDoc<RecoveryIndexV1>({
  kind: "workshop.recovery-index",
  version: 1,
  checkpointWhen: () => true,
  scope: "session",
  initial: () => ({ state: "uninitialized" }),
});

/** Session-scoped request family; request identities and receipts are retained without eviction. */
export const WorkshopRecoveryRequestDoc = defineDocFamily<RecoveryRequestV1, string>({
  kind: "workshop.recovery-request",
  version: 1,
  checkpointWhen: () => true,
  scope: "session",
  family: true,
  initial: (requestId) => ({
    requestId,
    state: "unadmitted",
    intent: null,
    actions: [],
    continuations: [],
    globalDispatch: null,
    restartEvents: [],
    createdAt: null,
    closedAt: null,
    closure: null,
    supersededBy: null,
  }),
});
