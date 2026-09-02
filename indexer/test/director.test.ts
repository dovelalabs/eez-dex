/**
 * The director exists on devnet and nowhere else — RD-2 IX-1, FE-9.
 *
 * "These endpoints must not exist in any other profile — not disabled at
 * runtime, *absent*." So the test is not that they refuse: it is that the
 * route table does not contain them, that the module implementing them is
 * never imported, and that a request meets the same 404 as a path nobody ever
 * wrote a handler for.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { EventHub } from "../src/hub.ts";
import { INDEXER_PROFILES, loading } from "../src/protocol.ts";
import { DIRECTOR_CONTROLS, DirectorError, directorArgv, runControl } from "../src/server/director.ts";
import { serve } from "../src/server/http.ts";
import { createIndexer } from "../src/index.ts";

function hub(): EventHub {
  return new EventHub({ mode: "live", profile: "devnet", sources: [loading("l2")] });
}

const RUNNER = { command: "/bin/echo", run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }) };

test("fe9: off devnet the director's routes are not built at all", async () => {
  for (const profile of INDEXER_PROFILES.filter((name) => name !== "devnet")) {
    const gateway = await serve({ hub: hub(), profile, port: 0, director: RUNNER });
    try {
      assert.deepEqual(
        gateway.routes.filter((route) => route.includes("director")),
        [],
        `${profile} must not carry a director route`,
      );
      for (const control of DIRECTOR_CONTROLS) {
        const response = await fetch(`http://127.0.0.1:${gateway.port}/director/${control}`, { method: "POST" });
        assert.equal(response.status, 404, `${profile} /director/${control}`);
      }
      // The read-only surface is unchanged: nothing else was turned off with it.
      assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/snapshot`)).status, 200);
    } finally {
      await gateway.close();
    }
  }
});

test("fe9: the gateway on a non-devnet profile has no director route either", async () => {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    profile: "testnet",
    fixture: new URL("fixtures/run.json", import.meta.url).pathname,
    speed: 0,
  });
  after(() => indexer.close());

  assert.deepEqual(indexer.routes.filter((route) => route.includes("director")), []);
  assert.equal((await fetch(`http://127.0.0.1:${indexer.port}/director/burst`, { method: "POST" })).status, 404);
});

test("fe9: on devnet each control maps to an HX-3 scenario op", async () => {
  const gateway = await serve({ hub: hub(), profile: "devnet", port: 0, director: RUNNER });
  after(() => gateway.close());

  assert.deepEqual(gateway.routes.filter((route) => route.includes("director")), [
    "POST /director/burst",
    "POST /director/drift",
    "POST /director/stall",
  ]);

  const response = await fetch(`http://127.0.0.1:${gateway.port}/director/burst`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orders: 8 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()) as unknown, {
    ok: true,
    control: "burst",
    argv: ["--op", "place", "--count", "8"],
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
});

test("fe9: a control's parameter is an integer in range, or the request fails", async () => {
  assert.deepEqual(directorArgv("burst", {}), ["--op", "place", "--count", "8"]);
  assert.deepEqual(directorArgv("drift", { bps: -250 }), ["--op", "drift", "--bps", "-250"]);
  assert.deepEqual(directorArgv("stall", { slots: 2 }), ["--op", "stall", "--slots", "2"]);

  // Nothing a caller sends can become argv, let alone shell syntax.
  assert.throws(() => directorArgv("burst", { orders: "8; rm -rf /" }), DirectorError);
  assert.throws(() => directorArgv("burst", { orders: 1000 }), DirectorError);
  assert.throws(() => directorArgv("burst", { orders: 1.5 }), DirectorError);
  assert.throws(() => directorArgv("exfiltrate", {}), DirectorError);
});

test("fe9: a control the harness rejects is reported, not swallowed", async () => {
  const failing = await runControl(
    "stall",
    { slots: 3 },
    { command: "x", run: async () => ({ exitCode: 1, stdout: "", stderr: "no enclave" }) },
  );
  assert.equal(failing.exitCode, 1);
  assert.equal(failing.stderr, "no enclave");
});
