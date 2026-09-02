/**
 * `keccak256`, pinned to published vectors — RD-2 IX-1.
 *
 * The indexer derives every event topic and function selector it decodes with
 * from a signature string, so if this hash were wrong the gateway would decode
 * nothing and say so loudly. These vectors are what make "derived, not
 * hard-coded" safe.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256Hex } from "../src/chain/keccak.ts";

test("ix1: keccak256 matches the published vectors", () => {
  assert.equal(
    keccak256Hex(""),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(
    keccak256Hex("abc"),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  // Longer than one 136-byte block, so the absorb loop is exercised
  // (cross-checked with `cast keccak`).
  assert.equal(
    keccak256Hex("a".repeat(200)),
    "0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d",
  );
});

test("ix1: keccak256 gives the event topics Ethereum publishes", () => {
  assert.equal(
    keccak256Hex("Transfer(address,address,uint256)"),
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
  assert.equal(
    keccak256Hex("Swap(address,address,int256,int256,uint160,uint128,int24)"),
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  );
});
