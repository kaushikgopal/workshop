import { z } from "zod";
import { identifyHostBoot } from "./identify-host-boot.js";
import { processGroupId, processStartIdForVerification } from "./identify-process.js";
import { probeProcessGroup, terminateProcessGroup, type ProcessGroupProbeResult } from "./kill-process-tree.js";
import { processIdentitySchema } from "./schema.js";

export interface PersistedProcessIdentity {
  pid: number;
  pgid: number;
  startIdentity: string;
  serviceBootId: string;
}

/** The persisted fields required to verify or retire one process incarnation. */
export interface ProcessDeathTarget {
  identity: PersistedProcessIdentity | null;
  launchServiceBootId?: string;
}

export type ProcessDeathRefusalReason =
  | "identity_missing"
  | "host_boot_unavailable"
  | "boot_mismatch"
  | "pid_reused_group_alive"
  | "group_alive"
  | "probe_denied"
  | "retire_failed"
  | "probe_error";

export type ProcessDeathVerification =
  | {
    kind: "confirmed_absent";
    method: "group_absent_probe";
    checkedIdentity: PersistedProcessIdentity;
    hostBootId: string;
    observedAt: string;
  }
  | {
    kind: "retired_after_identity_match";
    checkedIdentity: PersistedProcessIdentity;
    hostBootId: string;
    observedAt: string;
  }
  | {
    kind: "refused";
    reason: ProcessDeathRefusalReason;
    checkedIdentity: PersistedProcessIdentity | null;
    observedAt: string;
  };

export interface ProcessDeathVerifierDependencies {
  identifyHostBoot: () => string | null;
  probeGroup: (pgid: number) => ProcessGroupProbeResult;
  processStartId: (pid: number) => string | null;
  processGroupId: (pid: number) => number | null;
  terminateGroup: (pgid: number) => Promise<boolean>;
}

const defaultDependencies: ProcessDeathVerifierDependencies = {
  identifyHostBoot,
  probeGroup: probeProcessGroup,
  processStartId: processStartIdForVerification,
  processGroupId,
  terminateGroup: terminateProcessGroup,
};

/** Confirm group absence, or safely retire a group whose recorded identity still matches. */
export async function verifyProcessDeath(
  target: ProcessDeathTarget,
  dependencies: Partial<ProcessDeathVerifierDependencies> = {},
): Promise<ProcessDeathVerification> {
  const parsed = processIdentitySchema.safeParse(target.identity);
  if (!parsed.success) return refused("identity_missing", null);
  const identity = parsed.data;
  const checkedIdentity: PersistedProcessIdentity = identity;
  const tools = { ...defaultDependencies, ...dependencies };
  let hostBootId: string | null;
  try {
    hostBootId = tools.identifyHostBoot();
  } catch {
    return refused("host_boot_unavailable", checkedIdentity);
  }
  const checkedBootId = z.string().uuid().safeParse(hostBootId);
  if (!checkedBootId.success) return refused("host_boot_unavailable", checkedIdentity);
  hostBootId = checkedBootId.data;

  let initialProbe = probe(tools.probeGroup, identity.pgid);
  if (initialProbe.state === "absent") return confirmedAbsent(checkedIdentity, hostBootId);
  if (initialProbe.state === "denied") return refused("probe_denied", checkedIdentity);
  if (initialProbe.state === "error") return refused("probe_error", checkedIdentity);

  if (target.launchServiceBootId === undefined || target.launchServiceBootId !== identity.serviceBootId) {
    return refused("boot_mismatch", checkedIdentity);
  }

  let currentStartIdentity: string | null;
  try {
    currentStartIdentity = tools.processStartId(identity.pid);
  } catch {
    return refused("probe_error", checkedIdentity);
  }
  if (currentStartIdentity !== identity.startIdentity) {
    initialProbe = probe(tools.probeGroup, identity.pgid);
    if (initialProbe.state === "absent") return confirmedAbsent(checkedIdentity, hostBootId);
    if (initialProbe.state === "denied") return refused("probe_denied", checkedIdentity);
    if (initialProbe.state === "error") return refused("probe_error", checkedIdentity);
    return refused("pid_reused_group_alive", checkedIdentity);
  }

  let currentProcessGroup: number | null;
  try {
    currentProcessGroup = tools.processGroupId(identity.pid);
  } catch {
    return refused("probe_error", checkedIdentity);
  }
  if (currentProcessGroup !== identity.pgid) {
    initialProbe = probe(tools.probeGroup, identity.pgid);
    if (initialProbe.state === "absent") return confirmedAbsent(checkedIdentity, hostBootId);
    if (initialProbe.state === "denied") return refused("probe_denied", checkedIdentity);
    if (initialProbe.state === "error") return refused("probe_error", checkedIdentity);
    return refused("group_alive", checkedIdentity);
  }

  try {
    await tools.terminateGroup(identity.pgid);
  } catch {
    return refused("retire_failed", checkedIdentity);
  }

  const finalProbe = probe(tools.probeGroup, identity.pgid);
  if (finalProbe.state === "absent") {
    return {
      kind: "retired_after_identity_match",
      checkedIdentity,
      hostBootId,
      observedAt: new Date().toISOString(),
    };
  }
  if (finalProbe.state === "denied") return refused("probe_denied", checkedIdentity);
  if (finalProbe.state === "error") return refused("probe_error", checkedIdentity);
  return refused("retire_failed", checkedIdentity);
}

function probe(
  probeGroup: ProcessDeathVerifierDependencies["probeGroup"],
  pgid: number,
): ProcessGroupProbeResult {
  try {
    return probeGroup(pgid);
  } catch (error) {
    return { state: "error", error };
  }
}

function confirmedAbsent(checkedIdentity: PersistedProcessIdentity, hostBootId: string): ProcessDeathVerification {
  return {
    kind: "confirmed_absent",
    method: "group_absent_probe",
    checkedIdentity,
    hostBootId,
    observedAt: new Date().toISOString(),
  };
}

function refused(
  reason: ProcessDeathRefusalReason,
  checkedIdentity: PersistedProcessIdentity | null,
): ProcessDeathVerification {
  return { kind: "refused", reason, checkedIdentity, observedAt: new Date().toISOString() };
}
