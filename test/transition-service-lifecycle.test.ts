import assert from "node:assert/strict";
import { test } from "node:test";
import { createServiceLifecycle, serviceCanDispatchRequests, transitionServiceLifecycle } from "../service/start-service.ts";

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
