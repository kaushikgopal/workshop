import assert from "node:assert/strict";
import test from "node:test";

import { allowLoopbackEveRequests } from "../agent/lib/allow-loopback-eve-requests.ts";

test("loopback eve auth requires the explicit local-service opt-in", async () => {
  const authenticate = allowLoopbackEveRequests(false);

  assert.equal(await authenticate(new Request("http://127.0.0.1:3000/eve/v1/session")), null);
});

test("loopback eve auth accepts local clients as an operator", async () => {
  const authenticate = allowLoopbackEveRequests(true);

  for (const url of [
    "http://127.0.0.1:3000/eve/v1/session",
    "http://localhost:3000/eve/v1/session",
    "http://[::1]:3000/eve/v1/session",
  ]) {
    assert.deepEqual(await authenticate(new Request(url)), {
      authenticator: "workshop-loopback",
      attributes: {},
      principalId: "workshop:local",
      principalType: "service",
    });
  }

  assert.notEqual(
    await authenticate(
      new Request("http://127.0.0.1:3000/eve/v1/session", {
        headers: { origin: "http://127.0.0.1:3000" },
      }),
    ),
    null,
  );
});

test("loopback eve auth rejects remote hosts and cross-origin browser requests", async () => {
  const authenticate = allowLoopbackEveRequests(true);

  assert.equal(await authenticate(new Request("https://workshop.example.com/eve/v1/session")), null);
  assert.equal(
    await authenticate(
      new Request("http://127.0.0.1:3000/eve/v1/session", {
        headers: { origin: "https://attacker.example" },
      }),
    ),
    null,
  );
  assert.equal(
    await authenticate(
      new Request("http://127.0.0.1:3000/eve/v1/session", {
        headers: { origin: "http://localhost:3000" },
      }),
    ),
    null,
  );
});
