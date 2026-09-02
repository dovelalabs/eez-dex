/**
 * The gateway, end to end — RD-2 WP-5, IX-1, IX-2.
 *
 * Phase 4b's entry point is implemented: `createIndexer` serves a stream, and
 * the frozen schema travels with it.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { SCHEMA_VERSION, createIndexer, parseArgv, resolveOptions } from "../src/index.ts";

const RUN = fileURLToPath(new URL("fixtures/run.json", import.meta.url));

test("ix1: the gateway serves a recorded run with no infrastructure behind it", async () => {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    profile: "testnet",
    fixture: RUN,
    speed: 0,
  });
  after(() => indexer.close());
  await indexer.done;

  assert.equal(indexer.schemaVersion, SCHEMA_VERSION);
  assert.equal(indexer.mode, "replay");
  assert.ok(indexer.port !== null && indexer.port > 0);

  const snapshot = await indexer.snapshot();
  assert.ok(snapshot.windows.length >= 3, "the run covers more than one window");
  assert.ok(snapshot.settlements.length >= 2);
  assert.notEqual(snapshot.mirror, null);
});

test("ix2: the gateway re-exports the frozen schema", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("ix1: the stream is an async iterable of the same events", async () => {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    profile: "testnet",
    fixture: RUN,
    speed: 0,
    serve: false,
  });
  after(() => indexer.close());

  const seen: number[] = [];
  const reading = (async () => {
    for await (const event of indexer.stream()) {
      seen.push(event.seq);
      if (seen.length === 5) break;
    }
  })();

  await Promise.race([reading, indexer.done]);
  await reading;
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test("ix1: the gateway points at any environment by configuration", () => {
  const options = resolveOptions(
    ["--l2", "http://l2:8545", "--book", "0xb0", "--port", "9000", "--profile", "testnet"],
    { L1_RPC: "http://l1:8545", SETTLER_URL: "http://settler/state", PORT: "1" },
  );
  assert.equal(options.l2Rpc, "http://l2:8545");
  // A flag beats the environment; the environment beats the default.
  assert.equal(options.port, 9000);
  assert.equal(options.l1Rpc, "http://l1:8545");
  assert.equal(options.settlerUrl, "http://settler/state");
  assert.equal(options.profile, "testnet");

  assert.deepEqual(parseArgv(["--replay", "run.json", "--speed=4", "--director"]), {
    replay: "run.json",
    speed: "4",
    director: "true",
  });
  assert.throws(() => resolveOptions(["--profile", "moonbase"]), /PROFILE must be one of/);
});

test("ix1: a live gateway with nothing to read fails at startup, not at the first tick", async () => {
  await assert.rejects(
    () => createIndexer({ l1Rpc: "", l2Rpc: "http://127.0.0.1:1", windowBook: "", port: 0, serve: false }),
    /WINDOW_BOOK is not set/,
  );
});
