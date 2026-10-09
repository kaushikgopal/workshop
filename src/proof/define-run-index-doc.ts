import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Session-scoped identity of the one proof run this state dir owns. Reopening
 * reads it and reuses the run and task instead of creating another.
 */
export const RunIndexDoc = defineDoc<{ runId: string | null; taskId: number | null }>({
  kind: "proof.run-index",
  version: 1,
  scope: "session",
  initial: () => ({ runId: null, taskId: null }),
});
