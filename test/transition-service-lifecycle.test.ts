import assert from "node:assert/strict";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { test } from "node:test";
import { closeServiceStore, createServiceLifecycle, openServiceHarness, serviceCanDispatchRequests, transitionServiceLifecycle } from "../service/start-service.ts";

test("service lifecycle admits dispatch only after readiness and stops once", () => {
  let state = createServiceLifecycle();
  assert.equal(serviceCanDispatchRequests(state), false);

  const ready = transitionServiceLifecycle(state, { type: "ready" });
  assert.equal(ready.kind, "accepted");
  if (ready.kind !== "accepted") throw new Error("Starting service should become ready");
  state = ready.state;
  assert.equal(state.kind, "ready");
  assert.equal(serviceCanDispatchRequests(state), true);

  const stopping = transitionServiceLifecycle(state, { type: "stop", cause: "SIGTERM" });
  assert.equal(stopping.kind, "accepted");
  if (stopping.kind !== "accepted") throw new Error("Ready service should stop");
  state = stopping.state;
  assert.equal(state.kind, "stopping");
  assert.equal(transitionServiceLifecycle(state, { type: "stop", cause: "SIGINT" }).kind, "already-stopping");

  const stopped = transitionServiceLifecycle(state, { type: "stopped", result: "success" });
  assert.equal(stopped.kind, "accepted");
  if (stopped.kind !== "accepted") throw new Error("Stopping service should become stopped");
  state = stopped.state;
  assert.equal(state.kind, "stopped");
  assert.equal(transitionServiceLifecycle(state, { type: "stop", cause: "SIGINT" }).kind, "already-stopped");
  assert.equal(serviceCanDispatchRequests(state), false);
});

test("startup failure rejects readiness but can still stop and clean up", () => {
  const starting = createServiceLifecycle();
  const failed = transitionServiceLifecycle(starting, { type: "fail", error: new Error("bootstrap failed") });
  assert.equal(failed.kind, "accepted");
  if (failed.kind !== "accepted") throw new Error("Starting service should fail");
  assert.equal(failed.state.kind, "failed");
  assert.equal(serviceCanDispatchRequests(failed.state), false);
  assert.equal(transitionServiceLifecycle(failed.state, { type: "ready" }).kind, "rejected");

  const stopping = transitionServiceLifecycle(failed.state, { type: "stop", cause: "startup failure" });
  assert.equal(stopping.kind, "accepted");
  if (stopping.kind !== "accepted") throw new Error("Failed service should enter cleanup");
  assert.equal(transitionServiceLifecycle(stopping.state, { type: "stopped", result: "failed" }).kind, "accepted");
});

test("out-of-order lifecycle events leave the service state unchanged", () => {
  const starting = createServiceLifecycle();
  const rejected = transitionServiceLifecycle(starting, { type: "stopped", result: "success" });
  assert.deepEqual(rejected, { kind: "rejected", code: "invalid-transition", state: starting });
  assert.equal(starting.kind, "starting");
});

test("a failed harness cleanup retains storage ownership until closure is confirmed", async () => {
  const storage = await openNodeSqliteStorage(":memory:");
  const originalClose = storage.close.bind(storage);
  let closeCalls = 0;
  let releaseCalls = 0;
  let storageClosed = false;
  storage.close = async () => {
    closeCalls += 1;
    throw new Error("injected storage cleanup failure");
  };
  const lifecycle = createServiceLifecycle();
  if (lifecycle.kind !== "starting") throw new Error("New service should be starting");
  const resources = lifecycle.resources;
  resources.storage = storage;
  resources.storeLock = { release: async () => { releaseCalls += 1; } };

  try {
    await assert.rejects(openServiceHarness(resources, async () => {
      try {
        await storage.close(BACKGROUND_CONTEXT);
      } catch (cleanupError) {
        throw new AggregateError([new Error("injected harness initialization failure"), cleanupError], "harness startup and cleanup failed");
      }
      throw new Error("Expected the injected cleanup failure");
    }), /harness startup and cleanup failed/);

    const firstCleanup = await closeServiceStore(resources);
    const ownershipAfterFailure = {
      storageRetained: resources.storage === storage,
      markedClosed: resources.storageClosed,
      ownerReleased: releaseCalls > 0,
      closeResult: firstCleanup.kind,
      closeCalls,
    };
    storage.close = originalClose;
    const secondCleanup = await closeServiceStore(resources);
    storageClosed = ownershipAfterFailure.storageRetained && secondCleanup.kind === "closed";

    assert.deepEqual(ownershipAfterFailure, {
      storageRetained: true,
      markedClosed: false,
      ownerReleased: false,
      closeResult: "failed",
      closeCalls: 2,
    });
    assert.deepEqual(secondCleanup, { kind: "closed" });
    assert.equal(releaseCalls, 1);
  } finally {
    storage.close = originalClose;
    if (!storageClosed) await originalClose(BACKGROUND_CONTEXT);
  }
});
