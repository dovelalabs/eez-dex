/**
 * The Phase 4b entry point exists, type-checks, and fails loudly naming its
 * owner.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SCHEMA_VERSION, createIndexer } from "../src/index.ts";

test("phase 4b: the read-side gateway is a stub", () => {
  assert.throws(
    () =>
      createIndexer({
        l1Rpc: "http://127.0.0.1:8545",
        l2Rpc: "http://127.0.0.1:8546",
        windowBook: "0x00000000000000000000000000000000000000b0",
        port: 8080,
      }),
    /not implemented: Phase 4b/,
  );
});

test("ix2: the gateway re-exports the frozen schema", () => {
  assert.equal(SCHEMA_VERSION, 1);
});
