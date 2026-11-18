import assert from "node:assert/strict";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harness } from "@earendil-works/pi-durable";
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

  const stopping = transitionServiceLifecycle(state, { type: "stop", signal: "SIGTERM" });
  assert.equal(stopping.kind, "accepted");
  if (stopping.kind !== "accepted") throw new Error("Ready service should stop");
  state = stopping.state;
  assert.equal(state.kind, "cleaning");
  if (state.kind !== "cleaning") throw new Error("Ready service should enter cleanup");
  assert.equal(state.cause, "SIGTERM");
  assert.deepEqual(state.completion, { kind: "return" });
  assert.equal(transitionServiceLifecycle(state, { type: "stop", signal: "SIGINT" }).kind, "already-stopping");

  const stopped = transitionServiceLifecycle(state, { type: "stopped" });
  assert.equal(stopped.kind, "accepted");
  if (stopped.kind !== "accepted") throw new Error("Cleaning service should become stopped");
  state = stopped.state;
  assert.equal(state.kind, "stopped");
  if (state.kind !== "stopped") throw new Error("Service should be stopped");
  assert.equal(state.result, "success");
  assert.equal(transitionServiceLifecycle(state, { type: "stop", signal: "SIGINT" }).kind, "already-stopped");
  assert.equal(serviceCanDispatchRequests(state), false);
});

test("startup failure waits for bootstrap settlement before cleanup", () => {
  const startupError = new Error("bootstrap failed");
  const starting = createServiceLifecycle();
  const failed = transitionServiceLifecycle(starting, { type: "fail", error: startupError });
  assert.equal(failed.kind, "accepted");
  if (failed.kind !== "accepted") throw new Error("Starting service should fail");
  let state = failed.state;
  assert.equal(state.kind, "boot-stop-requested");
  assert.equal(serviceCanDispatchRequests(state), false);
  assert.equal(transitionServiceLifecycle(state, { type: "ready" }).kind, "rejected");

  const settled = transitionServiceLifecycle(state, { type: "bootstrap-settled", error: startupError });
  assert.equal(settled.kind, "accepted");
  if (settled.kind !== "accepted") throw new Error("Failed bootstrap should begin cleanup");
  state = settled.state;
  assert.equal(state.kind, "cleaning");
  if (state.kind !== "cleaning") throw new Error("Failed bootstrap should clean up");
  assert.deepEqual(state.completion, { kind: "throw", error: startupError });
  assert.equal(state.result, "success");
  assert.equal(transitionServiceLifecycle(state, { type: "stopped" }).kind, "accepted");
});

test("out-of-order lifecycle events leave the service state unchanged", () => {
  const starting = createServiceLifecycle();
  const rejected = transitionServiceLifecycle(starting, { type: "stopped" });
  assert.deepEqual(rejected, { kind: "rejected", code: "invalid-transition", state: starting });
  assert.equal(starting.kind, "starting");
});

test("signal during an awaited bootstrap acquisition defers cleanup until it settles", async () => {
  let settleAcquisition!: (error: unknown) => void;
  const acquisition = new Promise<unknown>((resolve) => { settleAcquisition = resolve; });
  const lifecycle = { state: createServiceLifecycle() };
  let acquisitionSettled = false;
  let cleanupStarted = false;

  const bootstrap = (async () => {
    const error = await acquisition;
    acquisitionSettled = true;
    const settled = transitionServiceLifecycle(lifecycle.state, { type: "bootstrap-settled", error });
    assert.equal(settled.kind, "accepted");
    if (settled.kind !== "accepted") throw new Error("Stopped bootstrap should settle into cleanup");
    lifecycle.state = settled.state;
    cleanupStarted = lifecycle.state.kind === "cleaning";
  })();
  const stop = transitionServiceLifecycle(lifecycle.state, { type: "stop", signal: "SIGTERM" });
  assert.equal(stop.kind, "accepted");
  if (stop.kind !== "accepted") throw new Error("Signal should stop bootstrap");
  lifecycle.state = stop.state;
  const waitingState = lifecycle.state;
  assert.equal(waitingState.kind, "boot-stop-requested");
  assert.equal(transitionServiceLifecycle(waitingState, { type: "stop", signal: "SIGINT" }).kind, "already-stopping");
  await Promise.resolve();
  assert.equal(acquisitionSettled, false);
  assert.equal(cleanupStarted, false);

  settleAcquisition(new Error("acquisition rejected after signal"));
  await bootstrap;
  assert.equal(cleanupStarted, true);
  const settledState = lifecycle.state;
  assert.equal(settledState.kind, "cleaning");
  if (settledState.kind !== "cleaning") throw new Error("Settled bootstrap should clean up");
  assert.equal(settledState.cause, "SIGTERM");
  assert.deepEqual(settledState.completion, { kind: "return" });
});

test("bootstrap storage failure keeps its cause and ignores duplicate reports", () => {
  const first = transitionServiceLifecycle(createServiceLifecycle(), { type: "storage-failure", error: undefined });
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") throw new Error("First storage failure should be recorded");
  let state = first.state;
  assert.equal(state.kind, "boot-stop-requested");
  if (state.kind !== "boot-stop-requested") throw new Error("Storage failure should stop bootstrap");
  assert.equal(state.request.kind, "storage-failure");
  assert.ok(state.storageFailure);
  assert.equal(state.storageFailure.error, undefined);
  assert.equal(transitionServiceLifecycle(state, { type: "storage-failure", error: new Error("duplicate") }).kind, "ignored");
  assert.equal(transitionServiceLifecycle(state, { type: "stop", signal: "SIGTERM" }).kind, "already-stopping");

  const settled = transitionServiceLifecycle(state, { type: "bootstrap-settled", error: undefined });
  assert.equal(settled.kind, "accepted");
  if (settled.kind !== "accepted") throw new Error("Storage-failed bootstrap should clean up");
  state = settled.state;
  assert.equal(state.kind, "cleaning");
  if (state.kind !== "cleaning") throw new Error("Storage-failed bootstrap should enter cleanup");
  assert.equal(state.cause, "startup failure");
  assert.deepEqual(state.completion, { kind: "throw", error: undefined });
  assert.equal(state.result, "failed");
});

test("a storage failure after a bootstrap signal preserves the signal and caught error", () => {
  const stopped = transitionServiceLifecycle(createServiceLifecycle(), { type: "stop", signal: "SIGTERM" });
  assert.equal(stopped.kind, "accepted");
  if (stopped.kind !== "accepted") throw new Error("Signal should stop bootstrap");
  let state = stopped.state;
  const storageError = new Error("storage failure after signal");
  const reported = transitionServiceLifecycle(state, { type: "storage-failure", error: storageError });
  assert.equal(reported.kind, "accepted");
  if (reported.kind !== "accepted") throw new Error("Storage failure should be recorded");
  state = reported.state;
  assert.equal(transitionServiceLifecycle(state, { type: "stop", signal: "SIGINT" }).kind, "already-stopping");

  const acquisitionError = new Error("actual acquisition rejection");
  const settled = transitionServiceLifecycle(state, { type: "bootstrap-settled", error: acquisitionError });
  assert.equal(settled.kind, "accepted");
  if (settled.kind !== "accepted") throw new Error("Stopped bootstrap should clean up");
  state = settled.state;
  assert.equal(state.kind, "cleaning");
  if (state.kind !== "cleaning") throw new Error("Stopped bootstrap should enter cleanup");
  assert.equal(state.cause, "SIGTERM");
  assert.deepEqual(state.completion, { kind: "throw", error: acquisitionError });
  assert.equal(state.result, "failed");
  assert.equal(state.storageFailure?.error, storageError);
});

test("a storage failure while ready starts failed cleanup once", () => {
  const ready = transitionServiceLifecycle(createServiceLifecycle(), { type: "ready" });
  if (ready.kind !== "accepted") throw new Error("Service should become ready");
  const storageError = new Error("runtime storage failure");
  const failed = transitionServiceLifecycle(ready.state, { type: "storage-failure", error: storageError });
  assert.equal(failed.kind, "accepted");
  if (failed.kind !== "accepted") throw new Error("Runtime storage failure should start cleanup");
  const cleaning = failed.state;
  assert.equal(cleaning.kind, "cleaning");
  if (cleaning.kind !== "cleaning") throw new Error("Ready service should enter cleanup");
  assert.equal(cleaning.cause, "fatal durable storage failure");
  assert.equal(cleaning.result, "failed");
  assert.deepEqual(cleaning.completion, { kind: "return" });
  assert.equal(cleaning.storageFailure?.error, storageError);
  assert.equal(transitionServiceLifecycle(cleaning, { type: "storage-failure", error: new Error("duplicate") }).kind, "ignored");
  assert.equal(transitionServiceLifecycle(cleaning, { type: "stop", signal: "SIGTERM" }).kind, "already-stopping");
  const stopped = transitionServiceLifecycle(cleaning, { type: "stopped" });
  assert.equal(stopped.kind, "accepted");
  if (stopped.kind !== "accepted") throw new Error("Cleanup should finish");
  assert.equal(stopped.state.kind, "stopped");
  if (stopped.state.kind !== "stopped") throw new Error("Service should be stopped");
  assert.equal(stopped.state.result, "failed");
});

test("a storage failure during cleanup does not change the cleanup result snapshot", () => {
  const ready = transitionServiceLifecycle(createServiceLifecycle(), { type: "ready" });
  assert.equal(ready.kind, "accepted");
  if (ready.kind !== "accepted") throw new Error("Service should become ready");
  const stop = transitionServiceLifecycle(ready.state, { type: "stop", signal: "SIGTERM" });
  assert.equal(stop.kind, "accepted");
  if (stop.kind !== "accepted") throw new Error("Ready service should stop");
  let state = stop.state;
  assert.equal(state.kind, "cleaning");
  if (state.kind !== "cleaning") throw new Error("Ready service should enter cleanup");
  assert.equal(state.result, "success");
  assert.equal(transitionServiceLifecycle(state, { type: "stop", signal: "SIGINT" }).kind, "already-stopping");

  const reported = transitionServiceLifecycle(state, { type: "storage-failure", error: new Error("late storage failure") });
  assert.equal(reported.kind, "accepted");
  if (reported.kind !== "accepted") throw new Error("First cleanup-time storage failure should be recorded");
  state = reported.state;
  assert.equal(state.kind, "cleaning");
  if (state.kind !== "cleaning") throw new Error("Cleanup should continue");
  assert.equal(state.result, "success");
  assert.deepEqual(state.completion, { kind: "return" });
  const stopped = transitionServiceLifecycle(state, { type: "stopped" });
  assert.equal(stopped.kind, "accepted");
  if (stopped.kind !== "accepted") throw new Error("Cleanup should finish");
  assert.equal(stopped.state.kind, "stopped");
  if (stopped.state.kind !== "stopped") throw new Error("Service should be stopped");
  assert.equal(stopped.state.result, "success");
  assert.equal(stopped.state.storageFailure?.error, state.storageFailure?.error);
});

test("cleanup failures change the shutdown result without changing completion", () => {
  const ready = transitionServiceLifecycle(createServiceLifecycle(), { type: "ready" });
  if (ready.kind !== "accepted") throw new Error("Service should become ready");
  const stop = transitionServiceLifecycle(ready.state, { type: "stop", signal: "SIGTERM" });
  if (stop.kind !== "accepted") throw new Error("Ready service should stop");
  const failed = transitionServiceLifecycle(stop.state, { type: "cleanup-failed" });
  assert.equal(failed.kind, "accepted");
  if (failed.kind !== "accepted") throw new Error("Cleanup failure should be recorded");
  assert.equal(failed.state.kind, "cleaning");
  if (failed.state.kind !== "cleaning") throw new Error("Cleanup should continue");
  assert.equal(failed.state.result, "failed");
  assert.deepEqual(failed.state.completion, { kind: "return" });
});

for (const store of [{ kind: "not-opened" }, { kind: "closed" }] as const) {
  test(`service harness rejects ${store.kind} store ownership`, async () => {
    const lifecycle = createServiceLifecycle({ store });
    if (lifecycle.kind !== "starting") throw new Error("New service should be starting");
    const resources = lifecycle.resources;
    let openCalls = 0;
    await assert.rejects(openServiceHarness(resources, async () => {
      openCalls += 1;
      throw new Error("Harness must not open without storage ownership");
    }), /Durable storage is not available for harness startup/);
    assert.equal(openCalls, 0);
    assert.deepEqual(resources.store, store);
  });
}

test("a successful harness handoff transfers store ownership", async () => {
  const storage = await openNodeSqliteStorage(":memory:");
  const originalClose = storage.close.bind(storage);
  let harnessClosed = false;
  const harness = {
    close: async () => {
      harnessClosed = true;
      await originalClose(BACKGROUND_CONTEXT);
    },
  } as unknown as Harness;
  const lifecycle = createServiceLifecycle();
  if (lifecycle.kind !== "starting") throw new Error("New service should be starting");
  const resources = lifecycle.resources;
  resources.store = { kind: "storage-owned", storage };
  try {
    let openedWith: unknown;
    const ownership = await openServiceHarness(resources, async (ownedStorage) => {
      openedWith = ownedStorage;
      return harness;
    });
    assert.equal(openedWith, storage);
    assert.deepEqual(ownership, { kind: "harness-owned", harness });
    assert.deepEqual(resources.store, ownership);
    assert.deepEqual(await closeServiceStore(resources), { kind: "closed" });
    assert.deepEqual(resources.store, { kind: "closed" });
    assert.equal(harnessClosed, true);
  } finally {
    if (!harnessClosed) await originalClose(BACKGROUND_CONTEXT);
  }
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
  resources.store = { kind: "storage-owned", storage };
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
      storageRetained: resources.store.kind === "storage-owned" && resources.store.storage === storage,
      storeState: resources.store.kind,
      ownerReleased: releaseCalls > 0,
      closeResult: firstCleanup.kind,
      closeCalls,
    };
    storage.close = originalClose;
    const secondCleanup = await closeServiceStore(resources);
    storageClosed = secondCleanup.kind === "closed";

    assert.deepEqual(ownershipAfterFailure, {
      storageRetained: true,
      storeState: "storage-owned",
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
