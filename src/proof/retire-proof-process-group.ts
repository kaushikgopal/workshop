import { processStartId } from "../process/identify-process.js";
import { terminateProcessGroup } from "../process/kill-process-tree.js";
import type { ProcessIdentity } from "./types.js";

/**
 * Retire the process group a recorded identity leads and confirm that no
 * member survives. A dead leader never means the group is empty: descendants
 * keep the group alive, so the whole group is terminated and polled through
 * the shared `terminateProcessGroup` semantics.
 *
 * The leader's start identity guards against PID reuse. A live pid under a
 * different start identity means the kernel recycled the pid, which POSIX
 * allows only after the recorded group's lifetime ended; the group at that
 * pgid is a stranger and must not be signalled. That case counts as retired.
 */
export async function retireProofProcessGroup(identity: ProcessIdentity, graceMs = 2000): Promise<boolean> {
  // Every proof launch records the leader's own pid as the group. A mismatch
  // means the record cannot identify a group, so nothing is signalled.
  if (identity.pgid !== identity.pid) return false;
  const currentStartId = processStartId(identity.pid);
  if (currentStartId !== null && currentStartId !== identity.startId) return true;
  return terminateProcessGroup(identity.pgid, graceMs);
}
