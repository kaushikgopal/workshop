import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { identifyHostBoot } from "../src/process/identify-host-boot.js";
import { processGroupId, processStartIdOrThrow } from "../src/process/identify-process.js";
import { probeProcessGroup, terminateProcessGroup } from "../src/process/kill-process-tree.js";
import { verifyProcessDeath, type PersistedProcessIdentity } from "../src/process/verify-process-death.js";

interface DetachedChild {
  pid: number;
  pgid: number;
  startIdentity: string;
}

async function spawnDetachedChild(): Promise<DetachedChild> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error("detached child has no PID");
  child.unref();
  const pgid = processGroupId(child.pid);
  if (pgid === null) throw new Error(`cannot read process group for pid ${child.pid}`);
  return { pid: child.pid, pgid, startIdentity: processStartIdOrThrow(child.pid) };
}

function persistedIdentity(child: DetachedChild, serviceBootId: string): PersistedProcessIdentity {
  return {
    pid: child.pid,
    pgid: child.pgid,
    startIdentity: child.startIdentity,
    serviceBootId,
  };
}

async function cleanup(child: DetachedChild): Promise<void> {
  expect(await terminateProcessGroup(child.pgid, 50)).toBe(true);
}

function expectObservation(value: string): void {
  expect(Number.isFinite(Date.parse(value))).toBe(true);
}

describe("identity-aware process-death verification", () => {
  test("retires a live group only after the recorded process identity matches", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    const identity = persistedIdentity(child, serviceBootId);
    try {
      const result = await verifyProcessDeath({ identity, launchServiceBootId: serviceBootId });
      expect(result.kind).toBe("retired_after_identity_match");
      expect(result.checkedIdentity).toEqual(identity);
      if (result.kind !== "refused") expect(result.hostBootId === identifyHostBoot()).toBe(true);
      expectObservation(result.observedAt);
      expect(probeProcessGroup(child.pgid).state).toBe("absent");
    } finally {
      await cleanup(child);
    }
  });

  test("confirms an already-absent group with a signal-zero probe", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    const identity = persistedIdentity(child, serviceBootId);
    try {
      expect(await terminateProcessGroup(child.pgid, 50)).toBe(true);
      const result = await verifyProcessDeath({ identity, launchServiceBootId: serviceBootId });
      expect(result.kind).toBe("confirmed_absent");
      if (result.kind === "confirmed_absent") expect(result.method).toBe("group_absent_probe");
      if (result.kind !== "refused") expect(result.hostBootId === identifyHostBoot()).toBe(true);
      expect(result.checkedIdentity).toEqual(identity);
      expectObservation(result.observedAt);
    } finally {
      await cleanup(child);
    }
  });

  test("refuses a changed PID identity while its recorded group remains alive", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    const identity = { ...persistedIdentity(child, serviceBootId), startIdentity: "not-the-current-start" };
    try {
      const result = await verifyProcessDeath({ identity, launchServiceBootId: serviceBootId });
      expect(result).toMatchObject({ kind: "refused", reason: "pid_reused_group_alive", checkedIdentity: identity });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("refuses before probing or signalling when the host boot ID is unavailable or invalid", async () => {
    const serviceBootId = randomUUID();
    const identity = { pid: 123, pgid: 123, startIdentity: "start", serviceBootId };
    for (const identify of [() => null, () => "invalid", () => { throw new Error("unavailable"); }]) {
      let probed = false;
      const result = await verifyProcessDeath({ identity, launchServiceBootId: serviceBootId }, {
        identifyHostBoot: identify,
        probeGroup: () => { probed = true; return { state: "absent" }; },
      });
      expect(result).toMatchObject({ kind: "refused", reason: "host_boot_unavailable" });
      expect(probed).toBe(false);
    }
  });

  test("refuses an identity-free launch without probing or retiring a child", async () => {
    const child = await spawnDetachedChild();
    try {
      const result = await verifyProcessDeath({ identity: null });
      expect(result).toMatchObject({ kind: "refused", reason: "identity_missing", checkedIdentity: null });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("maps injected probe errors to probe_error without retiring the group", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    try {
      const result = await verifyProcessDeath(
        { identity: persistedIdentity(child, serviceBootId), launchServiceBootId: serviceBootId },
        { probeGroup: () => ({ state: "error", error: new Error("injected probe failure") }) },
      );
      expect(result).toMatchObject({ kind: "refused", reason: "probe_error" });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("maps process identity lookup errors to probe_error", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    try {
      const result = await verifyProcessDeath(
        { identity: persistedIdentity(child, serviceBootId), launchServiceBootId: serviceBootId },
        { processStartId: () => { throw new Error("injected identity lookup failure"); } },
      );
      expect(result).toMatchObject({ kind: "refused", reason: "probe_error" });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("maps a denied group probe to probe_denied", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    try {
      const result = await verifyProcessDeath(
        { identity: persistedIdentity(child, serviceBootId), launchServiceBootId: serviceBootId },
        { probeGroup: () => ({ state: "denied" }) },
      );
      expect(result).toMatchObject({ kind: "refused", reason: "probe_denied" });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("refuses a launch-boot mismatch while the recorded group is live", async () => {
    const child = await spawnDetachedChild();
    const identity = persistedIdentity(child, randomUUID());
    try {
      const result = await verifyProcessDeath({ identity, launchServiceBootId: randomUUID() });
      expect(result).toMatchObject({ kind: "refused", reason: "boot_mismatch" });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("refuses when the recorded PID is not a member of its recorded group", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    try {
      const result = await verifyProcessDeath(
        { identity: persistedIdentity(child, serviceBootId), launchServiceBootId: serviceBootId },
        { processGroupId: () => child.pgid + 1 },
      );
      expect(result).toMatchObject({ kind: "refused", reason: "group_alive" });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });

  test("refuses when identity-matched retirement cannot confirm absence", async () => {
    const child = await spawnDetachedChild();
    const serviceBootId = randomUUID();
    try {
      const result = await verifyProcessDeath(
        { identity: persistedIdentity(child, serviceBootId), launchServiceBootId: serviceBootId },
        { terminateGroup: async () => false },
      );
      expect(result).toMatchObject({ kind: "refused", reason: "retire_failed" });
      expect(probeProcessGroup(child.pgid).state).toBe("alive");
    } finally {
      await cleanup(child);
    }
  });
});
